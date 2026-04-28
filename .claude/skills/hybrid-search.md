# Skill: Hybrid Search & Retrieval

## Scope
Everything inside `modules/worker/vector.service.ts` and the Prisma raw SQL retrieval queries.
Use this skill when working on: hybrid search SQL, RRF fusion, reranking, semantic caching, pgvector indexes.

---

## Search Strategy: Dense + Sparse → RRF → Rerank

### Step 1 — Semantic (Dense) Search
```sql
WITH semantic_search AS (
  SELECT
    id, content, metadata,
    1 - (embedding <=> ${embeddingVector}::vector) AS semantic_score
  FROM document_chunks
  WHERE session_id = ${sessionId}
  ORDER BY embedding <=> ${embeddingVector}::vector
  LIMIT 20
),
```
- Uses HNSW index (`document_chunks_embedding_idx`)
- Distance metric: **cosine** (`<=>`)

### Step 2 — Keyword (Sparse) Search
```sql
keyword_search AS (
  SELECT
    id, content, metadata,
    ts_rank_cd(search_vector, plainto_tsquery('english', ${userPrompt})) AS keyword_score
  FROM document_chunks
  WHERE session_id = ${sessionId}
    AND search_vector @@ plainto_tsquery('english', ${userPrompt})
  ORDER BY keyword_score DESC
  LIMIT 20
),
```
- Uses GIN index (`document_chunks_search_idx`)
- `tsvector` is auto-populated by Postgres trigger on insert/update

### Step 3 — Reciprocal Rank Fusion (RRF)
```sql
SELECT
  COALESCE(s.id, k.id)           AS id,
  COALESCE(s.content, k.content) AS content,
  COALESCE(s.metadata, k.metadata) AS metadata,
  COALESCE(s.semantic_score, 0) + COALESCE(k.keyword_score, 0) AS rrf_score
FROM semantic_search s
FULL OUTER JOIN keyword_search k ON s.id = k.id
ORDER BY rrf_score DESC
LIMIT 50;
```
Full outer join captures chunks that appear in only one result set.  
Returns **Top 50** candidates for reranking.

---

## Reranking

### Primary: Cohere Rerank 3
```typescript
const reranked = await cohere.rerank({
  model: 'rerank-english-v3.0',
  query: userPrompt,
  documents: top50.map(c => c.content),
  top_n: 5,
});
```

### Timeout & Fallback
```typescript
const RERANK_TIMEOUT_MS = 600;

try {
  const result = await Promise.race([
    this.rerank(userPrompt, top50),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('rerank_timeout')), RERANK_TIMEOUT_MS)
    ),
  ]);
  return result.slice(0, 5);
} catch (err) {
  this.langfuse.log({ tags: ['rerank_failure'], error: err.message });
  return top50.slice(0, 5);   // graceful degradation: use RRF top-5
}
```

### Safety Threshold
If `reranked[0].relevanceScore < 0.60`, **do not call the LLM**. Return:
```json
{ "answer": "I couldn't find relevant information in your uploaded documents to answer that question." }
```

---

## Semantic Cache

### Write (after successful generation)
```typescript
await redis.set(
  `semantic:${sessionId}:${queryHash}`,
  JSON.stringify({ answer, embeddingVector }),
  'EX', 86400   // 24-hour TTL
);
```

### Read (before retrieval)
```typescript
// 1. Exact hash check
const exact = await redis.get(`semantic:${sessionId}:${queryHash}`);
if (exact) return JSON.parse(exact).answer;

// 2. Semantic similarity check (cosine ≥ 0.98)
// Iterate cached vectors for this session — return if similarity threshold met
```

Cache must be **invalidated** for the entire `session_id` when any document is deleted.

---

## Index Definitions (manual SQL — must be applied after Prisma migration)
```sql
-- HNSW for dense vector search
CREATE INDEX document_chunks_embedding_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops);

-- GIN for full-text / keyword search
CREATE INDEX document_chunks_search_idx
  ON document_chunks USING GIN (search_vector);

-- Auto-populate tsvector
CREATE FUNCTION tsvector_update_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('pg_catalog.english', NEW.content);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER tsvectorupdate
  BEFORE INSERT OR UPDATE ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION tsvector_update_trigger();
```

---

## Integration Test Checklist
- [ ] Hybrid search returns ≤ 50 results
- [ ] Chunk with highest combined score is ranked #1
- [ ] Semantic cache hit returns identical answer without hitting Postgres
- [ ] Cache is fully cleared after document deletion
- [ ] Reranker timeout falls back gracefully (top-5 from RRF)
- [ ] Score < 0.60 returns canned "no context" response — LLM never called
- [ ] Cascading delete leaves zero orphan chunks for that session
