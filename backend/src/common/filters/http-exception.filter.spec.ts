import { HttpException, HttpStatus } from '@nestjs/common';
import { normalizeException } from './http-exception.filter';

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
});
