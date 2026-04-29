import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../../config/env.config';
import { LangfuseTraceClient } from 'langfuse';
import OpenAI from 'openai';
import { withLlmRetry } from '../../../common/utils/llm-retry.util';
import { LangfuseService } from '../../observability/langfuse.service';
import { PrismaService } from '../../prisma/prisma.service';
import { COSINE_SIMILARITY_THRESHOLD } from '../prompts/system-prompt';
import { RAGState, RetrievedChunk } from '../types/rag-state.types';

/** P95 budget for the hybrid SQL retrieval query. */
const RETRIEVAL_LATENCY_BUDGET_MS = 200;

/** P95 budget for the query embedding call (free-tier models can be slow). */
const EMBED_LATENCY_BUDGET_MS = 3000;

/**
 * Raw result shape returned by the hybrid RRF $queryRaw call.
 * Prisma maps snake_case SQL aliases to camelCase via double-quoted aliases in the query.
 */
interface RawChunkRow {
  id: string;
  content: string;
  documentId: string;
  metadata: Record<string, unknown> | null;
  rrfScore: number;
  cosineSimilarity: number;
}

/**
 * RetrievalNodeService executes the hybrid Reciprocal Rank Fusion (RRF) search.
 *
 * Pipeline:
 *   • Semantic arm: top-20 chunks by cosine distance (pgvector HNSW index)
 *   • Keyword arm:  top-20 chunks by BM25 ts_rank_cd (GIN tsvector index)
 *   • RRF merge:    FULL OUTER JOIN, score = Σ(1/(60+rank)), top-5
 *
 * Guardrail: if the top chunk's cosine similarity < COSINE_SIMILARITY_THRESHOLD (0.30),
 * the query has no relevant match — route is set to NO_CONTEXT and the graph ends early.
 * v2: Cohere Rerank 3 will be inserted between this node and GeneratorNode.
 */
@Injectable()
export class RetrievalNodeService {
  private readonly logger = new Logger(RetrievalNodeService.name);
  private readonly openai: OpenAI;
  private readonly embeddingModel: string;
  private readonly expectedDimensions: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly langfuseService: LangfuseService,
    configService: ConfigService<EnvConfig, true>,
  ) {
    this.embeddingModel = configService.get('EMBEDDING_MODEL', { infer: true });
    this.expectedDimensions = configService.get('EMBEDDING_DIMENSIONS', { infer: true });
    this.openai = new OpenAI({
      apiKey: configService.get('OPENROUTER_API_KEY', { infer: true }),
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }

  /**
   * LangGraph node function — runs hybrid search and applies the context guardrail.
   *
   * @param state - Current RAG state (must have queryEmbedding and sessionId).
   * @param trace - Langfuse trace client for observability (may be null).
   * @returns Partial state: `{ chunks }` on success, `{ chunks: [], route: 'NO_CONTEXT' }` on guardrail.
   */
  async execute(
    state: RAGState,
    trace: LangfuseTraceClient | null,
  ): Promise<Partial<RAGState>> {
    const span = this.langfuseService.createSpan(trace, {
      name: 'retrieval',
      input: { query: state.userQuery, sessionId: state.sessionId },
    });

    // Use pre-computed embedding from ChatService if available (set when semantic cache is active).
    // Falls back to embedding here for backward compatibility and GREETING/VIOLATION skip paths.
    const queryEmbedding =
      state.queryEmbedding.length > 0
        ? state.queryEmbedding
        : await this.embedQuery(state.userQuery, state.sessionId, trace);

    const start = Date.now();
    const embeddingParam = `[${queryEmbedding.join(',')}]`;

    let rawRows: RawChunkRow[] = [];
    try {

      rawRows = await this.prisma.$queryRaw<RawChunkRow[]>`
        WITH semantic AS (
          SELECT
            dc.id,
            dc.content,
            dc.document_id,
            dc.metadata,
            ROW_NUMBER() OVER (ORDER BY dc.embedding <=> ${embeddingParam}::halfvec) AS rank,
            1 - (dc.embedding <=> ${embeddingParam}::halfvec) AS cosine_similarity
          FROM document_chunks dc
          WHERE dc.session_id = ${state.sessionId}
          ORDER BY dc.embedding <=> ${embeddingParam}::halfvec
          LIMIT 20
        ),
        keyword AS (
          SELECT
            dc.id,
            dc.content,
            dc.document_id,
            dc.metadata,
            ROW_NUMBER() OVER (
              ORDER BY ts_rank_cd(dc.search_vector, plainto_tsquery('english', ${state.userQuery})) DESC
            ) AS rank
          FROM document_chunks dc
          WHERE dc.session_id = ${state.sessionId}
            AND dc.search_vector @@ plainto_tsquery('english', ${state.userQuery})
          ORDER BY ts_rank_cd(dc.search_vector, plainto_tsquery('english', ${state.userQuery})) DESC
          LIMIT 20
        ),
        rrf AS (
          SELECT
            COALESCE(s.id, k.id)              AS id,
            COALESCE(s.content, k.content)    AS content,
            COALESCE(s.document_id, k.document_id) AS document_id,
            COALESCE(s.metadata, k.metadata)  AS metadata,
            COALESCE(1.0 / (60.0 + s.rank), 0) + COALESCE(1.0 / (60.0 + k.rank), 0) AS rrf_score,
            COALESCE(s.cosine_similarity, 0)  AS cosine_similarity
          FROM semantic s
          FULL OUTER JOIN keyword k ON s.id = k.id
        )
        SELECT
          id,
          content,
          document_id       AS "documentId",
          metadata,
          rrf_score         AS "rrfScore",
          cosine_similarity AS "cosineSimilarity"
        FROM rrf
        ORDER BY rrf_score DESC
        LIMIT 5
      `;
    } catch (err) {
      this.logger.error({
        event: 'retrieval_sql_failed',
        sessionId: state.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Return empty chunks and let the guardrail fire
      rawRows = [];
    }

    const latencyMs = Date.now() - start;
    if (latencyMs > RETRIEVAL_LATENCY_BUDGET_MS) {
      this.logger.warn({
        event: 'latency_budget_exceeded',
        operation: 'retrieval',
        latencyMs,
        budget: RETRIEVAL_LATENCY_BUDGET_MS,
        sessionId: state.sessionId,
      });
    }

    const rawChunks: RetrievedChunk[] = rawRows.map((row) => ({
      id: row.id,
      content: row.content,
      documentId: row.documentId,
      filename: '',  // resolved below
      rrfScore: Number(row.rrfScore),
      cosineSimilarity: Number(row.cosineSimilarity),
      metadata: row.metadata,
    }));

    // Batch-fetch upload filenames from the documents table.
    // Kept separate from the RRF SQL to avoid complicating the CTE query.
    const docIds = [...new Set(rawChunks.map((c) => c.documentId))];
    let filenameMap = new Map<string, string>();
    if (docIds.length > 0) {
      try {
        const docs = await this.prisma.document.findMany({
          where: { id: { in: docIds } },
          select: { id: true, filename: true },
        });
        filenameMap = new Map(docs.map((d) => [d.id, d.filename]));
      } catch (err) {
        this.logger.warn({
          event: 'filename_fetch_failed',
          sessionId: state.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const chunks: RetrievedChunk[] = rawChunks.map((c) => ({
      ...c,
      filename: filenameMap.get(c.documentId) ?? 'Unknown document',
    }));

    const topSimilarity = chunks[0]?.cosineSimilarity ?? 0;

    // Context guardrail: insufficient semantic relevance → short-circuit before generation.
    if (chunks.length === 0 || topSimilarity < COSINE_SIMILARITY_THRESHOLD) {
      this.logger.log({
        event: 'no_context_guardrail',
        topSimilarity,
        chunkCount: chunks.length,
        sessionId: state.sessionId,
      });
      this.langfuseService.finalizeSpan(
        span,
        {
          guardrail: 'NO_CONTEXT',
          topSimilarity,
          chunkCount: 0,
          chunks: [],
        },
        { latencyMs },
      );
      return { chunks: [], route: 'NO_CONTEXT' };
    }

    // Emit chunk scores + content previews so retrieval quality is auditable in Langfuse
    // without having to cross-reference chunk IDs manually.
    this.langfuseService.finalizeSpan(
      span,
      {
        chunkCount: chunks.length,
        topSimilarity,
        chunks: chunks.map((c) => ({
          id: c.id,
          contentPreview: c.content.slice(0, 300),
          filename: c.filename,
          cosineSimilarity: c.cosineSimilarity,
          rrfScore: c.rrfScore,
        })),
      },
      { latencyMs },
    );
    this.logger.log({
      event: 'retrieval_complete',
      chunkCount: chunks.length,
      topSimilarity,
      sessionId: state.sessionId,
      latencyMs,
    });

    return { chunks };
  }

  /**
   * Embeds a query string via OpenRouter using the configured embedding model.
   * Public so ChatService can pre-compute the embedding for semantic cache lookup
   * before the graph runs — RetrievalNode then reuses the result from state.
   *
   * Retries on transient failures (429, 5xx) with exponential backoff.
   * Throws on unrecoverable failure — the graph catches it and writes an error SSE event.
   *
   * @param query - Text to embed.
   * @param sessionId - Used for log correlation.
   * @param trace - Langfuse trace client (may be null).
   * @returns Dense embedding vector.
   */
  async embedQuery(
    query: string,
    sessionId: string,
    trace: LangfuseTraceClient | null,
  ): Promise<number[]> {
    const generation = this.langfuseService.createGeneration(trace, {
      name: 'embedding',
      model: this.embeddingModel,
      input: query,
    });

    const start = Date.now();
    try {
      const response = await withLlmRetry(
        () =>
          this.openai.embeddings.create({
            model: this.embeddingModel,
            input: query,
            encoding_format: 'float',
          }),
        this.logger,
        { operation: 'embed_query', sessionId },
      );

      const embedding = response.data[0]?.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error(`Embedding response missing data for model "${this.embeddingModel}"`);
      }

      // Dimension mismatch means every pgvector similarity query will fail or silently
      // return garbage. Throw early with a clear message rather than letting it surface
      // as a cryptic SQL error or silent retrieval failure.
      if (embedding.length !== this.expectedDimensions) {
        throw new Error(
          `Embedding dimension mismatch: model "${this.embeddingModel}" returned ` +
          `${embedding.length} dimensions but EMBEDDING_DIMENSIONS is set to ` +
          `${this.expectedDimensions}. Update the env var to match the model.`,
        );
      }

      const latencyMs = Date.now() - start;
      if (latencyMs > EMBED_LATENCY_BUDGET_MS) {
        this.logger.warn({
          event: 'latency_budget_exceeded',
          operation: 'embed_query',
          latencyMs,
          budget: EMBED_LATENCY_BUDGET_MS,
          model: this.embeddingModel,
        });
      }

      const totalTokens = response.usage?.total_tokens;
      this.langfuseService.finalizeGeneration(generation, {
        output: `vector(${embedding.length})`,
        usage: { totalTokens },
        metadata: { latencyMs, model: this.embeddingModel },
      });

      return embedding as number[];
    } catch (err) {
      this.logger.error({
        event: 'embed_query_failed',
        sessionId,
        model: this.embeddingModel,
        error: err instanceof Error ? err.message : String(err),
      });
      this.langfuseService.finalizeGeneration(generation, {
        output: null,
        metadata: { latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }
}
