export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

/** A single source cited by the assistant in a RAG response. */
export interface Citation {
  /** 1-indexed — matches the [Source N] marker used inline in the response text. */
  number: number;
  documentId: string;
  filename: string;
  pageNumber?: number;
  /** First 150 characters of the source chunk — shown as preview in the UI. */
  excerpt: string;
}

export interface Document {
  id: string;
  jobId: string;
  name: string;
  status: DocumentStatus;
  tokenCount?: number;
  errorMessage?: string;
  uploadedAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  traceId?: string;
  /** Structured citations from the backend — populated after the SSE stream completes. */
  citations?: Citation[];
  feedback?: 1 | -1;
  createdAt: string;
}

export interface UploadResponse {
  jobId: string;
  documentId: string;
  status: 'PENDING';
}

export interface DocumentStatusResponse {
  documentId: string;
  status: DocumentStatus;
  errorMessage?: string | null;
  tokenCount?: number | null;
}

export interface FeedbackPayload {
  traceId: string;
  /** 1 = thumbs up, -1 = thumbs down, 0 = clear (overwrites previous score in Langfuse). */
  score: 1 | -1 | 0;
}
