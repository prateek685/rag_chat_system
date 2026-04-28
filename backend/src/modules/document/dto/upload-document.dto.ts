import { ApiProperty } from '@nestjs/swagger';

/** Response shape for POST /api/documents/upload. */
export class UploadDocumentResponseDto {
  @ApiProperty({ description: 'BullMQ job ID — use with GET /status/:jobId to poll processing state' })
  jobId!: string;

  @ApiProperty({ description: 'Document row UUID' })
  documentId!: string;

  @ApiProperty({ enum: ['PENDING'], description: 'Initial processing status — always PENDING on upload' })
  status!: 'PENDING';
}
