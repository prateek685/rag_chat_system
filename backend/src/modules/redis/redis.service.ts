import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Singleton ioredis client managed by NestJS lifecycle hooks.
 * Exported from RedisModule (@Global) so BullMQ and ChatService
 * can inject it without re-importing RedisModule.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  /** Raw ioredis client — inject RedisService and access .client for direct use. */
  readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.getOrThrow<string>('REDIS_HOST');
    const port = this.configService.get<number>('REDIS_PORT', 6379);

    this.client = new Redis({
      host,
      port,
      // Defer TCP handshake to onModuleInit so NestJS controls connection ordering.
      lazyConnect: true,
      // BullMQ requires maxRetriesPerRequest: null on the shared connection.
      maxRetriesPerRequest: null,
      // Fail fast on commands issued before connect() — surfaces misconfiguration early.
      enableOfflineQueue: false,
    });
  }

  /** Establishes the Redis connection after all providers are resolved. */
  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log('Redis connection established');
  }

  /** Sends QUIT so in-flight commands drain before the socket closes. */
  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis connection closed');
  }
}
