import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

function makeContext(overrides: {
  method?: string;
  url?: string;
  sessionId?: string;
} = {}): ExecutionContext {
  const req = {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/api/chat',
    headers: { 'x-session-id': overrides.sessionId ?? 'session-abc' },
    traceId: undefined as string | undefined,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
    getHandler: jest.fn(),
    getClass: jest.fn(),
  } as unknown as ExecutionContext;
}

function makeHandler(payload: unknown = { ok: true }): CallHandler {
  return { handle: jest.fn().mockReturnValue(of(payload)) };
}

function makeErrorHandler(error: Error): CallHandler {
  return { handle: jest.fn().mockReturnValue(throwError(() => error)) };
}

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
  });

  describe('intercept() — happy path', () => {
    it('calls next.handle() and forwards the response value', (done) => {
      const ctx = makeContext();
      const next = makeHandler({ data: 'hello' });

      interceptor.intercept(ctx, next).subscribe({
        next: (val) => {
          expect(val).toEqual({ data: 'hello' });
          done();
        },
      });
    });

    it('attaches a traceId UUID to the request object', (done) => {
      const req = {
        method: 'POST',
        url: '/api/documents',
        headers: { 'x-session-id': 'sess-1' },
        traceId: undefined as string | undefined,
      };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: jest.fn(),
        getClass: jest.fn(),
      } as unknown as ExecutionContext;

      interceptor.intercept(ctx, makeHandler()).subscribe({
        complete: () => {
          expect(req.traceId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          );
          done();
        },
      });
    });

    it('logs request_completed on success', (done) => {
      const logSpy = jest
        .spyOn((interceptor as unknown as { logger: { log: jest.Mock } }).logger, 'log')
        .mockImplementation(() => {});

      const ctx = makeContext({ method: 'GET', url: '/api/chat', sessionId: 'sess-42' });

      interceptor.intercept(ctx, makeHandler()).subscribe({
        complete: () => {
          expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              event: 'request_completed',
              method: 'GET',
              url: '/api/chat',
              sessionId: 'sess-42',
            }),
          );
          done();
        },
      });
    });

    it('includes a numeric latencyMs in the log', (done) => {
      const logSpy = jest
        .spyOn((interceptor as unknown as { logger: { log: jest.Mock } }).logger, 'log')
        .mockImplementation(() => {});

      interceptor.intercept(makeContext(), makeHandler()).subscribe({
        complete: () => {
          const call = logSpy.mock.calls[0][0] as { latencyMs: unknown };
          expect(typeof call.latencyMs).toBe('number');
          done();
        },
      });
    });
  });

  describe('intercept() — error path', () => {
    it('logs request_failed on error', (done) => {
      const warnSpy = jest
        .spyOn((interceptor as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => {});

      const ctx = makeContext({ method: 'POST', url: '/api/chat' });
      const next = makeErrorHandler(new Error('upstream failure'));

      interceptor.intercept(ctx, next).subscribe({
        error: () => {
          expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              event: 'request_failed',
              method: 'POST',
              url: '/api/chat',
              error: 'upstream failure',
            }),
          );
          done();
        },
      });
    });

    it('re-emits the error so upstream handlers can catch it', (done) => {
      jest
        .spyOn((interceptor as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => {});

      const thrownErr = new Error('db timeout');
      interceptor.intercept(makeContext(), makeErrorHandler(thrownErr)).subscribe({
        error: (err) => {
          expect(err).toBe(thrownErr);
          done();
        },
      });
    });

    it('falls back to "no-session" when x-session-id header is absent', (done) => {
      const logSpy = jest
        .spyOn((interceptor as unknown as { logger: { log: jest.Mock } }).logger, 'log')
        .mockImplementation(() => {});

      const req = { method: 'GET', url: '/health', headers: {}, traceId: undefined };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: jest.fn(),
        getClass: jest.fn(),
      } as unknown as ExecutionContext;

      interceptor.intercept(ctx, makeHandler()).subscribe({
        complete: () => {
          expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: 'no-session' }),
          );
          done();
        },
      });
    });
  });
});
