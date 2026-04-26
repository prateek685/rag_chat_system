---
name: M6 Testing Suite Status
description: M6 complete — chat.controller.spec.ts (5 unit tests), 12 document integration tests, 8 chat integration tests, test:integration npm script; 100 unit + 20 integration tests green; crypto supply-chain fix
type: project
---

M6 is complete as of 2026-04-26.

**Why:** M6 closes coverage gaps — `ChatController` had no unit test; no HTTP-level integration tests existed. The plan mandates 85%+ global coverage and zero bugs on feature release.

**How to apply:** Unit tests live in `src/` alongside their subjects (`*.spec.ts`). Integration tests live in `backend/test/integration/` and use `npm run test:integration`. Both must pass before any PR merge. The `jest.mock('langfuse', ...)` pattern is required in any spec that transitively imports `LangfuseService`.

## Files created

### Unit tests
- `backend/src/modules/chat/chat.controller.spec.ts` — 5 tests:
  - `POST /chat` delegates to `chatService.handleChat(dto, req.sessionId, res)`
  - `POST /chat` propagates `HttpException` (429 path tested at controller boundary)
  - `POST /chat/retry` delegates to `chatService.handleRetry(req.sessionId, res)`
  - `POST /chat/feedback` delegates to `chatService.handleFeedback(dto)` and resolves void
  - `handleFeedback` error-swallowing verified (controller resolves normally regardless)

### Integration tests
- `backend/test/integration/document.e2e-spec.ts` — 12 Supertest tests:
  - Session Guard: 400 missing header, 400 invalid UUIDv4
  - Upload: 201 valid `.txt`, 400 no file, 415 unsupported MIME, 413 oversized (11MB), 409 conflict
  - Status: 200 found, 404 not found
  - Delete: 204 success, 403 forbidden (wrong session), 404 not found
- `backend/test/integration/chat.e2e-spec.ts` — 8 Supertest tests:
  - Session Guard: 400 missing header, 400 invalid UUIDv4
  - `POST /chat`: 200 + `Content-Type: text/event-stream` + `[DONE]` marker, 400 empty message, 429 rate limit
  - `POST /chat/retry`: SSE stream with `[DONE]`
  - `POST /chat/feedback`: 204 valid payload, 400 invalid score (`score: 0`)
- `backend/test/integration/jest-e2e.json` — Jest config: `testTimeout: 30000`, `ts-jest` transform (no explicit tsconfig path — auto-detect avoids relative-path resolution bug)

### npm script
- `"test:integration": "jest --config ./test/integration/jest-e2e.json"` added to `backend/package.json`

## Bug fixes discovered during M6

### `@HttpCode(200)` on SSE POST endpoints
- `ChatController.chat()` and `ChatController.retry()` were missing `@HttpCode(200)`
- NestJS defaults all `@Post()` routes to 201; SSE streams must return 200
- Fixed in `chat.controller.ts` — this was a production correctness bug, not just a test issue

### Squatted `crypto` npm package removed
- `crypto: ^1.0.1` was a squatted npm package (last published 2013), NOT Node's built-in
- Removed from `package.json`; all usages migrated to named imports from `node:crypto`:
  - `document.service.ts`: `import { createHash } from 'node:crypto'`
  - `chat.service.ts`: `import { createHash, randomUUID } from 'node:crypto'`
  - `document.service.spec.ts`: `import { createHash } from 'node:crypto'`
- Call sites updated: `crypto.createHash(...)` → `createHash(...)`, `crypto.randomUUID()` → `randomUUID()`

## Integration test setup patterns

### `process.env.UPLOADS_PATH` must be set BEFORE imports
`document.controller.ts` reads `UPLOADS_BASE` as a module-level constant at load time. Set the env var at the very top of the spec file before any `import` statements.

### Module setup for integration tests
```typescript
// Real guard + mocked dependencies
{ provide: APP_GUARD, useClass: SessionGuard }
{ provide: PrismaService, useValue: mockPrisma }  // session.upsert mock
{ provide: RedisService, useValue: mockRedis }    // client.get, client.setex mocks
{ provide: Reflector, useValue: mockReflector }   // getAllAndOverride → false
```

### Supertest default import
```typescript
import request from 'supertest';  // correct
// import * as request from 'supertest';  // WRONG — request is not a function
```

### ts-jest tsconfig in jest-e2e.json
Do NOT specify an explicit `tsconfig` path — ts-jest auto-detects `backend/tsconfig.json` from the rootDir. Explicit `../../tsconfig.json` resolves relative to CWD (not config file location) and breaks when run from a different directory.

## Test counts
- **Unit tests**: 100 passing across 10 suites
- **Integration tests**: 20 passing across 2 suites
- **`tsc --noEmit`**: 0 errors
