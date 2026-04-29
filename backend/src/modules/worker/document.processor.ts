import * as fs from 'fs';
import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { MarkdownTextSplitter, RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { getEncoding } from 'js-tiktoken';
import { Job } from 'bullmq';
import pdfParse from 'pdf-parse';
import { PrismaService } from '../prisma/prisma.service';
import { VectorService } from './vector.service';
import { LangfuseService } from '../observability/langfuse.service';
import {
  DOCUMENT_PROCESSING_QUEUE,
  DocumentJobPayload,
  DocumentJobPayloadSchema,
} from './types/document-job.types';

/**
 * At 50k tokens a single document consumes ~50% of gpt-4o's context window.
 * Above this threshold retrieval coherence degrades significantly.
 */
const MAX_TOKEN_COUNT = 50_000;

/**
 * Pre-parse byte ceiling for plain-text files (txt, csv, md).
 * For UTF-8 prose, 4 bytes/token is a conservative lower bound — meaning any plain-text
 * file larger than this is guaranteed to exceed MAX_TOKEN_COUNT after parsing.
 * Rejecting here avoids reading the full file into memory before discovering it's over budget.
 * PDFs cannot use this gate: binary overhead makes file size an unreliable token proxy.
 */
const MAX_PLAIN_TEXT_BYTES = MAX_TOKEN_COUNT * 4; // 200 KB

/**
 * ~250 tokens at 4 chars/token. Leaves headroom for 5 chunks
 * to fit in the 2048-token context slot reserved for retrieved context.
 */
const CHUNK_SIZE = 1_000;

/** Ensures sentences straddling chunk boundaries are captured. */
const CHUNK_OVERLAP = 200;

/** MIME types that can be parsed as plain text without a dedicated parser. */
const PLAIN_TEXT_MIME_TYPES = new Set<string>([
  'text/plain',
  'text/csv',
  'text/markdown',
]);

/**
 * Thrown when pdf-parse encounters an encrypted/password-protected PDF.
 * Decouples the user-facing message from the library's internal error string
 * ("No password given") so message copy is stable across pdf-parse version bumps.
 */
class PasswordProtectedPdfError extends Error {
  constructor() {
    super(
      'File is password-protected. Please upload an unlocked version.',
    );
    this.name = 'PasswordProtectedPdfError';
  }
}

/**
 * BullMQ worker for the document-processing queue.
 * Orchestrates the full pipeline: validate → parse → chunk → embed → store → cleanup.
 * On any failure the document status is updated to FAILED before rethrowing
 * so the status endpoint reflects the failure in real time.
 */
/**
 * lockDuration: worker holds the job lock for 30s, renewed every 15s while active.
 * maxStalledCount: job moves to failed after 2 stalls — prevents infinite crash loops.
 */
@Processor(DOCUMENT_PROCESSING_QUEUE, { lockDuration: 30_000, maxStalledCount: 2 })
@Injectable()
export class DocumentProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorService: VectorService,
    private readonly langfuseService: LangfuseService,
  ) {
    super();
  }

  /**
   * Main processing handler. BullMQ retries up to 3 times (exponential backoff 2s → 4s → 8s).
   *
   * @param job - BullMQ job carrying DocumentJobPayload.
   */
  async process(job: Job<DocumentJobPayload>): Promise<void> {
    // Validate payload at the consumer boundary before touching any infrastructure.
    const payload = DocumentJobPayloadSchema.parse(job.data);
    const { documentId, sessionId, filePath, originalFilename, mimeType } = payload;

    this.logger.log({ event: 'job_started', jobId: job.id, documentId, attempt: job.attemptsMade + 1 });

    const e2eStart = Date.now();
    const trace = this.langfuseService.createTrace({
      name: 'document-processing',
      sessionId,
      input: JSON.stringify({ documentId, originalFilename, mimeType }),
    });

    try {
      // Phase 1: Mark as PROCESSING so the status endpoint reflects progress immediately.
      // Also fetch sessionId to assert the denormalization invariant before any chunk writes.
      const doc = await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'PROCESSING' },
        select: { sessionId: true },
      });

      // DENORMALIZATION INVARIANT: chunks inherit sessionId from the parent document.
      // A mismatch means the job payload was corrupted — fail loudly before inserting any
      // chunk row to prevent cross-session data leakage (zero-tolerance per CLAUDE.md).
      if (doc.sessionId !== sessionId) {
        throw new Error(
          `Session ID mismatch: payload has "${sessionId}" but document "${documentId}" owns session "${doc.sessionId}". Aborting to prevent cross-session data leakage.`,
        );
      }

      // Phase 2: Verify the file is still present and readable (could be lost if disk fills).
      await fs.promises.access(filePath, fs.constants.R_OK);

      // Phase 2b: Pre-parse byte gate for plain-text files.
      // PDFs are skipped here — binary overhead makes size an unreliable token proxy,
      // so PDFs are checked after parse in Phase 4 below.
      if (PLAIN_TEXT_MIME_TYPES.has(mimeType)) {
        const { size: fileSizeBytes } = await fs.promises.stat(filePath);
        if (fileSizeBytes > MAX_PLAIN_TEXT_BYTES) {
          this.logger.warn({
            event: 'token_limit_exceeded_pre_parse',
            documentId,
            sessionId,
            mimeType,
            fileSizeBytes,
            maxBytes: MAX_PLAIN_TEXT_BYTES,
            maxTokenCount: MAX_TOKEN_COUNT,
          });
          throw new Error(
            `Document exceeds size limit before parsing: ${fileSizeBytes} bytes ` +
            `(max ~${MAX_PLAIN_TEXT_BYTES} bytes for plain text, equating to ~${MAX_TOKEN_COUNT} tokens). ` +
            'Please split the document into smaller files.',
          );
        }
      }

      // Phase 3: Parse the file into raw text.
      const rawText = await this.parseFile(filePath, mimeType);

      // Phase 4: Count tokens and enforce the 50k limit.
      // For PDFs this is the first opportunity to gate on size — parse cost is unavoidable.
      // The warn log here lets us monitor how often large documents are rejected post-parse.
      const tokenCount = await this.countTokens(rawText);
      if (tokenCount > MAX_TOKEN_COUNT) {
        this.logger.warn({
          event: 'token_limit_exceeded_post_parse',
          documentId,
          sessionId,
          mimeType,
          tokenCount,
          maxTokenCount: MAX_TOKEN_COUNT,
        });
        throw new Error(
          `Document exceeds token limit: ${tokenCount} tokens (max ${MAX_TOKEN_COUNT}). ` +
          'Please split the document into smaller files.',
        );
      }

      // Phase 5: Split at natural semantic boundaries (headings, paragraphs, sentences).
      const chunks = await this.createSplitter(mimeType).createDocuments(
        [rawText],
        [{ source: originalFilename }],
      );

      // Guard: an empty PDF or all-whitespace file produces zero chunks.
      // Marking it COMPLETED would mislead the user — all retrieval queries would return NO_CONTEXT.
      if (chunks.length === 0) {
        throw new Error('No text content found. The file may be empty or contain only whitespace.');
      }

      // Phase 6 + 7: Batch-embed all chunks in one OpenAI call, then bulk-insert.
      // Trace is forwarded so the embedding generation span nests under this job's trace.
      await this.vectorService.embedAndStore(chunks, documentId, sessionId, trace);

      // Phase 8: Mark as COMPLETED and persist the token count.
      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'COMPLETED', tokenCount },
      });

      const e2eLatencyMs = Date.now() - e2eStart;
      this.langfuseService.finalizeTrace(trace, 'completed', {
        documentId,
        tokenCount,
        chunkCount: chunks.length,
        e2eLatencyMs,
      });

      // Phase 9: Remove the temp file. Non-fatal — a warn log is sufficient if it fails.
      await fs.promises.unlink(filePath).catch((err: NodeJS.ErrnoException) => {
        this.logger.warn({ event: 'temp_file_delete_failed', filePath, error: err.message });
      });

      this.logger.log({ event: 'job_completed', jobId: job.id, documentId, tokenCount, chunkCount: chunks.length });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      this.langfuseService.recordTraceError(trace, 'document_processing_failure', errorMessage);

      // Update status to FAILED immediately so every retry reflects current state.
      // The catch inside is intentional — a failed status update must not mask the original error.
      await this.prisma.document
        .update({
          where: { id: documentId },
          data: { status: 'FAILED', errorMessage },
        })
        .catch((updateErr: unknown) => {
          this.logger.error({
            event: 'status_update_failed',
            documentId,
            error: updateErr instanceof Error ? updateErr.message : String(updateErr),
          });
        });

      // Rethrow so BullMQ can retry the job according to the backoff config.
      throw err;
    }
  }

  /**
   * Fires after every failed attempt. On the final attempt (no retries remaining),
   * deletes the orphaned upload file so disk usage stays bounded.
   * Intermediate failures leave the file in place so the retry can re-parse it.
   *
   * @param job - The failed BullMQ job.
   * @param err - The error that caused the failure.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<DocumentJobPayload>, err: Error): Promise<void> {
    this.logger.error({
      event: 'job_failed_permanently',
      jobId: job.id,
      documentId: job.data?.documentId,
      totalAttempts: job.attemptsMade,
      error: err.message,
    });

    // Clean up the upload file only when all retries are exhausted.
    // Intermediate failures must keep the file so the next attempt can re-parse it.
    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await fs.promises.unlink(job.data.filePath).catch((unlinkErr: NodeJS.ErrnoException) => {
        this.logger.warn({
          event: 'orphan_file_delete_failed',
          filePath: job.data?.filePath,
          error: unlinkErr.message,
        });
      });
    }
  }

  /**
   * Parses a file into a plain-text string suitable for chunking.
   * PDF extraction uses pdf-parse; all other allowed types (txt, csv, md) are read as UTF-8.
   *
   * @param filePath - Absolute path to the file on disk.
   * @param mimeType - MIME type as reported by Multer.
   * @returns Extracted plain text.
   */
  private async parseFile(filePath: string, mimeType: string): Promise<string> {
    if (mimeType === 'application/pdf') {
      const buffer = await fs.promises.readFile(filePath);
      let parsedText: string;
      try {
        const data = await pdfParse(buffer);
        parsedText = data.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // pdf-parse surfaces "No password given" for encrypted PDFs; also guard
        // against future message changes by matching "encrypted" as a fallback.
        if (/no password given|encrypted/i.test(msg)) {
          throw new PasswordProtectedPdfError();
        }
        throw new Error('Could not read PDF — file may be corrupted or use an unsupported format.');
      }
      // A successfully-parsed PDF with no text is almost certainly scanned or image-only.
      // Returning empty text here would silently produce zero chunks and mislead the user.
      if (!parsedText || parsedText.trim().length === 0) {
        throw new Error(
          'PDF contains only images or scanned content. Please use a text-based PDF or run OCR first.',
        );
      }
      return parsedText;
    }

    if (PLAIN_TEXT_MIME_TYPES.has(mimeType)) {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      // Null bytes are present in binary files but never in valid UTF-8 text.
      // Letting binary data through produces garbled chunks that embed but return nonsense.
      if (content.includes('\x00')) {
        throw new Error('File contains binary data and cannot be processed as text.');
      }
      return content;
    }

    // Defensive fallback — fileFilter in the controller should prevent this path.
    throw new Error(`Unsupported MIME type for parsing: ${mimeType}`);
  }

  /**
   * Returns the appropriate text splitter for the given MIME type.
   *
   * Markdown files use MarkdownTextSplitter which adds heading separators
   * (\n## , \n### , \n#### ) before the standard paragraph/line/word hierarchy.
   * This preserves section boundaries so each chunk stays within one heading's scope,
   * avoiding cross-section context bleed that degrades retrieval precision.
   *
   * All other types (txt, csv, pdf) use RecursiveCharacterTextSplitter with an
   * explicit separator hierarchy: paragraph → line → word → character.
   * Separators are declared explicitly rather than relying on library defaults
   * so the chunking strategy is readable and auditable in this file alone.
   *
   * @param mimeType - MIME type of the document being processed.
   * @returns Configured splitter instance.
   */
  private createSplitter(
    mimeType: string,
  ): MarkdownTextSplitter | RecursiveCharacterTextSplitter {
    const options = { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP };

    if (mimeType === 'text/markdown') {
      // MarkdownTextSplitter extends RecursiveCharacterTextSplitter with heading
      // separators prepended: ['\n## ', '\n### ', '\n#### ', '\n\n', '\n', ' ', '']
      return new MarkdownTextSplitter(options);
    }

    // Explicit separator hierarchy for plain text, CSV, and PDF-extracted text.
    // '\n\n' → paragraph breaks (highest priority — most semantically meaningful)
    // '\n'   → single line breaks (preserves list items, table rows)
    // ' '    → word boundaries (last resort before character-level split)
    // ''     → character-level fallback for long unbroken strings
    return new RecursiveCharacterTextSplitter({
      ...options,
      separators: ['\n\n', '\n', ' ', ''],
    });
  }

  /**
   * Counts BPE tokens using the cl100k_base encoding (same as gpt-4o / text-embedding-3-small).
   *
   * @param text - The raw document text.
   * @returns Token count.
   */
  private async countTokens(text: string): Promise<number> {
    const enc = getEncoding('cl100k_base');
    return enc.encode(text).length;
  }
}
