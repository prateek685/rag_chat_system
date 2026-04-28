import { z } from 'zod';

/** BullMQ queue name — single constant shared by producer and consumer. */
export const DOCUMENT_PROCESSING_QUEUE = 'document-processing';

/**
 * Zod schema for the BullMQ job payload.
 * Validated at enqueue time (DocumentService) and dequeue time (DocumentProcessor)
 * to surface malformed payloads early rather than failing silently in the worker.
 */
export const DocumentJobPayloadSchema = z.object({
  documentId: z.string().uuid(),
  sessionId: z.string().uuid(),
  /** Absolute path to the uploaded file on disk (written by Multer diskStorage). */
  filePath: z.string().min(1),
  originalFilename: z.string().min(1),
  mimeType: z.string().min(1),
});

export type DocumentJobPayload = z.infer<typeof DocumentJobPayloadSchema>;
