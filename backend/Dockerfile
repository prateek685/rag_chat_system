# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# ── Stage 2: Run ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# postgresql-client provides psql for running manual_indexes.sql after migrations
RUN apk add --no-cache postgresql-client

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder --chown=node:node /app/dist          ./dist
COPY --from=builder --chown=node:node /app/node_modules  ./node_modules
COPY --from=builder --chown=node:node /app/prisma        ./prisma
COPY --from=builder --chown=node:node /app/package.json  ./package.json

# Run as non-root — node user (uid 1000) ships with node:alpine.
USER node

EXPOSE 8080

CMD ["node", "dist/main.js"]
