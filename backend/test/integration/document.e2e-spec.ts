// Must be set before any imports — DocumentController reads UPLOADS_BASE at module-load time.
process.env.UPLOADS_PATH = '/tmp/rag-test-uploads';

import * as fs from 'fs';
import {
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentStatus } from '@prisma/client';
import request from 'supertest';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { SessionGuard } from '../../src/common/guards/session.guard';
import { DocumentController } from '../../src/modules/document/document.controller';
import { DocumentService } from '../../src/modules/document/document.service';
import { PrismaService } from '../../src/modules/prisma/prisma.service';
import { RedisService } from '../../src/modules/redis/redis.service';

/** A deterministic UUIDv4 used as the test session ID throughout the suite. */
const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-89cd-ef0123456789';
const VALID_JOB_ID = 'job-abc-00001';
const VALID_DOC_ID = 'doc-uuid-00001';

describe('DocumentController (integration)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  const mockDocumentService = {
    uploadDocument: jest.fn(),
    getStatusByJobId: jest.fn(),
    deleteDocument: jest.fn(),
  };

  // SessionGuard dependencies — mocked to avoid live DB/Redis connections.
  const mockPrisma = {
    session: {
      upsert: jest.fn().mockResolvedValue({ id: SESSION_ID }),
    },
  };

  const mockRedis = {
    // Return null on every get → cache miss → guard will upsert via mockPrisma.
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
  };

  // getAllAndOverride returns false → no route is marked @Public().
  const mockReflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
  };

  beforeAll(async () => {
    // Ensure the upload root exists for Multer's diskStorage destination callback.
    fs.mkdirSync('/tmp/rag-test-uploads', { recursive: true });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [DocumentController],
      providers: [
        { provide: DocumentService, useValue: mockDocumentService },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: Reflector, useValue: mockReflector },
        { provide: APP_GUARD, useClass: SessionGuard },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'UPLOADS_PATH') return '/tmp/rag-test-uploads';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    // MulterExceptionFilter is applied via @UseFilters on DocumentController — automatic.
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync('/tmp/rag-test-uploads', { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-arm SessionGuard mocks after clearAllMocks() wipes mockResolvedValue state.
    mockPrisma.session.upsert.mockResolvedValue({ id: SESSION_ID });
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue('OK');
    mockReflector.getAllAndOverride.mockReturnValue(false);
  });

  // ---------------------------------------------------------------------------
  // Session Guard
  // ---------------------------------------------------------------------------

  describe('Session Guard', () => {
    it('returns 400 when x-session-id header is absent', async () => {
      const res = await request(server).get('/documents/status/some-job');
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/x-session-id/i);
    });

    it('returns 400 when x-session-id is not a valid UUIDv4', async () => {
      const res = await request(server)
        .get('/documents/status/some-job')
        .set('x-session-id', 'not-a-uuid');
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/UUIDv4/i);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /documents/upload
  // ---------------------------------------------------------------------------

  describe('POST /documents/upload', () => {
    it('returns 201 with jobId, documentId, and status PENDING for a valid text file', async () => {
      mockDocumentService.uploadDocument.mockResolvedValueOnce({
        jobId: VALID_JOB_ID,
        documentId: VALID_DOC_ID,
        status: 'PENDING',
      });

      const res = await request(server)
        .post('/documents/upload')
        .set('x-session-id', SESSION_ID)
        .attach('file', Buffer.from('Hello, this is a test document.'), {
          filename: 'test.txt',
          contentType: 'text/plain',
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        jobId: VALID_JOB_ID,
        documentId: VALID_DOC_ID,
        status: 'PENDING',
      });
      expect(mockDocumentService.uploadDocument).toHaveBeenCalledTimes(1);
    });

    it('returns 400 when no file is attached', async () => {
      const res = await request(server)
        .post('/documents/upload')
        .set('x-session-id', SESSION_ID);
      expect(res.status).toBe(400);
    });

    it('returns 415 for an unsupported MIME type', async () => {
      const res = await request(server)
        .post('/documents/upload')
        .set('x-session-id', SESSION_ID)
        .attach('file', Buffer.from('binary data'), {
          filename: 'malware.exe',
          contentType: 'application/octet-stream',
        });
      expect(res.status).toBe(415);
    });

    it('returns 413 when the file exceeds 10 MB', async () => {
      // 10 MB + 1 byte triggers Multer's LIMIT_FILE_SIZE → MulterExceptionFilter → 413.
      const oversizedBuffer = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');

      const res = await request(server)
        .post('/documents/upload')
        .set('x-session-id', SESSION_ID)
        .attach('file', oversizedBuffer, {
          filename: 'huge.txt',
          contentType: 'text/plain',
        });
      expect(res.status).toBe(413);
    });

    it('returns 409 when DocumentService throws ConflictException (duplicate file)', async () => {
      mockDocumentService.uploadDocument.mockRejectedValueOnce(
        new ConflictException('Duplicate file content for this session'),
      );

      const res = await request(server)
        .post('/documents/upload')
        .set('x-session-id', SESSION_ID)
        .attach('file', Buffer.from('duplicate content'), {
          filename: 'duplicate.txt',
          contentType: 'text/plain',
        });
      expect(res.status).toBe(409);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /documents/status/:jobId
  // ---------------------------------------------------------------------------

  describe('GET /documents/status/:jobId', () => {
    it('returns 200 with document status DTO when the document is found', async () => {
      mockDocumentService.getStatusByJobId.mockResolvedValueOnce({
        documentId: VALID_DOC_ID,
        status: DocumentStatus.COMPLETED,
        errorMessage: null,
        tokenCount: 1500,
      });

      const res = await request(server)
        .get(`/documents/status/${VALID_JOB_ID}`)
        .set('x-session-id', SESSION_ID);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        documentId: VALID_DOC_ID,
        status: 'COMPLETED',
        tokenCount: 1500,
      });
    });

    it('returns 404 when the job ID does not belong to this session', async () => {
      mockDocumentService.getStatusByJobId.mockRejectedValueOnce(
        new NotFoundException('Job ID not found for this session'),
      );

      const res = await request(server)
        .get('/documents/status/nonexistent-job')
        .set('x-session-id', SESSION_ID);
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /documents/:documentId
  // ---------------------------------------------------------------------------

  describe('DELETE /documents/:documentId', () => {
    it('returns 204 for a successful deletion', async () => {
      mockDocumentService.deleteDocument.mockResolvedValueOnce(undefined);

      const res = await request(server)
        .delete(`/documents/${VALID_DOC_ID}`)
        .set('x-session-id', SESSION_ID);
      expect(res.status).toBe(204);
    });

    it('returns 403 when the document belongs to a different session', async () => {
      mockDocumentService.deleteDocument.mockRejectedValueOnce(
        new ForbiddenException('Document belongs to a different session'),
      );

      const res = await request(server)
        .delete(`/documents/${VALID_DOC_ID}`)
        .set('x-session-id', SESSION_ID);
      expect(res.status).toBe(403);
    });

    it('returns 404 when the document does not exist', async () => {
      mockDocumentService.deleteDocument.mockRejectedValueOnce(
        new NotFoundException('Document not found'),
      );

      const res = await request(server)
        .delete('/documents/nonexistent-doc-id')
        .set('x-session-id', SESSION_ID);
      expect(res.status).toBe(404);
    });
  });
});
