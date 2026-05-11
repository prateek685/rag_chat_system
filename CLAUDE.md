# RAG Chat System — Claude Code Context

## Project Overview

An open, login-free RAG (Retrieval-Augmented Generation) chat platform. Users upload documents, then query them via a conversational interface. No authentication required — sessions are scoped via a browser-generated `session_id` stored in `localStorage`.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js (React), react-markdown, SSE streaming |
| Backend | NestJS (TypeScript) |
| Orchestration | LangGraph (TypeScript) |
| LLM — Generator | GPT-4o |
| LLM — Router/Summary | GPT-4o-mini |
| Embeddings | text-embedding-3-small (1536-dim) |
| Vector + Primary DB | PostgreSQL + pgvector + tsvector |
| ORM | Prisma |
| Queue | BullMQ (backed by Redis) |
| Cache | Redis (semantic cache + API cache) |
| Observability | Langfuse |
| Testing | Jest + Supertest |
| Deployment | Docker + Docker Compose |

## Repository Structure

```
/
├── frontend/          # Next.js app
├── backend/           # NestJS app
│   ├── src/
│   │   ├── app.module.ts
│   │   ├── common/
│   │   │   ├── filters/
│   │   │   └── interceptors/
│   │   ├── config/
│   │   │   └── env.config.ts
│   │   └── modules/
│   │       ├── prisma/
│   │       ├── document/
│   │       ├── chat/
│   │       │   ├── prompt-builder.service.ts  # prompt-engineering agent
│   │       │   ├── prompts/system-prompt.ts
│   │       │   ├── prompts/greeting-prompt.ts
│   │       │   └── nodes/
│   │       ├── worker/
│   │       └── observability/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   └── test/
│       ├── integration/
│       └── evals/
│           ├── datasets/golden-dataset.json
│           ├── scripts/run-evals.ts
│           └── retrieval-quality.spec.ts
├── uploads/           # Docker volume — local document storage
├── docker-compose.yml
└── .env
```

## Core Architectural Decisions

### Session Management
- `session_id` is a UUIDv4 generated client-side on first visit, persisted to `localStorage`
- Every HTTP request carries `x-session-id` header
- All DB queries enforce a strict `WHERE session_id = $1` clause — no cross-session data leakage
- Session history persists across tab closes; clears only if user clears browser storage

### Document Processing Pipeline
1. **Upload** — Multer validates file type (`.txt`, `.csv`, `.md`, `.pdf`) and size (≤ 10MB)
2. **SHA-256 dedup** — reject with `409` if hash exists for session
3. **Queue** — NestJS pushes a BullMQ job; controller returns `job_id` immediately
4. **Parse** — LangChain loaders extract text + metadata (page number, source filename)
5. **Chunk** — `RecursiveCharacterTextSplitter` at natural boundaries (paragraph → newline → space)
6. **Embed** — Batch call to `text-embedding-3-small` → 1536-dim dense vectors
7. **Store** — Upsert to `document_chunks`: `embedding` (pgvector) + `search_vector` (tsvector auto-trigger)

BullMQ retry policy: 3 attempts, exponential backoff (2s → 4s → 8s). Failed jobs go to DLQ; alert fires to Slack if `failed` queue length exceeds 10.

### Chat Processing Pipeline
1. **Exact cache check** — Redis lookup by `session_id + query`
2. **Embed query** — `text-embedding-3-small`
3. **Semantic cache check** — Redis cosine similarity ≥ 0.98; TTL 24h
4. **LangGraph routing** — `gpt-4o-mini` classifies intent: `RAG_QUERY | GREETING | VIOLATION`
5. **Hybrid search** — RRF over pgvector (dense, cosine) + tsvector (BM25); retrieve Top 50
6. **Rerank** — Cohere Rerank 3 (or local HuggingFace fallback); keep Top 5; timeout 600ms
7. **Guardrail check** — if top reranker score < 0.30, return canned "no relevant context" reply
8. **Prompt assembly** — System prompt + Running Summary + last 4–6 messages + 5 chunks + user query
9. **Stream** — SSE via `res.write()`; frontend renders with `react-markdown`
10. **Async save** — persist Q/A to Postgres, update Redis cache, finalize Langfuse trace

### Memory Strategy
- **Sliding window**: fetch last 4–6 messages from `messages` table (Prisma `take`)
- **Running summary** (triggered when `message_count > 10`): LangGraph `SummarizeMemoryNode` compresses oldest 8 messages via `gpt-4o-mini` into `sessions.running_summary`, then deletes those rows

### LangGraph Nodes
| Node | Model | Responsibility |
|---|---|---|
| `RouterNode` | gpt-4o-mini | Classify intent → `RAG_QUERY / GREETING / VIOLATION` |
| `RetrievalNode` | — | Execute hybrid SQL + reranking |
| `GeneratorNode` | gpt-4o | Stream final answer |
| `SummarizeMemoryNode` | gpt-4o-mini | Compress old messages into running summary |

### Prompt Engineering — "Safety Caboose" Pattern
System prompt is placed at the **end** of the message array (not the beginning) to defend against prompt injection. Message order: `HumanMessage → AIMessage (history) → retrieved context → SystemMessage`.

### Guardrails
| Type | Trigger | Action |
|---|---|---|
| Input | Router returns `VIOLATION` | Return canned refusal, skip pipeline |
| Context | Top reranker score < 0.30 | Return "no relevant context found" |
| Token budget | Session exceeds 100k tokens | Halt generation, prompt user to clear session |
| File size | Doc > 50k tokens or 10MB | Reject with `413` |
| Rate limit | > 10 messages/min per session | `429` response |

## Database Schema Summary

**`sessions`** — `id (PK, from localStorage UUID)`, `running_summary`, timestamps  
**`documents`** — `id`, `session_id`, `filename`, `status (PENDING/PROCESSING/COMPLETED/FAILED)`, `error_message`  
**`document_chunks`** — `id`, `document_id`, `session_id`, `content`, `metadata (JSON)`, `embedding vector(1536)`, `search_vector tsvector`  
**`messages`** — `id`, `session_id`, `role (user/assistant/system)`, `content`, `citations (JSON)`, `created_at`

**Critical indexes (raw SQL — Prisma cannot generate these):**
```sql
-- Dense vector search (HNSW)
CREATE INDEX document_chunks_embedding_idx ON document_chunks USING hnsw (embedding vector_cosine_ops);
-- Full-text search (GIN)
CREATE INDEX document_chunks_search_idx ON document_chunks USING GIN (search_vector);
-- Auto-populate tsvector on insert/update
CREATE TRIGGER tsvectorupdate BEFORE INSERT OR UPDATE ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION tsvector_update_trigger();
```

## Environment Variables

See `.env.example`. Required at runtime:
- `DATABASE_URL`
- `REDIS_HOST`, `REDIS_PORT`
- `OPENROUTER_API_KEY` — single credential for all LLM calls (embeddings, generation, routing)
- `EMBEDDING_MODEL`, `GENERATOR_MODEL`, `ROUTER_MODEL` — model names (defaults to free-tier OpenRouter models; switch to `openai/gpt-4o` etc. to use OpenAI via OpenRouter proxy)
- `EMBEDDING_DIMENSIONS` — must match the vector() column type (default 1536)
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`

## Testing Standards

- **Coverage targets**: 85% global; **100%** on chunking, embedding formatting, prompt assembly
- **Unit tests**: Jest + mocked external APIs (OpenAI, Langfuse, Prisma)
- **Integration/E2E**: Supertest against a test DB
- **Evals**: `test/evals/golden-dataset.json` (50 Q/A pairs); run via `test/evals/scripts/run-evals.ts`

### CI/CD Gates
| Trigger | Tests Run | Merge Block |
|---|---|---|
| Pre-commit | Unit tests only | Yes |
| Pull Request | Unit + Integration + mini-eval (10 Qs) | Block if eval < 90% |
| Nightly cron | Full 50-question eval suite | Alert only |

## Common Commands

```bash
# Start all services
docker compose up -d

# Backend dev
cd backend && npm run start:dev

# Frontend dev
cd frontend && npm run dev

# Run unit tests
cd backend && npm run test

# Run E2E tests
cd backend && npm run test:e2e

# Run full eval suite
cd backend && npx ts-node test/evals/scripts/run-evals.ts

# Apply Prisma migrations + raw SQL indexes
cd backend && npx prisma migrate deploy
# Then manually apply: prisma/migrations/manual_indexes.sql

# Open Langfuse dashboard
open http://localhost:3000

# Open API docs (Swagger)
open http://localhost:8080/api
```

## Key Constraints & Non-Negotiables

1. **Everything runs locally** — no cloud services except OpenAI API and (optionally) Cohere Rerank
2. **P95 response latency ≤ 2 seconds** — reranker has a hard 600ms timeout with graceful fallback
3. **Zero cross-session data leakage** — every query must include `session_id` WHERE clause
4. **Safety Caboose pattern** — system prompt always last in message array
5. **100% faithfulness threshold** — zero tolerance for hallucinated facts
6. **Cascading deletes** — deleting a document must wipe all its chunks atomically
7. **Debuggable by logs alone** — every error, slow path, and state transition must be loggable without attaching a debugger. See logging standards in `skills/observability-evals.md`.
8. **AI quality is always measured** — every chat request records latency, token cost, retrieval scores, and faithfulness signal in Langfuse. No request goes untracked.
9. **Zero bugs on feature release** — new features require 100% branch coverage on their own code plus a passing mini-eval before merge. No exceptions.

## Open / Pending Decisions

- Evaluation pipeline tooling: custom RAGAS mimic vs. Langfuse cloud vs. Python microservice vs. Promptfoo
- Conversational memory boundary — exact sliding window size (currently 4–6)
- CI/CD platform (GitHub Actions assumed)
- Prompt injection hardening audit

---

## Coding Standards

These apply to every file in the codebase — backend, frontend, tests, and scripts. No exceptions.

### 1. Efficiency & Performance
- Prefer single-pass algorithms. Never iterate a collection twice when once will do.
- Batch all external API calls (OpenAI embeddings, Cohere rerank). Never call in a loop.
- Use `Promise.all()` for independent async operations. Never `await` sequentially when parallelism is safe.
- Avoid loading full DB result sets into memory — always use `take`/`limit` and cursor pagination.
- Cache aggressively at the right layer: Redis for API responses, Postgres indexes for retrieval. Do not add application-layer caching that duplicates existing infrastructure.
- Profile before optimising. A comment like `// bottleneck measured at Xms on 2024-xx-xx` is required alongside any non-obvious optimisation.

### 2. Type Safety
- `strict: true` is enabled in `tsconfig.json` — never disable it, never suppress with `// @ts-ignore` or `as any`.
- Every function must have explicit parameter types and a return type annotation — no implicit `any`, no inferred return types on exported functions.
- Use Zod for runtime validation of all external inputs: request bodies, env vars, LLM JSON responses, BullMQ job payloads.
- Database query results typed via generated Prisma client types — never cast with `as`.
- Discriminated unions preferred over optional fields for modelling variant states (e.g. `{ status: 'completed' } | { status: 'failed'; error: string }` not `{ status: string; error?: string }`).
- All environment variables accessed through `env.config.ts` which validates and types them at startup — never `process.env.THING` inline.

### 3. Nomenclature
Consistency across every layer so any developer can trace a concept from HTTP request to DB column without a mapping document.

**Files** — `kebab-case.ts`. Examples: `document.service.ts`, `vector.service.ts`, `chat.controller.ts`

**Classes & Types** — `PascalCase`. Examples: `DocumentProcessor`, `HybridSearchResult`, `RAGState`

**Functions & variables** — `camelCase`. Examples: `buildMessageArray`, `hybridSearch`, `topRerankedChunks`

**Constants & env keys** — `SCREAMING_SNAKE_CASE`. Examples: `RERANK_TIMEOUT_MS`, `OPENAI_API_KEY`

**Database tables** — `snake_case`, plural. Examples: `sessions`, `documents`, `document_chunks`, `messages`

**Database columns** — `snake_case`. Examples: `session_id`, `created_at`, `running_summary`, `search_vector`

**Prisma model fields** — `camelCase` (Prisma convention, maps to snake_case column via `@map`). Examples: `sessionId`, `createdAt`, `runningSummary`

**BullMQ job names** — `kebab-case` strings. Examples: `'process-document'`, `'summarize-memory'`

**Langfuse span names** — `kebab-case` strings. Examples: `'router'`, `'retrieval'`, `'reranker'`, `'generator'`

**LangGraph node names** — `PascalCase` suffixed with `Node`. Examples: `RouterNode`, `RetrievalNode`, `GeneratorNode`, `SummarizeMemoryNode`

**API routes** — `kebab-case`, plural nouns, no verbs. Examples: `/api/documents`, `/api/chat`, `/api/chat/feedback`

### 4. Integration Contracts
- Every integration point between two components (controller → service, service → queue, node → node) must have an explicit TypeScript interface defining the input and output shape. No untyped `object` passing between boundaries.
- Controller → Service: DTOs validated with `class-validator` decorators. Never access `req.body` directly in a controller.
- Service → BullMQ: job payload interface defined in a shared types file, imported by both producer and consumer.
- LangGraph node to node: `RAGState` is the single shared contract — never add ad-hoc properties to the state without updating the interface.
- NestJS → Frontend SSE: event shape documented inline as a TypeScript type in a `types/sse.types.ts` file shared or mirrored in the frontend.
- When modifying any integration point, check both sides before committing — a type change on the producer that isn't reflected on the consumer is a runtime bug waiting to happen.

### 5. Latency Budgets
All latencies are P95 targets. Instrument every path. Log a `warn` if a budget is exceeded.

| Path | P95 Budget | Action on breach |
|---|---|---|
| End-to-end chat (entry → first token) | ≤ 2000ms | `warn` log + Langfuse alert |
| Time-to-first-token (TTFT) | ≤ 800ms | `warn` log |
| RouterNode (gpt-4o-mini classification) | ≤ 300ms | `warn` log |
| Hybrid search SQL query | ≤ 200ms | `warn` log + check indexes |
| Reranker (Cohere) | ≤ 600ms hard timeout | Fallback + `warn` log |
| Document upload → queued response | ≤ 200ms | `warn` log |
| Redis cache read | ≤ 10ms | `warn` log |

Implementation pattern — wrap every external call with a latency measurement:
```typescript
const start = Date.now();
const result = await externalCall();
const latencyMs = Date.now() - start;
if (latencyMs > BUDGET_MS) {
  this.logger.warn({ event: 'latency_budget_exceeded', operation: 'reranker', latencyMs, budget: BUDGET_MS });
}
```

### 6. Comments
- **Why, not what.** A comment that restates the code (`// increment i`) is noise. A comment that explains the reason (`// offset by 1 because the API returns 1-indexed pages`) is signal.
- Every exported function, class, and interface must have a JSDoc block: `@param`, `@returns`, and a one-line description minimum.
- Non-obvious algorithmic decisions require an inline comment. If you had to think about it for more than 30 seconds, future readers will too.
- Every guardrail and threshold constant must have a comment explaining the reasoning behind the value:
```typescript
/** 
 * Safety threshold for reranker relevance scores.
 * Scores below this indicate no semantically relevant chunks exist for the query.
 * Returning a canned response is preferable to hallucinating from low-quality context.
 */
const RERANKER_SCORE_THRESHOLD = 0.30;
```
- `TODO` comments must include a ticket reference and owner: `// TODO(#123, @owner): implement semantic dedup`. A bare `TODO` without context will be rejected in PR review.
- No commented-out code in production branches. Delete it — version control has the history.

### 7. Error & Exception Handling
- **Never swallow errors silently.** Every `catch` block must either rethrow, log at `error` level, or handle explicitly. An empty `catch` block is a bug.
- Use NestJS exception filters for all HTTP error responses — never `res.status(500).send(...)` directly in a controller.
- All errors thrown from services must use typed NestJS exceptions (`NotFoundException`, `BadRequestException`, `ConflictException`) — never throw plain `Error` objects across a service boundary.
- External API calls (OpenAI, Cohere, Langfuse) must be wrapped with try/catch. On failure: log with full context, update any relevant DB status, and either rethrow or activate the defined fallback path.
- BullMQ processors must never let an unhandled exception crash the worker process. Every `process()` method wraps its body in try/catch and updates document status on failure.
- Async operations that run after `res.end()` (persistence, cache writes, Langfuse flush) must have their own try/catch — an error there must not be silently lost.
- Prisma errors must be caught and mapped to domain exceptions before crossing a service boundary. Never let a `PrismaClientKnownRequestError` reach the controller layer unwrapped.
- Validate all LLM JSON responses before using them. If `gpt-4o-mini` returns malformed routing JSON, catch the parse error, log it, and default to `RAG_QUERY` as the safe fallback.

```typescript
// Pattern — external call with full error handling
try {
  const result = await externalService.call(payload);
  this.logger.log({ event: 'call_success', traceId, latencyMs });
  return result;
} catch (err) {
  this.logger.error({ event: 'call_failed', traceId, error: err.message, payload });
  // activate fallback or rethrow typed exception
  throw new ServiceUnavailableException('External service failed');
}
```

---

## Working Guidelines for Claude

### 1. Token Efficiency
- Read only the files directly relevant to the current task. Do not scan the entire codebase to orient yourself on every request.
- When you need context about a module, read its skill file first — it is a compressed summary specifically designed to avoid full-file reads.
- Prefer `view_range` over reading entire files. If you need a function, find it — don't read 500 lines to get to line 420.
- When generating code, write it once correctly. Do not produce a draft and then immediately rewrite it in the same response.
- Batch related reads into the minimum number of tool calls. Read `chat.service.ts` and `chat.service.spec.ts` together if you need both, not sequentially with commentary in between.
- **NEVER read `.env`, `.env.local`, `.env.production`, or any file whose name starts with `.env`.** These files contain secrets. If you need to know which env vars are required, read `.env.example` only. Never cat, grep, or scan `.env` files under any circumstances — not for debugging, not for context, not to verify values.

### 2. Surgical Edits — Never Rewrite What You Aren't Changing
- Use `str_replace` for all file modifications. Identify the exact lines that need to change and replace only those.
- Never recreate an entire file to make a small change. If a function needs updating, replace that function's block — not the whole module.
- When updating a Prisma schema, change the affected model only. Do not rewrite the entire `schema.prisma`.
- When fixing a bug in one node, do not refactor surrounding nodes. Scope your edit to the reported problem.
- If a test needs a new assertion, add it to the existing `describe` block — do not regenerate the entire spec file.
- Before editing, state explicitly which lines or block you are changing and why. This keeps the diff minimal and reviewable.

### 3. Context and Scope Management
- At the start of each task, identify which agent and skill own the area you are working in. Read that skill file. Do not re-read `CLAUDE.md` in full on every task — it is a reference, not a ritual.
- Maintain awareness of module boundaries. If a fix in `chat.service.ts` requires a change in `vector.service.ts`, call that out explicitly rather than silently editing across boundaries.
- If you are mid-task and realise the scope has grown (e.g., a bug fix requires a schema change), stop and flag it before proceeding. Do not silently expand scope.
- When a task is complete, summarise only what changed — file name, function or block modified, and why. Do not re-explain the entire system.
- If context about a prior decision is unclear, check `CLAUDE.md` and the relevant skill file before asking. Most architectural decisions are already recorded here.

### 4. Implementation Fidelity — No Drift from the Plan
**This is a hard rule. Violations will be treated as bugs, not style differences.**

- Before writing any code, confirm the relevant phase and milestone in the memory files under `memory/`. If no plan exists for the area, ask before proceeding.
- Implement exactly what the plan specifies. Do not add features, change interfaces, swap libraries, alter data models, or introduce abstractions that are not in the plan — even if they seem like improvements.
- If the plan is ambiguous or appears wrong, **stop and ask**. Do not interpret your way around ambiguity.
- If implementing the plan as written is technically impossible or would introduce a bug, **stop and flag it explicitly** — state which plan item is the blocker and why. Do not silently substitute an alternative.
- Scope creep in a single PR is a merge-block: every file touched must trace back to a plan item. If you find yourself editing files outside the plan's scope, stop.
- Design documents (schema, API contracts, LangGraph state shape, SSE event types) are frozen once a phase begins. Do not alter them mid-phase without an explicit user decision recorded in memory.

### 5. Memory Updates After Every Phase
**Required — not optional.**

- When a phase or milestone is complete (or partially complete and blocked), update the relevant file(s) in `memory/` immediately — before reporting done to the user.
- Record: what was built, what was skipped, any decisions that deviated from the original plan and why, and the current status of the next phase.
- Use absolute dates (e.g. `2026-04-24`) not relative ones ("yesterday", "last week").
- If a new phase starts that has no memory file yet, create one following the existing naming pattern (e.g. `project_m3_status.md`) and add it to `MEMORY.md`.
- Memory files are the single source of truth for project progress. If the memory file says a step is done, it must be genuinely done — not just coded but untested.

### 6. Debugging Runbook — Trace-First Investigation

**When the user reports an unexpected response, always start with the Langfuse trace. Never guess.**

**Trigger**: User says the response was wrong / unexpected and provides a `traceId`.

**Step-by-step flow:**

```
1. FETCH TRACE
   npx langfuse-cli api traces get <traceId>
   → Captures: input query, final output, all observations, scores, e2e latency.

2. CHECK ROUTER (observation name: "router")
   → Was the route correct? (RAG_QUERY / GREETING / VIOLATION)
   → Was latency within 300ms budget?
   → If misrouted: root cause is the router model or prompt — stop here.

3. CHECK RETRIEVAL (observation name: "retrieval")
   → How many chunks returned? What are the cosine similarity scores?
   → Read contentPreview of each chunk — is the answer actually present in any chunk?
   → If top similarity < 0.30: guardrail should have fired — check why it didn't.
   → If answer IS in a chunk but model said it wasn't: data quality or model failure — go to step 5.
   → If answer is NOT in any chunk: retrieval failure — root cause is embedding/search quality.

4. CHECK RERANKER (observation name: "reranker")
   → Were chunks reordered? Did the right chunk surface to position 1?
   → If reranker span is absent: reranker was skipped — check timeout/fallback path.

5. CHECK GENERATOR INPUT (observation name: "generator" → input field)
   → Read the FULL message array fed to the model:
     - Are the right chunks present in the context message?
     - Is the data in a parseable format (no merged PDF columns, no truncation)?
     - Is the system prompt last (Safety Caboose)?
     - Is conversation history correct (no orphaned assistant turns)?
   → If data IS present but model said it wasn't: model comprehension failure — root cause
     is either data format (PDF table merging) or model capability (free-tier model).

6. IDENTIFY ROOT CAUSE — use this decision tree:
   Misrouted?            → Router model/prompt bug
   Answer not in chunks? → Embedding/chunking/retrieval bug
   Chunks present, model failed to read? → Data format bug (fix at document processor)
   Chunks present, model ignored rules?  → Model capability (upgrade model)
   Correct answer, wrong format/citation? → Prompt/post-processing bug

7. DO NOT propose a fix until you can point to the exact observation, field, and value
   that proves the root cause. "The model probably..." is not a root cause.
```

**Scores to always check:**
- `keyword-overlap` < 0.30 → response likely doesn't use retrieved context
- Router latency > 300ms → model too slow, budget breached
- TTFT > 800ms → generator too slow, budget breached

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
