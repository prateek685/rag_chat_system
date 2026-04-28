-- ============================================================
-- Migration: document_chunks.embedding → halfvec(2048)
-- Reason: nvidia/llama-nemotron-embed-vl-1b-v2:free outputs 2048-dim vectors.
-- halfvec (16-bit float) is used because pgvector's HNSW index caps at 2000 dims
-- for the standard vector type; halfvec raises that cap to 4000 dims (pgvector >= 0.7.0).
--
-- Run BEFORE starting the backend for the first time with this model.
-- WARNING: drops any existing embeddings — re-process documents after applying.
--
-- Apply: psql $DATABASE_URL -f prisma/migrations/alter_embedding_dim_1536_to_2048.sql
-- ============================================================

-- Step 1: Drop HNSW index if it exists (pgvector requires no index before ALTER COLUMN).
DROP INDEX IF EXISTS document_chunks_embedding_idx;

-- Step 2: Replace the column with halfvec(2048).
ALTER TABLE document_chunks DROP COLUMN IF EXISTS embedding;
ALTER TABLE document_chunks ADD COLUMN embedding halfvec(2048);

-- Step 3: Rebuild the HNSW index using halfvec_cosine_ops.
-- ef_construction=64 balances build time vs. recall; tune if recall degrades.
CREATE INDEX document_chunks_embedding_idx
  ON document_chunks USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
