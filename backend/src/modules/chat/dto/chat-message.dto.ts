import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ChatMessageDto {
  @ApiProperty({ description: 'The user message to send to the RAG pipeline', maxLength: 4000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  message!: string;

  @ApiPropertyOptional({ description: 'When true, bypasses the exact-match Redis cache' })
  @IsOptional()
  @IsBoolean()
  skipCache?: boolean;
}
