import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import multer from 'multer';

/**
 * Scoped to DocumentController — catches MulterError thrown by Multer middleware
 * before the handler runs and maps it to the appropriate NestJS HTTP exception.
 * Not registered globally because Multer errors only occur on upload routes.
 */
@Catch(multer.MulterError)
export class MulterExceptionFilter implements ExceptionFilter {
  catch(exception: multer.MulterError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const mapped =
      exception.code === 'LIMIT_FILE_SIZE'
        ? new PayloadTooLargeException('File exceeds the 10 MB size limit')
        : new UnsupportedMediaTypeException(exception.message);

    response.status(mapped.getStatus()).json({
      statusCode: mapped.getStatus(),
      timestamp: new Date().toISOString(),
      path: request.url,
      message: mapped.message,
    });
  }
}
