---
name: M3 Chat Pipeline Status
description: M3 complete — LangGraph RAG orchestration, SSE streaming, rate limiting, exact-match cache, sliding window, running summary, hybrid retrieval, reranking, citations; ~60 tests green
type: project
---

M3 is complete as of 2026-04-25.

**Why:** M3 is the core value-delivery layer. It takes session context + uploaded documents and streams a grounded LLM response back to the user via SSE.

**How to apply:** All chat behaviour flows through `ChatService.handleChat()` → `RagGraphService.execute()`. Changes to retrieval, routing, or generation must be made in the relevant LangGraph node, not in ChatService.

## Files created

### Chat module
- `backend/src/modules/chat/chat.controller.ts` — `POST /chat` (SSE stream), `POST /chat/retry`, `POST /chat/feedback`; `@HttpCode(200)` on SSE endpoints (NestJS defaults POST→201; SSE must return 200)
- `backend/src/modules/chat/chat.service.ts` — orchestrates full pipeline: rate limit → DB save → SSE headers → exact-match cache check → session context load → Langfuse trace → graph execute → citations → `[DONE]` → async post-process
- `backend/src/modules/chat/chat.module.ts`
- `backend/src/modules/chat/dto/chat-message.dto.ts` — `{ message: string (required, @MaxLength(4000)); skipCache?: boolean }`
- `backend/src/modules/chat/dto/feedback.dto.ts` — `{ traceId: string; score: 1 | -1 }` — uses `@IsIn([1, -1])`
- `backend/src/modules/chat/types/rag-state.types.ts` — `RAGState`, `RetrievedChunk`, `Citation`, `SlidingWindowMessage`

### LangGraph
- `backend/src/modules/chat/graph/rag-graph.service.ts` — builds StateGraph, wires nodes, conditional edges from RouterNode output
- `backend/src/modules/chat/nodes/router.node.ts` — `gpt-4o-mini` classifies intent: `RAG_QUERY | GREETING | VIOLATION`; structured JSON output; fallback to `RAG_QUERY` on parse error
- `backend/src/modules/chat/nodes/retrieval.node.ts` — embeds query with `text-embedding-3-small`, hybrid SQL (pgvector cosine + tsvector RRF), Cohere rerank (600ms hard timeout, score fallback), guardrail check (top score < 0.60 → `NO_CONTEXT` route)
- `backend/src/modules/chat/nodes/generator.node.ts` — `gpt-4o` streaming via OpenAI stream; writes tokens to SSE via `writeToken` callback; `stream_options: { include_usage: true }`
- `backend/src/modules/chat/prompt-builder.service.ts` — assembles message array: `HumanMessage → AIMessage (history) → retrieved context → SystemMessage` (Safety Caboose — system prompt last to resist injection)
- `backend/src/modules/chat/prompts/system-prompt.ts` — `VIOLATION_RESPONSE`, `NO_CONTEXT_RESPONSE` canned strings
- `backend/src/modules/chat/prompts/greeting-prompt.ts`

## Key implementation details

### Rate limiting (`chat.service.ts`)
- Redis INCR-based: `rate_limit:{sessionId}` key; atomic increment + TTL on first request
- `RATE_LIMIT_MAX = 10` messages per `RATE_LIMIT_TTL_SECONDS = 60`
- Throws `HttpException(429)` BEFORE SSE headers are flushed so `HttpExceptionFilter` can still write a JSON 429 body

### Exact-match cache
- Key: `chat:cache:{sha256(sessionId:message)}`; TTL 24h
- Canned guardrail responses (`NO_CONTEXT`, `VIOLATION`) are NEVER cached — session-state-dependent
- Cache is skipped on retry (`isRetry=true`) or when `dto.skipCache=true`

### Sliding window + running summary
- `SLIDING_WINDOW_SIZE = 6`; messages fetched `orderBy: { createdAt: 'desc' }, take: 6` then reversed
- `runningSummary` loaded from `sessions.running_summary` in parallel with messages
- `SummarizeMemoryNode` (triggered when `message_count > 10`): compresses oldest 8 messages via `gpt-4o-mini`, writes result to `sessions.running_summary`, deletes compressed rows

### SSE stream contract
- Each token: `data: {"token":"..."}\n\n`
- Citations (if any): `data: {"citations":[...]}\n\n`
- Trace ID: `data: {"traceId":"..."}\n\n`
- End: `data: [DONE]\n\n`
- Error: `data: {"error":"..."}\n\n` then `data: [DONE]\n\n`

### Retry flow (`handleRetry`)
1. Delete last assistant message
2. Find last user message, delete it
3. Re-call `handleChat` with `skipCache=true`, `RETRY_TEMPERATURE=0.4`

### Post-processing (after `res.end()`, via `setImmediate`)
- Save assistant message (with `traceId` + `citations` JSON)
- Write exact-match cache (non-fatal on error)
- Finalize Langfuse trace with `e2eLatencyMs` + `route`

### Citations
- Parsed from `[Source N]` or `【Source N】` markers in the full response
- Mapped to `RetrievedChunk` array; chunks beyond `chunks.length` silently dropped (hallucinated sources)
- `pageNumber` extracted from `metadata.loc.pageNumber` (PDFLoader) or `metadata.page` (flat)

## Tests
- `backend/src/modules/chat/chat.service.spec.ts` — covers rate limit, cache hit/miss, graph success/failure, canned route responses, post-process DB/cache/Langfuse
- `backend/src/modules/chat/chat.controller.spec.ts` — 5 unit tests: delegation, 429 propagation, retry delegation, feedback delegation, feedback error-swallowing
