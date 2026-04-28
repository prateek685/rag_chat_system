import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { randomUUID } from 'node:crypto';

/** Logs every incoming request and its response latency. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { traceId: string }>();
    const { method, url } = req;
    const sessionId = (req.headers['x-session-id'] as string) ?? 'no-session';
    const start = Date.now();
    const traceId = randomUUID();
    req.traceId = traceId;

    return next.handle().pipe(
      tap({
        next: () => {
          const latencyMs = Date.now() - start;
          this.logger.log({
            event: 'request_completed',
            method,
            url,
            sessionId,
            traceId,
            latencyMs,
          });
        },
        error: (err) => {
          const latencyMs = Date.now() - start;
          this.logger.warn({
            event: 'request_failed',
            method,
            url,
            sessionId,
            traceId,
            latencyMs,
            error: err.message,
          });
        },
      }),
    );
  }
}
