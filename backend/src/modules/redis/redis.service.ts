import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../config/env.config';
import Redis from 'ioredis';

/**
 * P95 budget for individual Redis operations.
 * A miss here almost always means a network issue or Redis overload.
 */
const REDIS_LATENCY_BUDGET_MS = 10;

/**
 * Singleton ioredis client managed by NestJS lifecycle hooks.
 * Exported from RedisModule (@Global) so BullMQ and other services can inject it.
 *
 * All application-level code should use the typed wrapper methods (get, setex, etc.)
 * which provide uniform latency logging and fail-open error handling.
 * The raw `client` property remains available as an escape hatch for BullMQ,
 * which requires direct ioredis access for queue management.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  /** Raw ioredis client — use ONLY for BullMQ. App code must use the typed wrappers below. */
  readonly client: Redis;

  constructor(private readonly configService: ConfigService<EnvConfig, true>) {
    const host = this.configService.get('REDIS_HOST', { infer: true });
    const port = this.configService.get('REDIS_PORT', { infer: true });

    this.client = new Redis({
      host,
      port,
      // Defer TCP handshake to onModuleInit so NestJS controls connection ordering.
      lazyConnect: true,
      // BullMQ requires maxRetriesPerRequest: null on the shared connection.
      maxRetriesPerRequest: null,
      // Fail fast on commands issued before connect() — surfaces misconfiguration early.
      enableOfflineQueue: false,
    });
  }

  /** Establishes the Redis connection after all providers are resolved. */
  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log('Redis connection established');
  }

  /** Sends QUIT so in-flight commands drain before the socket closes. */
  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis connection closed');
  }

  // ---------------------------------------------------------------------------
  // Typed wrappers — fail-open, latency-instrumented
  // ---------------------------------------------------------------------------

  /**
   * Gets a string value by key. Returns null on cache miss or Redis error (fail-open).
   *
   * @param key - Redis key.
   * @returns The stored string or null.
   */
  async get(key: string): Promise<string | null> {
    const start = Date.now();
    try {
      const result = await this.client.get(key);
      this.logLatency('get', key, Date.now() - start);
      return result;
    } catch (err) {
      this.logger.warn({
        event: 'redis_get_failed',
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Sets a string value with no expiry. Fail-open — errors are logged, not thrown.
   *
   * @param key - Redis key.
   * @param value - String value to store.
   */
  async set(key: string, value: string): Promise<void> {
    const start = Date.now();
    try {
      await this.client.set(key, value);
      this.logLatency('set', key, Date.now() - start);
    } catch (err) {
      this.logger.warn({
        event: 'redis_set_failed',
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Sets a string value with a TTL. Fail-open — errors are logged, not thrown.
   *
   * @param key - Redis key.
   * @param ttlSeconds - Time-to-live in seconds.
   * @param value - String value to store.
   */
  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    const start = Date.now();
    try {
      await this.client.setex(key, ttlSeconds, value);
      this.logLatency('setex', key, Date.now() - start);
    } catch (err) {
      this.logger.warn({
        event: 'redis_setex_failed',
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Deletes a single key. Fail-open — errors are logged, not thrown.
   *
   * @param key - Redis key to delete.
   */
  async del(key: string): Promise<void> {
    const start = Date.now();
    try {
      await this.client.del(key);
      this.logLatency('del', key, Date.now() - start);
    } catch (err) {
      this.logger.warn({
        event: 'redis_del_failed',
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Atomically increments an integer counter. Returns 0 on Redis error (fail-open).
   * The fail-open default of 0 means the rate-limiter treats a Redis outage as
   * "first request in window" — users are served rather than hard-blocked.
   *
   * @param key - Redis key holding the integer counter.
   * @returns New counter value, or 0 if Redis is unavailable.
   */
  async incr(key: string): Promise<number> {
    const start = Date.now();
    try {
      const result = await this.client.incr(key);
      this.logLatency('incr', key, Date.now() - start);
      return result;
    } catch (err) {
      this.logger.warn({
        event: 'redis_incr_failed',
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  /**
   * Sets the expiry on an existing key. Fail-open — errors are logged, not thrown.
   *
   * @param key - Redis key.
   * @param seconds - TTL in seconds.
   */
  async expire(key: string, seconds: number): Promise<void> {
    const start = Date.now();
    try {
      await this.client.expire(key, seconds);
      this.logLatency('expire', key, Date.now() - start);
    } catch (err) {
      this.logger.warn({
        event: 'redis_expire_failed',
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Enumerates keys matching a glob pattern using SCAN (non-blocking cursor iteration).
   * Safe for production — never uses KEYS which blocks Redis on large keyspaces.
   * Returns an empty array on error (fail-open).
   *
   * @param pattern - Glob pattern, e.g. `semantic:{sessionId}:*`.
   * @returns Array of matching key strings.
   */
  async scan(pattern: string): Promise<string[]> {
    const results: string[] = [];
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        results.push(...keys);
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn({
        event: 'redis_scan_failed',
        pattern,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    return results;
  }

  /**
   * Deletes all keys matching a glob pattern using SCAN + batched DEL.
   * Uses SCAN (not KEYS) to avoid blocking Redis on large keyspaces.
   * Returns 0 on error (fail-open).
   *
   * @param pattern - Glob pattern, e.g. `semantic:{sessionId}:*`.
   * @returns Total number of keys deleted.
   */
  async delPattern(pattern: string): Promise<number> {
    let deleted = 0;
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.client.del(...(keys as [string, ...string[]]));
          deleted += keys.length;
        }
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn({
        event: 'redis_del_pattern_failed',
        pattern,
        deleted,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return deleted;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Logs a warning if an operation exceeds the latency budget. */
  private logLatency(operation: string, key: string, latencyMs: number): void {
    if (latencyMs > REDIS_LATENCY_BUDGET_MS) {
      this.logger.warn({
        event: 'latency_budget_exceeded',
        operation: `redis_${operation}`,
        key,
        latencyMs,
        budget: REDIS_LATENCY_BUDGET_MS,
      });
    }
  }
}
