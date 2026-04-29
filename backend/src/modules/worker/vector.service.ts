import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../config/env.config';
import OpenAI from 'openai';
import { Document as LangChainDocument } from '@langchain/core/documents';
import { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import type { LangfuseTraceClient } from 'langfuse';
import { PrismaService } from '../prisma/prisma.service';
import { LangfuseService } from '../observability/langfuse.service';
import { withLlmRetry } from '../../common/utils/llm-retry.util';

/**
 * Threshold for the embeddings API call latency alarm.
 * OpenAI text-embedding-3-small (via OpenRouter): ~50 chunks in 1–3s; 5s gives 2× headroom.
 * Free-tier models may have higher latency — monitor p95 in Langfuse and tune if needed.
 */
const EMBED_LATENCY_BUDGET_MS = 5_000;

/** Internal shape used for the bulk INSERT. Not exported — consumers work with LangChainDocument[]. */
interface ChunkInsertRow {
  id: string;
  documentId: string;
  sessionId: string;
  content: string;
  metadata: Record<string, unknown>;
  /** pgvector array literal: '[0.1,0.2,...]' — passed as a bound parameter, not interpolated. */
  embedding: string;
}

/**
 * Handles batch embedding and bulk storage of document chunks.
 * All OpenAI calls are batched in a single request; all inserts are issued
 * in a single $executeRaw statement to minimise round-trips.
 */
@Injectable()
export class VectorService {
  private readonly logger = new Logger(VectorService.name);
  private readonly openai: OpenAI;
  private readonly embeddingModel: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<EnvConfig, true>,
    private readonly langfuseService: LangfuseService,
  ) {
    this.embeddingModel = this.configService.get('EMBEDDING_MODEL', { infer: true });
    // All embedding calls route through OpenRouter's OpenAI-compatible API.
    // Switch EMBEDDING_MODEL to 'openai/text-embedding-3-small' to use OpenAI
    // via OpenRouter's proxy without any code change.
    this.openai = new OpenAI({
      apiKey: this.configService.get('OPENROUTER_API_KEY', { infer: true }),
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }

  /**
   * Embeds all chunk texts in a single batched OpenAI API call, then bulk-inserts
   * all rows into document_chunks in a single $executeRaw statement.
   * The tsvectorupdate trigger auto-populates search_vector on insert — no manual update needed.
   *
   * @param chunks - LangChain Document objects with pageContent and metadata.
   * @param documentId - Parent document UUID.
   * @param sessionId - Owning session UUID (denormalized for retrieval performance).
   * @param trace - Optional parent Langfuse trace to nest the embedding generation span under.
   */
  async embedAndStore(
    chunks: LangChainDocument[],
    documentId: string,
    sessionId: string,
    trace: LangfuseTraceClient | null = null,
  ): Promise<void> {
    if (chunks.length === 0) return;

    const texts = chunks.map((c) => c.pageContent);

    const generation = this.langfuseService.createGeneration(trace, {
      name: 'embedding',
      model: this.embeddingModel,
      input: { chunkCount: texts.length },
    });

    const start = Date.now();
    let vectors: number[][];
    let promptTokens: number | undefined;
    let totalTokens: number | undefined;
    try {
      // maxAttempts: 2 — BullMQ already retries the full job up to 3×; keeping inner retries
      // at 2 caps the worst-case delay at ~1.2s before BullMQ takes over, avoiding a compounding
      // retry window of 8s+ that re-runs the full parse + chunk + embed cycle unnecessarily.
      const response = await withLlmRetry(
        () => this.openai.embeddings.create({
          model: this.embeddingModel,
          input: texts,
          encoding_format: 'float',
        }),
        this.logger,
        { operation: 'embeddings_batch', sessionId, maxAttempts: 2 },
      );
      // Guard against non-standard OpenRouter responses that omit the data field.
      // Some free-tier or vision-language models return unexpected response shapes.
      if (!response.data || response.data.length === 0) {
        throw new InternalServerErrorException(
          `Embedding API returned no data for model "${this.embeddingModel}". ` +
          'Verify the model supports the /v1/embeddings endpoint on OpenRouter.',
        );
      }
      if (response.data.length !== texts.length) {
        throw new InternalServerErrorException(
          `Embedding count mismatch: sent ${texts.length} texts, received ${response.data.length} embeddings`,
        );
      }

      promptTokens = response.usage?.prompt_tokens;
      totalTokens = response.usage?.total_tokens;

      vectors = response.data.map((d) => {
        if (!Array.isArray(d.embedding)) {
          throw new InternalServerErrorException(
            `Embedding response has unexpected format for model "${this.embeddingModel}": ` +
            `embedding field is ${typeof d.embedding}, expected number[]`,
          );
        }
        return d.embedding as number[];
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.langfuseService.finalizeGeneration(generation, {
        output: { error: errorMessage },
        metadata: { latencyMs: Date.now() - start, chunkCount: chunks.length, documentId },
      });
      this.logger.error({
        event: 'embed_failed',
        documentId,
        chunkCount: chunks.length,
        model: this.embeddingModel,
        error: errorMessage,
      });
      // Pass through our own controlled exceptions — they already carry user-readable messages.
      if (err instanceof InternalServerErrorException) {
        throw err;
      }
      // Translate raw SDK errors at the integration boundary.
      // Internal status codes and SDK internals must not reach user-facing surfaces.
      throw new InternalServerErrorException(
        'Document processing failed. Please try again.',
      );
    }
    const latencyMs = Date.now() - start;
    if (latencyMs > EMBED_LATENCY_BUDGET_MS) {
      this.logger.warn({
        event: 'latency_budget_exceeded',
        operation: 'embeddings',
        model: this.embeddingModel,
        latencyMs,
        budget: EMBED_LATENCY_BUDGET_MS,
        chunkCount: chunks.length,
      });
    }

    this.langfuseService.finalizeGeneration(generation, {
      output: { embeddingCount: vectors.length },
      usage: { promptTokens, totalTokens },
      metadata: { latencyMs, chunkCount: chunks.length, documentId },
    });

    const rows: ChunkInsertRow[] = chunks.map((chunk, i) => ({
      id: uuidv4(),
      documentId,
      sessionId,
      content: chunk.pageContent,
      metadata: chunk.metadata as Record<string, unknown>,
      embedding: `[${vectors[i].join(',')}]`,
    }));

    try {
      await this.bulkInsertChunks(rows);
    } catch (err) {
      this.logger.error({
        event: 'chunk_store_failed',
        documentId,
        count: rows.length,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new InternalServerErrorException('Document processing failed. Please try again.');
    }
    this.logger.log({ event: 'chunks_stored', documentId, count: rows.length, latencyMs });
  }

  /**
   * Issues a single parameterized INSERT for all chunk rows.
   * Prisma.sql + Prisma.join ensures no user data reaches the SQL as raw strings.
   * The ::jsonb and ::vector casts are SQL-level and safe — they apply after binding.
   *
   * @param rows - Pre-computed rows with pgvector literal embeddings.
   */
  private async bulkInsertChunks(rows: ChunkInsertRow[]): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO document_chunks (id, document_id, session_id, content, metadata, embedding)
      VALUES ${Prisma.join(
      rows.map(
        (r) =>
          Prisma.sql`(${r.id}, ${r.documentId}, ${r.sessionId}, ${r.content}, ${r.metadata}::jsonb, ${r.embedding}::halfvec)`,
      ),
    )}
    `;
  }
}
