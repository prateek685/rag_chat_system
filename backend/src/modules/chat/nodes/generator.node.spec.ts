jest.mock('langfuse', () => ({ Langfuse: jest.fn() }));

// Async generator helper — simulates an OpenAI streaming response.
async function* makeStream(
  tokens: string[],
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
) {
  for (const token of tokens) {
    yield { choices: [{ delta: { content: token } }], usage: null };
  }
  // Final chunk carries usage when stream_options.include_usage = true
  if (usage) {
    yield { choices: [{ delta: { content: '' } }], usage };
  }
}

const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { GeneratorNodeService } from './generator.node';
import { LangfuseService } from '../../observability/langfuse.service';
import { PromptBuilderService } from '../prompt-builder.service';
import { RAGState } from '../types/rag-state.types';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';

function makeState(overrides: Partial<RAGState> = {}): RAGState {
  return {
    sessionId: 'session-1',
    userQuery: 'What is RAG?',
    queryEmbedding: [],
    route: 'RAG_QUERY',
    chunks: [],
    slidingWindow: [],
    runningSummary: null,
    fullResponse: '',
    traceId: 'trace-1',
    skipCache: false,
    temperature: 0.7,
    ...overrides,
  };
}

describe('GeneratorNodeService', () => {
  let service: GeneratorNodeService;
  let langfuse: jest.Mocked<LangfuseService>;
  let promptBuilder: jest.Mocked<PromptBuilderService>;

  const mockGeneration = { id: 'gen-1' };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeneratorNodeService,
        {
          provide: PromptBuilderService,
          useValue: {
            buildMessages: jest.fn().mockReturnValue([
              new HumanMessage('What is RAG?'),
              new SystemMessage('You are a helpful assistant.'),
            ]),
          },
        },
        {
          provide: LangfuseService,
          useValue: {
            createGeneration: jest.fn().mockReturnValue(mockGeneration),
            finalizeGeneration: jest.fn(),
            scoreTrace: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'GENERATOR_MODEL') return 'gpt-4o';
              if (key === 'OPENROUTER_API_KEY') return 'test-key';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(GeneratorNodeService);
    langfuse = module.get(LangfuseService) as jest.Mocked<LangfuseService>;
    promptBuilder = module.get(PromptBuilderService) as jest.Mocked<PromptBuilderService>;
  });

  describe('execute() — happy path', () => {
    it('concatenates streamed tokens into fullResponse', async () => {
      mockCreate.mockResolvedValueOnce(
        makeStream(['Hello', ' world', '!'], {
          prompt_tokens: 20,
          completion_tokens: 5,
          total_tokens: 25,
        }),
      );

      const tokens: string[] = [];
      const result = await service.execute(makeState(), (t) => tokens.push(t), null);

      expect(result.fullResponse).toBe('Hello world!');
      expect(tokens).toEqual(['Hello', ' world', '!']);
    });

    it('calls writeToken for every non-empty token', async () => {
      mockCreate.mockResolvedValueOnce(makeStream(['A', 'B', 'C']));

      const written: string[] = [];
      await service.execute(makeState(), (t) => written.push(t), null);

      expect(written).toEqual(['A', 'B', 'C']);
    });

    it('returns empty fullResponse when stream yields no tokens', async () => {
      mockCreate.mockResolvedValueOnce(makeStream([]));

      const result = await service.execute(makeState(), jest.fn(), null);

      expect(result.fullResponse).toBe('');
    });

    it('calls buildMessages with the provided state', async () => {
      mockCreate.mockResolvedValueOnce(makeStream(['ok']));
      const state = makeState({ route: 'GREETING' });

      await service.execute(state, jest.fn(), null);

      expect(promptBuilder.buildMessages).toHaveBeenCalledWith(state);
    });

    it('finalizes the Langfuse generation with token usage', async () => {
      mockCreate.mockResolvedValueOnce(
        makeStream(['response'], { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }),
      );

      await service.execute(makeState(), jest.fn(), null);

      expect(langfuse.finalizeGeneration).toHaveBeenCalledWith(
        mockGeneration,
        expect.objectContaining({
          output: 'response',
          usage: expect.objectContaining({ promptTokens: 10, completionTokens: 3 }),
        }),
      );
    });
  });

  describe('execute() — message role mapping', () => {
    it('maps HumanMessage to user role in the OpenAI payload', async () => {
      mockCreate.mockResolvedValueOnce(makeStream(['ok']));

      await service.execute(makeState(), jest.fn(), null);

      const callArg = mockCreate.mock.calls[0][0] as { messages: Array<{ role: string }> };
      const roles = callArg.messages.map((m) => m.role);
      expect(roles).toContain('user');
      expect(roles).toContain('system');
    });
  });

  describe('execute() — error handling', () => {
    it('rethrows when the stream creation fails', async () => {
      // Status 400 is non-retryable — withLlmRetry throws on the first attempt.
      mockCreate.mockRejectedValueOnce(Object.assign(new Error('upstream down'), { status: 400 }));

      await expect(service.execute(makeState(), jest.fn(), null)).rejects.toThrow('upstream down');
    });

    it('retries on 429 before succeeding', async () => {
      const rateLimitErr = Object.assign(new Error('Rate limited'), { status: 429 });
      mockCreate
        .mockRejectedValueOnce(rateLimitErr)
        .mockRejectedValueOnce(rateLimitErr)
        .mockResolvedValueOnce(makeStream(['success']));

      const result = await service.execute(makeState(), jest.fn(), null);

      expect(result.fullResponse).toBe('success');
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });
  });

  describe('execute() — faithfulness scoring', () => {
    it('calls scoreTrace with keyword-overlap score when route is RAG_QUERY and chunks exist', async () => {
      mockCreate.mockResolvedValueOnce(makeStream(['transformer attention mechanism']));
      const chunk = {
        id: 'c1', content: 'transformer attention mechanism sequence processing',
        documentId: 'd1', filename: 'paper.pdf', rrfScore: 0.05, cosineSimilarity: 0.8, metadata: null,
      };

      await service.execute(
        makeState({ route: 'RAG_QUERY', chunks: [chunk], traceId: 'trace-abc' }),
        jest.fn(),
        null,
      );

      expect(langfuse.scoreTrace).toHaveBeenCalledWith(
        'trace-abc',
        'keyword-overlap',
        expect.any(Number),
      );
    });

    it('does NOT call scoreTrace for GREETING route', async () => {
      mockCreate.mockResolvedValueOnce(makeStream(['Hello!']));

      await service.execute(makeState({ route: 'GREETING', chunks: [] }), jest.fn(), null);

      expect(langfuse.scoreTrace).not.toHaveBeenCalled();
    });

    it('does NOT call scoreTrace when chunks array is empty', async () => {
      mockCreate.mockResolvedValueOnce(makeStream(['some response']));

      await service.execute(makeState({ route: 'RAG_QUERY', chunks: [] }), jest.fn(), null);

      expect(langfuse.scoreTrace).not.toHaveBeenCalled();
    });

    it('scoreTrace receives a value between 0 and 1', async () => {
      mockCreate.mockResolvedValueOnce(makeStream(['transformer training costs']));
      const chunk = {
        id: 'c1', content: 'transformer attention layers training costs flops',
        documentId: 'd1', filename: 'paper.pdf', rrfScore: 0.05, cosineSimilarity: 0.8, metadata: null,
      };

      await service.execute(
        makeState({ route: 'RAG_QUERY', chunks: [chunk] }),
        jest.fn(),
        null,
      );

      const score = (langfuse.scoreTrace as jest.Mock).mock.calls[0][2] as number;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });
});
