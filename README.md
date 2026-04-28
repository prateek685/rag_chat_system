# RAG Chat System

An open, login-free Retrieval-Augmented Generation (RAG) chat platform. Upload documents and query them through a conversational interface — no authentication required.

## Features

- **No login required** — sessions are scoped via a browser-generated `session_id` stored in `localStorage`
- **Document upload** — supports `.txt`, `.csv`, `.md`, `.pdf` (up to 10MB)
- **Hybrid search** — dense vector search (pgvector) + full-text search (tsvector) combined via Reciprocal Rank Fusion
- **Streaming responses** — SSE-based streaming with `react-markdown` rendering
- **Semantic caching** — Redis cosine similarity cache (threshold 0.98, TTL 24h)
- **Conversation memory** — sliding window (last 4–6 messages) + running summary compression
- **Guardrails** — intent routing, relevance threshold, token budget, rate limiting
- **Observability** — every request traced in Langfuse with latency, token cost, and retrieval scores

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
| Queue | BullMQ (Redis-backed) |
| Cache | Redis (semantic cache + API cache) |
| Observability | Langfuse |
| Testing | Jest + Supertest |
| Deployment | Docker + Docker Compose |

## Prerequisites

- Docker and Docker Compose
- Node.js 20+
- OpenAI API key
- Langfuse instance (self-hosted or cloud)
- Cohere API key (optional — local HuggingFace reranker used as fallback)

## Getting Started

### 1. Clone and configure

```bash
git clone <repo-url>
cd rag_chat_system
cp .env.example .env
# Fill in required values in .env
```

### 2. Required environment variables

```env
DATABASE_URL=postgresql://...
REDIS_HOST=localhost
REDIS_PORT=6379
OPENAI_API_KEY=sk-...
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...
LANGFUSE_HOST=http://localhost:3000
```

### 3. Start all services

```bash
docker compose up -d
```

### 4. Apply database migrations

```bash
cd backend
npx prisma migrate deploy
# Then apply critical raw SQL indexes (HNSW + GIN + tsvector trigger):
psql $DATABASE_URL -f prisma/migrations/manual_indexes.sql
```

### 5. Start in development mode

```bash
# Backend
cd backend && npm run start:dev

# Frontend (separate terminal)
cd frontend && npm run dev
```

Frontend: http://localhost:3001  
Backend API: http://localhost:8080  
Swagger docs: http://localhost:8080/api  
Langfuse dashboard: http://localhost:3000

## Architecture Overview

### Document Processing Pipeline

```
Upload → SHA-256 dedup → BullMQ job → Parse → Chunk → Embed → Store (pgvector + tsvector)
```

- Chunking via `RecursiveCharacterTextSplitter` at natural boundaries
- Batch embedding via `text-embedding-3-small`
- BullMQ retry: 3 attempts with exponential backoff (2s → 4s → 8s)

### Chat Pipeline

```
Redis exact cache → Embed query → Semantic cache → LangGraph routing →
Hybrid search → Cohere rerank → Guardrail check → Prompt assembly → SSE stream →
Async persist + cache update + Langfuse trace
```

### LangGraph Nodes

| Node | Model | Responsibility |
|---|---|---|
| `RouterNode` | gpt-4o-mini | Classify intent: `RAG_QUERY / GREETING / VIOLATION` |
| `RetrievalNode` | — | Hybrid SQL search + reranking |
| `GeneratorNode` | gpt-4o | Stream final answer |
| `SummarizeMemoryNode` | gpt-4o-mini | Compress old messages into running summary |

### Guardrails

| Type | Trigger | Action |
|---|---|---|
| Input | Router returns `VIOLATION` | Canned refusal, skip pipeline |
| Context | Top reranker score < 0.60 | Return "no relevant context found" |
| Token budget | Session exceeds 100k tokens | Halt generation |
| File size | Doc > 10MB or 50k tokens | `413` response |
| Rate limit | > 10 messages/min per session | `429` response |

## API Reference

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/documents` | Upload a document |
| `GET` | `/api/documents` | List documents for session |
| `DELETE` | `/api/documents/:id` | Delete a document and its chunks |
| `POST` | `/api/chat` | Send a message (returns SSE stream) |
| `POST` | `/api/chat/feedback` | Submit thumbs up/down on a response |

All requests must include the `x-session-id` header.

## Testing

```bash
# Unit tests
cd backend && npm run test

# E2E / integration tests
cd backend && npm run test:e2e

# Full RAG evaluation suite (50 Q/A pairs)
cd backend && npx ts-node test/evals/scripts/run-evals.ts
```

Coverage targets: **85% global**, **100%** on chunking, embedding formatting, and prompt assembly.

## Performance Targets (P95)

| Path | Budget |
|---|---|
| End-to-end chat (entry → first token) | ≤ 2000ms |
| Time-to-first-token (TTFT) | ≤ 800ms |
| RouterNode classification | ≤ 300ms |
| Hybrid search SQL | ≤ 200ms |
| Reranker (Cohere) | ≤ 600ms (hard timeout, fallback on breach) |
| Document upload → queued | ≤ 200ms |
| Redis cache read | ≤ 10ms |

## Repository Structure

```
/
├── frontend/          # Next.js app
├── backend/           # NestJS app
│   ├── src/
│   │   ├── modules/
│   │   │   ├── document/   # Upload, parse, chunk, embed
│   │   │   ├── chat/       # LangGraph pipeline, prompt builder
│   │   │   ├── worker/     # BullMQ processors
│   │   │   └── observability/  # Langfuse integration
│   │   └── config/
│   ├── prisma/        # Schema + migrations
│   └── test/
│       ├── integration/
│       └── evals/     # Golden dataset + eval scripts
├── uploads/           # Docker volume — local document storage
├── docker-compose.yml
└── .env
```

## Security & Privacy

- No cross-session data access — every query enforces `WHERE session_id = $1`
- System prompt placed **last** in the message array (Safety Caboose pattern) to defend against prompt injection
- No user accounts or persistent identity — clearing `localStorage` resets the session
- All services run locally; only OpenAI API and optionally Cohere are external calls