import { Module } from '@nestjs/common';
import { WorkerModule } from '../worker/worker.module';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';

/**
 * Owns the document upload, status polling, and deletion endpoints.
 * Imports WorkerModule to receive the BullMQ queue token via @InjectQueue.
 * PrismaModule and RedisModule are global — no explicit import required.
 */
@Module({
  imports: [WorkerModule],
  controllers: [DocumentController],
  providers: [DocumentService],
})
export class DocumentModule {}
