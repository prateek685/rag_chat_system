/**
 * Generic exponential-backoff retry wrapper for LLM and embedding API calls.
 *
 * Retries on transient server/rate-limit errors (429, 5xx, network failures).
 * Throws immediately on client errors (400, 401, 403, 422) — retrying these
 * wastes quota and would never succeed.
 */

/** HTTP status codes that indicate a transient failure worth retrying. */
export const RETRYABLE_HTTP_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export interface LlmRetryOptions {
  /** Short label used in log events (e.g. 'router', 'generator', 'embed_query'). */
  operation: string;
  /** Passed through to log events for correlation. */
  sessionId?: string;
  /** Total attempts including the initial call. Defaults to 3. */
  maxAttempts?: number;
  /**
   * Delay before attempt 2 (ms). Doubles each retry.
   * Attempt delays: baseDelay, baseDelay×2, baseDelay×4 (all + random jitter ≤ 200ms).
   * Defaults to 1000ms.
   */
  baseDelayMs?: number;
}

/**
 * Calls `fn()` and retries with exponential backoff on transient failures.
 *
 * @param fn - Factory that creates the promise to retry on each attempt.
 * @param logger - Any object with a `warn` method (pass `this.logger` from a NestJS service).
 * @param options - Retry configuration.
 * @returns The resolved value of `fn()`.
 * @throws The last error after all attempts are exhausted, or immediately on non-retryable errors.
 */
export async function withLlmRetry<T>(
  fn: () => Promise<T>,
  logger: { warn(obj: object): void },
  options: LlmRetryOptions,
): Promise<T> {
  const { operation, sessionId, maxAttempts = 3, baseDelayMs = 1000 } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Extract HTTP status from OpenAI SDK error shape.
      const status =
        (err as { status?: number })?.status ??
        (err as { response?: { status?: number } })?.response?.status;

      // Non-retryable client errors — throw immediately.
      const isClientError =
        status !== undefined && !RETRYABLE_HTTP_STATUS_CODES.has(status) && status < 500;
      if (isClientError || attempt === maxAttempts) {
        throw err;
      }

      // Exponential backoff: 1s → 2s → 4s, each + random jitter up to 200ms.
      const jitter = Math.floor(Math.random() * 200);
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + jitter;

      logger.warn({
        event: 'llm_retry_scheduled',
        operation,
        sessionId,
        attempt,
        maxAttempts,
        statusCode: status,
        delayMs,
      });

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
