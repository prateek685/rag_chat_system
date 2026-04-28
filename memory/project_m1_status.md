---
name: M1 Database & Session Foundation Status
description: M1 complete — Prisma schema, PrismaService (Prisma 7 adapter), SessionGuard, all tests green
type: project
---

M1 is complete as of 2026-04-22.

**Why:** M1 establishes the DB schema and session contract that M2 (document upload) and M3 (chat pipeline) both depend on.

**How to apply:** When starting M2, PrismaService is injectable everywhere (global module) and `request.sessionId` is always populated by SessionGuard before any controller runs.

## What was done

### Schema (`backend/prisma/schema.prisma`)
- 4 models: `Session`, `Document`, `DocumentChunk`, `Message`
- `DocumentStatus` enum: `PENDING | PROCESSING | COMPLETED | FAILED`
- `MessageRole` enum: `user | assistant | system`
- `Document.fileHash` — SHA-256; `@@unique([sessionId, fileHash])` for dedup
- `DocumentChunk.embedding` — `Unsupported("vector(1536)")`, written via `$executeRaw`
- `DocumentChunk.searchVector` — `Unsupported("tsvector")`, populated by DB trigger
- `@@index([sessionId])` on `document_chunks` — all retrieval queries filter by session
- `@@index([sessionId, createdAt(sort: Asc)])` on `messages` — sliding window memory query
- `onDelete: Cascade` on Document→Session and Message→Session relations
- All camelCase Prisma fields mapped to `snake_case` DB columns via `@map`

### Prisma 7 config (see `project_prisma7_adapter.md` for full detail)
- `backend/prisma.config.ts` — datasource URL for CLI
- `PrismaService` constructor passes `new PrismaPg({ connectionString })` to `super({ adapter })`

### NestJS wiring
- `backend/src/modules/prisma/prisma.module.ts` — `@Global()` singleton
- `backend/src/modules/prisma/prisma.service.ts` — connect/disconnect lifecycle
- `backend/src/common/guards/session.guard.ts` — validates UUIDv4, upserts Session row, attaches `request.sessionId`
- `backend/src/app.module.ts` — `PrismaModule` imported, `SessionGuard` as `APP_GUARD` (global)

### Tests
- `prisma.service.spec.ts` — 3 tests (connect, disconnect, defined)
- `session.guard.spec.ts` — 4 tests (missing header, invalid UUID, v1 UUID, valid UUID upserts + attaches)
- 7 / 7 passing
