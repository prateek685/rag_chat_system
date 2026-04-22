# Skill: Document Processing Pipeline

## Scope
Everything that happens from file upload → parsed → chunked → embedded → stored in PostgreSQL.
Use this skill when working on: `modules/document/`, `modules/worker/`, Multer config, BullMQ jobs, LangChain loaders, `RecursiveCharacterTextSplitter`, embedding calls, Prisma upserts to `document_chunks`.

---

## Accepted File Types & Limits
- Extensions: `.txt`, `.csv`, `.md`, `.pdf`
- Max size: **10 MB per file**
- Max tokens per document: **50,000** (reject with `413` if exceeded)
- Dedup: SHA-256 hash of file buffer — reject with `409 Conflict` if hash exists for the session

---

## Pipeline Phases

### Phase 1 — Validation (Multer + NestJS Guard)
```typescript
// Guard checks: MIME type AND extension (not just one)
// Reject before any disk write on failure
```

### Phase 2 — Local Save
```
/uploads/{session_id}/{sanitised_filename}
```
- Sanitise filename: strip special chars, normalise unicode
- Clean up temp file on both success AND failure (use `finally` block)

### Phase 3 — BullMQ Job Creation
```typescript
await this.documentQueue.add('process-document', {
  sessionId,
  filePath,
  documentId,
}, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: false,   // retain for DLQ inspection
});
```
Controller returns `{ jobId, status: 'queued' }` immediately.

### Phase 4 — Parsing (LangChain Loaders)
| Extension | Loader |
|---|---|
| `.txt` / `.md` | `TextLoader` |
| `.csv` | `CSVLoader` |
| `.pdf` | `PDFLoader` |

All loaders inject `metadata: { source, page }` automatically. Preserve this — it becomes citation data.

### Phase 5 — Chunking
```typescript
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 800,         // characters (≈ 200 tokens)
  chunkOverlap: 100,
  separators: ['\n\n', '\n', ' ', ''],  // priority order
});
```
**Edge cases to handle (unit tested at 100% coverage):**
- Empty string `""` → return `[]`, do not throw
- Single character → return as single chunk
- No whitespace/newlines (wall of text) → splitter should still split at `chunkSize`
- Binary/corrupt content → catch error, mark document `FAILED`, do not crash worker

### Phase 6 — Embedding
```typescript
// Always batch — never call per chunk in a loop
const response = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: chunks.map(c => c.pageContent),
});
// response.data[i].embedding → Float32Array, 1536 dimensions
```

### Phase 7 — Storage
```typescript
// Use prisma.$transaction for atomicity
await prisma.$transaction(
  chunks.map((chunk, i) => prisma.$executeRaw`
    INSERT INTO document_chunks (id, document_id, session_id, content, metadata, embedding)
    VALUES (
      gen_random_uuid(),
      ${documentId},
      ${sessionId},
      ${chunk.pageContent},
      ${JSON.stringify(chunk.metadata)}::jsonb,
      ${JSON.stringify(embeddings[i])}::vector
    )
  `)
);
// tsvector is populated automatically by the Postgres trigger
```

---

## BullMQ Error Handling

```typescript
@OnWorkerEvent('failed')
async onFailed(job: Job, error: Error) {
  if (job.attemptsMade >= job.opts.attempts) {
    // Job exhausted — update document status to FAILED
    await this.prisma.document.update({
      where: { id: job.data.documentId },
      data: { status: 'FAILED', errorMessage: error.message },
    });
    // Check DLQ threshold and alert
    await this.alertIfDlqOverThreshold();
  }
}

// Stalled job config
lockDuration: 30_000,        // ms — worker must renew within this window
maxStalledCount: 2,          // prevent infinite crash loops
```

DLQ alert threshold: `N = 10` failed jobs → POST to Slack webhook.

---

## Document Status Polling
Frontend polls `GET /api/documents/status/:jobId` every 2 seconds.  
Backend queries BullMQ job state → maps to `{ status: 'queued' | 'processing' | 'completed' | 'failed', errorMessage? }`.  
Chat input remains **locked** until status is `completed`.

---

## Ghost Memory (Document Deletion)
When `DELETE /api/documents/:documentId` is called:
1. Prisma cascade delete removes all `document_chunks` (foreign key `onDelete: Cascade`)
2. Invalidate all Redis cache keys for `session_id`
3. Inject a `system` role message into chat history:
```typescript
await prisma.message.create({
  data: {
    sessionId,
    role: 'system',
    content: `[SYSTEM DIRECTIVE: The user has permanently deleted "${filename}". Ignore facts from that document in prior history.]`,
  },
});
```

---

## Unit Test Checklist (100% coverage required)
- [ ] Empty document → `[]` returned, no throw
- [ ] Single-char document → `['x']` returned
- [ ] Wall-of-text (no whitespace) → chunks ≤ `chunkSize`
- [ ] Binary/corrupt file → `FAILED` status set, worker does not crash
- [ ] Batch embedding call used (not per-chunk loop)
- [ ] SHA-256 dedup returns `409` on duplicate
- [ ] `finally` block deletes temp file in all code paths
