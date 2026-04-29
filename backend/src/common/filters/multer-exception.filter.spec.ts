import multer from 'multer';
import { ArgumentsHost } from '@nestjs/common';
import { MulterExceptionFilter } from './multer-exception.filter';

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeHost(url = '/api/documents'): {
  host: ArgumentsHost;
  status: jest.Mock;
  json: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const ctx = {
    getResponse: jest.fn().mockReturnValue({ status }),
    getRequest: jest.fn().mockReturnValue({ url }),
  };
  return {
    host: { switchToHttp: jest.fn().mockReturnValue(ctx) } as unknown as ArgumentsHost,
    status,
    json,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MulterExceptionFilter', () => {
  let filter: MulterExceptionFilter;

  beforeEach(() => {
    filter = new MulterExceptionFilter();
  });

  it('maps LIMIT_FILE_SIZE to 413 with the size-limit message', () => {
    const { host, status, json } = makeHost();

    filter.catch(new multer.MulterError('LIMIT_FILE_SIZE'), host);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 413,
        message: 'File exceeds the 10 MB size limit',
      }),
    );
  });

  it('maps any other MulterError code to 415 UnsupportedMediaType', () => {
    const { host, status, json } = makeHost();

    filter.catch(new multer.MulterError('LIMIT_FIELD_COUNT'), host);

    expect(status).toHaveBeenCalledWith(415);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 415 }));
  });

  it('includes the request path in the response body', () => {
    const { host, json } = makeHost('/api/documents/upload');

    filter.catch(new multer.MulterError('LIMIT_FILE_SIZE'), host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/documents/upload' }),
    );
  });

  it('includes an ISO timestamp in the response body', () => {
    const { host, json } = makeHost();

    filter.catch(new multer.MulterError('LIMIT_FILE_SIZE'), host);

    const body = (json.mock.calls[0] as [Record<string, unknown>])[0];
    expect(new Date(body.timestamp as string).getTime()).not.toBeNaN();
  });
});
