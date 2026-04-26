import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../config/env.config';
import Langfuse, { LangfuseGenerationClient, LangfuseSpanClient, LangfuseTraceClient } from 'langfuse';

/** Token usage shape from OpenAI responses (both streaming and non-streaming). */
export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Metadata value type accepted by the Langfuse SDK for observations and traces.
 * Matches the SDK's internal `LangfuseMetadataProperties` constraint.
 */
export type LangfuseMetadataValue = string | number | boolean | string[] | null | undefined;

/** Strips undefined values from a metadata object before passing to the Langfuse SDK. */
function cleanMetadata(
  raw: Record<string, LangfuseMetadataValue>,
): Record<string, string | number | boolean | string[] | null> {
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string | number | boolean | string[] | null] =>
      entry[1] !== undefined,
    ),
  );
}

/**
 * Thin wrapper around the Langfuse SDK.
 * All methods are non-throwing — errors are caught and logged so that
 * observability failures never impact the user-facing chat experience.
 */
@Injectable()
export class LangfuseService implements OnModuleDestroy {
  private readonly logger = new Logger(LangfuseService.name);
  private readonly client: Langfuse;

  constructor(private readonly configService: ConfigService<EnvConfig, true>) {
    this.client = new Langfuse({
      publicKey: configService.get('LANGFUSE_PUBLIC_KEY', { infer: true }),
      secretKey: configService.get('LANGFUSE_SECRET_KEY', { infer: true }),
      baseUrl: configService.get('LANGFUSE_HOST', { infer: true }),
    });
  }

  /**
   * Creates a top-level trace for a chat request.
   * Returns null on error — callers must guard against null before using the trace.
   *
   * @param params.name - Trace name (e.g. 'chat', 'retry').
   * @param params.sessionId - Session UUID for grouping traces.
   * @param params.input - The raw user message.
   * @param params.tags - Optional tags (e.g. ['retry']).
   */
  createTrace(params: {
    name: string;
    sessionId: string;
    input: string;
    tags?: string[];
  }): LangfuseTraceClient | null {
    try {
      return this.client.trace({
        name: params.name,
        sessionId: params.sessionId,
        input: params.input,
        tags: params.tags ?? [],
      });
    } catch (err) {
      this.logger.warn({
        event: 'langfuse_trace_create_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Creates a child span within a trace.
   * Returns null on error — span failures must not surface to the user.
   *
   * @param trace - Parent trace client (may be null if createTrace failed).
   * @param params.name - Span name matching Langfuse span conventions ('router', 'retrieval', etc.).
   * @param params.input - Input data for the span (logged to Langfuse, not sent to LLM).
   */
  createSpan(
    trace: LangfuseTraceClient | null,
    params: { name: string; input?: unknown },
  ): LangfuseSpanClient | null {
    if (!trace) return null;
    try {
      return trace.span({ name: params.name, input: params.input });
    } catch (err) {
      this.logger.warn({
        event: 'langfuse_span_create_failed',
        spanName: params.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Finalizes a span with its output and optional metadata.
   *
   * @param span - Span client to finalize (may be null if createSpan failed).
   * @param output - Output data produced by this span.
   * @param metadata - Optional structured metadata (latency, model name, etc.).
   */
  finalizeSpan(
    span: LangfuseSpanClient | null,
    output: unknown,
    metadata?: Record<string, LangfuseMetadataValue>,
  ): void {
    if (!span) return;
    try {
      span.end({ output, metadata });
    } catch (err) {
      this.logger.warn({
        event: 'langfuse_span_finalize_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Creates a Langfuse generation observation for an LLM call.
   * Use instead of createSpan when the observation involves a language model —
   * generation type enables automatic token cost calculation in the Langfuse dashboard.
   *
   * @param trace - Parent trace client (may be null if createTrace failed).
   * @param params.name - Generation name ('router', 'generator', 'embedding').
   * @param params.model - Model identifier (e.g. 'gpt-4o-mini').
   * @param params.input - Full prompt or query input logged to Langfuse.
   * @param params.modelParameters - Optional model parameters (temperature, max_tokens, etc.).
   */
  createGeneration(
    trace: LangfuseTraceClient | null,
    params: {
      name: string;
      model: string;
      input: unknown;
      modelParameters?: Record<string, string | number | boolean | null>;
    },
  ): LangfuseGenerationClient | null {
    if (!trace) return null;
    try {
      return trace.generation({
        name: params.name,
        model: params.model,
        input: params.input,
        modelParameters: params.modelParameters,
      });
    } catch (err) {
      this.logger.warn({
        event: 'langfuse_generation_create_failed',
        generationName: params.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Finalizes a generation observation with output, token usage, and metadata.
   * Token usage enables cost tracking in the Langfuse dashboard.
   *
   * @param generation - Generation client to finalize (may be null if createGeneration failed).
   * @param params.output - Full model output (response text, route classification, etc.).
   * @param params.usage - Token counts from the LLM API response.
   * @param params.metadata - Optional structured metadata (latency, TTFT, route, etc.).
   */
  finalizeGeneration(
    generation: LangfuseGenerationClient | null,
    params: {
      output: unknown;
      usage?: LlmUsage;
      metadata?: Record<string, LangfuseMetadataValue>;
    },
  ): void {
    if (!generation) return;
    try {
      generation.end({
        output: params.output,
        usage: params.usage
          ? {
              promptTokens: params.usage.promptTokens,
              completionTokens: params.usage.completionTokens,
              totalTokens: params.usage.totalTokens,
            }
          : undefined,
        // Strip undefined values — Langfuse metadata does not accept undefined.
        metadata: params.metadata ? cleanMetadata(params.metadata) : undefined,
      });
    } catch (err) {
      this.logger.warn({
        event: 'langfuse_generation_finalize_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Updates the trace output after generation completes.
   * Safe to call from setImmediate post-response — errors do not propagate.
   *
   * @param trace - Trace to finalize (may be null).
   * @param output - The full generated response text.
   * @param metadata - Optional trace-level metadata (e2eLatencyMs, route, etc.).
   */
  finalizeTrace(
    trace: LangfuseTraceClient | null,
    output: string,
    metadata?: Record<string, LangfuseMetadataValue>,
  ): void {
    if (!trace) return;
    try {
      trace.update({ output, metadata });
    } catch (err) {
      this.logger.warn({
        event: 'langfuse_trace_finalize_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Records a pipeline error on the trace for failure-type analysis in Langfuse.
   * Errors are classified by type so the dashboard can surface error rates per failure category.
   *
   * @param trace - Trace to update (may be null if createTrace failed).
   * @param errorType - Failure category string (e.g. 'llm_pipeline_failure', 'embed_query_failed').
   * @param errorMessage - Raw error message for debugging.
   */
  recordTraceError(
    trace: LangfuseTraceClient | null,
    errorType: string,
    errorMessage: string,
  ): void {
    if (!trace) return;
    try {
      trace.update({ metadata: { errorType, errorMessage } });
    } catch (err) {
      this.logger.warn({
        event: 'langfuse_trace_error_record_failed',
        errorType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Submits a user feedback score bound to a specific trace ID.
   * Called from the feedback endpoint; errors are swallowed so the HTTP 204 still returns.
   *
   * @param traceId - Langfuse trace ID from the original chat response.
   * @param value - 1 (thumbs up) or -1 (thumbs down).
   */
  async score(traceId: string, value: number): Promise<void> {
    try {
      await this.client.score({ traceId, name: 'user-feedback', value });
    } catch (err) {
      this.logger.warn({
        event: 'langfuse_score_failed',
        traceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Flushes any buffered Langfuse events before the process shuts down. */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.flushAsync();
    } catch (err) {
      this.logger.warn({ event: 'langfuse_flush_failed', error: String(err) });
    }
  }
}
