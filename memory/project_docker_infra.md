---
name: Docker Compose & Infrastructure Setup
description: Docker Compose created ahead of M7 — 5 containers, key design decisions for local dev
type: project
---

Docker Compose was set up during M1 at user request (ahead of the planned M7 slot).

**Why:** User needed the Postgres container running to test migrations during M1 development.

**How to apply:** `docker compose up postgres redis -d` spins up just the DB + cache for local dev. Full `docker compose up --build` brings everything up. Run `npx prisma migrate dev` after postgres is healthy.

## Container map

| Service | Image | Port | Notes |
|---|---|---|---|
| `rag_postgres` | `ankane/pgvector:latest` | 5432 | Primary DB + vector store |
| `rag_redis` | `redis:7-alpine` | 6379 | BullMQ queue + cache; AOF persistence on |
| `rag_langfuse` | `langfuse/langfuse:latest` | 3000 | Shares the same Postgres instance |
| `rag_nestjs` | `./backend/Dockerfile` | 8080 | Multi-stage; startup: migrate → manual_indexes → node |
| `rag_nextjs` | `./frontend/Dockerfile` | 3001 | Next.js standalone build |

## Key decisions

**DATABASE_URL encoding** — The password `tequity@123#` contains `@` and `#` which break URL parsing. The root `.env` stores the pre-encoded form: `tequity%40123%23`. The backend's own `.env` uses `localhost` for local dev; Docker injects the `postgres`-host URL via `environment:` block.

**`init-db.sql`** — Only runs `CREATE EXTENSION IF NOT EXISTS vector`. HNSW/GIN indexes and the tsvector trigger live in `backend/prisma/migrations/manual_indexes.sql` and are applied by the NestJS startup script *after* `prisma migrate deploy` has created the `document_chunks` table.

**Backend startup CMD:**
```sh
npx prisma migrate deploy && \
psql $DATABASE_URL -f /app/prisma/migrations/manual_indexes.sql && \
node dist/main.js
```
`postgresql-client` is installed in the runner stage to provide `psql`.

**`uploads` volume** — Named Docker volume (not bind mount) so document files survive `docker compose down`.

**`frontend/next.config.ts`** — `output: 'standalone'` enabled; required for the multi-stage frontend Dockerfile.

## Files created
- `docker-compose.yml` (root)
- `.env` (root — shared vars for compose substitution)
- `.env.example` (root — updated)
- `init-db.sql` (root)
- `backend/Dockerfile`
- `frontend/Dockerfile`
- `frontend/next.config.ts` — added `output: 'standalone'`
