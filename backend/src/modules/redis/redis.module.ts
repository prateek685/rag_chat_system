import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Global singleton — import once in AppModule.
 * RedisService is injectable in every module without re-importing.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
