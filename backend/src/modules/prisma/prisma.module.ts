import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global singleton — import once in AppModule; PrismaService is injectable everywhere.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
