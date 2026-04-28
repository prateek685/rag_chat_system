---
name: V2 Features Status
description: V2 complete — Semantic Caching, Running Summary, Redis restructure, LLM retry; 155 unit tests green, tsc clean
type: project
---

V2 features are complete as of 2026-04-26.

**Why:** V2 improves latency resilience (retry), reduces redundant LLM calls (semantic cache), controls context cost (running summary), and improves Redis discipline (typed wrappers). All features are non-blocking to streaming.

**How to apply:** V2 is done. Unit tests: `npm run test` (155 passing). TypeScript: `tsc --noEmit` (0 errors). Do not re-implement. The semantic cache, summarize node, and retry util are all registered and wired.

---

## Feature 1 — Redis Module Restructure

**Files changed:** `redis.service.ts`, `redis.service.spec.ts`, `chat.service.ts`, `document.service.ts`

`RedisService` now exposes typed wrapper methods instead of raw `client` access for app-level code:

| Method | Behaviour on error |
|--------|-------------------|
| `get(key)` | returns `null` |
| `set(key, value)` | swallows error |
| `setex(key, ttl, value)` | swallows error |
| `del(key)` | swallows error |
| `incr(key)` | returns `0` (fail-open — treated as first request in window) |
| `expire(key, seconds)` | swallows error |
| `scan(pattern)` | SCAN cursor loop (never KEYS); returns `[]` on error |
| `delPattern(pattern)` | SCAN + batched DEL; returns count deleted; returns `0` on error |

Raw `readonly client: Redis` kept as BullMQ escape hatch only.  
Private `logLatency()` warns when any wrapper exceeds 10ms.

`document.service.ts → flushSessionCache()` migrated from `client.keys() + pipeline` to `redis.delPattern('semantic:{sessionId}:*')`. Both `flushSessionCache` and `SemanticCacheService.store()` have their own try/catch for double fail-open safety (unit test mocks bypass the wrapper's built-in fail-open).

---

## Feature 2 — LLM Retry Logic

**New file:** `backend/src/common/utils/llm-retry.util.ts`

```typescript
export async function withLlmRetry<T>(
  fn: () => Promise<T>,
  logger: { warn(obj: object): void },
  options: LlmRetryOptions,  // { operation, sessionId?, maxAttempts=3, baseDelayMs=1000 }
): Promise<T>
```

- **Retryable:** 429, 500, 502, 503, 504, network errors (no status code)
- **Non-retryable (throws immediately):** 400, 401, 403, 422
- **Backoff:** `baseDelayMs × 2^(attempt-1) + random(0–200ms)` → 1s, 2s, 4s + jitter

Applied to:
- `RouterNodeService` — `openai.chat.completions.create()`
- `GeneratorNodeService` — stream init `create({ stream: true })` only; `for await` loop is outside retry
- `RetrievalNodeService.embedQuery()` — `openai.embeddings.create()`
- `SummarizeMemoryNodeService` — condensation LLM call

---

## Feature 3 — Semantic Caching

**New files:** `semantic-cache.service.ts`, `semantic-cache.service.spec.ts`

Key schema: `semantic:{sessionId}:{randomBytes(4).toString('hex')}`  
Value: `JSON.stringify({ embedding: number[], response: string })`  
TTL: 86 400s (24h). Threshold: cosine ≥ 0.98. Max scan: 100 entries.

### Pipeline integration (ChatService)

New order in `handleChat()`:
1. Rate limit
2. Save user message
3. SSE headers
4. Exact cache check (`redis.get`)
5. Create Langfuse trace (moved earlier so embedding span nests under it)
6. `Promise.all([retrievalNode.embedQuery(), loadSessionContext()])` — parallel pre-computation
7. Semantic cache check → if hit: stream + `setImmediate(promote to exact cache)` + return
8. Execute LangGraph (graph receives pre-computed `queryEmbedding`; `RetrievalNode` skips re-embedding)
9–11. Canned response / citations / `[DONE]`
12. `setImmediate(() => postProcess(...))` — writes semantic cache for RAG_QUERY routes only

`RetrievalNodeService.embedQuery()` changed from `private` to `public`.  
`RetrievalNode.execute()` short-circuits: if `state.queryEmbedding.length > 0` uses it, else calls `embedQuery()`.

### Cache invalidation

| Trigger | Exact cache | Semantic cache |
|---------|-------------|----------------|
| User retries | ✅ `redis.del(chatCacheKey(staleHash))` | ✅ `semanticCache.invalidateSession(sessionId)` |
| Thumbs-down feedback | ✅ via `invalidateCacheForTrace()` | ✅ via `invalidateCacheForTrace()` |
| Document deleted | ✗ (hash opaque, expires via TTL) | ✅ `redis.delPattern('semantic:{sessionId}:*')` |
| VIOLATION / NO_CONTEXT | never written | never written |

`invalidateCacheForTrace(traceId)` — finds assistant message by traceId → finds preceding user message → deletes exact cache key → wipes semantic cache. Non-throwing; Langfuse score already recorded before it runs.

---

## Feature 4 — Running Summary (SummarizeMemoryNode)

**New files:** `nodes/summarize-memory.node.ts`, `nodes/summarize-memory.node.spec.ts`

Constants: `MESSAGE_THRESHOLD = 10`, `MESSAGES_TO_COMPRESS = 8`, `SUMMARY_MAX_TOKENS = 600`.

### execute(sessionId, currentSummary) algorithm

1. Count `user + assistant` messages (system ghost messages excluded)
2. If count ≤ 10: finalize Langfuse trace as `'skipped'`, return (no-op)
3. `findMany` oldest 8 messages (`orderBy: createdAt ASC, take: 8`)
4. Build condensation prompt (prior summary prefix if exists + message lines)
5. `withLlmRetry(() => openai.chat.completions.create(...))` — uses `ROUTER_MODEL`
6. If LLM returns empty string: log warn, return without DB update
7. `$transaction([session.update({ runningSummary }), message.deleteMany({ id: { in: ids } })])`
8. Own Langfuse trace `'summarize-memory'`; outer try/catch — never throws to caller

Called as last step of `postProcess()` (inside `setImmediate`) — never blocks streaming.  
`runningSummary` passed to `execute()` is the value from the current turn's context. The updated summary is available from the next turn onwards (one turn delayed by design).

---

## Module registration

`chat.module.ts` updated — two new providers added:

```typescript
providers: [
  ChatService, PromptBuilderService, RagGraphService,
  RouterNodeService, RetrievalNodeService, GeneratorNodeService,
  SemanticCacheService,          // new
  SummarizeMemoryNodeService,    // new
],
```

`RedisModule` is global so `RedisService` available without explicit import. `ObservabilityModule` import covers `LangfuseService`.

---

## Test counts

- **Unit tests:** 155 passing across 13 suites
- **`tsc --noEmit`:** 0 errors

### New spec files
- `semantic-cache.service.spec.ts` — 11 tests (miss, hit ≥0.98, near-miss, orthogonal, scan error, GET error per key, malformed JSON skip, 100-entry cap, store TTL/pattern, store fail-open, invalidateSession)
- `summarize-memory.node.spec.ts` — 9 tests (below threshold no-op, findMany args, LLM+DB in one transaction, prior summary in prompt, Langfuse trace finalised, empty LLM response, LLM reject, $transaction fail, count() fail, 429 retry)

### Updated spec files
- `chat.service.spec.ts` — 6 new test cases: semantic cache hit path, postProcess store for RAG_QUERY, no store for VIOLATION/NO_CONTEXT, postProcess calls summarize, handleRetry cache invalidation, handleFeedback negative score invalidation + traceId not found edge case
- `document.service.spec.ts` — redis mock updated from `client.keys/pipeline` to `delPattern`; cache flush test updated to assert `delPattern` call
- `redis.service.spec.ts` — tests for all new wrapper methods
