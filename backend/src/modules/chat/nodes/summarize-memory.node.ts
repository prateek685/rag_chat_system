import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { EnvConfig } from '../../../config/env.config';
import { withLlmRetry } from '../../../common/utils/llm-retry.util';
import { LangfuseService } from '../../observability/langfuse.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Minimum number of user+assistant messages before summarization is triggered.
 * Below this threshold the sliding window (last 6 messages) is sufficient context.
 */
const MESSAGE_THRESHOLD = 10;

/** Number of oldest messages to compress into the running summary per trigger. */
const MESSAGES_TO_COMPRESS = 8;

/** Token budget for the summary LLM response (gpt-4o-mini is the model). */
const SUMMARY_MAX_TOKENS = 600;

/**
 * SummarizeMemoryNodeService compresses old messages into a running session summary.
 *
 * Called asynchronously from ChatService.postProcess() after the SSE stream closes —
 * it never blocks streaming latency.
 *
 * When triggered (message_count > MESSAGE_THRESHOLD):
 *   1. Fetch the oldest MESSAGES_TO_COMPRESS user+assistant messages.
 *   2. Ask the router model to condense them + the existing summary.
 *   3. Update sessions.running_summary and delete those messages in one transaction.
 *
 * The updated summary is available to the NEXT chat turn via loadSessionContext().
 */
@Injectable()
export class SummarizeMemoryNodeService {
  private readonly logger = new Logger(SummarizeMemoryNodeService.name);
  private readonly openai: OpenAI;
  private readonly routerModel: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly langfuseService: LangfuseService,
    configService: ConfigService<EnvConfig, true>,
  ) {
    // Reuses ROUTER_MODEL (gpt-4o-mini equivalent) — cheap and fast at condensing text.
    this.routerModel = configService.get('ROUTER_MODEL', { infer: true });
    this.openai = new OpenAI({
      apiKey: configService.get('OPENROUTER_API_KEY', { infer: true }),
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }

  /**
   * Conditionally compresses the oldest messages into the running summary.
   * No-op if message count is ≤ MESSAGE_THRESHOLD.
   * All failures are caught and logged — this must never throw to the caller.
   *
   * @param sessionId - Session UUID to operate on.
   * @param currentSummary - Existing running_summary from the session row (may be null).
   */
  async execute(sessionId: string, currentSummary: string | null): Promise<void> {
    const trace = this.langfuseService.createTrace({
      name: 'summarize-memory',
      sessionId,
      input: sessionId,
    });

    try {
      // Count only user+assistant messages — system ghost messages are excluded.
      const messageCount = await this.prisma.message.count({
        where: { sessionId, role: { in: ['user', 'assistant'] } },
      });

      if (messageCount <= MESSAGE_THRESHOLD) {
        this.langfuseService.finalizeTrace(trace, 'skipped', { messageCount, threshold: MESSAGE_THRESHOLD });
        return;
      }

      // Fetch the oldest MESSAGES_TO_COMPRESS messages for compression.
      const oldMessages = await this.prisma.message.findMany({
        where: { sessionId, role: { in: ['user', 'assistant'] } },
        orderBy: { createdAt: 'asc' },
        take: MESSAGES_TO_COMPRESS,
        select: { id: true, role: true, content: true },
      });

      if (oldMessages.length === 0) return;

      const prompt = this.buildPrompt(currentSummary, oldMessages);

      const generation = this.langfuseService.createGeneration(trace, {
        name: 'summarize',
        model: this.routerModel,
        input: prompt,
        modelParameters: { temperature: 0, max_tokens: SUMMARY_MAX_TOKENS },
      });

      const start = Date.now();
      let newSummary: string;

      try {
        const response = await withLlmRetry(
          () =>
            this.openai.chat.completions.create({
              model: this.routerModel,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0,
              max_tokens: SUMMARY_MAX_TOKENS,
            }),
          this.logger,
          { operation: 'summarize-memory', sessionId },
        );

        newSummary = response.choices[0]?.message?.content?.trim() ?? '';

        if (!newSummary) {
          this.logger.warn({ event: 'summarize_empty_response', sessionId });
          this.langfuseService.finalizeGeneration(generation, {
            output: null,
            metadata: { latencyMs: Date.now() - start, error: 'empty_response' },
          });
          this.langfuseService.finalizeTrace(trace, 'failed', { reason: 'empty_llm_response' });
          return;
        }

        this.langfuseService.finalizeGeneration(generation, {
          output: newSummary,
          usage: {
            promptTokens: response.usage?.prompt_tokens,
            completionTokens: response.usage?.completion_tokens,
            totalTokens: response.usage?.total_tokens,
          },
          metadata: { latencyMs: Date.now() - start },
        });
      } catch (err) {
        this.logger.error({
          event: 'summarize_llm_failed',
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.langfuseService.finalizeTrace(trace, 'failed', { reason: 'llm_error' });
        return;
      }

      // Update summary and delete compressed messages atomically.
      const messageIds = oldMessages.map((m) => m.id);
      try {
        await this.prisma.$transaction([
          this.prisma.session.update({
            where: { id: sessionId },
            data: { runningSummary: newSummary },
          }),
          this.prisma.message.deleteMany({
            where: { id: { in: messageIds } },
          }),
        ]);
      } catch (err) {
        this.logger.error({
          event: 'summarize_db_transaction_failed',
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.langfuseService.finalizeTrace(trace, 'failed', { reason: 'db_transaction_error' });
        return;
      }

      this.logger.log({
        event: 'summarize_memory_complete',
        sessionId,
        messagesCompressed: oldMessages.length,
        messageCount,
      });
      this.langfuseService.finalizeTrace(trace, 'completed', {
        messagesCompressed: oldMessages.length,
        messageCount,
      });
    } catch (err) {
      // Outer safety net — postProcess must never fail because of summarization.
      this.logger.error({
        event: 'summarize_memory_unexpected_error',
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Builds the condensation prompt combining the existing summary and the messages to compress.
   */
  private buildPrompt(
    currentSummary: string | null,
    messages: Array<{ role: string; content: string }>,
  ): string {
    const priorSummarySection = currentSummary
      ? `Prior summary:\n${currentSummary}\n\n`
      : '';

    const messageLines = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n---\n');

    return (
      `You are a conversation memory compressor. Condense the following into a brief factual ` +
      `summary (under 300 words) that preserves key facts, context, and the conversation direction.\n\n` +
      `${priorSummarySection}` +
      `Messages to incorporate:\n${messageLines}\n\n` +
      `Return ONLY the updated summary text. No preamble.`
    );
  }
}
