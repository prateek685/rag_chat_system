---
name: M4 Frontend Status
description: M4 complete — Next.js chat UI with SSE streaming, document sidebar, citations panel, feedback bar, shadcn/ui v4 components; tsc clean + build clean
type: project
---

M4 is complete as of 2026-04-25.

**Why:** M4 delivers the user-facing interface. No auth — sessions are UUID v4 values generated client-side on first visit and persisted to `localStorage`.

**How to apply:** All API communication goes through `frontend/src/lib/api.ts`. SSE parsing lives in `useChat.ts`. Do not add fetch calls directly in components.

## Files created

### App shell
- `frontend/src/app/layout.tsx` — root layout with Inter font, global CSS, metadata
- `frontend/src/app/globals.css` — Tailwind base + shadcn CSS variables (dark/light tokens)
- `frontend/src/app/page.tsx` — landing/redirect to `/chat`
- `frontend/src/app/chat/page.tsx` — main chat page; composes `Header`, `Sidebar`, `ChatWindow`

### Components
- `frontend/src/components/chat/ChatWindow.tsx` — message list + `ChatInput`; scrolls to bottom on new messages
- `frontend/src/components/chat/ChatInput.tsx` — textarea with send button; disabled while streaming; Shift+Enter for newline, Enter to send
- `frontend/src/components/chat/MessageBubble.tsx` — renders user/assistant/system messages; assistant messages use `react-markdown` with GFM
- `frontend/src/components/chat/FeedbackBar.tsx` — thumbs up/down; calls `POST /chat/feedback`; users can re-vote (no `disabled={voted}`)
- `frontend/src/components/chat/CitationPill.tsx` — `[Source N]` chip that opens `CitationSidePanel`
- `frontend/src/components/chat/CitationSidePanel.tsx` — slide-out panel (Sheet) listing citations with filename, page number, excerpt
- `frontend/src/components/sidebar/Sidebar.tsx` — document list + `UploadZone`; responsive (Sheet on mobile)
- `frontend/src/components/sidebar/DocumentItem.tsx` — shows filename, status badge (PENDING/PROCESSING/COMPLETED/FAILED), delete button; polls status every 3s while PENDING/PROCESSING
- `frontend/src/components/sidebar/UploadZone.tsx` — drag-and-drop + file picker; accepts `.txt .csv .md .pdf`; max 10MB client-side guard
- `frontend/src/components/layout/Header.tsx` — app title, session ID display (truncated), retry button
- `frontend/src/components/ui/` — shadcn/ui v4 primitives: `button`, `badge`, `card`, `scroll-area`, `separator`, `sheet`, `textarea`, `tooltip`

### Hooks
- `frontend/src/hooks/useSession.ts` — generates/retrieves UUIDv4 from `localStorage`; SSR-safe
- `frontend/src/hooks/useChat.ts` — manages message list, SSE stream parsing, retry; extracts `token`, `citations`, `traceId`, `[DONE]`, `error` event types
- `frontend/src/hooks/useDocuments.ts` — upload, delete, status polling; wraps `api.ts`

### Lib
- `frontend/src/lib/api.ts` — typed fetch wrappers for all backend endpoints; always attaches `x-session-id` header
- `frontend/src/lib/types.ts` — shared TypeScript types: `Message`, `Citation`, `DocumentStatus`, `UploadResponse`, SSE event shapes
- `frontend/src/lib/citations.ts` — parses `[Source N]` markers from assistant message text for inline `CitationPill` injection
- `frontend/src/lib/storage.ts` — `localStorage` read/write helpers (session ID, theme preference)
- `frontend/src/lib/utils.ts` — `cn()` (clsx + tailwind-merge), date formatting

## Key implementation details

### shadcn/ui v4
- Uses v4 (Canary at time of implementation) — component primitives ship without a default `className`; styles must be explicit
- `components.json` at `frontend/` root configures aliases and style variant
- `postcss.config.mjs` required for Tailwind v4 PostCSS integration

### SSE parsing in `useChat.ts`
- `fetch` + `ReadableStream` — NOT `EventSource` (EventSource doesn't support POST with body)
- Parser splits on `\n\n`, strips `data: ` prefix, handles `[DONE]` sentinel
- `citations` and `traceId` events are received after the last token, before `[DONE]`

### Session isolation
- `useSession.ts` generates a UUIDv4 on first load using `crypto.randomUUID()` (Web Crypto API)
- All `api.ts` calls set `'x-session-id': sessionId` header
- No cookies, no server session — stateless client

## Configuration files
- `frontend/components.json` — shadcn config
- `frontend/postcss.config.mjs` — Tailwind PostCSS plugin
- `frontend/package.json` — added `react-markdown`, `remark-gfm`, `clsx`, `tailwind-merge`, `lucide-react`
