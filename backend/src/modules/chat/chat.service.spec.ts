// jest.mock must appear before imports. Factory must be self-contained (no outer const refs).
jest.mock('langfuse', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    trace: jest.fn().mockReturnValue({ id: 'trace-123', span: jest.fn(), update: jest.fn() }),
    score: jest.fn().mockResolvedValue(undefined),
    flushAsync: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    embeddings: {
      create: jest.fn().mockResolvedValue({
        data: [{ embedding: new Array(2048).fill(0.1) }],
      }),
    },
  })),
}));

import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { Response } from 'express';
import { LangfuseService } from '../observability/langfuse.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ChatService } from './chat.service';
import { FeedbackDto } from './dto/feedback.dto';
import { RagGraphService } from './graph/rag-graph.service';
import { RetrievalNodeService } from './nodes/retrieval.node';
import { SummarizeMemoryNodeService } from './nodes/summarize-memory.node';
import { PromptBuilderService } from './prompt-builder.service';
import { SemanticCacheService } from './semantic-cache.service';
import { NO_CONTEXT_RESPONSE, RAG_SYSTEM_PROMPT, VIOLATION_RESPONSE } from './prompts/system-prompt';
import { RAGState, RetrievedChunk, SlidingWindowMessage } from './types/rag-state.types';

const makeMockRes = (): jest.Mocked<Response> =>
  ({
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  }) as unknown as jest.Mocked<Response>;

describe('ChatService', () => {
  let service: ChatService;
  let prisma: jest.Mocked<PrismaService>;
  let redis: Record<string, jest.Mock>;
  let ragGraph: jest.Mocked<RagGraphService>;
  let langfuse: jest.Mocked<LangfuseService>;
  let retrievalNode: { embedQuery: jest.Mock };
  let semanticCache: jest.Mocked<SemanticCacheService>;
  let summarizeMemoryNode: { execute: jest.Mock };

  const mockChunk: RetrievedChunk = {
    id: 'chunk-1',
    content: 'The capital of France is Paris.',
    documentId: 'doc-1',
    filename: 'geo.txt',
    rrfScore: 0.05,
    cosineSimilarity: 0.82,
    metadata: { source: 'geo.txt' },
  };

  const makeDefaultFinalState = (): RAGState => ({
    sessionId: 'session-1',
    userQuery: 'What is Paris?',
    queryEmbedding: [],
    route: 'RAG_QUERY',
    chunks: [mockChunk],
    slidingWindow: [],
    runningSummary: null,
    fullResponse: 'Paris is the capital of France.',
    traceId: 'trace-1',
    skipCache: false,
    temperature: 0.7,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      message: {
        create: jest.fn().mockResolvedValue({ id: 'msg-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        delete: jest.fn().mockResolvedValue({}),
      },
      session: {
        findUnique: jest.fn().mockResolvedValue({ runningSummary: null }),
      },
    } as unknown as jest.Mocked<PrismaService>;

    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      setex: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(undefined),
      scan: jest.fn().mockResolvedValue([]),
      delPattern: jest.fn().mockResolvedValue(0),
    };

    ragGraph = {
      execute: jest.fn().mockResolvedValue(makeDefaultFinalState()),
    } as unknown as jest.Mocked<RagGraphService>;

    langfuse = {
      createTrace: jest.fn().mockReturnValue({ id: 'trace-1', update: jest.fn(), span: jest.fn() }),
      createSpan: jest.fn().mockReturnValue({ end: jest.fn() }),
      finalizeSpan: jest.fn(),
      finalizeTrace: jest.fn(),
      createGeneration: jest.fn().mockReturnValue({ end: jest.fn() }),
      finalizeGeneration: jest.fn(),
      recordTraceError: jest.fn(),
      score: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<LangfuseService>;

    retrievalNode = {
      embedQuery: jest.fn().mockResolvedValue([]),
    };

    semanticCache = {
      lookup: jest.fn().mockResolvedValue(null),
      store: jest.fn().mockResolvedValue(undefined),
      invalidateSession: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SemanticCacheService>;

    summarizeMemoryNode = {
      execute: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        PromptBuilderService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: RagGraphService, useValue: ragGraph },
        { provide: LangfuseService, useValue: langfuse },
        { provide: RetrievalNodeService, useValue: retrievalNode },
        { provide: SemanticCacheService, useValue: semanticCache },
        { provide: SummarizeMemoryNodeService, useValue: summarizeMemoryNode },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const map: Record<string, string> = {
                GENERATOR_MODEL: 'test-gen',
                ROUTER_MODEL: 'test-router',
              };
              return map[key] ?? 'default';
            },
          },
        },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  // ---------------------------------------------------------------------------
  // PromptBuilderService — Safety Caboose order
  // ---------------------------------------------------------------------------
  describe('PromptBuilderService.buildMessages — Safety Caboose order', () => {
    let promptBuilder: PromptBuilderService;

    beforeEach(() => {
      promptBuilder = new PromptBuilderService();
    });

    it('places SystemMessage last, user question second-to-last, context third-to-last', () => {
      const state: RAGState = {
        sessionId: 'session-1',
        userQuery: 'What is the capital of France?',
        queryEmbedding: [],
        route: 'RAG_QUERY',
        chunks: [mockChunk],
        slidingWindow: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
          // Current query is always the last entry: persisted to DB before loadSessionContext runs.
          { role: 'user', content: 'What is the capital of France?' },
        ],
        runningSummary: null,
        fullResponse: '',
        traceId: 'trace-1',
        skipCache: false,
        temperature: 0.7,
      };

      const messages = promptBuilder.buildMessages(state);

      // Last message = SystemMessage (Safety Caboose)
      expect(messages[messages.length - 1]).toBeInstanceOf(SystemMessage);

      // Second-to-last = current user question
      const secondToLast = messages[messages.length - 2];
      expect(secondToLast).toBeInstanceOf(HumanMessage);
      expect(secondToLast.content).toBe('What is the capital of France?');

      // Third-to-last = retrieved context
      const contextMsg = messages[messages.length - 3];
      expect(contextMsg).toBeInstanceOf(HumanMessage);
      expect(String(contextMsg.content)).toContain('Context from uploaded documents');
      expect(String(contextMsg.content)).toContain('The capital of France is Paris.');

      // Sliding window at the start
      expect(messages[0]).toBeInstanceOf(HumanMessage);
      expect(messages[0].content).toBe('Hello');
      expect(messages[1]).toBeInstanceOf(AIMessage);
      expect(messages[1].content).toBe('Hi there!');
    });

    it('excludes system-role ghost messages from sliding window', () => {
      const state: RAGState = {
        sessionId: 'session-1',
        userQuery: 'Follow-up?',
        queryEmbedding: [],
        route: 'RAG_QUERY',
        chunks: [],
        slidingWindow: [
          { role: 'user', content: 'First question' },
          { role: 'system', content: '[SYSTEM DIRECTIVE: Document deleted]' },
          { role: 'assistant', content: 'First answer' },
          // Current query is always the last entry: persisted to DB before loadSessionContext runs.
          { role: 'user', content: 'Follow-up?' },
        ],
        runningSummary: null,
        fullResponse: '',
        traceId: 'trace-1',
        skipCache: false,
        temperature: 0.7,
      };

      const messages = promptBuilder.buildMessages(state);
      const contents = messages.map((m) => String(m.content));
      expect(contents).not.toContain('[SYSTEM DIRECTIVE: Document deleted]');
    });

    it('system prompt contains PDF table formatting rules for superscript exponents', () => {
      // These rules were added after a live bug where the LLM read "2.3·10\n19" as 2.3×10²⁰
      // because pdf-parse puts superscript exponents on their own line.
      expect(RAG_SYSTEM_PROMPT).toContain('Superscript exponents are extracted onto their own line');
      expect(RAG_SYSTEM_PROMPT).toContain('·10');
    });

    it('system prompt instructs the LLM to count columns before reading table data rows', () => {
      expect(RAG_SYSTEM_PROMPT).toContain('counting columns from the header row');
    });
  });

  // ---------------------------------------------------------------------------
  // VIOLATION path
  // ---------------------------------------------------------------------------
  describe('handleChat — VIOLATION path', () => {
    it('writes VIOLATION_RESPONSE to the SSE stream', async () => {
      ragGraph.execute.mockResolvedValueOnce({
        ...makeDefaultFinalState(),
        route: 'VIOLATION',
        fullResponse: '',
      } as RAGState);

      const res = makeMockRes();
      await service.handleChat({ message: 'bad request' }, 'session-1', res);

      const written = (res.write as jest.Mock).mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join('');
      expect(written).toContain(VIOLATION_RESPONSE);
      expect(res.end).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // NO_CONTEXT guardrail
  // ---------------------------------------------------------------------------
  describe('handleChat — NO_CONTEXT guardrail', () => {
    it('writes NO_CONTEXT_RESPONSE to the SSE stream', async () => {
      ragGraph.execute.mockResolvedValueOnce({
        ...makeDefaultFinalState(),
        route: 'NO_CONTEXT',
        fullResponse: '',
      } as RAGState);

      const res = makeMockRes();
      await service.handleChat({ message: 'what is dark matter?' }, 'session-1', res);

      const written = (res.write as jest.Mock).mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join('');
      expect(written).toContain(NO_CONTEXT_RESPONSE);
      expect(res.end).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Sliding window — chronological order
  // ---------------------------------------------------------------------------
  describe('handleChat — sliding window chronological order', () => {
    it('reverses DB desc-order to chronological order before passing to graph', async () => {
      // Simulate DB returning newest-first (ORDER BY created_at DESC)
      const dbMessages = [
        { role: 'assistant', content: 'Answer 3' },
        { role: 'user', content: 'Question 3' },
        { role: 'assistant', content: 'Answer 2' },
        { role: 'user', content: 'Question 2' },
        { role: 'assistant', content: 'Answer 1' },
        { role: 'user', content: 'Question 1' },
      ];
      (prisma.message.findMany as jest.Mock).mockResolvedValueOnce(dbMessages);

      const res = makeMockRes();
      await service.handleChat({ message: 'test' }, 'session-1', res);

      const callArgs = ragGraph.execute.mock.calls[0][0] as Partial<RAGState>;
      const window = callArgs.slidingWindow as SlidingWindowMessage[];

      expect(window[0].content).toBe('Question 1');
      expect(window[1].content).toBe('Answer 1');
      expect(window[2].content).toBe('Question 2');
      expect(window[5].content).toBe('Answer 3');
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------
  describe('checkRateLimit', () => {
    it('throws 429 HttpException when message count exceeds 10', async () => {
      redis.incr.mockResolvedValueOnce(11);

      const res = makeMockRes();
      await expect(service.handleChat({ message: 'test' }, 'session-1', res)).rejects.toThrow(
        expect.objectContaining({ status: HttpStatus.TOO_MANY_REQUESTS }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Semantic cache hit
  // ---------------------------------------------------------------------------
  describe('handleChat — semantic cache hit', () => {
    it('streams cached response and promotes to exact cache without running the graph', async () => {
      const cachedResponse = 'Cached semantic answer';
      retrievalNode.embedQuery.mockResolvedValueOnce([0.1, 0.2, 0.3]);
      semanticCache.lookup.mockResolvedValueOnce(cachedResponse);

      const res = makeMockRes();
      await service.handleChat({ message: 'What is Paris?' }, 'session-1', res);

      // Flush setImmediate (exact cache promotion)
      await new Promise<void>((resolve) => setImmediate(resolve));

      const written = (res.write as jest.Mock).mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join('');
      expect(written).toContain(cachedResponse);
      expect(written).toContain('[DONE]');
      expect(ragGraph.execute).not.toHaveBeenCalled();
      // Exact cache promoted from semantic hit
      expect(redis.setex).toHaveBeenCalledWith(
        expect.stringContaining('chat:cache:'),
        expect.any(Number),
        cachedResponse,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // postProcess — semantic cache write
  // ---------------------------------------------------------------------------
  describe('handleChat — postProcess semantic cache', () => {
    it('stores response in semantic cache for RAG_QUERY route when embedding is non-empty', async () => {
      retrievalNode.embedQuery.mockResolvedValueOnce([0.1, 0.2, 0.3]);

      const res = makeMockRes();
      await service.handleChat({ message: 'test' }, 'session-1', res);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(semanticCache.store).toHaveBeenCalledWith(
        'session-1',
        [0.1, 0.2, 0.3],
        expect.any(String),
      );
    });

    it('does NOT store response in semantic cache for VIOLATION route', async () => {
      retrievalNode.embedQuery.mockResolvedValueOnce([0.1, 0.2, 0.3]);
      ragGraph.execute.mockResolvedValueOnce({
        ...makeDefaultFinalState(),
        route: 'VIOLATION',
        fullResponse: '',
      } as RAGState);

      const res = makeMockRes();
      await service.handleChat({ message: 'bad request' }, 'session-1', res);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(semanticCache.store).not.toHaveBeenCalled();
    });

    it('does NOT store response in semantic cache for NO_CONTEXT route', async () => {
      retrievalNode.embedQuery.mockResolvedValueOnce([0.1, 0.2, 0.3]);
      ragGraph.execute.mockResolvedValueOnce({
        ...makeDefaultFinalState(),
        route: 'NO_CONTEXT',
        fullResponse: '',
      } as RAGState);

      const res = makeMockRes();
      await service.handleChat({ message: 'dark matter?' }, 'session-1', res);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(semanticCache.store).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // postProcess — summarize memory
  // ---------------------------------------------------------------------------
  describe('handleChat — postProcess summarize', () => {
    it('calls summarizeMemoryNode.execute with sessionId and runningSummary from context', async () => {
      const existingSummary = 'Prior conversation summary.';
      (prisma.session.findUnique as jest.Mock).mockResolvedValueOnce({
        runningSummary: existingSummary,
      });

      const res = makeMockRes();
      await service.handleChat({ message: 'test' }, 'session-1', res);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(summarizeMemoryNode.execute).toHaveBeenCalledWith('session-1', existingSummary);
    });
  });

  // ---------------------------------------------------------------------------
  // handleRetry — cache invalidation
  // ---------------------------------------------------------------------------
  describe('handleRetry — cache invalidation', () => {
    it('deletes exact cache key and wipes semantic cache before re-running', async () => {
      const lastAssistant = { id: 'asst-1', content: 'Paris is the capital.' };
      const lastUser = { id: 'user-1', content: 'What is Paris?' };
      (prisma.message.findFirst as jest.Mock)
        .mockResolvedValueOnce(lastAssistant)
        .mockResolvedValueOnce(lastUser);

      const res = makeMockRes();
      await service.handleRetry('session-1', res);

      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('chat:cache:'));
      expect(semanticCache.invalidateSession).toHaveBeenCalledWith('session-1');
    });
  });

  // ---------------------------------------------------------------------------
  // handleFeedback — cache invalidation on negative score
  // ---------------------------------------------------------------------------
  describe('handleFeedback', () => {
    it('forwards score and traceId to LangfuseService.score()', async () => {
      const dto: FeedbackDto = { traceId: 'trace-abc', score: 1 };
      await service.handleFeedback(dto);
      expect(langfuse.score).toHaveBeenCalledWith('trace-abc', 1);
    });

    it('invalidates exact and semantic cache on score = -1', async () => {
      const assistantMsg = { sessionId: 'session-1', createdAt: new Date('2024-01-02') };
      const userMsg = { content: 'What is Paris?' };
      (prisma.message.findFirst as jest.Mock)
        .mockResolvedValueOnce(assistantMsg)
        .mockResolvedValueOnce(userMsg);

      const dto: FeedbackDto = { traceId: 'trace-abc', score: -1 };
      await service.handleFeedback(dto);

      expect(langfuse.score).toHaveBeenCalledWith('trace-abc', -1);
      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('chat:cache:'));
      expect(semanticCache.invalidateSession).toHaveBeenCalledWith('session-1');
    });

    it('does NOT invalidate cache on score = +1', async () => {
      const dto: FeedbackDto = { traceId: 'trace-abc', score: 1 };
      await service.handleFeedback(dto);

      expect(redis.del).not.toHaveBeenCalled();
      expect(semanticCache.invalidateSession).not.toHaveBeenCalled();
    });

    it('still records Langfuse score when cache invalidation DB lookup fails', async () => {
      (prisma.message.findFirst as jest.Mock).mockRejectedValueOnce(new Error('DB down'));

      const dto: FeedbackDto = { traceId: 'trace-abc', score: -1 };
      await expect(service.handleFeedback(dto)).resolves.toBeUndefined();

      expect(langfuse.score).toHaveBeenCalledWith('trace-abc', -1);
    });

    it('does not throw when invalidateCacheForTrace finds no assistant message', async () => {
      (prisma.message.findFirst as jest.Mock).mockResolvedValueOnce(null);

      const dto: FeedbackDto = { traceId: 'unknown-trace', score: -1 };
      await expect(service.handleFeedback(dto)).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Error tracking — recordTraceError on graph failure
  // ---------------------------------------------------------------------------
  describe('handleChat — graph execution failure', () => {
    it('calls recordTraceError with llm_pipeline_failure when graph throws', async () => {
      ragGraph.execute.mockRejectedValueOnce(new Error('model timeout'));

      const res = makeMockRes();
      await service.handleChat({ message: 'test' }, 'session-1', res);

      expect(langfuse.recordTraceError).toHaveBeenCalledWith(
        expect.anything(),
        'llm_pipeline_failure',
        'model timeout',
      );
      expect(res.end).toHaveBeenCalled();
    });

    it('writes error SSE event and [DONE] when graph throws', async () => {
      ragGraph.execute.mockRejectedValueOnce(new Error('upstream error'));

      const res = makeMockRes();
      await service.handleChat({ message: 'test' }, 'session-1', res);

      const written = (res.write as jest.Mock).mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join('');
      expect(written).toContain('Something went wrong');
      expect(written).toContain('[DONE]');
    });
  });

  // ---------------------------------------------------------------------------
  // E2E latency — finalizeTrace receives metadata
  // ---------------------------------------------------------------------------
  describe('handleChat — postProcess finalizeTrace', () => {
    it('calls finalizeTrace with e2eLatencyMs and route metadata after successful graph run', async () => {
      const res = makeMockRes();
      await service.handleChat({ message: 'test' }, 'session-1', res);

      // Flush the setImmediate queue so postProcess completes before asserting.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(langfuse.finalizeTrace).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({ e2eLatencyMs: expect.any(Number), route: 'RAG_QUERY' }),
      );
    });
  });
});
