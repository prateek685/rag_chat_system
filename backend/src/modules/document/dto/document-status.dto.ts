import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentStatus } from '@prisma/client';

/** Response shape for GET /api/documents/status/:jobId. */
export class DocumentStatusResponseDto {
  @ApiProperty({ description: 'Document row UUID' })
  documentId!: string;

  @ApiProperty({ enum: DocumentStatus, description: 'Current processing status' })
  status!: DocumentStatus;

  @ApiPropertyOptional({ description: 'Error detail when status is FAILED' })
  errorMessage?: string | null;

  @ApiPropertyOptional({ description: 'Token count (populated when status is COMPLETED)' })
  tokenCount?: number | null;
}
