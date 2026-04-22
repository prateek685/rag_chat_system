# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* vars are baked into the client bundle at build time.
# Pass them as build args so the final image has the correct API URL.
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build

# ── Stage 2: Run ─────────────────────────────────────────────────────────────
# next.config.ts sets output: 'standalone', which produces a minimal
# self-contained server in .next/standalone — no full node_modules needed.
FROM node:20-alpine AS runner

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder /app/.next/standalone  ./
COPY --from=builder /app/.next/static      ./.next/static
COPY --from=builder /app/public            ./public

EXPOSE 3000

CMD ["node", "server.js"]
