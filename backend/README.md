# RAG Chat System — Backend

NestJS API server for the RAG (Retrieval-Augmented Generation) chat platform.

## Tech Stack

- **Framework**: NestJS (TypeScript)
- **Orchestration**: LangGraph (TypeScript)
- **LLM / Embeddings**: OpenRouter (GPT-4o, GPT-4o-mini, text-embedding-3-small)
- **Database**: PostgreSQL + pgvector (via Prisma 7 + `@prisma/adapter-pg`)
- **Queue**: BullMQ (backed by Redis)
- **Cache**: Redis (exact + semantic cache)
- **Observability**: Langfuse

## Setup

```bash
# Install dependencies
npm install

# Start all services (Postgres, Redis, pgAdmin)
docker compose up -d

# Apply Prisma migrations
npx prisma migrate deploy

# Apply raw SQL indexes (HNSW, GIN, tsvector trigger)
psql $DATABASE_URL -f prisma/migrations/manual_indexes.sql
```

## Running

```bash
# Development (watch mode)
npm run start:dev

# Production
npm run start:prod
```

## Testing

```bash
# Unit tests
npm run test

# Unit tests with coverage
npm run test:cov

# E2E / integration tests
npm run test:e2e

# Full eval suite (50 Q/A pairs)
npx ts-node test/evals/scripts/run-evals.ts
```

## Environment Variables

Copy `.env.example` to `.env` and fill in the required values:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_HOST` | Yes | Redis hostname |
| `REDIS_PORT` | No | Redis port (default: 6379) |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for all LLM calls |
| `EMBEDDING_MODEL` | No | Embedding model name (default: nvidia/llama-nemotron-embed-vl-1b-v2:free) |
| `GENERATOR_MODEL` | No | Generator model name (default: deepseek/deepseek-r1:free) |
| `ROUTER_MODEL` | No | Router model name (default: google/gemma-3-4b-it:free) |
| `LANGFUSE_PUBLIC_KEY` | Yes | Langfuse public key |
| `LANGFUSE_SECRET_KEY` | Yes | Langfuse secret key |
| `LANGFUSE_HOST` | Yes | Langfuse host URL |
| `UPLOADS_PATH` | No | Absolute path for uploaded files (default: `<cwd>/uploads`) |

## API Docs

Swagger UI is available at `http://localhost:8080/api` when the server is running.
