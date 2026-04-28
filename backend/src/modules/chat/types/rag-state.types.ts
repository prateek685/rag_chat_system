import { Annotation } from '@langchain/langgraph';

/** A single retrieved document chunk from hybrid RRF search. */
export interface RetrievedChunk {
  id: string;
  content: string;
  documentId: string;
  /** Original upload filename from the documents table — resolved after retrieval. */
  filename: string;
  rrfScore: number;
  /** Cosine similarity from pgvector (1 - cosine_distance). Used for the 0.30 guardrail check (COSINE_SIMILARITY_THRESHOLD). */
  cosineSimilarity: number;
  metadata: Record<string, unknown> | null;
}

/**
 * Structured citation linking a [Source N] marker in the response text to its
 * source chunk. Sent to the frontend via SSE and persisted to messages.citations.
 */
export interface Citation {
  /** 1-indexed — matches the [Source N] marker used inline in the response text. */
  number: number;
  chunkId: string;
  documentId: string;
  /** User-facing upload filename (e.g. "policy.pdf"). */
  filename: string;
  /** Page number extracted from chunk metadata, if available. */
  pageNumber?: number;
  /** First 150 characters of chunk content — shown as source preview in the UI. */
  excerpt: string;
}

/**
 * Route classification from RouterNode.
 * NO_CONTEXT is set by RetrievalNode when top chunk cosine similarity < COSINE_SIMILARITY_THRESHOLD (0.30).
 */
export type ChatRoute = 'RAG_QUERY' | 'GREETING' | 'VIOLATION' | 'NO_CONTEXT';

/**
 * Callback for streaming tokens from GeneratorNode to the HTTP response.
 * Passed via closure to avoid serializing it into LangGraph state.
 */
export type WriteTokenFn = (token: string) => void;

/** Sliding window message from DB — used to build conversation history context. */
export interface SlidingWindowMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * LangGraph state annotation for the RAG pipeline.
 * Each field is replaced (not merged) when a node returns a partial update.
 * The writeToken callback and Langfuse trace are NOT in state — passed via closure.
 */
export const RAGStateAnnotation = Annotation.Root({
  sessionId: Annotation<string>(),
  userQuery: Annotation<string>(),
  queryEmbedding: Annotation<number[]>(),
  route: Annotation<ChatRoute | null>(),
  chunks: Annotation<RetrievedChunk[]>(),
  slidingWindow: Annotation<SlidingWindowMessage[]>(),
  runningSummary: Annotation<string | null>(),
  fullResponse: Annotation<string>(),
  traceId: Annotation<string>(),
  skipCache: Annotation<boolean>(),
  temperature: Annotation<number>(),
});

export type RAGState = typeof RAGStateAnnotation.State;
