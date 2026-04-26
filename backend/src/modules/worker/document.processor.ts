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
      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'PROCESSING' },
      });

      // Phase 2: Verify the file is still present and readable (could be lost if disk fills).
      await fs.promises.access(filePath, fs.constants.R_OK);

      // Phase 3: Parse the file into raw text.
      const rawText = await this.parseFile(filePath, mimeType);

      // Phase 4: Count tokens and enforce the 50k limit.
      const tokenCount = await this.countTokens(rawText);
      if (tokenCount > MAX_TOKEN_COUNT) {
        throw new Error(
          `Document exceeds token limit: ${tokenCount} tokens (max ${MAX_TOKEN_COUNT})`,
        );
      }

      // Phase 5: Split at natural semantic boundaries (headings, paragraphs, sentences).
      const chunks = await this.createSplitter(mimeType).createDocuments(
        [rawText],
        [{ source: originalFilename }],
      );

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
      const data = await pdfParse(buffer);
      return data.text;
    }

    if (PLAIN_TEXT_MIME_TYPES.has(mimeType)) {
      return fs.promises.readFile(filePath, 'utf-8');
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
