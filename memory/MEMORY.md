# Memory Index

- [M0 Bootstrap Status](project_m0_status.md) — M0 complete: NestJS + Next.js scaffolded, all deps, Swagger, ValidationPipe, env config, filters, interceptors
- [M1 Database & Session Foundation Status](project_m1_status.md) — M1 complete: Prisma schema (4 models), PrismaService, SessionGuard, 7 tests green
- [M2 Document Upload & Processing Pipeline Status](project_m2_status.md) — M2 complete: Bull queue, Multer upload, SHA-256 dedup, PDF/text/md parsing, semantic chunking, pgvector bulk INSERT, delete with cache flush + ghost message; 50 tests green
- [Prisma 7 Driver Adapter Pattern](project_prisma7_adapter.md) — url removed from schema.prisma; prisma.config.ts + @prisma/adapter-pg required; test mocking pattern
- [Docker Compose & Infrastructure Setup](project_docker_infra.md) — 5 containers, DATABASE_URL encoding gotcha, init-db.sql vs manual_indexes.sql split, uploads volume
- [Claude Working Guidelines](feedback_claude_guidelines.md) — NEVER read .env files; no implementation drift from plan; update memory after every phase
- [M3 Chat Pipeline Status](project_m3_status.md) — M3 complete: LangGraph RAG, SSE streaming, rate limit, cache, sliding window, running summary, hybrid retrieval, reranker, citations
- [M4 Frontend Status](project_m4_status.md) — M4 complete: Next.js chat UI, SSE stream parser, document sidebar, citation panel, FeedbackBar, shadcn/ui v4, session localStorage
- [M5 Observability & Feedback Status](project_m5_status.md) — M5 complete: Langfuse tracing in all nodes + document processor, token usage, eval skeleton (8-entry dataset), 95 tests green
- [M6 Testing Suite Status](project_m6_status.md) — M6 complete: chat.controller unit tests, 12 document + 8 chat integration tests, @HttpCode(200) fix, node:crypto migration; 100+20 tests green
- [V2 Features Status](project_v2_status.md) — V2 complete: Redis wrappers, LLM retry (withLlmRetry), semantic cache (cosine ≥0.98), running summary (SummarizeMemoryNode); 155 unit tests green
