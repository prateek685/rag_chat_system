// jest.mock must appear before all imports — factory must be self-contained.
// ChatController → ChatService → LangfuseService → langfuse uses dynamic imports
// which crash Jest's VM unless the module is mocked at the top level.
jest.mock('langfuse', () => ({
  __esModule: true,
  default: jest.fn(),
  LangfuseTraceClient: jest.fn(),
}));

import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatMessageDto } from './dto/chat-message.dto';
import { FeedbackDto } from './dto/feedback.dto';

type SessionRequest = Request & { sessionId: string };

const makeMockRes = (): jest.Mocked<Response> =>
  ({
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  }) as unknown as jest.Mocked<Response>;

const makeSessionReq = (
  sessionId = 'a1b2c3d4-e5f6-4a7b-89cd-ef0123456789',
): SessionRequest => ({ sessionId }) as unknown as SessionRequest;

describe('ChatController', () => {
  let controller: ChatController;
  let chatService: jest.Mocked<ChatService>;

  beforeEach(async () => {
    const mockChatService = {
      handleChat: jest.fn().mockResolvedValue(undefined),
      handleRetry: jest.fn().mockResolvedValue(undefined),
      handleFeedback: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: mockChatService }],
    }).compile();

    controller = module.get<ChatController>(ChatController);
    chatService = module.get<ChatService>(ChatService) as jest.Mocked<ChatService>;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('chat — POST /chat', () => {
    it('delegates to chatService.handleChat with dto, sessionId, and res', async () => {
      const dto: ChatMessageDto = { message: 'What is the revenue for Q3?' };
      const req = makeSessionReq();
      const res = makeMockRes();

      await controller.chat(dto, req, res);

      expect(chatService.handleChat).toHaveBeenCalledTimes(1);
      expect(chatService.handleChat).toHaveBeenCalledWith(dto, req.sessionId, res);
    });

    it('propagates HttpException thrown by chatService (e.g. 429 rate limit)', async () => {
      const rateLimitError = new HttpException(
        'Too Many Requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
      chatService.handleChat.mockRejectedValueOnce(rateLimitError);

      const dto: ChatMessageDto = { message: 'test' };
      const req = makeSessionReq();
      const res = makeMockRes();

      const caught = await controller.chat(dto, req, res).catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });
  });

  describe('retry — POST /chat/retry', () => {
    it('delegates to chatService.handleRetry with sessionId and res', async () => {
      const req = makeSessionReq();
      const res = makeMockRes();

      await controller.retry(req, res);

      expect(chatService.handleRetry).toHaveBeenCalledTimes(1);
      expect(chatService.handleRetry).toHaveBeenCalledWith(req.sessionId, res);
    });
  });

  describe('feedback — POST /chat/feedback', () => {
    it('delegates to chatService.handleFeedback and resolves void', async () => {
      const dto: FeedbackDto = { traceId: 'trace-abc-123', score: 1 };

      await expect(controller.feedback(dto)).resolves.toBeUndefined();

      expect(chatService.handleFeedback).toHaveBeenCalledTimes(1);
      expect(chatService.handleFeedback).toHaveBeenCalledWith(dto);
    });

    it('resolves normally because ChatService.handleFeedback swallows errors internally', async () => {
      // ChatService.handleFeedback resolves regardless — errors are swallowed at the
      // service level so the controller never sees a rejection here.
      chatService.handleFeedback.mockResolvedValueOnce(undefined);

      const dto: FeedbackDto = { traceId: 'trace-xyz-789', score: -1 };

      await expect(controller.feedback(dto)).resolves.toBeUndefined();
      expect(chatService.handleFeedback).toHaveBeenCalledWith(dto);
    });
  });
});
