---
name: M2 Document Upload & Processing Pipeline Status
description: M2 complete — document upload, Bull queue, PDF/text parsing, semantic chunking, pgvector bulk insert, SHA-256 dedup, delete with cache flush + ghost message; 50 tests green
type: project
---

M2 is complete as of 2026-04-24.

**Why:** M2 delivers the full document ingestion pipeline that M3 (chat/RAG) depends on for retrieval context.

**How to apply:** When starting M3, `document_chunks` rows exist in Postgres with `embedding vector(1536)` and `search_vector tsvector` populated. The HNSW and GIN indexes are live. `VectorService.embedAndStore()` is the write path; M3 needs only the read/retrieval path.

## Files created

### Worker layer
- `backend/src/modules/worker/types/document-job.types.ts` — `DOCUMENT_PROCESSING_QUEUE` constant + `DocumentJobPayloadSchema` (Zod) + `DocumentJobPayload` type
- `backend/src/modules/worker/worker.module.ts` — `BullModule.forRootAsync` (reads `REDIS_HOST`/`REDIS_PORT` from ConfigService, legacy `bull@4` format `redis: { host, port }` NOT `connection: {}`), `registerQueue` with `settings: { lockDuration: 30_000, maxStalledCount: 2 }`, exports `BullModule`
- `backend/src/modules/worker/vector.service.ts` — single-batch `embedDocuments()` call, single `$executeRaw` bulk INSERT with `::vector` + `::jsonb` casts; `tsvectorupdate` trigger auto-populates `search_vector`; `EMBED_LATENCY_BUDGET_MS = 5_000`
- `backend/src/modules/worker/document.processor.ts` — 9-phase pipeline (`@Process('process-document')`), `@OnQueueFailed()` hook, PDF via `pdf-parse@1` (v1.1.4 — callable function API; v2 is class-based and incompatible), semantic chunking via `createSplitter(mimeType)`

### Document layer
- `backend/src/modules/document/dto/upload-document.dto.ts` — `{ jobId, documentId, status: 'PENDING' }`
- `backend/src/modules/document/dto/document-status.dto.ts` — `{ documentId, status: DocumentStatus, errorMessage?, tokenCount? }`
- `backend/src/modules/document/document.service.ts` — `uploadDocument` (SHA-256 dedup → 409 + orphan unlink, `Document.create`, Zod validate, `queue.add`, `Document.update(jobId)`, latency warn >200ms), `getStatusByJobId`, `deleteDocument` (cascade delete → Redis flush → ghost message)
- `backend/src/modules/document/document.controller.ts` — Multer `diskStorage` to `/app/uploads/{sessionId}/`, `limits: { fileSize: 10MB }`, fileFilter (4 MIME types), `@UseFilters(MulterExceptionFilter)`
- `backend/src/modules/document/document.module.ts` — `imports: [WorkerModule]`

### Common
- `backend/src/common/filters/multer-exception.filter.ts` — catches `multer.MulterError`; `LIMIT_FILE_SIZE` → 413, others → 415; scoped to `DocumentController` only (NOT global)

### Modified
- `backend/src/app.module.ts` — added `DocumentModule` import

## Key implementation details

### Semantic chunking (`document.processor.ts:190-210`)
- `text/markdown` → `MarkdownTextSplitter` — adds heading separators `['\n## ', '\n### ', '\n#### ']` before `['\n\n', '\n', ' ', '']`; keeps content within one section's scope
- All other types → `RecursiveCharacterTextSplitter` with **explicit** `separators: ['\n\n', '\n', ' ', '']` (never rely on library defaults)
- `CHUNK_SIZE = 1_000`, `CHUNK_OVERLAP = 200`

### Bull queue (legacy `bull@4`, NOT `bullmq`)
- `@nestjs/bull@11.0.4` wraps legacy `bull@4.16.5` — config uses `redis: { host, port }` not `connection: {}`
- `JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: true, removeOnFail: false }`
- Job payload validated by Zod at **both** producer (`document.service.ts`) and consumer (`document.processor.ts`)

### Multer fileFilter callback
- When rejecting, call `cb(new UnsupportedMediaTypeException(...))` with **one argument only** — passing `false` as second arg causes a TypeScript error because the error overload has no second param

### Orphan file cleanup on permanent failure (`document.processor.ts`)
- `onFailed` is async; fires after every failed attempt
- On **final** failure (`job.attemptsMade >= job.opts.attempts`): deletes `job.data.filePath` — non-fatal warn log if unlink fails
- On **intermediate** failures: file is left intact so the retry attempt can re-parse it
- Successful jobs already delete the file in Phase 9 (unchanged)
- No schema change needed — `filePath` is in the job payload, not the DB

### Delete flow
- Cascade delete via Prisma removes all `document_chunks` atomically
- Redis flush: `redis.client.keys('session:{sessionId}:*')` → pipeline delete (O(N) — comment marks where SCAN should replace for large deployments)
- Ghost message: `role: 'system'`, content `"[SYSTEM DIRECTIVE: Document '{filename}' has been deleted. Ignore facts from it in prior history.]"` — prevents chat pipeline hallucinating from deleted content
- Both Redis flush and ghost message are **non-fatal** (log warn/error, never rethrow)

### pgvector INSERT pattern (`vector.service.ts`)
```typescript
await this.prisma.$executeRaw`
  INSERT INTO document_chunks (id, document_id, session_id, content, metadata, embedding)
  VALUES ${Prisma.join(
    rows.map(r => Prisma.sql`(${r.id}, ${r.documentId}, ${r.sessionId}, ${r.content}, ${r.metadata}::jsonb, ${r.embedding}::vector)`)
  )}
`;
```
- `$executeRaw` called as tagged template — second arg is the `Prisma.join(...)` result
- In tests, `mock.calls[0][1].strings` contains `::vector`/`::jsonb`; `mock.calls[0][1].values` contains bound params

## Tests
- `document.controller.spec.ts` — 9 tests
- `document.service.spec.ts` — 14 tests
- `document.processor.spec.ts` — 18 tests (chunking edge cases, token limit, error handling, PDF, orphan file cleanup)
- `vector.service.spec.ts` — 9 tests (batch embed, single INSERT, Prisma.Sql structure)
- **53 / 53 passing** (4 pre-existing `session.guard.spec.ts` failures are unrelated to M2 — mock context missing `getHandler`/`getClass`)

## Token limit
- `MAX_TOKEN_COUNT = 50_000` — counts via `getEncoding('cl100k_base')` (js-tiktoken, same BPE as gpt-4o / text-embedding-3-small)
- Exceeding limit → `status: FAILED` + errorMessage, job retried per backoff policy
