import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { DocumentProcessor } from './document.processor';
import { VectorService } from './vector.service';
import { DOCUMENT_PROCESSING_QUEUE } from './types/document-job.types';
import { ObservabilityModule } from '../observability/observability.module';

/**
 * Owns the BullMQ queue definition and all background processing providers.
 * Exports BullModule so DocumentModule can inject the queue via @InjectQueue.
 */
@Module({
  imports: [
    ObservabilityModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      /**
       * Uses ConfigService (validated at startup) instead of process.env.
       * BullMQ manages its own Redis connection separate from the global ioredis
       * singleton — the queue needs a dedicated non-blocking connection.
       */
      useFactory: (config: ConfigService): { connection: { host: string; port: number } } => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT', 6379),
        },
      }),
    }),
    BullModule.registerQueue({
      name: DOCUMENT_PROCESSING_QUEUE,
    }),
  ],
  providers: [DocumentProcessor, VectorService],
  /** Exports the queue token so DocumentModule can inject Queue<DocumentJobPayload>. */
  exports: [BullModule],
})
export class WorkerModule {}
