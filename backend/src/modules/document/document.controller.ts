import * as path from 'path';
import * as fs from 'fs';
import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
  UploadedFile,
  UnsupportedMediaTypeException,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage, Options as MulterOptions } from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { MulterExceptionFilter } from '../../common/filters/multer-exception.filter';
import { DocumentService } from './document.service';
import { UploadDocumentResponseDto } from './dto/upload-document.dto';
import { DocumentStatusResponseDto } from './dto/document-status.dto';

/**
 * Base path for uploaded files.
 * In Docker this maps to the /app/uploads volume mount.
 * Locally it defaults to an `uploads/` folder in the project root.
 */
const UPLOADS_BASE = process.env.UPLOADS_PATH ?? require('path').join(process.cwd(), 'uploads');

/** Maximum file size in bytes — enforced by Multer before the handler runs. */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Allowed MIME types. Any other type is rejected with 415 before the handler runs. */
const ALLOWED_MIME_TYPES = new Set<string>([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/pdf',
]);

/** Express request extended with sessionId attached by SessionGuard. */
type SessionRequest = Request & { sessionId: string };

/**
 * Multer diskStorage configuration.
 * Files are saved to {UPLOADS_BASE}/{sessionId}/{uuid}-{sanitisedName}.{ext}
 * so the absolute path can be derived from metadata alone without a DB lookup.
 */
const multerDiskOptions: MulterOptions = {
  storage: diskStorage({
    destination: (req: SessionRequest, _file, cb) => {
      const dir = path.join(UPLOADS_BASE, req.sessionId);
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
      // MulterExceptionFilter catches it if it is an HttpException;
      // the global HttpExceptionFilter handles it otherwise.
      // Multer's FileFilterCallback overload: cb(error) aborts the upload.
      // No second argument here — passing false alongside an error is not in the type.
      cb(
        new UnsupportedMediaTypeException(
          `File type '${file.mimetype}' is not allowed. Accepted: .txt, .csv, .md, .pdf`,
        ),
      );
    }
  },
};

@ApiTags('documents')
@ApiSecurity('session-id')
@Controller('documents')
@UseFilters(MulterExceptionFilter)
export class DocumentController {
  private readonly logger = new Logger(DocumentController.name);

  constructor(private readonly documentService: DocumentService) {}

  /**
   * Uploads a document for processing. Returns immediately with a jobId for status polling.
   * The file is saved to disk by Multer, then enqueued for background processing.
   *
   * @param file - Uploaded file from multipart/form-data.
   * @param req - Extended request carrying the validated sessionId from SessionGuard.
   * @returns Upload response with jobId, documentId, and PENDING status.
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', multerDiskOptions))
  @ApiOperation({ summary: 'Upload a document for RAG processing' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 201, type: UploadDocumentResponseDto })
  @ApiResponse({ status: 409, description: 'Duplicate file content in session' })
  @ApiResponse({ status: 413, description: 'File exceeds 10 MB' })
  @ApiResponse({ status: 415, description: 'Unsupported file type' })
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: SessionRequest,
  ): Promise<UploadDocumentResponseDto> {
    if (!file) {
      throw new BadRequestException('No file provided — include a file field in the multipart body');
    }
    return this.documentService.uploadDocument(file, req.sessionId);
  }

  /**
   * Polls the processing status of a previously uploaded document.
   * Uses the jobId returned by the upload endpoint as the lookup key.
   *
   * @param jobId - BullMQ job ID string.
   * @param req - Extended request carrying the validated sessionId.
   * @returns Current document status DTO.
   */
  @Get('status/:jobId')
  @ApiOperation({ summary: 'Poll document processing status by job ID' })
  @ApiResponse({ status: 200, type: DocumentStatusResponseDto })
  @ApiResponse({ status: 404, description: 'Job ID not found for this session' })
  async getStatus(
    @Param('jobId') jobId: string,
    @Req() req: SessionRequest,
  ): Promise<DocumentStatusResponseDto> {
    return this.documentService.getStatusByJobId(jobId, req.sessionId);
  }

  /**
   * Deletes a document and all associated chunks. Flushes related Redis cache keys
   * and inserts a ghost system message to prevent the chat pipeline from hallucinating
   * from deleted content.
   *
   * @param documentId - UUID of the document to delete.
   * @param req - Extended request carrying the validated sessionId.
   */
  @Delete(':documentId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a document and flush related cache' })
  @ApiResponse({ status: 204, description: 'Document deleted' })
  @ApiResponse({ status: 403, description: 'Document belongs to a different session' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  async deleteDocument(
    @Param('documentId') documentId: string,
    @Req() req: SessionRequest,
  ): Promise<void> {
    await this.documentService.deleteDocument(documentId, req.sessionId);
  }
}
