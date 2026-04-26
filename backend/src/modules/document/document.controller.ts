import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
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
import { Request } from 'express';
import { MulterExceptionFilter } from '../../common/filters/multer-exception.filter';
import { DocumentService } from './document.service';
import { DocumentUploadInterceptor } from './document-upload.interceptor';
import { UploadDocumentResponseDto } from './dto/upload-document.dto';
import { DocumentStatusResponseDto } from './dto/document-status.dto';

/** Express request extended with sessionId attached by SessionGuard. */
type SessionRequest = Request & { sessionId: string };

@ApiTags('documents')
@ApiSecurity('session-id')
@Controller('documents')
@UseFilters(MulterExceptionFilter)
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  /**
   * Uploads a document for processing. Returns immediately with a jobId for status polling.
   * File validation (type, size) and disk storage are handled by DocumentUploadInterceptor.
   *
   * @param file - Uploaded file from multipart/form-data.
   * @param req - Extended request carrying the validated sessionId from SessionGuard.
   * @returns Upload response with jobId, documentId, and PENDING status.
   */
  @Post('upload')
  @UseInterceptors(DocumentUploadInterceptor)
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
    @Req() req: SessionRequest & { file?: Express.Multer.File },
  ): Promise<UploadDocumentResponseDto> {
    const file = req.file;
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
