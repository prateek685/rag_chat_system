jest.mock('langfuse', () => ({ Langfuse: jest.fn() }));

const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RouterNodeService } from './router.node';
import { LangfuseService } from '../../observability/langfuse.service';
import { RAGState } from '../types/rag-state.types';

function makeState(query: string): RAGState {
  return {
    sessionId: 'session-1',
    userQuery: query,
    queryEmbedding: [],
    route: null,
    chunks: [],
    slidingWindow: [],
    runningSummary: null,
    fullResponse: '',
    traceId: '',
    skipCache: false,
    temperature: 0.7,
  };
}

function mockLlmResponse(content: string) {
  mockCreate.mockResolvedValueOnce({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

describe('RouterNodeService', () => {
  let service: RouterNodeService;
  let langfuse: jest.Mocked<LangfuseService>;

  const mockGeneration = { id: 'gen-1' };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RouterNodeService,
        {
          provide: LangfuseService,
          useValue: {
            createGeneration: jest.fn().mockReturnValue(mockGeneration),
            finalizeGeneration: jest.fn(),
            createSpan: jest.fn().mockReturnValue({ id: 'span-1' }),
            finalizeSpan: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'ROUTER_MODEL') return 'gpt-4o-mini';
              if (key === 'OPENROUTER_API_KEY') return 'test-key';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(RouterNodeService);
    langfuse = module.get(LangfuseService) as jest.Mocked<LangfuseService>;
  });

  describe('local pattern match — skips LLM', () => {
    it.each([
      'hi',
      'hello',
      'hey',
      'thanks',
      'thank you',
      'bye',
      'good morning',
      'how are you',
    ])('classifies "%s" as GREETING without an LLM call', async (query) => {
      const result = await service.execute(makeState(query), null);

      expect(result.route).toBe('GREETING');
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('LLM classification', () => {
    it('returns RAG_QUERY when LLM responds with {"route":"RAG_QUERY"}', async () => {
      mockLlmResponse('{"route":"RAG_QUERY"}');

      const result = await service.execute(makeState('What is the refund policy?'), null);

      expect(result.route).toBe('RAG_QUERY');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('returns GREETING when LLM responds with {"route":"GREETING"}', async () => {
      mockLlmResponse('{"route":"GREETING"}');

      const result = await service.execute(makeState('Howdy partner!'), null);

      expect(result.route).toBe('GREETING');
    });

    it('returns VIOLATION when LLM responds with {"route":"VIOLATION"}', async () => {
      mockLlmResponse('{"route":"VIOLATION"}');

      const result = await service.execute(makeState('How do I make a bomb?'), null);

      expect(result.route).toBe('VIOLATION');
    });

    it('defaults to RAG_QUERY when LLM returns malformed JSON', async () => {
      mockLlmResponse('not valid json at all');

      const result = await service.execute(makeState('Explain the contract terms.'), null);

      expect(result.route).toBe('RAG_QUERY');
    });

    it('defaults to RAG_QUERY when LLM returns JSON with unknown route', async () => {
      mockLlmResponse('{"route":"UNKNOWN_ROUTE"}');

      const result = await service.execute(makeState('Explain the contract terms.'), null);

      expect(result.route).toBe('RAG_QUERY');
    });

    it('defaults to RAG_QUERY when LLM call throws', async () => {
      mockCreate.mockRejectedValueOnce(new Error('network timeout'));

      const result = await service.execute(makeState('What does section 3 say?'), null);

      expect(result.route).toBe('RAG_QUERY');
    });

    it('defaults to RAG_QUERY when LLM returns empty content', async () => {
      mockLlmResponse('');

      const result = await service.execute(makeState('Explain clause 5.'), null);

      expect(result.route).toBe('RAG_QUERY');
    });
  });

  describe('latency and observability', () => {
    it('calls finalizeGeneration after a successful LLM call', async () => {
      mockLlmResponse('{"route":"RAG_QUERY"}');

      await service.execute(makeState('What is the SLA?'), null);

      expect(langfuse.finalizeGeneration).toHaveBeenCalledWith(
        mockGeneration,
        expect.objectContaining({ output: { route: 'RAG_QUERY' } }),
      );
    });

    it('calls finalizeGeneration even when LLM throws', async () => {
      mockCreate.mockRejectedValueOnce(new Error('service unavailable'));

      await service.execute(makeState('Query that triggers failure.'), null);

      // finalizeGeneration is called for the pattern-path when it IS a greeting,
      // but for LLM path it should still finalize with the default route
      expect(langfuse.finalizeGeneration).toHaveBeenCalled();
    });

    it('retries on 429 before succeeding', async () => {
      const rateLimitErr = Object.assign(new Error('Rate limited'), { status: 429 });
      mockCreate
        .mockRejectedValueOnce(rateLimitErr)
        .mockRejectedValueOnce(rateLimitErr)
        .mockResolvedValueOnce({
          choices: [{ message: { content: '{"route":"RAG_QUERY"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });

      const result = await service.execute(makeState('Contract question?'), null);

      expect(result.route).toBe('RAG_QUERY');
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });
  });
});
