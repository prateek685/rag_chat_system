import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration (prisma generate, prisma migrate).
 * The runtime client reads the URL separately via the PrismaPg adapter
 * passed to PrismaClient({ adapter }) in PrismaService.
 */
export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL is not set'); })(),
  },
});
