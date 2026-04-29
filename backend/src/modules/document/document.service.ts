import { createHash } from 'node:crypto';
import * as fs from 'fs';
import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, JobsOptions, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { DocumentJobPayload, DocumentJobPayloadSchema, DOCUMENT_PROCESSING_QUEUE } from '../worker/types/document-job.types';
import { UploadDocumentResponseDto } from './dto/upload-document.dto';
import { DocumentStatusResponseDto } from './dto/document-status.dto';

/**
 * P95 upload-to-queued response budget per CLAUDE.md latency table.
 * Warns if the full uploadDocument path (hash + dedup + create + enqueue) exceeds this.
 */
const UPLOAD_QUEUE_LATENCY_BUDGET_MS = 200;

/** BullMQ job options — 3 attempts with exponential backoff; keep failed jobs for DLQ inspection. */
const JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: true,
  removeOnFail: false,
};

/**
 * Handles document lifecycle: upload validation, queue dispatch, status polling, and deletion.
 * All operations are scoped by sessionId — no cross-session data access is possible.
 */
@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @InjectQueue(DOCUMENT_PROCESSING_QUEUE)
    private readonly documentQueue: Queue<DocumentJobPayload>,
  ) {}

  /**
   * Validates the uploaded file, persists a Document row, and enqueues a processing job.
   * Returns within the P95 latency budget (≤200ms); all heavy work happens asynchronously.
   *
   * @param file - Multer file object written to disk by diskStorage.
   * @param sessionId - Validated session UUID from the request header.
   * @returns Upload response with jobId, documentId, and initial PENDING status.
   * @throws ConflictException if this session already contains the same file content.
   */
  async uploadDocument(
    file: Express.Multer.File,
    sessionId: string,
  ): Promise<UploadDocumentResponseDto> {
    const start = Date.now();

    // SHA-256 of the file on disk. At ≤10MB this read is fast (<50ms on typical hardware).
    const fileBuffer = await fs.promises.readFile(file.path);
    const fileHash = createHash('sha256').update(fileBuffer).digest('hex');

    // Dedup check — unique constraint on (sessionId, fileHash) enforces session isolation.
    const existing = await this.prisma.document.findUnique({
      where: { sessionId_fileHash: { sessionId, fileHash } },
    });

    if (existing) {
      // Clean up the orphan temp file before rejecting — avoids disk leaks on duplicate uploads.
      await fs.promises.unlink(file.path).catch((err: NodeJS.ErrnoException) => {
        this.logger.warn({ event: 'orphan_cleanup_failed', filePath: file.path, error: err.message });
      });
      throw new ConflictException(
        `File '${file.originalname}' has already been uploaded in this session`,
      );
    }

    // Persist the document row with PENDING status before enqueuing.
    const doc = await this.prisma.document.create({
      data: {
        sessionId,
        filename: file.originalname,
        fileHash,
        status: 'PENDING',
      },
    });

    // Validate and enqueue the job payload.
    const payload = DocumentJobPayloadSchema.parse({
      documentId: doc.id,
      sessionId,
      filePath: file.path,
      originalFilename: file.originalname,
      mimeType: file.mimetype,
    } satisfies DocumentJobPayload);

    let job: Job<DocumentJobPayload>;
    try {
      job = await this.documentQueue.add('process-document', payload, JOB_OPTIONS);
    } catch (err) {
      // Queue unavailable — roll back the document row to avoid orphaned PENDING records.
      await this.prisma.document.delete({ where: { id: doc.id } }).catch(() => null);
      this.logger.error({
        event: 'queue_add_failed',
        documentId: doc.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Translate the raw BullMQ/Redis error at the integration boundary.
      throw new ServiceUnavailableException('Document processing failed. Please try again.');
    }

    // Store jobId so the status endpoint can look up the document by job reference.
    await this.prisma.document.update({
      where: { id: doc.id },
      data: { jobId: String(job.id) },
    });

    const latencyMs = Date.now() - start;
    if (latencyMs > UPLOAD_QUEUE_LATENCY_BUDGET_MS) {
      this.logger.warn({
        event: 'latency_budget_exceeded',
        operation: 'upload-to-queued',
        latencyMs,
        budget: UPLOAD_QUEUE_LATENCY_BUDGET_MS,
      });
    }

    this.logger.log({ event: 'document_queued', documentId: doc.id, jobId: String(job.id), latencyMs });

    return { jobId: String(job.id), documentId: doc.id, status: 'PENDING' };
  }

  /**
   * Returns the current processing status of a document identified by its BullMQ job ID.
   * The jobId is the polling handle returned by uploadDocument.
   *
   * @param jobId - BullMQ job ID string.
   * @param sessionId - Validated session UUID — prevents cross-session status reads.
   * @returns Status DTO with current state, optional error message, and token count.
   * @throws NotFoundException if no document matches the jobId for this session.
   */
  async getStatusByJobId(
    jobId: string,
    sessionId: string,
  ): Promise<DocumentStatusResponseDto> {
    const doc = await this.prisma.document.findFirst({
      where: { jobId, sessionId },
    });

    if (!doc) {
      throw new NotFoundException(`No document found for job ID: ${jobId}`);
    }

    return {
      documentId: doc.id,
      status: doc.status,
      errorMessage: doc.errorMessage,
      tokenCount: doc.tokenCount,
    };
  }

  /**
   * Deletes a document and all its chunks atomically, flushes related Redis cache keys,
   * and inserts a ghost system message to prevent the chat pipeline from referencing
   * deleted content in the session history.
   *
   * @param documentId - UUID of the document to delete.
   * @param sessionId - Validated session UUID — prevents cross-session deletion.
   * @throws NotFoundException if the document does not exist.
   * @throws ForbiddenException if the document belongs to a different session.
   */
  async deleteDocument(documentId: string, sessionId: string): Promise<void> {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });

    if (!doc) {
      throw new NotFoundException(`Document not found: ${documentId}`);
    }

    // Enforce zero cross-session data leakage — a session can only delete its own documents.
    if (doc.sessionId !== sessionId) {
      throw new ForbiddenException('Access denied: document does not belong to this session');
    }

    // Prisma cascade (onDelete: Cascade on DocumentChunk.document) wipes all chunks atomically.
    await this.prisma.document.delete({ where: { id: documentId } });

    // Flush semantic cache keys for this session — non-fatal, document is already deleted.
    await this.flushSessionCache(sessionId, documentId);

    // Insert a ghost system message so the chat pipeline knows to disregard deleted content.
    await this.insertGhostMessage(sessionId, doc.filename, documentId);
  }

  /**
   * Flushes semantic cache keys for the session using SCAN + batched DEL.
   * Exact cache entries (chat:cache:{sha256}) cannot be enumerated by session because
   * the hash combines sessionId + query opaquely — they expire naturally via TTL (24h).
   * Failure is non-fatal — the document is already deleted; cache will expire naturally.
   *
   * @param sessionId - Session UUID whose semantic cache keys should be purged.
   * @param documentId - Used for logging context only.
   */
  private async flushSessionCache(sessionId: string, documentId: string): Promise<void> {
    try {
      const deleted = await this.redis.delPattern(`semantic:${sessionId}:*`);
      this.logger.log({ event: 'session_cache_flushed', sessionId, documentId, keysDeleted: deleted });
    } catch (err) {
      this.logger.warn({
        event: 'session_cache_flush_failed',
        sessionId,
        documentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Inserts a system-role message directing the chat pipeline to ignore facts from the deleted document.
   * Failure is non-fatal — the document is already deleted; the warning surfaces in logs.
   *
   * @param sessionId - Session UUID to scope the message.
   * @param filename - Human-readable filename for the directive content.
   * @param documentId - Used for logging context only.
   */
  private async insertGhostMessage(
    sessionId: string,
    filename: string,
    documentId: string,
  ): Promise<void> {
    try {
      await this.prisma.message.create({
        data: {
          sessionId,
          role: 'system',
          content: `[SYSTEM DIRECTIVE: Document '${filename}' has been deleted. Ignore facts from it in prior history.]`,
        },
      });
      this.logger.log({ event: 'ghost_message_inserted', sessionId, documentId });
    } catch (err) {
      // Non-fatal: the document is deleted; the absence of the ghost message is an edge case.
      this.logger.error({
        event: 'ghost_message_insert_failed',
        sessionId,
        documentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
