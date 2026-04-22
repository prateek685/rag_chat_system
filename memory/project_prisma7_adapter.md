---
name: Prisma 7 Driver Adapter Pattern
description: How Prisma 7.7.0 is configured — url removed from schema, prisma.config.ts + @prisma/adapter-pg required
type: project
---

Prisma 7 removed `url = env("DATABASE_URL")` from `schema.prisma`. Running `prisma generate` without the fix throws `P1012`.

**Why:** Prisma 7 mandates driver adapters; built-in connection handling was removed entirely.

**How to apply:** Never add `url` back to `schema.prisma`. Any new service that instantiates `PrismaClient` must pass `{ adapter }`. Migrations and generate commands rely on `prisma.config.ts` being present at `backend/`.

## The three-part fix

### 1. `backend/prisma/schema.prisma` — no url, no previewFeatures, no extensions
```prisma
generator client { provider = "prisma-client-js" }
datasource db    { provider = "postgresql" }
```
pgvector is enabled by `init-db.sql`; `Unsupported("vector(1536)")` still works without extensions in schema.

### 2. `backend/prisma.config.ts` — URL for Prisma CLI
```ts
import 'dotenv/config'
import { defineConfig } from 'prisma/config'
export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL! },
})
```

### 3. `PrismaService` — adapter for runtime
```ts
import { PrismaPg } from '@prisma/adapter-pg'
constructor() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL environment variable is not set')
  super({ adapter: new PrismaPg({ connectionString: url }) })
}
```

## Installed packages
`@prisma/adapter-pg`, `pg`, `@types/pg`

## Test mocking pattern
Mock `PrismaClient` as a **real class** (not `jest.fn().mockImplementation(() => plainObject)`) — returning a plain object from a constructor replaces `this` and strips the subclass prototype methods:
```ts
jest.mock('@prisma/client', () => {
  class MockPrismaClient {
    constructor(_opts: unknown) {}
    $connect = jest.fn().mockResolvedValue(undefined)
    $disconnect = jest.fn().mockResolvedValue(undefined)
  }
  return { PrismaClient: MockPrismaClient }
})
```
