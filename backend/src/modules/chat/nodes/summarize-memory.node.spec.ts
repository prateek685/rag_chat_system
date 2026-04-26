import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { SummarizeMemoryNodeService } from './summarize-memory.node';
import { LangfuseService } from '../../observability/langfuse.service';
import { PrismaService } from '../../prisma/prisma.service';

jest.mock('langfuse', () => ({ Langfuse: jest.fn() }));

// Shared mock for OpenAI chat completions
const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

const mockMessages = [
  { id: 'msg-1', role: 'user', content: 'What is the policy?' },
  { id: 'msg-2', role: 'assistant', content: 'The policy states X.' },
  { id: 'msg-3', role: 'user', content: 'What about Y?' },
  { id: 'msg-4', role: 'assistant', content: 'Y is covered in section 3.' },
  { id: 'msg-5', role: 'user', content: 'And Z?' },
  { id: 'msg-6', role: 'assistant', content: 'Z is not included.' },
  { id: 'msg-7', role: 'user', content: 'Thanks.' },
  { id: 'msg-8', role: 'assistant', content: 'You are welcome.' },
];

describe('SummarizeMemoryNodeService', () => {
  let service: SummarizeMemoryNodeService;
  let prisma: jest.Mocked<Pick<PrismaService, 'message' | 'session' | '$transaction'>>;
  let langfuse: jest.Mocked<LangfuseService>;

  const mockTrace = { id: 'trace-1' };
  const mockGeneration = { id: 'gen-1' };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SummarizeMemoryNodeService,
        {
          provide: PrismaService,
          useValue: {
            message: {
              count: jest.fn(),
              findMany: jest.fn(),
              deleteMany: jest.fn(),
            },
            session: {
              update: jest.fn(),
            },
            $transaction: jest.fn(),
          },
        },
        {
          provide: LangfuseService,
          useValue: {
            createTrace: jest.fn().mockReturnValue(mockTrace),
            createGeneration: jest.fn().mockReturnValue(mockGeneration),
            finalizeGeneration: jest.fn(),
            finalizeTrace: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'ROUTER_MODEL') return 'google/gemma-3-4b-it:free';
              if (key === 'OPENROUTER_API_KEY') return 'test-key';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(SummarizeMemoryNodeService);
    prisma = module.get(PrismaService) as unknown as typeof prisma;
    langfuse = module.get(LangfuseService) as jest.Mocked<LangfuseService>;
  });

  describe('execute() — below threshold', () => {
    it('is a no-op when message count is at or below 10', async () => {
      (prisma.message.count as jest.Mock).mockResolvedValue(10);

      await service.execute('session-1', null);

      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('execute() — above threshold', () => {
    beforeEach(() => {
      (prisma.message.count as jest.Mock).mockResolvedValue(12);
      (prisma.message.findMany as jest.Mock).mockResolvedValue(mockMessages);
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'Condensed summary.' } }],
        usage: { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260 },
      });
      (prisma.$transaction as jest.Mock).mockResolvedValue([undefined, undefined]);
    });

    it('calls findMany with oldest 8 user+assistant messages', async () => {
      await service.execute('session-1', null);

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { sessionId: 'session-1', role: { in: ['user', 'assistant'] } },
          orderBy: { createdAt: 'asc' },
          take: 8,
        }),
      );
    });

    it('calls LLM and updates DB in a single transaction', async () => {
      await service.execute('session-1', null);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('includes prior summary in the prompt when provided', async () => {
      await service.execute('session-1', 'Existing summary text.');

      const callArgs = mockCreate.mock.calls[0][0] as { messages: Array<{ content: string }> };
      expect(callArgs.messages[0].content).toContain('Prior summary:\nExisting summary text.');
    });

    it('finalizes Langfuse trace with completed status', async () => {
      await service.execute('session-1', null);

      expect(langfuse.finalizeTrace).toHaveBeenCalledWith(
        mockTrace,
        'completed',
        expect.objectContaining({ messagesCompressed: 8 }),
      );
    });
  });

  describe('execute() — error handling', () => {
    beforeEach(() => {
      (prisma.message.count as jest.Mock).mockResolvedValue(12);
      (prisma.message.findMany as jest.Mock).mockResolvedValue(mockMessages);
    });

    it('does not throw when LLM returns empty response', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '' } }],
        usage: {},
      });

      await expect(service.execute('session-1', null)).resolves.toBeUndefined();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not throw when LLM call rejects', async () => {
      mockCreate.mockRejectedValue(new Error('LLM unavailable'));

      await expect(service.execute('session-1', null)).resolves.toBeUndefined();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not throw when $transaction fails', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'Summary.' } }],
        usage: {},
      });
      (prisma.$transaction as jest.Mock).mockRejectedValue(new Error('DB error'));

      await expect(service.execute('session-1', null)).resolves.toBeUndefined();
    });

    it('does not throw when count() fails', async () => {
      (prisma.message.count as jest.Mock).mockRejectedValue(new Error('DB down'));

      await expect(service.execute('session-1', null)).resolves.toBeUndefined();
    });

    it('retries on 429 from LLM before eventually failing', async () => {
      // First two attempts are 429, third succeeds
      const rateLimitErr = Object.assign(new Error('Rate limited'), { status: 429 });
      mockCreate
        .mockRejectedValueOnce(rateLimitErr)
        .mockRejectedValueOnce(rateLimitErr)
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'Retried summary.' } }],
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
        });

      (prisma.$transaction as jest.Mock).mockResolvedValue([undefined, undefined]);

      await service.execute('session-1', null);

      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});
