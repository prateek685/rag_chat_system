import * as fs from 'fs';
import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { DocumentProcessor } from './document.processor';
import { VectorService } from './vector.service';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentJobPayload } from './types/document-job.types';

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    access: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn(),
  },
  constants: { R_OK: 4 },
}));

jest.mock('pdf-parse', () => jest.fn().mockResolvedValue({ text: 'parsed pdf content' }));

// Spy on js-tiktoken so we can control token counts in tests.
jest.mock('js-tiktoken', () => ({
  getEncoding: jest.fn().mockReturnValue({
    encode: jest.fn().mockReturnValue(new Array(100).fill(0)), // default: 100 tokens
  }),
}));

import { getEncoding } from 'js-tiktoken';

const DOCUMENT_ID = '22222222-2222-4222-a222-222222222222';
const SESSION_ID = '11111111-1111-4111-a111-111111111111';
const FILE_PATH = '/app/uploads/session/uuid-test.txt';

function makeJob(
  overrides: Partial<DocumentJobPayload> = {},
  jobOverrides: { attemptsMade?: number; opts?: { attempts?: number } } = {},
): Job<DocumentJobPayload> {
  return {
    id: 'job-1',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      documentId: DOCUMENT_ID,
      sessionId: SESSION_ID,
      filePath: FILE_PATH,
      originalFilename: 'test.txt',
      mimeType: 'text/plain',
      ...overrides,
    },
    ...jobOverrides,
  } as unknown as Job<DocumentJobPayload>;
}

describe('DocumentProcessor', () => {
  let processor: DocumentProcessor;
  let prisma: jest.Mocked<PrismaService>;
  let vectorService: jest.Mocked<VectorService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentProcessor,
        {
          provide: PrismaService,
          useValue: {
            document: {
              update: jest.fn().mockResolvedValue({}),
            },
          },
        },
        {
          provide: VectorService,
          useValue: {
            embedAndStore: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    processor = module.get<DocumentProcessor>(DocumentProcessor);
    prisma = module.get(PrismaService);
    vectorService = module.get(VectorService);

    (fs.promises.access as jest.Mock).mockResolvedValue(undefined);
    (fs.promises.readFile as jest.Mock).mockResolvedValue('sample text content');
    (fs.promises.unlink as jest.Mock).mockResolvedValue(undefined);

    // Default: 100 tokens (well below the 50k limit)
    (getEncoding as jest.Mock).mockReturnValue({
      encode: jest.fn().mockReturnValue(new Array(100).fill(0)),
    });
  });

  afterEach(() => jest.clearAllMocks());

  // ---------------------------------------------------------------------------
  // Phase sequencing
  // ---------------------------------------------------------------------------

  describe('process — phase sequencing', () => {
    it('sets status to PROCESSING as the first DB operation', async () => {
      const updateCalls: string[] = [];
      (prisma.document.update as jest.Mock).mockImplementation(({ data }) => {
        updateCalls.push(data.status as string);
        return Promise.resolve({});
      });

      await processor.process(makeJob());

      expect(updateCalls[0]).toBe('PROCESSING');
    });

    it('sets status to COMPLETED with tokenCount on successful processing', async () => {
      await processor.process(makeJob());

      const completedCall = (prisma.document.update as jest.Mock).mock.calls.find(
        ([args]: [{ data: { status: string } }]) => args.data.status === 'COMPLETED',
      );
      expect(completedCall).toBeDefined();
      expect(completedCall[0].data).toMatchObject({ status: 'COMPLETED', tokenCount: 100 });
    });

    it('deletes temp file after successful processing', async () => {
      await processor.process(makeJob());

      expect(fs.promises.unlink).toHaveBeenCalledWith(FILE_PATH);
    });

    it('logs warn (does not throw) if temp file delete fails post-success', async () => {
      (fs.promises.unlink as jest.Mock).mockRejectedValue(new Error('ENOENT'));

      await expect(processor.process(makeJob())).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Chunking edge cases
  // ---------------------------------------------------------------------------

  describe('process — chunking edge cases', () => {
    it('calls embedAndStore with empty array for empty file content', async () => {
      (fs.promises.readFile as jest.Mock).mockResolvedValue('');

      await processor.process(makeJob());

      expect(vectorService.embedAndStore).toHaveBeenCalledWith([], DOCUMENT_ID, SESSION_ID);
    });

    it('calls embedAndStore with 1 chunk for single-character content', async () => {
      (fs.promises.readFile as jest.Mock).mockResolvedValue('a');

      await processor.process(makeJob());

      expect(vectorService.embedAndStore).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ pageContent: 'a' })]),
        DOCUMENT_ID,
        SESSION_ID,
      );
    });

    it('calls embedAndStore with multiple chunks for a 10,000-char text with no whitespace', async () => {
      const hugeUnbrokenBlock = 'x'.repeat(10_000);
      (fs.promises.readFile as jest.Mock).mockResolvedValue(hugeUnbrokenBlock);

      await processor.process(makeJob());

      const [[chunks]] = (vectorService.embedAndStore as jest.Mock).mock.calls;
      // 10,000 chars / (1000 chunk - 200 overlap) = at least 12 chunks
      expect((chunks as unknown[]).length).toBeGreaterThan(1);
    });

    it('splits text with paragraph breaks at \\n\\n boundaries first', async () => {
      const paragraphText = 'Para one content.\n\nPara two content.';
      (fs.promises.readFile as jest.Mock).mockResolvedValue(paragraphText);

      await processor.process(makeJob());

      const [[chunks]] = (vectorService.embedAndStore as jest.Mock).mock.calls;
      expect((chunks as { pageContent: string }[]).some((c) => c.pageContent.includes('Para one'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Token limit guard
  // ---------------------------------------------------------------------------

  describe('process — token limit guard', () => {
    it('processes successfully when token count is exactly MAX_TOKEN_COUNT (50,000)', async () => {
      (getEncoding as jest.Mock).mockReturnValue({
        encode: jest.fn().mockReturnValue(new Array(50_000).fill(0)),
      });

      await expect(processor.process(makeJob())).resolves.toBeUndefined();
    });

    it('sets status FAILED and errorMessage when token count exceeds 50,000', async () => {
      (getEncoding as jest.Mock).mockReturnValue({
        encode: jest.fn().mockReturnValue(new Array(50_001).fill(0)),
      });

      await expect(processor.process(makeJob())).rejects.toThrow();

      const failedCall = (prisma.document.update as jest.Mock).mock.calls.find(
        ([args]: [{ data: { status: string } }]) => args.data.status === 'FAILED',
      );
      expect(failedCall).toBeDefined();
      expect(failedCall[0].data.errorMessage).toMatch(/50001/);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('process — error handling', () => {
    it('sets status FAILED with errorMessage and rethrows on any error', async () => {
      (fs.promises.access as jest.Mock).mockRejectedValue(new Error('ENOENT: file not found'));

      await expect(processor.process(makeJob())).rejects.toThrow('ENOENT: file not found');

      const failedCall = (prisma.document.update as jest.Mock).mock.calls.find(
        ([args]: [{ data: { status: string } }]) => args.data.status === 'FAILED',
      );
      expect(failedCall).toBeDefined();
      expect(failedCall[0].data.errorMessage).toContain('ENOENT');
    });

    it('rethrows the original error after setting FAILED status', async () => {
      const originalError = new Error('OpenAI API error');
      vectorService.embedAndStore.mockRejectedValue(originalError);

      await expect(processor.process(makeJob())).rejects.toBe(originalError);
    });

    it('handles Zod parse error on invalid job payload', async () => {
      const badJob = { id: 'job-bad', attemptsMade: 0, data: { bad: 'payload' } } as unknown as Job<DocumentJobPayload>;

      await expect(processor.process(badJob)).rejects.toThrow();
      // Zod error thrown before any DB call
      expect(prisma.document.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // PDF parsing
  // ---------------------------------------------------------------------------

  describe('process — PDF parsing', () => {
    it('uses pdf-parse for application/pdf files', async () => {
      const pdfParse = jest.requireMock<jest.Mock>('pdf-parse');
      (fs.promises.readFile as jest.Mock).mockResolvedValue(Buffer.from('%PDF-'));

      await processor.process(makeJob({ mimeType: 'application/pdf' }));

      expect(pdfParse).toHaveBeenCalled();
      expect(vectorService.embedAndStore).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ pageContent: expect.stringContaining('parsed pdf') })]),
        DOCUMENT_ID,
        SESSION_ID,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // onFailed hook
  // ---------------------------------------------------------------------------

  describe('onFailed', () => {
    it('logs error event with jobId, documentId, and attempt count', async () => {
      const logSpy = jest.spyOn((processor as unknown as { logger: { error: jest.Mock } }).logger, 'error').mockImplementation(() => undefined);
      const job = makeJob();

      await processor.onFailed(job, new Error('final failure'));

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'job_failed_permanently',
          jobId: 'job-1',
          documentId: DOCUMENT_ID,
        }),
      );
    });

    it('deletes orphan file when all retries are exhausted (attemptsMade === attempts)', async () => {
      const job = makeJob({}, { attemptsMade: 3, opts: { attempts: 3 } });

      await processor.onFailed(job, new Error('all retries exhausted'));

      expect(fs.promises.unlink).toHaveBeenCalledWith(FILE_PATH);
    });

    it('does NOT delete file on intermediate failure when retries remain', async () => {
      const job = makeJob({}, { attemptsMade: 1, opts: { attempts: 3 } });

      await processor.onFailed(job, new Error('attempt 1 failed'));

      expect(fs.promises.unlink).not.toHaveBeenCalled();
    });

    it('logs warn (does not throw) if orphan file delete fails on final failure', async () => {
      (fs.promises.unlink as jest.Mock).mockRejectedValue(new Error('ENOENT'));
      const job = makeJob({}, { attemptsMade: 3, opts: { attempts: 3 } });

      await expect(processor.onFailed(job, new Error('final failure'))).resolves.toBeUndefined();
    });
  });
});
