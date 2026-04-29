import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { HttpExceptionFilter, normalizeException } from './http-exception.filter';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHost(opts: {
  url?: string;
  method?: string;
  traceId?: string;
}): { host: ArgumentsHost; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const ctx = {
    getResponse: jest.fn().mockReturnValue({ status }),
    getRequest: jest.fn().mockReturnValue({
      url: opts.url ?? '/api/test',
      method: opts.method ?? 'GET',
      traceId: opts.traceId,
    }),
  };
  return {
    host: { switchToHttp: jest.fn().mockReturnValue(ctx) } as unknown as ArgumentsHost,
    status,
    json,
  };
}

describe('normalizeException', () => {
  it('should normalize a standard nested HttpException gracefully', () => {
    const errorResponse = { message: ['Validation failed'], error: 'Bad Request', statusCode: 400 };
    const exception = new HttpException(errorResponse, HttpStatus.BAD_REQUEST);
    const result = normalizeException(exception);

    expect(result).toEqual({
      status: 400,
      message: ['Validation failed'],
      error: 'Bad Request',
    });
  });

  it('should normalize a string HttpException', () => {
    const exception = new HttpException('Forbidden access', HttpStatus.FORBIDDEN);
    const result = normalizeException(exception);

    expect(result).toEqual({
      status: 403,
      message: 'Forbidden access',
      error: undefined,
    });
  });

  it('should handle standard Error instances gracefully without exposing internals to message', () => {
    const exception = new Error('Some internal database failure');
    const result = normalizeException(exception);

    expect(result).toEqual({
      status: 500,
      message: 'Internal server error',
    });
  });

  it('should handle completely unknown exceptions correctly', () => {
    const exception = { random: 'object' };
    const result = normalizeException(exception);

    expect(result).toEqual({
      status: 500,
      message: 'Internal server error',
    });
  });

  it('should handle null correctly', () => {
    const exception = null;
    const result = normalizeException(exception);

    expect(result).toEqual({
      status: 500,
      message: 'Internal server error',
    });
  });

  it('defaults message to "Internal server error" when HttpException response object has no message field', () => {
    const exception = new HttpException({ code: 'CUSTOM' } as object, HttpStatus.UNPROCESSABLE_ENTITY);
    const result = normalizeException(exception);
    expect(result.message).toBe('Internal server error');
  });
});

// ─── HttpExceptionFilter.catch() ─────────────────────────────────────────────

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
  });

  it('sends the correct HTTP status and JSON body for an HttpException', () => {
    const { host, status, json } = makeHost({ url: '/api/chat', method: 'POST' });

    filter.catch(new NotFoundException('Resource not found'), host);

    // NotFoundException wraps the custom string as `message`; the standard phrase
    // ('Not Found') lands in `error`.
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, message: 'Resource not found', path: '/api/chat' }),
    );
  });

  it('includes the error field when the exception response carries one', () => {
    const { host, json } = makeHost({});

    filter.catch(new BadRequestException(['name must not be empty']), host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, error: 'Bad Request' }),
    );
  });

  it('omits the error field when the exception response has none', () => {
    const { host, json } = makeHost({});

    filter.catch(new HttpException('Unprocessable', HttpStatus.UNPROCESSABLE_ENTITY), host);

    const body = (json.mock.calls[0] as [Record<string, unknown>])[0];
    expect(body.error).toBeUndefined();
  });

  it('returns 500 for non-HttpException errors', () => {
    const { host, status } = makeHost({});

    filter.catch(new Error('db connection lost'), host);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('includes request.traceId in the response when present', () => {
    const { host, json } = makeHost({ traceId: 'trace-xyz' });

    filter.catch(new NotFoundException('x'), host);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ traceId: 'trace-xyz' }));
  });

  it('falls back to "unknown" traceId when request.traceId is absent', () => {
    const { host, json } = makeHost({ traceId: undefined });

    filter.catch(new NotFoundException('x'), host);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ traceId: 'unknown' }));
  });

  it('includes an ISO timestamp in the response body', () => {
    const { host, json } = makeHost({});

    filter.catch(new NotFoundException('x'), host);

    const body = (json.mock.calls[0] as [Record<string, unknown>])[0];
    expect(new Date(body.timestamp as string).getTime()).not.toBeNaN();
  });
});
