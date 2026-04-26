import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/** Redis key prefix for all semantic cache entries. */
const SEMANTIC_KEY_PREFIX = 'semantic';

/** Build a session-scoped semantic cache key. */
const semanticKey = (sessionId: string, id: string): string =>
  `${SEMANTIC_KEY_PREFIX}:${sessionId}:${id}`;

/** Build the SCAN pattern to enumerate all semantic entries for a session. */
const sessionPattern = (sessionId: string): string =>
  `${SEMANTIC_KEY_PREFIX}:${sessionId}:*`;

/** TTL for semantic cache entries — matches exact cache (24 hours). */
const SEMANTIC_CACHE_TTL_SECONDS = 60 * 60 * 24;

/**
 * Cosine similarity threshold for a semantic cache hit.
 * 0.98 means the vectors are essentially identical — a different phrasing
 * of the same underlying question.
 */
const SIMILARITY_THRESHOLD = 0.98;

/**
 * Maximum number of cached entries to scan per session.
 * Bounds lookup time: even at 1536-dim, 100 comparisons completes in <5ms.
 */
const MAX_ENTRIES_TO_SCAN = 100;

/** Stored shape for each semantic cache entry. */
interface SemanticCacheEntry {
  embedding: number[];
  response: string;
}

/**
 * Session-scoped semantic cache using Redis.
 *
 * On every RAG_QUERY response:
 *  - Stores { embedding, response } at key `semantic:{sessionId}:{hex8}` (TTL 24h).
 *
 * On the next similar query:
 *  - SCANs keys for the session (up to MAX_ENTRIES_TO_SCAN).
 *  - Fetches all values in parallel.
 *  - Returns the response for the entry whose cosine similarity ≥ 0.98.
 *
 * All methods are fail-open — Redis failures are logged as warnings and
 * never propagate to the caller.
 */
@Injectable()
export class SemanticCacheService {
  private readonly logger = new Logger(SemanticCacheService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Checks whether the session has a semantically similar cached response.
   *
   * @param sessionId - Session UUID to scope the lookup.
   * @param queryEmbedding - Dense embedding of the current query.
   * @returns Cached response string if similarity ≥ 0.98, null otherwise.
   */
  async lookup(sessionId: string, queryEmbedding: number[]): Promise<string | null> {
    try {
      const keys = await this.redis.scan(sessionPattern(sessionId));
      if (keys.length === 0) return null;

      // Cap to the most recent MAX_ENTRIES_TO_SCAN keys to bound cost.
      const keysToCheck = keys.slice(0, MAX_ENTRIES_TO_SCAN);

      // Fetch all entries in parallel — single pass over the key list.
      const rawValues = await Promise.all(keysToCheck.map((k) => this.redis.get(k)));

      let bestSimilarity = 0;
      let bestResponse: string | null = null;

      for (const raw of rawValues) {
        if (!raw) continue;
        try {
          const entry = JSON.parse(raw) as SemanticCacheEntry;
          if (!Array.isArray(entry.embedding) || typeof entry.response !== 'string') continue;

          const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding);
          if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestResponse = entry.response;
          }
        } catch {
          // Malformed JSON — skip this entry silently.
        }
      }

      if (bestSimilarity >= SIMILARITY_THRESHOLD && bestResponse) {
        this.logger.log({ event: 'semantic_cache_hit', sessionId, similarity: bestSimilarity });
        return bestResponse;
      }

      return null;
    } catch (err) {
      this.logger.warn({
        event: 'semantic_cache_lookup_failed',
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Stores a RAG response alongside its query embedding for future similarity lookups.
   * Only call for genuine RAG_QUERY responses — never for canned VIOLATION/NO_CONTEXT replies.
   *
   * @param sessionId - Session UUID to scope the entry.
   * @param queryEmbedding - Dense embedding of the query that produced this response.
   * @param response - Full LLM response text to cache.
   */
  async store(sessionId: string, queryEmbedding: number[], response: string): Promise<void> {
    const id = randomBytes(4).toString('hex');
    const key = semanticKey(sessionId, id);
    const entry: SemanticCacheEntry = { embedding: queryEmbedding, response };

    try {
      await this.redis.setex(key, SEMANTIC_CACHE_TTL_SECONDS, JSON.stringify(entry));
      this.logger.log({ event: 'semantic_cache_stored', sessionId });
    } catch (err) {
      this.logger.warn({
        event: 'semantic_cache_store_failed',
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Deletes all semantic cache entries for the session.
   * Called on document delete, user retry, and negative feedback to prevent
   * stale or wrong answers being served from cache.
   *
   * @param sessionId - Session UUID whose cache to wipe.
   */
  async invalidateSession(sessionId: string): Promise<void> {
    const deleted = await this.redis.delPattern(sessionPattern(sessionId));
    this.logger.log({ event: 'semantic_cache_invalidated', sessionId, keysDeleted: deleted });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Computes cosine similarity between two same-length vectors.
   * Returns 0 for zero-length or mismatched vectors (safe default for threshold check).
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
