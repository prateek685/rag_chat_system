---
name: M5 Observability & Feedback Status
description: M5 complete — Langfuse tracing across chat pipeline and document processor; token usage on all generations; eval skeleton (8-entry dataset, run-evals stub, retrieval smoke test); 95 tests green
type: project
---

M5 is complete as of 2026-04-26.

**Why:** Every request must be tracked — latency, token cost, retrieval scores, faithfulness signal — per the non-negotiable in CLAUDE.md. Langfuse provides the tracing infrastructure; the eval skeleton provides the quality measurement path.

**How to apply:** All Langfuse operations go through `LangfuseService`. Never import or call the Langfuse SDK directly in nodes or services. `LangfuseService` methods are non-throwing — they log and return `null` on SDK errors.

## Files created / modified

### Observability module
- `backend/src/modules/observability/langfuse.service.ts` — wraps Langfuse SDK:
  - `createTrace(options)` → `LangfuseTraceClient | null`
  - `createGeneration(trace, name, input, model)` → `LangfuseGenerationClient | null`
  - `finalizeGeneration(generation, output, usage)` — records `prompt_tokens`, `completion_tokens`, `total_tokens`
  - `recordTraceError(trace, errorType, message)` — tags trace with error metadata
  - `finalizeTrace(trace, output, metadata)` — closes trace with `e2eLatencyMs`, `route`, `chunkCount` etc.
  - `score(traceId, value)` — forwards thumbs up/down (1 / -1) from FeedbackBar to Langfuse
- `backend/src/modules/observability/observability.module.ts` — exports `LangfuseService`

### Chat nodes updated for Langfuse
- `RouterNode` — switched from `createSpan` → `createGeneration`; records `prompt_tokens` + `total_tokens` from `gpt-4o-mini` response usage
- `RetrievalNode` — `embedQuery()` creates an `'embedding'` generation span with token count; retrieval span output includes chunk IDs + cosine/RRF scores
- `GeneratorNode` — switched to `createGeneration`; `stream_options: { include_usage: true }` on streaming call; token usage recorded in `finalizeGeneration`

### Document processor updated for Langfuse
- `DocumentProcessor.process()` creates a `'document-processing'` trace per BullMQ job; finalizes with `{ documentId, tokenCount, chunkCount, e2eLatencyMs }`; calls `recordTraceError('document_processing_failure', ...)` on failure
- `VectorService.embedAndStore()` accepts `trace: LangfuseTraceClient | null` as optional 4th arg; creates an `'embedding'` generation span nested under the job trace

### Module wiring
- `WorkerModule` imports `ObservabilityModule` so `LangfuseService` is injectable in the worker context
- `ChatModule` already imported `ObservabilityModule`

### Evals skeleton
- `backend/test/evals/datasets/golden-dataset.json` — 8 Q/A pairs covering document-grounded questions, greetings, and edge cases
- `backend/test/evals/scripts/run-evals.ts` — stub for full 50-question eval run; reads dataset, calls `/chat`, compares responses
- `backend/test/evals/retrieval-quality.spec.ts` — smoke test asserting retrieval returns ≥1 chunk for known golden queries

## Key implementation details

### Langfuse error isolation
- Every SDK call is wrapped in try/catch; errors are logged at `warn` level and the method returns `null`
- Callers receive `null` trace/generation and skip finalization — no pipeline interruption

### `jest.mock('langfuse', ...)` pattern (required in all specs that import ChatService or LangfuseService)
```typescript
jest.mock('langfuse', () => ({
  __esModule: true,
  default: jest.fn(),
  LangfuseTraceClient: jest.fn(),
}));
```
Prevents `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG` — Langfuse uses dynamic `import()` internally which crashes Jest's VM context.

### FeedbackBar change
- Removed `disabled={voted}` — users can re-vote (change good → bad or vice versa); each call to `score()` updates the Langfuse score

### Removed scope creep
- `ConfigService` removed from `ChatService` constructor (was unused after M5 refactor)
- `configService` parameter made non-property in `RouterNodeService` and `RetrievalNodeService` constructors

## Tests
- `backend/src/modules/observability/langfuse.service.spec.ts` — covers trace creation, generation lifecycle, error swallowing, score forwarding
- All existing specs updated to include `jest.mock('langfuse', ...)` where needed
- **95 / 95 passing** across 9 suites after M5
