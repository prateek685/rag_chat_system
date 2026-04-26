import * as path from 'path';
import * as fs from 'fs';
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  UnsupportedMediaTypeException,
  Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import type { Request } from 'express';
import { EnvConfig } from '../../config/env.config';

/** Maximum file size in bytes — enforced by Multer before the handler runs. */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Allowed MIME types. Any other type is rejected with 415 before the handler runs. */
const ALLOWED_MIME_TYPES = new Set<string>([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/pdf',
]);

type SessionRequest = Request & { sessionId: string };

/**
 * Injectable Multer interceptor for document uploads.
 *
 * Reads UPLOADS_PATH from ConfigService (Joi-validated at startup) so the
 * boot-order guarantee holds and tests can override via ConfigService mock
 * rather than mutating process.env.
 *
 * Files are saved to {uploadsBase}/{sessionId}/{uuid}-{sanitisedName}{ext}.
 */
@Injectable()
export class DocumentUploadInterceptor implements NestInterceptor {
  private readonly delegate: NestInterceptor;

  constructor(config: ConfigService<EnvConfig, true>) {
    const uploadsBase =
      config.get('UPLOADS_PATH', { infer: true }) ?? path.join(process.cwd(), 'uploads');
    const FileInterceptorClass: Type<NestInterceptor> = FileInterceptor(
      'file',
      buildMulterOptions(uploadsBase),
    );
    this.delegate = new FileInterceptorClass();
  }

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> | Promise<Observable<unknown>> {
    return this.delegate.intercept(context, next);
  }
}

/**
 * Builds Multer disk-storage options for the given uploads base path.
 *
 * @param uploadsBase - Absolute path to the uploads root directory.
 */
function buildMulterOptions(uploadsBase: string): MulterOptions {
  return {
    storage: diskStorage({
      destination: (req: unknown, _file, cb) => {
        const sessionId = (req as SessionRequest).sessionId || 'no-session';
        const dir = path.join(uploadsBase, sessionId);
        // mkdirSync is synchronous but fast — creates the session directory on first upload.
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname);
        const baseName = path
          .basename(file.originalname, ext)
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 50);
        cb(null, `${uuidv4()}-${baseName}${ext}`);
      },
    }),
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
        cb(null, true);
      } else {
        // Passing an Error to cb causes Multer to abort the upload.
        cb(
          new UnsupportedMediaTypeException(
            `File type '${file.mimetype}' is not allowed. Accepted: .txt, .csv, .md, .pdf`,
          ),
          false,
        );
      }
    },
  };
}
