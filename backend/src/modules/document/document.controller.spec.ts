import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { UploadDocumentResponseDto } from './dto/upload-document.dto';
import { DocumentStatusResponseDto } from './dto/document-status.dto';

const mockUploadResponse: UploadDocumentResponseDto = {
  jobId: 'job-123',
  documentId: 'doc-uuid-456',
  status: 'PENDING',
};

const mockStatusResponse: DocumentStatusResponseDto = {
  documentId: 'doc-uuid-456',
  status: 'COMPLETED',
  errorMessage: null,
  tokenCount: 1024,
};

const mockFile = {
  originalname: 'test.txt',
  mimetype: 'text/plain',
  path: '/app/uploads/session-id/uuid-test.txt',
  size: 1024,
} as Express.Multer.File;

const mockReq = { sessionId: 'session-uuid-abc' } as unknown as Request & { sessionId: string };

describe('DocumentController', () => {
  let controller: DocumentController;
  let service: jest.Mocked<DocumentService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentController],
      providers: [
        {
          provide: DocumentService,
          useValue: {
            uploadDocument: jest.fn(),
            getStatusByJobId: jest.fn(),
            deleteDocument: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<DocumentController>(DocumentController);
    service = module.get(DocumentService);
  });

  describe('POST /upload', () => {
    it('calls service.uploadDocument with file and sessionId, returns 201 response', async () => {
      service.uploadDocument.mockResolvedValue(mockUploadResponse);

      const result = await controller.uploadDocument(mockFile, mockReq as never);

      expect(service.uploadDocument).toHaveBeenCalledWith(mockFile, 'session-uuid-abc');
      expect(result).toEqual(mockUploadResponse);
    });

    it('throws BadRequestException when no file is provided', async () => {
      await expect(
        controller.uploadDocument(undefined, mockReq as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(service.uploadDocument).not.toHaveBeenCalled();
    });

    it('propagates ConflictException from service (duplicate file)', async () => {
      service.uploadDocument.mockRejectedValue(new ConflictException('Duplicate'));
      await expect(controller.uploadDocument(mockFile, mockReq as never)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('propagates UnsupportedMediaTypeException (wrong MIME type)', async () => {
      service.uploadDocument.mockRejectedValue(new UnsupportedMediaTypeException('Not allowed'));
      await expect(controller.uploadDocument(mockFile, mockReq as never)).rejects.toBeInstanceOf(
        UnsupportedMediaTypeException,
      );
    });

    it('propagates PayloadTooLargeException (file too big)', async () => {
      service.uploadDocument.mockRejectedValue(new PayloadTooLargeException('Too large'));
      await expect(controller.uploadDocument(mockFile, mockReq as never)).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
    });
  });

  describe('GET /status/:jobId', () => {
    it('calls service.getStatusByJobId with jobId and sessionId, returns status DTO', async () => {
      service.getStatusByJobId.mockResolvedValue(mockStatusResponse);

      const result = await controller.getStatus('job-123', mockReq as never);

      expect(service.getStatusByJobId).toHaveBeenCalledWith('job-123', 'session-uuid-abc');
      expect(result).toEqual(mockStatusResponse);
    });

    it('propagates NotFoundException when job not found', async () => {
      service.getStatusByJobId.mockRejectedValue(new NotFoundException('Not found'));
      await expect(controller.getStatus('unknown-job', mockReq as never)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('DELETE /:documentId', () => {
    it('calls service.deleteDocument with documentId and sessionId', async () => {
      service.deleteDocument.mockResolvedValue(undefined);

      await controller.deleteDocument('doc-uuid-456', mockReq as never);

      expect(service.deleteDocument).toHaveBeenCalledWith('doc-uuid-456', 'session-uuid-abc');
    });

    it('propagates ForbiddenException when document belongs to different session', async () => {
      service.deleteDocument.mockRejectedValue(new ForbiddenException('Access denied'));
      await expect(
        controller.deleteDocument('doc-uuid-456', mockReq as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('propagates NotFoundException when document does not exist', async () => {
      service.deleteDocument.mockRejectedValue(new NotFoundException('Not found'));
      await expect(
        controller.deleteDocument('unknown-doc', mockReq as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
