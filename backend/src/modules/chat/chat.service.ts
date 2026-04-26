import { createHash, randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Response } from 'express';
import { LangfuseTraceClient } from 'langfuse';
import { LangfuseService } from '../observability/langfuse.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ChatMessageDto } from './dto/chat-message.dto';
import { FeedbackDto } from './dto/feedback.dto';
import { RagGraphService } from './graph/rag-graph.service';
import { RetrievalNodeService } from './nodes/retrieval.node';
import { SummarizeMemoryNodeService } from './nodes/summarize-memory.node';
import { NO_CONTEXT_RESPONSE, VIOLATION_RESPONSE } from './prompts/system-prompt';
import { SemanticCacheService } from './semantic-cache.service';
import { Citation, RetrievedChunk, SlidingWindowMessage } from './types/rag-state.types';

/** Redis key for per-session rate limiting. */
const rateLimitKey = (sessionId: string): string => `rate_limit:${sessionId}`;
/** Maximum messages per session per rate-limit window. */
const RATE_LIMIT_MAX = 10;
/** Rate-limit window duration in seconds. */
const RATE_LIMIT_TTL_SECONDS = 60;

/** Redis key for the exact-match chat cache. */
const chatCacheKey = (hash: string): string => `chat:cache:${hash}`;
/** Cache TTL: 24 hours. */
const CACHE_TTL_SECONDS = 60 * 60 * 24;

/** Number of recent messages loaded for the sliding-window memory context. */
const SLIDING_WINDOW_SIZE = 6;

/** Default generation temperature. */
const DEFAULT_TEMPERATURE = 0.7;
/** Reduced temperature for retry requests (less repetition). */
const RETRY_TEMPERATURE = 0.4;

/** P95 budget for the full end-to-end chat pipeline. */
const E2E_LATENCY_BUDGET_MS = 2000;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly langfuseService: LangfuseService,
    private readonly ragGraph: RagGraphService,
    private readonly retrievalNode: RetrievalNodeService,
    private readonly semanticCache: SemanticCacheService,
    private readonly summarizeMemoryNode: SummarizeMemoryNodeService,
  ) {}

  /**
   * Orchestrates the full RAG chat pipeline and streams the response via SSE.
   *
   * Order: rate limit → DB save → SSE headers → exact cache check →
   *        Langfuse trace → [embed + load context in parallel] →
   *        semantic cache check → graph execute → stream canned response if needed →
   *        [DONE] → async post-processing (save + exact cache + semantic cache + summarize).
   *
   * @param dto - Validated chat message DTO.
   * @param sessionId - Owning session UUID (from SessionGuard).
   * @param res - Express response used for SSE write/end.
   * @param isRetry - True when called from handleRetry; skips cache write.
   * @param temperature - LLM sampling temperature (lower on retry for variety).
   */
  async handleChat(
    dto: ChatMessageDto,
    sessionId: string,
    res: Response,
    isRetry = false,
    temperature = DEFAULT_TEMPERATURE,
  ): Promise<void> {
    const e2eStart = Date.now();

    // 1. Rate limit — must throw BEFORE SSE headers are flushed so the exception filter
    //    can still write a proper 429 JSON response.
    await this.checkRateLimit(sessionId);

    // 2. Persist user message immediately (before any LLM call).
    await this.prisma.message.create({
      data: { sessionId, role: 'user', content: dto.message },
    });

    // 3. Set SSE headers and flush so the client sees the 200 status immediately.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Prevents nginx proxy buffering
    res.flushHeaders();

    const skipCache = dto.skipCache === true || isRetry;

    // 4. Exact-match cache check — keyed by SHA-256(sessionId:message).
    const cacheHash = createHash('sha256')
      .update(`${sessionId}:${dto.message}`)
      .digest('hex');
    const cacheKey = chatCacheKey(cacheHash);

    if (!skipCache) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.log({ event: 'exact_cache_hit', sessionId });
        res.write(`data: ${JSON.stringify({ token: cached })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    }

    // 5. Create Langfuse trace before embedding so the embedding span nests under it.
    const trace = this.langfuseService.createTrace({
      name: 'chat',
      sessionId,
      input: dto.message,
      tags: isRetry ? ['retry'] : [],
    });
    const traceId = trace?.id ?? randomUUID();

    // 6. Embed query + load context in parallel.
    //    Pre-computing the embedding here enables the semantic cache check and
    //    eliminates the duplicate embedding call inside RetrievalNode.
    let queryEmbedding: number[] = [];
    let slidingWindow: SlidingWindowMessage[] = [];
    let runningSummary: string | null = null;

    try {
      const [embedding, context] = await Promise.all([
        this.retrievalNode.embedQuery(dto.message, sessionId, trace),
        this.loadSessionContext(sessionId),
      ]);
      queryEmbedding = embedding;
      slidingWindow = context.slidingWindow;
      runningSummary = context.runningSummary;
    } catch (err) {
      // Embedding failure is fatal — we cannot serve a RAG response without it.
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error({ event: 'pre_embed_failed', sessionId, error: errorMessage });
      this.langfuseService.recordTraceError(trace, 'embed_failure', errorMessage);
      res.write(`data: ${JSON.stringify({ error: 'Something went wrong. Please try again.' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 7. Semantic cache check — only when not a retry/skipCache.
    if (!skipCache && queryEmbedding.length > 0) {
      const semanticHit = await this.semanticCache.lookup(sessionId, queryEmbedding);
      if (semanticHit) {
        this.logger.log({ event: 'semantic_cache_hit', sessionId });
        res.write(`data: ${JSON.stringify({ token: semanticHit })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        // Promote to exact cache so identical future queries are faster.
        setImmediate(() => {
          void this.redis.setex(cacheKey, CACHE_TTL_SECONDS, semanticHit);
        });
        return;
      }
    }

    // 8. Build the SSE write callback — captures res via closure.
    const writeToken = (token: string): void => {
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    };

    let fullResponse = '';
    let finalRoute: string | null = null;
    let retrievedChunks: RetrievedChunk[] = [];

    // 9. Execute the LangGraph pipeline.
    try {
      const finalState = await this.ragGraph.execute(
        {
          sessionId,
          userQuery: dto.message,
          // Pre-computed embedding — RetrievalNode skips re-embedding when non-empty.
          queryEmbedding,
          route: null,
          chunks: [],
          slidingWindow,
          runningSummary,
          fullResponse: '',
          traceId,
          skipCache,
          temperature,
        },
        writeToken,
        trace,
      );

      fullResponse = finalState.fullResponse;
      finalRoute = finalState.route;
      retrievedChunks = finalState.chunks;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error({
        event: 'graph_execution_failed',
        sessionId,
        error: errorMessage,
      });
      this.langfuseService.recordTraceError(trace, 'llm_pipeline_failure', errorMessage);
      res.write(`data: ${JSON.stringify({ error: 'Something went wrong. Please try again.' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 10. Write canned responses for routes that end the graph without streaming.
    if (finalRoute === 'VIOLATION' && !fullResponse) {
      fullResponse = VIOLATION_RESPONSE;
      res.write(`data: ${JSON.stringify({ token: fullResponse })}\n\n`);
    } else if (finalRoute === 'NO_CONTEXT' && !fullResponse) {
      fullResponse = NO_CONTEXT_RESPONSE;
      res.write(`data: ${JSON.stringify({ token: fullResponse })}\n\n`);
    }

    // 11. Build citations from retrieved chunks, signal stream end, close response.
    const citations = this.buildCitations(fullResponse, retrievedChunks);
    res.write(`data: ${JSON.stringify({ traceId })}\n\n`);
    if (citations.length > 0) {
      res.write(`data: ${JSON.stringify({ citations })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();

    const e2eLatencyMs = Date.now() - e2eStart;
    if (e2eLatencyMs > E2E_LATENCY_BUDGET_MS) {
      this.logger.warn({
        event: 'latency_budget_exceeded',
        operation: 'end_to_end_chat',
        latencyMs: e2eLatencyMs,
        budget: E2E_LATENCY_BUDGET_MS,
        sessionId,
      });
    }

    // 12. Non-blocking post-processing: save assistant message + caches + Langfuse + summarize.
    setImmediate(() => {
      void this.postProcess({
        sessionId,
        fullResponse,
        citations,
        cacheKey,
        queryEmbedding,
        skipCache,
        finalRoute,
        traceId,
        trace,
        e2eLatencyMs,
        runningSummary,
      });
    });
  }

  /**
   * Handles retry: clears stale cache entries, deletes the last assistant + user messages,
   * then re-runs the pipeline with skipCache=true and reduced temperature for variety.
   *
   * @param sessionId - Owning session UUID.
   * @param res - Express response for SSE streaming.
   */
  async handleRetry(sessionId: string, res: Response): Promise<void> {
    // Delete the most recent assistant message.
    const lastAssistant = await this.prisma.message.findFirst({
      where: { sessionId, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
    });
    if (lastAssistant) {
      await this.prisma.message.delete({ where: { id: lastAssistant.id } });
    }

    // Fetch the most recent user message to re-run.
    const lastUser = await this.prisma.message.findFirst({
      where: { sessionId, role: 'user' },
      orderBy: { createdAt: 'desc' },
    });

    if (!lastUser) {
      res.status(400).json({ message: 'No user message found to retry' });
      return;
    }

    // Invalidate stale cache so the wrong response is not served again.
    // Exact cache: delete the specific key for this query.
    const staleHash = createHash('sha256')
      .update(`${sessionId}:${lastUser.content}`)
      .digest('hex');
    await this.redis.del(chatCacheKey(staleHash));

    // Semantic cache: wipe entire session — retry signals the user found something wrong.
    await this.semanticCache.invalidateSession(sessionId);

    // Delete the user message — handleChat will persist it fresh.
    await this.prisma.message.delete({ where: { id: lastUser.id } });

    await this.handleChat(
      { message: lastUser.content, skipCache: true },
      sessionId,
      res,
      true,
      RETRY_TEMPERATURE,
    );
  }

  /**
   * Forwards a user feedback score to Langfuse.
   * On negative feedback (score = -1), invalidates the cached response so
   * the wrong answer is not served again to the same session.
   *
   * @param dto - Feedback payload with traceId and score (1 | -1).
   */
  async handleFeedback(dto: FeedbackDto): Promise<void> {
    // Record score in Langfuse regardless of cache outcome.
    await this.langfuseService.score(dto.traceId, dto.score);

    // Invalidate caches on thumbs-down to prevent the wrong answer from being served again.
    if (dto.score === -1) {
      await this.invalidateCacheForTrace(dto.traceId);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Redis INCR-based rate limiter scoped to sessionId.
   * INCR is atomic — no race condition between count read and TTL set.
   * The expire is set only on the first request in a window (count === 1).
   *
   * @throws TooManyRequestsException when the session exceeds RATE_LIMIT_MAX.
   */
  private async checkRateLimit(sessionId: string): Promise<void> {
    const key = rateLimitKey(sessionId);
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, RATE_LIMIT_TTL_SECONDS);
    }
    if (count > RATE_LIMIT_MAX) {
      throw new HttpException(
        `Rate limit exceeded: max ${RATE_LIMIT_MAX} messages per ${RATE_LIMIT_TTL_SECONDS}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Fetches the last SLIDING_WINDOW_SIZE messages (in chronological order)
   * and the session's running summary in parallel.
   */
  private async loadSessionContext(sessionId: string): Promise<{
    slidingWindow: SlidingWindowMessage[];
    runningSummary: string | null;
  }> {
    const [rawMessages, session] = await Promise.all([
      this.prisma.message.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        take: SLIDING_WINDOW_SIZE,
        select: { role: true, content: true },
      }),
      this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { runningSummary: true },
      }),
    ]);

    // Messages are fetched desc (newest first) then reversed to chronological order.
    const slidingWindow: SlidingWindowMessage[] = rawMessages
      .reverse()
      .map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }));

    return {
      slidingWindow,
      runningSummary: session?.runningSummary ?? null,
    };
  }

  /**
   * Async post-processing executed after res.end() via setImmediate.
   * Each step has its own try/catch — an error in one step must not prevent the others.
   * Order: save message → exact cache → semantic cache → Langfuse finalize → summarize.
   */
  private async postProcess(params: {
    sessionId: string;
    fullResponse: string;
    citations: Citation[];
    cacheKey: string;
    queryEmbedding: number[];
    skipCache: boolean;
    finalRoute: string | null;
    traceId: string;
    trace: LangfuseTraceClient | null;
    e2eLatencyMs: number;
    runningSummary: string | null;
  }): Promise<void> {
    const {
      sessionId,
      fullResponse,
      citations,
      cacheKey,
      queryEmbedding,
      skipCache,
      finalRoute,
      traceId,
      trace,
      e2eLatencyMs,
      runningSummary,
    } = params;

    // Save assistant message with traceId and structured citations for later feedback/display.
    try {
      await this.prisma.message.create({
        data: {
          sessionId,
          role: 'assistant',
          content: fullResponse,
          traceId,
          citations: citations.length > 0 ? (citations as object[]) : undefined,
        },
      });
    } catch (err) {
      this.logger.error({
        event: 'save_assistant_message_failed',
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Write exact-match and semantic caches only for real LLM responses.
    // Never cache canned guardrail replies (NO_CONTEXT, VIOLATION) — those are
    // session-state-dependent and would wrongly persist after documents change.
    const isCannedRoute = finalRoute === 'NO_CONTEXT' || finalRoute === 'VIOLATION';

    if (!skipCache && fullResponse && !isCannedRoute) {
      // Exact cache — serves future identical queries instantly.
      await this.redis.setex(cacheKey, CACHE_TTL_SECONDS, fullResponse);
      this.logger.log({ event: 'exact_cache_written', sessionId });

      // Semantic cache — serves semantically similar future queries.
      if (queryEmbedding.length > 0) {
        try {
          await this.semanticCache.store(sessionId, queryEmbedding, fullResponse);
        } catch (err) {
          this.logger.warn({
            event: 'semantic_cache_write_failed',
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Finalize Langfuse trace with E2E latency and route for pipeline-level analysis.
    this.langfuseService.finalizeTrace(trace, fullResponse, { e2eLatencyMs, route: finalRoute });

    // Summarize old messages if session is long — runs last so it doesn't delay other steps.
    // Any error here is caught inside execute() and never propagates.
    await this.summarizeMemoryNode.execute(sessionId, runningSummary);
  }

  /**
   * Looks up the question that produced a given traceId and clears its cache entries.
   * Called on thumbs-down feedback to prevent stale wrong answers from being served.
   * Non-throwing — Langfuse score was already recorded before this is called.
   */
  private async invalidateCacheForTrace(traceId: string): Promise<void> {
    try {
      const assistantMsg = await this.prisma.message.findFirst({
        where: { traceId },
        select: { sessionId: true, createdAt: true },
      });
      if (!assistantMsg) return;

      const { sessionId, createdAt } = assistantMsg;

      // Find the user message that immediately preceded this assistant response.
      const userMsg = await this.prisma.message.findFirst({
        where: { sessionId, role: 'user', createdAt: { lt: createdAt } },
        orderBy: { createdAt: 'desc' },
        select: { content: true },
      });
      if (!userMsg) return;

      // Delete the exact cache entry for the wrong answer.
      const staleHash = createHash('sha256')
        .update(`${sessionId}:${userMsg.content}`)
        .digest('hex');
      await this.redis.del(chatCacheKey(staleHash));

      // Wipe all semantic cache for the session — the wrong answer may also
      // be served to semantically similar future queries.
      await this.semanticCache.invalidateSession(sessionId);

      this.logger.log({ event: 'cache_invalidated_on_negative_feedback', sessionId, traceId });
    } catch (err) {
      // Non-fatal — Langfuse score was already recorded; cache expires via TTL.
      this.logger.warn({
        event: 'cache_invalidation_failed',
        traceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Parses [Source N] markers from the completed response text and maps each
   * referenced number to the corresponding retrieved chunk.
   * Citations that reference a number beyond the available chunks are silently
   * dropped — they indicate LLM hallucination of a non-existent source.
   */
  private buildCitations(fullResponse: string, chunks: RetrievedChunk[]): Citation[] {
    // Accept both ASCII [Source N] and full-width 【Source N】 — some models emit the latter.
    const re = /[\[【]Source\s+(\d+)[\]】]/g;
    const found = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(fullResponse)) !== null) {
      found.add(parseInt(m[1], 10));
    }
    return Array.from(found)
      .filter((n) => n >= 1 && n <= chunks.length)
      .sort((a, b) => a - b)
      .map((n) => {
        const chunk = chunks[n - 1];
        const pageNumber = this.extractPageNumber(chunk.metadata);
        const citation: Citation = {
          number: n,
          chunkId: chunk.id,
          documentId: chunk.documentId,
          filename: chunk.filename,
          excerpt: chunk.content.slice(0, 150).trim(),
        };
        if (pageNumber !== undefined) citation.pageNumber = pageNumber;
        return citation;
      });
  }

  /**
   * Extracts a page number from LangChain chunk metadata.
   * PDFLoader stores it as `loc.pageNumber`; older loaders use a flat `page` field.
   */
  private extractPageNumber(metadata: Record<string, unknown> | null): number | undefined {
    if (!metadata) return undefined;
    const loc = metadata.loc as { pageNumber?: number } | undefined;
    if (loc?.pageNumber !== undefined) return loc.pageNumber;
    if (typeof metadata.page === 'number') return metadata.page;
    return undefined;
  }
}
