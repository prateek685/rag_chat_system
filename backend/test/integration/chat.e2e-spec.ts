// Prevent ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG from Langfuse's dynamic import.
jest.mock('langfuse', () => ({ __esModule: true, default: jest.fn() }));

import {
  HttpException,
  HttpStatus,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { SessionGuard } from '../../src/common/guards/session.guard';
import { ChatController } from '../../src/modules/chat/chat.controller';
import { ChatService } from '../../src/modules/chat/chat.service';
import { PrismaService } from '../../src/modules/prisma/prisma.service';
import { RedisService } from '../../src/modules/redis/redis.service';

/** A deterministic UUIDv4 used as the test session ID throughout the suite. */
const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-89cd-ef0123456789';

/**
 * Writes a minimal SSE stream to the Express response and ends it.
 * Simulates the ChatService SSE pipeline without any LLM or DB calls.
 */
const sseStream = async (
  _dto: unknown,
  _sessionId: string,
  res: Response,
): Promise<void> => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: Hello from the RAG pipeline\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
};

const retryStream = async (_sessionId: string, res: Response): Promise<void> => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: Regenerated response\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
};

describe('ChatController (integration)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  const mockChatService = {
    handleChat: jest.fn().mockImplementation(sseStream),
    handleRetry: jest.fn().mockImplementation(retryStream),
    handleFeedback: jest.fn().mockResolvedValue(undefined),
  };

  // SessionGuard dependencies — mocked to avoid live DB/Redis connections.
  const mockPrisma = {
    session: {
      upsert: jest.fn().mockResolvedValue({ id: SESSION_ID }),
    },
  };

  const mockRedis = {
    client: {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    },
  };

  const mockReflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: mockChatService },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: Reflector, useValue: mockReflector },
        { provide: APP_GUARD, useClass: SessionGuard },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-arm session guard mocks after clearAllMocks().
    mockPrisma.session.upsert.mockResolvedValue({ id: SESSION_ID });
    mockRedis.client.get.mockResolvedValue(null);
    mockRedis.client.setex.mockResolvedValue('OK');
    mockReflector.getAllAndOverride.mockReturnValue(false);
    // Re-arm chat service mocks.
    mockChatService.handleChat.mockImplementation(sseStream);
    mockChatService.handleRetry.mockImplementation(retryStream);
    mockChatService.handleFeedback.mockResolvedValue(undefined);
  });

  // ---------------------------------------------------------------------------
  // Session Guard
  // ---------------------------------------------------------------------------

  describe('Session Guard', () => {
    it('returns 400 when x-session-id header is absent', async () => {
      const res = await request(server)
        .post('/chat')
        .send({ message: 'Hello' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/x-session-id/i);
    });

    it('returns 400 when x-session-id is not a valid UUIDv4', async () => {
      const res = await request(server)
        .post('/chat')
        .set('x-session-id', 'bad-id')
        .send({ message: 'Hello' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/UUIDv4/i);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /chat
  // ---------------------------------------------------------------------------

  describe('POST /chat', () => {
    it('streams SSE response with text/event-stream and a [DONE] marker', async () => {
      const res = await request(server)
        .post('/chat')
        .set('x-session-id', SESSION_ID)
        .send({ message: 'What is the Q3 revenue?' })
        .buffer(true);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.text).toContain('data: Hello from the RAG pipeline');
      expect(res.text).toContain('data: [DONE]');
      expect(mockChatService.handleChat).toHaveBeenCalledTimes(1);
    });

    it('returns 400 when message is an empty string (DTO validation)', async () => {
      const res = await request(server)
        .post('/chat')
        .set('x-session-id', SESSION_ID)
        .send({ message: '' });
      expect(res.status).toBe(400);
    });

    it('returns 429 JSON response when ChatService throws a rate-limit HttpException', async () => {
      mockChatService.handleChat.mockRejectedValueOnce(
        new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS),
      );

      const res = await request(server)
        .post('/chat')
        .set('x-session-id', SESSION_ID)
        .send({ message: 'Spam message' });

      expect(res.status).toBe(429);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /chat/retry
  // ---------------------------------------------------------------------------

  describe('POST /chat/retry', () => {
    it('streams SSE response with text/event-stream and a [DONE] marker', async () => {
      const res = await request(server)
        .post('/chat/retry')
        .set('x-session-id', SESSION_ID)
        .buffer(true);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.text).toContain('data: Regenerated response');
      expect(res.text).toContain('data: [DONE]');
      expect(mockChatService.handleRetry).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /chat/feedback
  // ---------------------------------------------------------------------------

  describe('POST /chat/feedback', () => {
    it('returns 204 for a valid thumbs-up feedback payload', async () => {
      const res = await request(server)
        .post('/chat/feedback')
        .set('x-session-id', SESSION_ID)
        .send({ traceId: 'trace-abc-001', score: 1 });

      expect(res.status).toBe(204);
      expect(mockChatService.handleFeedback).toHaveBeenCalledWith({
        traceId: 'trace-abc-001',
        score: 1,
      });
    });

    it('returns 400 when score is not in the allowed set [1, -1] (DTO validation)', async () => {
      const res = await request(server)
        .post('/chat/feedback')
        .set('x-session-id', SESSION_ID)
        .send({ traceId: 'trace-abc-002', score: 0 });

      expect(res.status).toBe(400);
    });
  });
});
