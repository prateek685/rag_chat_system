import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LangfuseTraceClient } from 'langfuse';
import OpenAI from 'openai';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { LangfuseService } from '../../observability/langfuse.service';
import { PromptBuilderService } from '../prompt-builder.service';
import { RAGState, WriteTokenFn } from '../types/rag-state.types';

/** Time-to-first-token latency budget. */
const TTFT_BUDGET_MS = 800;

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
    configService: ConfigService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly langfuseService: LangfuseService,
  ) {
    this.generatorModel = configService.getOrThrow<string>('GENERATOR_MODEL');
    this.openai = new OpenAI({
      apiKey: configService.getOrThrow<string>('OPENROUTER_API_KEY'),
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
      const stream = await this.openai.chat.completions.create({
        model: this.generatorModel,
        messages: openaiMessages,
        temperature: state.temperature,
        stream: true,
        // Request usage data on the final stream chunk for token cost tracking.
        stream_options: { include_usage: true },
      });

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
