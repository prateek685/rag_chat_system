// jest.mock must appear before imports. Factory must be self-contained (no outer const refs).
jest.mock('langfuse', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    trace: jest.fn().mockReturnValue({ id: 'trace-123', update: jest.fn() }),
    flushAsync: jest.fn().mockResolvedValue(undefined),
  })),
}));

// jest.mock is hoisted before imports — factory must be self-contained.
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    embeddings: {
      create: jest.fn().mockResolvedValue({
        data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
      }),
    },
  })),
}));

import OpenAI from 'openai';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Document as LangChainDocument } from '@langchain/core/documents';
import { VectorService } from './vector.service';
import { PrismaService } from '../prisma/prisma.service';
import { LangfuseService } from '../observability/langfuse.service';

const DOCUMENT_ID = '22222222-2222-4222-a222-222222222222';
const SESSION_ID = '11111111-1111-4111-a111-111111111111';

function makeChunks(count: number): LangChainDocument[] {
  return Array.from({ length: count }, (_, i) => ({
    pageContent: `chunk ${i + 1} content`,
    metadata: { source: 'test.txt' },
  }));
}

/** Returns the mock embeddings.create function from the most recent OpenAI constructor call. */
const getMockCreate = (): jest.Mock =>
  (OpenAI as jest.MockedClass<typeof OpenAI>).mock.results[
    (OpenAI as jest.MockedClass<typeof OpenAI>).mock.results.length - 1
  ].value.embeddings.create as jest.Mock;

describe('VectorService', () => {
  let service: VectorService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VectorService,
        {
          provide: PrismaService,
          useValue: {
            $executeRaw: jest.fn().mockResolvedValue(2),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'EMBEDDING_MODEL') return 'nvidia/llama-nemotron-embed-vl-1b-v2:free';
              return 'sk-or-test-key';
            }),
          },
        },
        {
          provide: LangfuseService,
          useValue: {
            createGeneration: jest.fn().mockReturnValue({}),
            finalizeGeneration: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<VectorService>(VectorService);
    prisma = module.get(PrismaService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('embedAndStore', () => {
    it('returns early without any API or DB calls when chunks array is empty', async () => {
      await service.embedAndStore([], DOCUMENT_ID, SESSION_ID);

      expect(getMockCreate()).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('calls embeddings.create exactly once regardless of chunk count (batch, not per-chunk)', async () => {
      getMockCreate().mockResolvedValue({
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }, { embedding: [0.5, 0.6] }],
      });

      await service.embedAndStore(makeChunks(3), DOCUMENT_ID, SESSION_ID);

      expect(getMockCreate()).toHaveBeenCalledTimes(1);
      expect(getMockCreate()).toHaveBeenCalledWith({
        model: 'nvidia/llama-nemotron-embed-vl-1b-v2:free',
        input: ['chunk 1 content', 'chunk 2 content', 'chunk 3 content'],
        encoding_format: 'float',
      });
    });

    it('calls $executeRaw exactly once regardless of chunk count (single bulk INSERT)', async () => {
      getMockCreate().mockResolvedValue({
        data: [{ embedding: [0.1] }, { embedding: [0.2] }, { embedding: [0.3] }, { embedding: [0.4] }, { embedding: [0.5] }],
      });

      await service.embedAndStore(makeChunks(5), DOCUMENT_ID, SESSION_ID);

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('formats embedding as pgvector array literal [x,y,...] in the INSERT payload', async () => {
      getMockCreate().mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });

      await service.embedAndStore(makeChunks(1), DOCUMENT_ID, SESSION_ID);

      // $executeRaw is called as a tagged template: (strings, ...values).
      // The second argument is the Prisma.Sql from Prisma.join(...) which has a
      // `values` array containing the bound parameters including the embedding literal.
      const callArgs = (prisma.$executeRaw as jest.Mock).mock.calls[0] as [unknown[], { values: unknown[] }];
      const joinedSql = callArgs[1] as { values: unknown[] };
      expect(JSON.stringify(joinedSql.values)).toContain('[0.1,0.2,0.3]');
    });

    it('includes ::halfvec cast in the INSERT for the embedding column', async () => {
      getMockCreate().mockResolvedValue({ data: [{ embedding: [0.1] }] });

      await service.embedAndStore(makeChunks(1), DOCUMENT_ID, SESSION_ID);

      // Prisma.sql`...${}::halfvec` puts '::halfvec' in the strings array of the Prisma.Sql fragment.
      const callArgs = (prisma.$executeRaw as jest.Mock).mock.calls[0] as [unknown[], { strings: string[] }];
      const joinedSql = callArgs[1] as { strings: string[] };
      expect(joinedSql.strings.join('')).toContain('::halfvec');
    });

    it('includes ::jsonb cast in the INSERT for the metadata column', async () => {
      getMockCreate().mockResolvedValue({ data: [{ embedding: [0.1] }] });

      await service.embedAndStore(makeChunks(1), DOCUMENT_ID, SESSION_ID);

      // Prisma.sql`...${}::jsonb` puts '::jsonb' in the strings array.
      const callArgs = (prisma.$executeRaw as jest.Mock).mock.calls[0] as [unknown[], { strings: string[] }];
      const joinedSql = callArgs[1] as { strings: string[] };
      expect(joinedSql.strings.join('')).toContain('::jsonb');
    });

    it('rethrows OpenAI API errors without wrapping', async () => {
      const apiError = new Error('OpenAI rate limit exceeded');
      getMockCreate().mockRejectedValue(apiError);

      await expect(service.embedAndStore(makeChunks(1), DOCUMENT_ID, SESSION_ID)).rejects.toBe(
        apiError,
      );
    });

    it('inserts chunks with correct documentId and sessionId', async () => {
      getMockCreate().mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });

      await service.embedAndStore(makeChunks(1), DOCUMENT_ID, SESSION_ID);

      // The Prisma.join result's values array contains all bound parameters including IDs.
      const callArgs = (prisma.$executeRaw as jest.Mock).mock.calls[0] as [unknown[], { values: unknown[] }];
      const joinedSql = callArgs[1] as { values: unknown[] };
      const valuesStr = JSON.stringify(joinedSql.values);
      expect(valuesStr).toContain(DOCUMENT_ID);
      expect(valuesStr).toContain(SESSION_ID);
    });
  });
});
