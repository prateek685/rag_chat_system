import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Helper to normalize exceptions to a consistent object, tested through the filter.
 */
export function normalizeException(exception: unknown): {
  status: number;
  message: string | string[];
  error?: string;
} {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();

    let message: string | string[] = 'Internal server error';
    let error: string | undefined;

    if (typeof response === 'string') {
      message = response;
    } else if (typeof response === 'object' && response !== null) {
      const resObj = response as any;
      message = resObj.message ?? message;
      error = resObj.error;
    }

    return { status, message, error };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'Internal server error',
  };
}

interface ErrorResponse {
  statusCode: number;
  timestamp: string;
  path: string;
  traceId: string;
  message: string | string[];
  error?: string;
}

/**
 * Global exception filter — catches all thrown exceptions and formats
 * them into a consistent JSON error envelope before sending to the client.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { traceId?: string }>();

    const normalized = normalizeException(exception);
    const traceId = request.traceId ?? 'unknown';

    this.logger.error({
      event: 'http_exception',
      status: normalized.status,
      path: request.url,
      method: request.method,
      traceId,
      error: exception instanceof Error ? exception.message : String(exception),
    });

    const errorResponse: ErrorResponse = {
      statusCode: normalized.status,
      timestamp: new Date().toISOString(),
      path: request.url,
      traceId,
      message: normalized.message,
    };

    if (normalized.error) {
      errorResponse.error = normalized.error;
    }

    response.status(normalized.status).json(errorResponse);
  }
}
