import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ChatService } from './chat.service';
import { ChatMessageDto } from './dto/chat-message.dto';
import { FeedbackDto } from './dto/feedback.dto';

/** Express request augmented by SessionGuard with the validated session ID. */
type SessionRequest = Request & { sessionId: string };

@ApiTags('chat')
@ApiSecurity('session-id')
@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(private readonly chatService: ChatService) {}

  /**
   * Main SSE chat endpoint.
   *
   * Uses `@Res()` WITHOUT `passthrough: true` — response lifecycle is owned entirely
   * by ChatService via res.write() / res.end(). NestJS response interceptors are
   * bypassed for this route so they cannot buffer the SSE token stream.
   *
   * Rate limiting is handled inside ChatService (Redis INCR counter per session_id).
   * TooManyRequestsException is thrown BEFORE SSE headers are flushed, so the global
   * HttpExceptionFilter can still return a proper 429 JSON response.
   */
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a message and stream the RAG response via SSE' })
  @ApiResponse({ status: 200, description: 'SSE token stream (text/event-stream)' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded (10 messages per 60s)' })
  async chat(
    @Body() dto: ChatMessageDto,
    @Req() req: SessionRequest,
    @Res() res: Response,
  ): Promise<void> {
    this.logger.log({ event: 'chat_request', sessionId: req.sessionId });
    await this.chatService.handleChat(dto, req.sessionId, res);
  }

  /**
   * Retry endpoint — deletes the last assistant response and regenerates it.
   * Implicitly sets skipCache=true and uses a lower temperature (0.4) for variety.
   */
  @Post('retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete the last AI response and regenerate it' })
  @ApiResponse({ status: 200, description: 'SSE token stream for the new response' })
  async retry(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    this.logger.log({ event: 'retry_request', sessionId: req.sessionId });
    await this.chatService.handleRetry(req.sessionId, res);
  }

  /**
   * Feedback endpoint — submits thumbs up (+1) or thumbs down (-1) to Langfuse.
   * Returns 204 No Content; the score binding is non-blocking.
   */
  @Post('feedback')
  @HttpCode(204)
  @ApiOperation({ summary: 'Submit user feedback for a chat response' })
  @ApiResponse({ status: 204, description: 'Feedback recorded successfully' })
  async feedback(@Body() dto: FeedbackDto): Promise<void> {
    await this.chatService.handleFeedback(dto);
  }
}
