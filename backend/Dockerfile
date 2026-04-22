# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: Run ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# postgresql-client provides psql for running manual_indexes.sql after migrations
RUN apk add --no-cache postgresql-client

WORKDIR /app

COPY --from=builder /app/dist          ./dist
COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/prisma        ./prisma
COPY --from=builder /app/package.json  ./package.json

EXPOSE 8080

# Startup order:
#   1. Apply Prisma migrations  (creates all tables)
#   2. Apply manual indexes     (HNSW, GIN, tsvector trigger — require tables to exist)
#   3. Start NestJS
CMD ["sh", "-c", \
  "npx prisma migrate deploy && \
   psql $DATABASE_URL -f /app/prisma/migrations/manual_indexes.sql && \
   node dist/main.js"]
