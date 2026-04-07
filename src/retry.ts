/**
 * Exponential backoff retry utility with jitter.
 *
 * Only retries errors that are deemed transient (ToolError.retryable or
 * heuristic checks on plain Error messages).
 */

import { logger } from './logger.js';
import { isToolError } from './errors.js';

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Initial delay in ms before the first retry. Default: 200. */
  initialDelayMs?: number;
  /** Maximum delay in ms between retries. Default: 5000. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each retry. Default: 2. */
  backoffFactor?: number;
  /** Label for log messages (e.g. "brave-search"). Default: "retry". */
  label?: string;
}

function isRetryable(err: unknown): boolean {
  if (isToolError(err)) return err.retryable;

  if (err instanceof Error) {
    if (err.name === 'AbortError') return true;
    const msg = err.message.toLowerCase();
    return /timeout|etimedout|econnreset|econnrefused|enotfound|socket hang up|fetch failed/.test(
      msg,
    );
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? 3);
  const initialDelayMs = opts?.initialDelayMs ?? 200;
  const maxDelayMs = opts?.maxDelayMs ?? 5000;
  const backoffFactor = opts?.backoffFactor ?? 2;
  const label = opts?.label ?? 'retry';

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      if (attempt === maxAttempts) break;
      if (!isRetryable(err)) throw err;

      // Full jitter: uniform random in [0, cappedDelay]
      const baseDelay = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
      const cappedDelay = Math.min(baseDelay, maxDelayMs);
      const jitteredDelay = Math.floor(Math.random() * (cappedDelay + 1));

      logger.warn(
        {
          label,
          attempt,
          maxAttempts,
          delayMs: jitteredDelay,
          error: err instanceof Error ? err.message : String(err),
          code: isToolError(err) ? err.code : undefined,
        },
        'Retrying after transient failure',
      );

      await sleep(jitteredDelay);
    }
  }

  throw lastError;
}
