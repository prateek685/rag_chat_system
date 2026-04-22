-- ============================================================
-- Manual indexes and triggers — applied AFTER prisma migrate deploy
-- Run: psql $DATABASE_URL -f prisma/migrations/manual_indexes.sql
-- ============================================================

-- Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- HNSW index for ultra-fast dense cosine-distance vector search.
-- ef_construction=64 balances build time vs. recall for 1536-dim embeddings.
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- GIN index for full-text keyword search (tsvector BM25).
CREATE INDEX IF NOT EXISTS document_chunks_search_idx
  ON document_chunks USING GIN (search_vector);

-- Function that keeps search_vector in sync with content on every write.
CREATE OR REPLACE FUNCTION update_search_vector()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('pg_catalog.english', NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: fires before every INSERT or UPDATE on document_chunks.
DROP TRIGGER IF EXISTS tsvectorupdate ON document_chunks;
CREATE TRIGGER tsvectorupdate
  BEFORE INSERT OR UPDATE ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();
