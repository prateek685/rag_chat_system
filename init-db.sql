-- Runs automatically on the very first Postgres container start
-- (mounted at /docker-entrypoint-initdb.d/init.sql).
-- Only enables the pgvector extension — HNSW/GIN indexes and the
-- tsvector trigger are applied by the backend startup script AFTER
-- prisma migrate deploy has created the document_chunks table.

CREATE EXTENSION IF NOT EXISTS vector;
