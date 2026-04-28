-- Change embedding column: vector(1536) → halfvec(2048)
-- Reason: nvidia/llama-nemotron-embed-vl-1b-v2:free outputs 2048-dim vectors.
-- halfvec (16-bit float) lifts pgvector's HNSW dimension cap from 2000 → 4000 dims
-- (requires pgvector >= 0.7.0; verified on 0.8.2).
-- Note: HNSW index is rebuilt by manual_indexes.sql after this migration runs.
ALTER TABLE document_chunks DROP COLUMN IF EXISTS embedding;
ALTER TABLE document_chunks ADD COLUMN embedding halfvec(2048);
