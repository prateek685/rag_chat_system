---
name: M0 Bootstrap Status
description: Tracks completion status of Module 0 (Project Bootstrap & Infrastructure)
type: project
---

M0 is complete. Backend and frontend scaffolded with all dependencies installed.

**Why:** M0 is the foundation all other modules depend on.

**How to apply:** When starting M1, the backend compiles cleanly and all deps are available. Skip any re-installation steps.

## What was done
- `backend/` — NestJS 10 scaffold, all deps installed (see package.json)
- `backend/src/main.ts` — ValidationPipe (whitelist+transform), Swagger on `/api/docs`, port from ConfigService
- `backend/src/app.module.ts` — ConfigModule global with Joi validation, APP_FILTER + APP_INTERCEPTOR wired
- `backend/src/config/env.config.ts` — Joi schema + EnvConfig interface; validates all required env vars at startup
- `backend/src/common/filters/http-exception.filter.ts` — Global HTTP exception filter, consistent JSON error envelope
- `backend/src/common/interceptors/logging.interceptor.ts` — Logs method, URL, sessionId, latencyMs per request
- `frontend/` — Next.js 15 (App Router, TypeScript, src/), axios + react-markdown + remark-gfm + uuid installed
- `.env.example` — All required env vars documented
- `.gitignore` — Covers node_modules, dist, .next, uploads, .env, OS files
- frontend `.git` removed (monorepo — single root repo)
