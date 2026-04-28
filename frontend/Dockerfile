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

# Run as non-root user
USER node

# Match the port mapping in docker-compose.yml ("127.0.0.1:3001:3001").
# next.js standalone server.js reads PORT at runtime; without this it defaults to 3000,
# leaving container:3001 with nothing listening while the compose mapping expects it.
ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
