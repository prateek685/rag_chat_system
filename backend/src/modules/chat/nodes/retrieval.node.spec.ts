jest.mock('langfuse', () => ({ Langfuse: jest.fn() }));

const mockEmbeddingsCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    embeddings: { create: mockEmbeddingsCreate },
  })),
}));

import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { RetrievalNodeService } from './retrieval.node';
import { LangfuseService } from '../../observability/langfuse.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RAGState } from '../types/rag-state.types';

const ABOVE_THRESHOLD = 0.75;
const BELOW_THRESHOLD = 0.20;

function makeState(overrides: Partial<RAGState> = {}): RAGState {
  return {
    sessionId: 'session-1',
    userQuery: 'What is the refund policy?',
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

function makeRawRow(overrides: Partial<{
  id: string;
  content: string;
  documentId: string;
  metadata: null;
  rrfScore: number;
  cosineSimilarity: number;
}> = {}) {
  return {
    id: 'chunk-1',
    content: 'Refunds are processed within 30 days.',
    documentId: 'doc-1',
    metadata: null,
    rrfScore: 0.05,
    cosineSimilarity: ABOVE_THRESHOLD,
    ...overrides,
  };
}

describe('RetrievalNodeService', () => {
  let service: RetrievalNodeService;
  let prisma: jest.Mocked<Pick<PrismaService, '$queryRaw' | 'document'>>;
  let langfuse: jest.Mocked<LangfuseService>;

  const mockSpan = { id: 'span-1' };
  const mockGeneration = { id: 'gen-1' };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetrievalNodeService,
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: jest.fn(),
            document: {
              findMany: jest.fn(),
            },
          },
        },
        {
          provide: LangfuseService,
          useValue: {
            createSpan: jest.fn().mockReturnValue(mockSpan),
            finalizeSpan: jest.fn(),
            createGeneration: jest.fn().mockReturnValue(mockGeneration),
            finalizeGeneration: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'EMBEDDING_MODEL') return 'text-embedding-3-small';
              if (key === 'OPENROUTER_API_KEY') return 'test-key';
              if (key === 'EMBEDDING_DIMENSIONS') return 1536;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(RetrievalNodeService);
    prisma = module.get(PrismaService) as unknown as typeof prisma;
    langfuse = module.get(LangfuseService) as jest.Mocked<LangfuseService>;
  });

  describe('execute() — pre-computed embedding reuse', () => {
    it('skips the embedding API call when queryEmbedding is already populated', async () => {
      const precomputed = new Array(1536).fill(0.1);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([makeRawRow()]);
      (prisma.document.findMany as jest.Mock).mockResolvedValueOnce([
        { id: 'doc-1', filename: 'policy.pdf' },
      ]);

      await service.execute(makeState({ queryEmbedding: precomputed }), null);

      expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
    });

    it('calls the embedding API when queryEmbedding is empty', async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.2) }],
        usage: { total_tokens: 8 },
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([makeRawRow()]);
      (prisma.document.findMany as jest.Mock).mockResolvedValueOnce([
        { id: 'doc-1', filename: 'policy.pdf' },
      ]);

      await service.execute(makeState({ queryEmbedding: [] }), null);

      expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('execute() — context guardrail', () => {
    it('returns NO_CONTEXT route when query returns no chunks', async () => {
      const precomputed = new Array(1536).fill(0.1);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      const result = await service.execute(makeState({ queryEmbedding: precomputed }), null);

      expect(result.route).toBe('NO_CONTEXT');
      expect(result.chunks).toHaveLength(0);
    });

    it('returns NO_CONTEXT route when top chunk cosine similarity is below threshold (0.30)', async () => {
      const precomputed = new Array(1536).fill(0.1);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        makeRawRow({ cosineSimilarity: BELOW_THRESHOLD }),
      ]);
      (prisma.document.findMany as jest.Mock).mockResolvedValueOnce([]);

      const result = await service.execute(makeState({ queryEmbedding: precomputed }), null);

      expect(result.route).toBe('NO_CONTEXT');
    });

    it('returns chunks when top cosine similarity meets threshold', async () => {
      const precomputed = new Array(1536).fill(0.1);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        makeRawRow({ cosineSimilarity: ABOVE_THRESHOLD }),
      ]);
      (prisma.document.findMany as jest.Mock).mockResolvedValueOnce([
        { id: 'doc-1', filename: 'policy.pdf' },
      ]);

      const result = await service.execute(makeState({ queryEmbedding: precomputed }), null);

      expect(result.route).toBeUndefined();
      expect(result.chunks).toHaveLength(1);
      expect(result.chunks![0].filename).toBe('policy.pdf');
    });
  });

  describe('execute() — filename resolution', () => {
    it('resolves filenames from the documents table', async () => {
      const precomputed = new Array(1536).fill(0.1);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        makeRawRow({ id: 'chunk-1', documentId: 'doc-1', cosineSimilarity: ABOVE_THRESHOLD }),
        makeRawRow({ id: 'chunk-2', documentId: 'doc-2', cosineSimilarity: ABOVE_THRESHOLD }),
      ]);
      (prisma.document.findMany as jest.Mock).mockResolvedValueOnce([
        { id: 'doc-1', filename: 'contract.pdf' },
        { id: 'doc-2', filename: 'terms.pdf' },
      ]);

      const result = await service.execute(makeState({ queryEmbedding: precomputed }), null);

      const filenames = result.chunks!.map((c) => c.filename);
      expect(filenames).toContain('contract.pdf');
      expect(filenames).toContain('terms.pdf');
    });

    it('falls back to "Unknown document" when filename fetch fails', async () => {
      const precomputed = new Array(1536).fill(0.1);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        makeRawRow({ cosineSimilarity: ABOVE_THRESHOLD }),
      ]);
      (prisma.document.findMany as jest.Mock).mockRejectedValueOnce(new Error('DB unavailable'));

      const result = await service.execute(makeState({ queryEmbedding: precomputed }), null);

      expect(result.chunks![0].filename).toBe('Unknown document');
    });

    it('deduplicates document IDs in the filename batch fetch', async () => {
      const precomputed = new Array(1536).fill(0.1);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        makeRawRow({ id: 'chunk-1', documentId: 'doc-1', cosineSimilarity: ABOVE_THRESHOLD }),
        makeRawRow({ id: 'chunk-2', documentId: 'doc-1', cosineSimilarity: ABOVE_THRESHOLD }),
      ]);
      (prisma.document.findMany as jest.Mock).mockResolvedValueOnce([
        { id: 'doc-1', filename: 'shared-doc.pdf' },
      ]);

      await service.execute(makeState({ queryEmbedding: precomputed }), null);

      expect(prisma.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['doc-1'] } } }),
      );
    });
  });

  describe('execute() — SQL error handling', () => {
    it('returns NO_CONTEXT when the SQL query throws', async () => {
      const precomputed = new Array(1536).fill(0.1);
      (prisma.$queryRaw as jest.Mock).mockRejectedValueOnce(new Error('DB timeout'));

      const result = await service.execute(makeState({ queryEmbedding: precomputed }), null);

      expect(result.route).toBe('NO_CONTEXT');
      expect(result.chunks).toHaveLength(0);
    });
  });

  describe('execute() — observability', () => {
    it('finalizes the Langfuse span with chunk count and top similarity', async () => {
      const precomputed = new Array(1536).fill(0.1);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        makeRawRow({ cosineSimilarity: ABOVE_THRESHOLD }),
      ]);
      (prisma.document.findMany as jest.Mock).mockResolvedValueOnce([]);

      await service.execute(makeState({ queryEmbedding: precomputed }), null);

      expect(langfuse.finalizeSpan).toHaveBeenCalledWith(
        mockSpan,
        expect.objectContaining({ chunkCount: 1, topSimilarity: ABOVE_THRESHOLD }),
        expect.anything(),
      );
    });

    it('includes contentPreview and filename in each chunk logged to Langfuse', async () => {
      const precomputed = new Array(1536).fill(0.1);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        makeRawRow({ content: 'Refunds are processed within 30 days.', cosineSimilarity: ABOVE_THRESHOLD }),
      ]);
      (prisma.document.findMany as jest.Mock).mockResolvedValueOnce([
        { id: 'doc-1', filename: 'policy.pdf' },
      ]);

      await service.execute(makeState({ queryEmbedding: precomputed }), null);

      const [, output] = (langfuse.finalizeSpan as jest.Mock).mock.calls[0] as [unknown, { chunks: { contentPreview: string; filename: string }[] }];
      expect(output.chunks[0].contentPreview).toContain('Refunds are processed');
      expect(output.chunks[0].filename).toBe('policy.pdf');
    });

    it('truncates contentPreview to 300 characters', async () => {
      const longContent = 'x'.repeat(500);
      const precomputed = new Array(1536).fill(0.1);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        makeRawRow({ content: longContent, cosineSimilarity: ABOVE_THRESHOLD }),
      ]);
      (prisma.document.findMany as jest.Mock).mockResolvedValueOnce([]);

      await service.execute(makeState({ queryEmbedding: precomputed }), null);

      const [, output] = (langfuse.finalizeSpan as jest.Mock).mock.calls[0] as [unknown, { chunks: { contentPreview: string }[] }];
      expect(output.chunks[0].contentPreview).toHaveLength(300);
    });

    it('finalizes span with NO_CONTEXT guardrail metadata when guardrail fires', async () => {
      const precomputed = new Array(1536).fill(0.1);
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      await service.execute(makeState({ queryEmbedding: precomputed }), null);

      expect(langfuse.finalizeSpan).toHaveBeenCalledWith(
        mockSpan,
        expect.objectContaining({ guardrail: 'NO_CONTEXT' }),
        expect.anything(),
      );
    });
  });

  describe('embedQuery()', () => {
    it('returns the embedding vector on success', async () => {
      const expected = new Array(1536).fill(0.5);
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: expected }],
        usage: { total_tokens: 12 },
      });

      const result = await service.embedQuery('test query', 'session-1', null);

      expect(result).toEqual(expected);
    });

    it('throws and finalizes Langfuse generation when embedding API fails', async () => {
      // Status 400 is non-retryable — withLlmRetry throws on the first attempt.
      mockEmbeddingsCreate.mockRejectedValueOnce(
        Object.assign(new Error('API error'), { status: 400 }),
      );

      await expect(service.embedQuery('query', 'session-1', null)).rejects.toThrow('API error');
      expect(langfuse.finalizeGeneration).toHaveBeenCalled();
    });

    it('throws when embedding response data is missing', async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce({ data: [], usage: {} });

      await expect(service.embedQuery('query', 'session-1', null)).rejects.toThrow();
    });

    it('throws with a clear message when model returns wrong number of dimensions', async () => {
      // Returns 512-dim instead of the configured 1536 — every pgvector query would silently fail.
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(512).fill(0.5) }],
        usage: { total_tokens: 8 },
      });

      await expect(service.embedQuery('query', 'session-1', null)).rejects.toThrow(
        /dimension mismatch.*512.*1536/i,
      );
    });
  });
});
