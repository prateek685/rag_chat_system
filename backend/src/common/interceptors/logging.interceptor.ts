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

/** Logs every incoming request and its response latency. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const { method, url } = req;
    const sessionId = req.headers['x-session-id'] ?? 'no-session';
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const latencyMs = Date.now() - start;
        this.logger.log({
          event: 'request_completed',
          method,
          url,
          sessionId,
          latencyMs,
        });
      }),
    );
  }
}
