import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../../config/env.config';
import { LangfuseTraceClient } from 'langfuse';
import OpenAI from 'openai';
import { withLlmRetry } from '../../../common/utils/llm-retry.util';
import { LangfuseService } from '../../observability/langfuse.service';
import { ChatRoute, RAGState } from '../types/rag-state.types';

/** P95 latency budget for the routing classification call. */
const ROUTER_LATENCY_BUDGET_MS = 300;

/**
 * Regex for local pre-classification — avoids an LLM round-trip for obvious greetings.
 * Matched messages skip the OpenRouter call entirely (faster + resilient to model downtime).
 */
const GREETING_PATTERN =
  /^(hi+|hello+|hey+|howdy|greetings?|good\s+(morning|afternoon|evening|day)|thanks?|thank\s+you|bye|goodbye|how\s+are\s+you|what'?s?\s+up|sup|yo|cheers|hiya)[\s!?.]*$/i;

const ROUTER_SYSTEM_PROMPT = `Classify the user message into exactly one category:
- RAG_QUERY: A factual question or request requiring document lookup.
- GREETING: A casual greeting, introduction, social pleasantry ("hi", "hello", "thanks", "how are you").
- VIOLATION: Harmful, offensive, or clearly malicious content.

Respond ONLY with valid JSON containing a single key "route".
Examples: {"route":"RAG_QUERY"} | {"route":"GREETING"} | {"route":"VIOLATION"}
Do not include any text outside the JSON object.`;

/**
 * RouterNodeService classifies the user's intent before the retrieval and generation steps.
 * Defaults to RAG_QUERY on any network or parse error to avoid blocking legitimate users.
 */
@Injectable()
export class RouterNodeService {
  private readonly logger = new Logger(RouterNodeService.name);
  private readonly openai: OpenAI;
  private readonly routerModel: string;

  constructor(
    configService: ConfigService<EnvConfig, true>,
    private readonly langfuseService: LangfuseService,
  ) {
    this.routerModel = configService.get('ROUTER_MODEL', { infer: true });
    this.openai = new OpenAI({
      apiKey: configService.get('OPENROUTER_API_KEY', { infer: true }),
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }

  /**
   * LangGraph node function — classifies user intent into one of three routes.
   *
   * @param state - Current RAG state.
   * @param trace - Langfuse trace client for observability (may be null).
   * @returns Partial state update: `{ route }`.
   */
  async execute(
    state: RAGState,
    trace: LangfuseTraceClient | null,
  ): Promise<Partial<RAGState>> {
    const start = Date.now();
    let route: ChatRoute = 'RAG_QUERY'; // Safe default — never block users on router failure

    // Fast local pre-check: skip the LLM call for obvious greetings.
    if (GREETING_PATTERN.test(state.userQuery.trim())) {
      this.langfuseService.finalizeGeneration(
        this.langfuseService.createGeneration(trace, {
          name: 'router',
          model: 'local-pattern',
          input: state.userQuery,
        }),
        { output: { route: 'GREETING' }, metadata: { source: 'local-pattern', latencyMs: 0 } },
      );
      this.logger.log({
        event: 'router_classified',
        route: 'GREETING',
        sessionId: state.sessionId,
        latencyMs: 0,
        source: 'pattern',
      });
      return { route: 'GREETING' };
    }

    const generation = this.langfuseService.createGeneration(trace, {
      name: 'router',
      model: this.routerModel,
      input: `${ROUTER_SYSTEM_PROMPT}\n\nUser Query:\n${state.userQuery}`,
      modelParameters: { temperature: 0, max_tokens: 30 },
    });

    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let totalTokens: number | undefined;

    try {
      const response = await withLlmRetry(
        () =>
          this.openai.chat.completions.create({
            model: this.routerModel,
            messages: [
              {
                role: 'user',
                content: `${ROUTER_SYSTEM_PROMPT}\n\nUser Query:\n${state.userQuery}`,
              },
            ],
            temperature: 0,
            max_tokens: 30,
          }),
        this.logger,
        { operation: 'router', sessionId: state.sessionId },
      );

      promptTokens = response.usage?.prompt_tokens;
      completionTokens = response.usage?.completion_tokens;
      totalTokens = response.usage?.total_tokens;

      const content = response.choices[0]?.message?.content?.trim() ?? '';

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        this.logger.warn({
          event: 'router_json_parse_failed',
          content,
          sessionId: state.sessionId,
          defaulting: 'RAG_QUERY',
        });
        parsed = null;
      }

      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'route' in parsed &&
        (parsed as Record<string, unknown>)['route'] === 'GREETING'
      ) {
        route = 'GREETING';
      } else if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'route' in parsed &&
        (parsed as Record<string, unknown>)['route'] === 'VIOLATION'
      ) {
        route = 'VIOLATION';
      } else if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'route' in parsed &&
        (parsed as Record<string, unknown>)['route'] === 'RAG_QUERY'
      ) {
        route = 'RAG_QUERY';
      } else {
        this.logger.warn({
          event: 'router_unknown_route',
          content,
          sessionId: state.sessionId,
          defaulting: 'RAG_QUERY',
        });
      }
    } catch (err) {
      this.logger.error({
        event: 'router_api_failed',
        error: err instanceof Error ? err.message : String(err),
        sessionId: state.sessionId,
        defaulting: 'RAG_QUERY',
      });
    }

    const latencyMs = Date.now() - start;
    if (latencyMs > ROUTER_LATENCY_BUDGET_MS) {
      this.logger.warn({
        event: 'latency_budget_exceeded',
        operation: 'router',
        latencyMs,
        budget: ROUTER_LATENCY_BUDGET_MS,
        model: this.routerModel,
      });
    }

    this.langfuseService.finalizeGeneration(generation, {
      output: { route },
      usage: { promptTokens, completionTokens, totalTokens },
      metadata: { model: this.routerModel, latencyMs },
    });
    this.logger.log({ event: 'router_classified', route, sessionId: state.sessionId, latencyMs });

    return { route };
  }
}
