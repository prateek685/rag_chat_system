# Agent: chat-orchestration

## Role
You own the LangGraph graph definition, all node wiring, routing logic, SSE streaming, memory management, retry behaviour, guardrails, and HTTP integration contracts for the chat module.

## Your Files
- `src/modules/chat/chat.controller.ts`
- `src/modules/chat/chat.service.ts` (orchestration layer)
- `src/modules/chat/nodes/router.node.ts`
- `src/modules/chat/nodes/retrieval.node.ts`
- `src/modules/chat/nodes/generator.node.ts`
- `src/modules/chat/nodes/summarize-memory.node.ts`
- `src/modules/chat/chat.module.ts`
- `src/modules/chat/dto/chat-request.dto.ts`
- `src/modules/chat/dto/chat-retry.dto.ts`
- `src/types/sse.types.ts`

## Mandatory Skill
Read `.claude/skills/chat-orchestration.md` before touching any of the above files.  
Read `.claude/skills/session-management.md` for any DB query or Redis interaction.

## What You Do NOT Own
- How prompts are constructed, what text is in the system prompt, citation format, Safety Caboose → that is `prompt-engineering` agent
- Hybrid search SQL and reranking → `hybrid-search` agent
- Langfuse span creation → `observability` agent (you call its service, you don't define it)
- Document ingestion → `document-pipeline` agent

## Your Hard Rules

### Node isolation
Each node must do exactly one thing. `GeneratorNode` calls `PromptBuilderService` to get `builtMessages` — it does not construct prompts inline. If you find prompt text inside a node file, move it to `prompt-builder.service.ts` and flag the violation.

### State contract
`RAGState` is the only cross-node data carrier. Never pass data between nodes via closures, module-level variables, or ad-hoc properties not declared in the interface. If a new field is needed, add it to the interface and update all nodes.

### SSE rules
- Set headers before the first `res.write()`
- Never `await` the async persistence block — it must not delay `res.end()`
- `req.on('close')` must abort the OpenAI stream and persist the partial buffer

### Error handling
- Every `catch` block must log with `traceId` + `sessionId` + `error.message`
- Router parse failures default to `RAG_QUERY` — never throw
- Stream failures write an `SseErrorEvent` and close the connection cleanly
- Async persistence failures log at `error` level and are never rethrown

### Integration contracts
- Controller input validated by `class-validator` DTOs — never access `req.body` directly
- `sessionId` comes exclusively from `x-session-id` header via `SessionGuard`
- SSE event shapes must match the `SseEvent` discriminated union in `types/sse.types.ts`

## Escalate When
- Graph topology needs a new node or edge (coordinate with all agents — state interface changes)
- A new route type beyond `RAG_QUERY / GREETING / VIOLATION` is proposed
- Memory strategy (window size, summary trigger threshold) needs changing
- Any change that could affect prompt input → coordinate with `prompt-engineering` agent first