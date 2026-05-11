import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../../config/env.config';
import { LangfuseTraceClient } from 'langfuse';
import OpenAI from 'openai';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { withLlmRetry } from '../../../common/utils/llm-retry.util';
import { computeKeywordOverlap } from '../../../common/utils/faithfulness.util';
import { LangfuseService } from '../../observability/langfuse.service';
import { PromptBuilderService } from '../prompt-builder.service';
import { RAGState, WriteTokenFn } from '../types/rag-state.types';

/** Time-to-first-token latency budget. */
const TTFT_BUDGET_MS = 800;

/**
 * Normalises citation brackets emitted by free-tier models that prefer CJK fullwidth
 * brackets (【Source N】) despite the system prompt requiring ASCII [Source N].
 * Applied to the complete response after streaming so the persisted text is always clean.
 * The live stream tokens are unaffected — normalisation happens before DB/Langfuse writes.
 */
function normalizeCitations(text: string): string {
  return text.replace(/【(Source \d+)】/g, '[$1]');
}

/**
 * Keyword-overlap score below this value triggers a warn log.
 * Does not block the response — faithfulness scoring is observability-only.
 * Calibrated at 0.30: typical well-grounded responses score 0.35–0.70;
 * below 0.30 suggests the response may contain content not present in the retrieved chunks.
 */
const FAITHFULNESS_WARN_THRESHOLD = 0.30;

/**
 * GeneratorNodeService streams the final LLM response token-by-token.
 *
 * The writeToken callback writes each token directly to the Express SSE response.
 * It is passed via closure at graph-build time and never stored in LangGraph state,
 * keeping state serializable and avoiding TypeScript strict-mode violations.
 */
@Injectable()
export class GeneratorNodeService {
  private readonly logger = new Logger(GeneratorNodeService.name);
  private readonly openai: OpenAI;
  private readonly generatorModel: string;

  constructor(
    configService: ConfigService<EnvConfig, true>,
    private readonly promptBuilder: PromptBuilderService,
    private readonly langfuseService: LangfuseService,
  ) {
    this.generatorModel = configService.get('GENERATOR_MODEL', { infer: true });
    this.openai = new OpenAI({
      apiKey: configService.get('OPENROUTER_API_KEY', { infer: true }),
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }

  /**
   * LangGraph node function — generates and streams the assistant response.
   *
   * @param state - Current RAG state (route, chunks, slidingWindow, userQuery, temperature).
   * @param writeToken - Callback that writes each streamed token to the SSE response.
   * @param trace - Langfuse trace client for observability (may be null).
   * @returns Partial state: `{ fullResponse }` with the complete accumulated text.
   */
  async execute(
    state: RAGState,
    writeToken: WriteTokenFn,
    trace: LangfuseTraceClient | null,
  ): Promise<Partial<RAGState>> {
    const messages = this.promptBuilder.buildMessages(state);

    // Convert LangChain BaseMessage array to OpenAI message format.
    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m) => {
      const role: 'user' | 'assistant' | 'system' =
        m instanceof HumanMessage ? 'user' : m instanceof AIMessage ? 'assistant' : 'system';
      return {
        role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };
    });

    // Create generation observation with the full prompt array as input —
    // enables token cost calculation and prompt inspection in the Langfuse dashboard.
    const generation = this.langfuseService.createGeneration(trace, {
      name: 'generator',
      model: this.generatorModel,
      input: openaiMessages,
      modelParameters: { temperature: state.temperature },
    });

    const start = Date.now();
    let firstTokenReceived = false;
    let ttftMs: number | undefined;
    let fullResponse = '';
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let totalTokens: number | undefined;

    try {
      // Retry wraps only the initial connection — once the stream is open we iterate
      // without retry (partial tokens already written to SSE response).
      const stream = await withLlmRetry(
        () =>
          this.openai.chat.completions.create({
            model: this.generatorModel,
            messages: openaiMessages,
            temperature: state.temperature,
            stream: true,
            // Request usage data on the final stream chunk for token cost tracking.
            stream_options: { include_usage: true },
          }),
        this.logger,
        { operation: 'generator', sessionId: state.sessionId },
      );

      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content ?? '';
        if (token) {
          if (!firstTokenReceived) {
            ttftMs = Date.now() - start;
            if (ttftMs > TTFT_BUDGET_MS) {
              this.logger.warn({
                event: 'latency_budget_exceeded',
                operation: 'ttft',
                latencyMs: ttftMs,
                budget: TTFT_BUDGET_MS,
                model: this.generatorModel,
              });
            }
            firstTokenReceived = true;
          }
          fullResponse += token;
          writeToken(token);
        }

        // Usage is only present on the final chunk when stream_options.include_usage = true.
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
          totalTokens = chunk.usage.total_tokens;
        }
      }
    } catch (err) {
      this.logger.error({
        event: 'generator_stream_failed',
        sessionId: state.sessionId,
        model: this.generatorModel,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const latencyMs = Date.now() - start;

    fullResponse = normalizeCitations(fullResponse);

    // Keyword-overlap faithfulness signal — only meaningful for RAG_QUERY with retrieved chunks.
    // Logs to Langfuse as a trace score so average faithfulness is visible on the dashboard.
    // A low score warrants investigation but does not block the response.
    if (state.route === 'RAG_QUERY' && state.chunks.length > 0) {
      const faithfulnessScore = computeKeywordOverlap(
        fullResponse,
        state.chunks.map((c) => c.content),
      );
      this.langfuseService.scoreTrace(state.traceId, 'keyword-overlap', faithfulnessScore);
      if (faithfulnessScore < FAITHFULNESS_WARN_THRESHOLD) {
        this.logger.warn({
          event: 'low_faithfulness_score',
          score: faithfulnessScore,
          threshold: FAITHFULNESS_WARN_THRESHOLD,
          sessionId: state.sessionId,
        });
      }
    }

    this.langfuseService.finalizeGeneration(generation, {
      output: fullResponse,
      usage: { promptTokens, completionTokens, totalTokens },
      metadata: {
        model: this.generatorModel,
        latencyMs,
        ttftMs,
        chunkCount: state.chunks.length,
        route: state.route,
      },
    });
    this.logger.log({
      event: 'generation_complete',
      sessionId: state.sessionId,
      responseLength: fullResponse.length,
      latencyMs,
      promptTokens,
      completionTokens,
    });

    return { fullResponse };
  }
}
