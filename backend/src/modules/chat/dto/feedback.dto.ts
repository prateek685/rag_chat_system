import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class FeedbackDto {
  @ApiProperty({ description: 'Langfuse trace ID returned with the streamed response' })
  @IsString()
  @IsNotEmpty()
  traceId!: string;

  @ApiProperty({ description: 'User feedback score: 1 = thumbs up, -1 = thumbs down, 0 = cleared', enum: [1, -1, 0] })
  @IsIn([1, -1, 0])
  score!: 1 | -1 | 0;
}
