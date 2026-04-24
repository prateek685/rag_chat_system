import * as crypto from 'crypto';
import * as fs from 'fs';
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { DocumentService } from './document.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { DOCUMENT_PROCESSING_QUEUE } from '../worker/types/document-job.types';

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    readFile: jest.fn(),
    unlink: jest.fn(),
  },
}));

const SESSION_ID = '11111111-1111-4111-a111-111111111111';
const DOCUMENT_ID = '22222222-2222-4222-a222-222222222222';
const FILE_HASH = 'abc123def456';
const JOB_ID = 'bull-job-789';

const mockFile = {
  originalname: 'report.txt',
  mimetype: 'text/plain',
  path: '/app/uploads/session/uuid-report.txt',
} as Express.Multer.File;

const mockDocument = {
  id: DOCUMENT_ID,
  sessionId: SESSION_ID,
  filename: 'report.txt',
  fileHash: FILE_HASH,
  status: 'PENDING' as const,
  errorMessage: null,
  jobId: JOB_ID,
  tokenCount: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('DocumentService', () => {
  let service: DocumentService;
  let prisma: jest.Mocked<PrismaService>;
  let redis: { client: jest.Mocked<{ keys: jest.Mock; pipeline: jest.Mock; del: jest.Mock; exec: jest.Mock }> };
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    const mockPipeline = { del: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([]) };
    redis = {
      client: {
        keys: jest.fn().mockResolvedValue([]),
        pipeline: jest.fn().mockReturnValue(mockPipeline),
        del: jest.fn(),
        exec: jest.fn(),
      },
    };
    queue = { add: jest.fn().mockResolvedValue({ id: JOB_ID }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentService,
        {
          provide: PrismaService,
          useValue: {
            document: {
              findUnique: jest.fn(),
              findFirst: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
            message: { create: jest.fn() },
          },
        },
        { provide: RedisService, useValue: redis },
        { provide: getQueueToken(DOCUMENT_PROCESSING_QUEUE), useValue: queue },
      ],
    }).compile();

    service = module.get<DocumentService>(DocumentService);
    prisma = module.get(PrismaService);

    // Default: file read returns a buffer for hashing
    (fs.promises.readFile as jest.Mock).mockResolvedValue(Buffer.from('file content'));
    (fs.promises.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => jest.clearAllMocks());

  // ---------------------------------------------------------------------------
  // uploadDocument
  // ---------------------------------------------------------------------------

  describe('uploadDocument', () => {
    beforeEach(() => {
      (prisma.document.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.document.create as jest.Mock).mockResolvedValue(mockDocument);
      (prisma.document.update as jest.Mock).mockResolvedValue({ ...mockDocument, jobId: JOB_ID });
    });

    it('computes SHA-256 hash and checks for duplicate (sessionId, fileHash)', async () => {
      await service.uploadDocument(mockFile, SESSION_ID);

      expect(fs.promises.readFile).toHaveBeenCalledWith(mockFile.path);
      expect(prisma.document.findUnique).toHaveBeenCalledWith({
        where: {
          sessionId_fileHash: {
            sessionId: SESSION_ID,
            fileHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      });
    });

    it('throws ConflictException and unlinks orphan file when duplicate detected', async () => {
      (prisma.document.findUnique as jest.Mock).mockResolvedValue(mockDocument);

      await expect(service.uploadDocument(mockFile, SESSION_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(fs.promises.unlink).toHaveBeenCalledWith(mockFile.path);
      expect(prisma.document.create).not.toHaveBeenCalled();
    });

    it('creates document row with status PENDING', async () => {
      await service.uploadDocument(mockFile, SESSION_ID);

      expect(prisma.document.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sessionId: SESSION_ID,
          filename: 'report.txt',
          status: 'PENDING',
        }),
      });
    });

    it('enqueues job with process-document name and valid payload', async () => {
      await service.uploadDocument(mockFile, SESSION_ID);

      expect(queue.add).toHaveBeenCalledWith(
        'process-document',
        expect.objectContaining({
          documentId: DOCUMENT_ID,
          sessionId: SESSION_ID,
          filePath: mockFile.path,
          originalFilename: 'report.txt',
          mimeType: 'text/plain',
        }),
        expect.objectContaining({ attempts: 3 }),
      );
    });

    it('updates document jobId after successful queue.add', async () => {
      await service.uploadDocument(mockFile, SESSION_ID);

      expect(prisma.document.update).toHaveBeenCalledWith({
        where: { id: DOCUMENT_ID },
        data: { jobId: JOB_ID },
      });
    });

    it('returns { jobId, documentId, status: PENDING }', async () => {
      const result = await service.uploadDocument(mockFile, SESSION_ID);

      expect(result).toEqual({ jobId: JOB_ID, documentId: DOCUMENT_ID, status: 'PENDING' });
    });

    it('deletes document row and rethrows when queue.add fails', async () => {
      queue.add.mockRejectedValue(new Error('Redis unavailable'));
      (prisma.document.delete as jest.Mock).mockResolvedValue(mockDocument);

      await expect(service.uploadDocument(mockFile, SESSION_ID)).rejects.toThrow(
        'Redis unavailable',
      );
      expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: DOCUMENT_ID } });
    });
  });

  // ---------------------------------------------------------------------------
  // getStatusByJobId
  // ---------------------------------------------------------------------------

  describe('getStatusByJobId', () => {
    it('returns status DTO when document found', async () => {
      (prisma.document.findFirst as jest.Mock).mockResolvedValue({
        ...mockDocument,
        status: 'COMPLETED',
        tokenCount: 500,
      });

      const result = await service.getStatusByJobId(JOB_ID, SESSION_ID);

      expect(result).toEqual({
        documentId: DOCUMENT_ID,
        status: 'COMPLETED',
        errorMessage: null,
        tokenCount: 500,
      });
    });

    it('throws NotFoundException when no document matches jobId + sessionId', async () => {
      (prisma.document.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.getStatusByJobId('unknown-job', SESSION_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // deleteDocument
  // ---------------------------------------------------------------------------

  describe('deleteDocument', () => {
    beforeEach(() => {
      (prisma.document.findUnique as jest.Mock).mockResolvedValue(mockDocument);
      (prisma.document.delete as jest.Mock).mockResolvedValue(mockDocument);
      (prisma.message.create as jest.Mock).mockResolvedValue({});
    });

    it('throws NotFoundException if document does not exist', async () => {
      (prisma.document.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteDocument(DOCUMENT_ID, SESSION_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws ForbiddenException if document belongs to a different session', async () => {
      (prisma.document.findUnique as jest.Mock).mockResolvedValue({
        ...mockDocument,
        sessionId: 'other-session',
      });

      await expect(service.deleteDocument(DOCUMENT_ID, SESSION_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('calls prisma.document.delete (cascade wipes all chunks)', async () => {
      await service.deleteDocument(DOCUMENT_ID, SESSION_ID);

      expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: DOCUMENT_ID } });
    });

    it('flushes Redis keys matching session:{sessionId}:*', async () => {
      redis.client.keys.mockResolvedValue(['session:abc:chat:key1', 'session:abc:embed:key2']);
      const pipeline = { del: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([]) };
      redis.client.pipeline.mockReturnValue(pipeline as never);

      await service.deleteDocument(DOCUMENT_ID, SESSION_ID);

      expect(redis.client.keys).toHaveBeenCalledWith(`session:${SESSION_ID}:*`);
      expect(pipeline.del).toHaveBeenCalledTimes(2);
      expect(pipeline.exec).toHaveBeenCalled();
    });

    it('inserts system ghost message with correct content', async () => {
      await service.deleteDocument(DOCUMENT_ID, SESSION_ID);

      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          sessionId: SESSION_ID,
          role: 'system',
          content: `[SYSTEM DIRECTIVE: Document 'report.txt' has been deleted. Ignore facts from it in prior history.]`,
        },
      });
    });

    it('does not rethrow when Redis flush fails (non-fatal — logs warn)', async () => {
      redis.client.keys.mockRejectedValue(new Error('Redis connection lost'));

      await expect(service.deleteDocument(DOCUMENT_ID, SESSION_ID)).resolves.toBeUndefined();
    });

    it('does not rethrow when ghost message insert fails (non-fatal — logs error)', async () => {
      (prisma.message.create as jest.Mock).mockRejectedValue(new Error('DB write failed'));

      await expect(service.deleteDocument(DOCUMENT_ID, SESSION_ID)).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // SHA-256 hash correctness sanity check
  // ---------------------------------------------------------------------------

  describe('SHA-256 hash computation', () => {
    it('produces the correct hex digest for a known input', async () => {
      const content = 'hello world';
      (fs.promises.readFile as jest.Mock).mockResolvedValue(Buffer.from(content));
      (prisma.document.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.document.create as jest.Mock).mockResolvedValue(mockDocument);
      (prisma.document.update as jest.Mock).mockResolvedValue(mockDocument);

      await service.uploadDocument(mockFile, SESSION_ID);

      const expectedHash = crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');
      expect(prisma.document.findUnique).toHaveBeenCalledWith({
        where: { sessionId_fileHash: { sessionId: SESSION_ID, fileHash: expectedHash } },
      });
    });
  });
});
