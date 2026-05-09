/**
 * V5.3.0 Retry utilities — exponential backoff, error classification, circuit breaker.
 *
 * Provides:
 * - classifyError: categorize errors as transient vs permanent for retry decisions
 * - withRetry: async retry wrapper with exponential backoff + jitter
 * - CircuitBreaker: sliding-window failure-rate tracker with auto-reset
 */

import { logger } from '../logger.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type ErrorClass = 'TRANSIENT' | 'PERMANENT';

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms (default: 16000) */
  maxDelayMs?: number;
  /** Optional AbortSignal — if aborted, retry loop stops */
  signal?: AbortSignal | undefined;
  /** Custom retry predicate — overrides classifyError when provided */
  shouldRetry?: ((err: unknown) => boolean) | undefined;
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 16000;

// ── Custom Error ────────────────────────────────────────────────────────────

/** Thrown when a CircuitBreaker is open and the call is rejected. */
export class CircuitBreakerOpenError extends Error {
  constructor() {
    super('Circuit breaker is open');
    this.name = 'CircuitBreakerOpenError';
  }
}

// ── Error Classification ────────────────────────────────────────────────────

const TRANSIENT_STATUS_CODES = new Set([429, 503]);
const PERMANENT_STATUS_CODES = new Set([400, 401, 403, 404]);
const TRANSIENT_NODE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED']);

/**
 * Classify an error as TRANSIENT (retryable) or PERMANENT (non-retryable).
 *
 * TRANSIENT: HTTP 429/503, ETIMEDOUT, ECONNRESET, ECONNREFUSED, socket hang up
 * PERMANENT: HTTP 400/401/403/404, ENOTFOUND, AbortError
 * Default: TRANSIENT for network-level errors, PERMANENT for everything else
 */
export function classifyError(err: unknown): ErrorClass {
  // Non-Error throws are permanent (cannot inspect cause)
  if (!(err instanceof Error)) {
    return 'PERMANENT';
  }

  // AbortError is always permanent — never retry
  if (err.name === 'AbortError') {
    return 'PERMANENT';
  }

  // Axios-style error shape (err.response.status)
  const errRecord = err as unknown as Record<string, unknown>;
  if (
    errRecord.response !== null &&
    errRecord.response !== undefined &&
    typeof errRecord.response === 'object'
  ) {
    const response = errRecord.response as Record<string, unknown>;
    const status = typeof response.status === 'number' ? response.status : undefined;

    if (status !== undefined) {
      if (TRANSIENT_STATUS_CODES.has(status)) return 'TRANSIENT';
      if (PERMANENT_STATUS_CODES.has(status)) return 'PERMANENT';
    }
  }

  // Node.js system error codes
  const nodeErr = err as NodeJS.ErrnoException;
  if (nodeErr.code !== undefined) {
    if (TRANSIENT_NODE_CODES.has(nodeErr.code)) return 'TRANSIENT';
    if (nodeErr.code === 'ENOTFOUND') return 'PERMANENT';
  }

  // Message-based heuristics for errors where code/status are not set
  const msg = err.message.toLowerCase();
  if (msg.includes('socket hang up') || msg.includes('econnreset')) {
    return 'TRANSIENT';
  }

  // Follow the cause chain (fetch wrappers nest the original error in cause)
  if (err.cause instanceof Error) {
    return classifyError(err.cause);
  }

  // Default: network errors tend to be transient
  return 'TRANSIENT';
}

// ── Retry with Exponential Backoff ──────────────────────────────────────────

/**
 * Compute the delay for a given retry attempt.
 * Uses exponential backoff: baseDelay * 2^attempt + random(0, baseDelay)
 * Capped at maxDelayMs.
 */
function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Retry an async function with exponential backoff and jitter.
 *
 * Only retries on TRANSIENT errors (determined by `classifyError` or a custom
 * `shouldRetry` predicate). AbortError and aborted signals short-circuit immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const shouldRetry = options?.shouldRetry;
  const signal = options?.signal;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Never retry if the enclosing operation was aborted
      if (signal?.aborted) {
        throw err;
      }

      // Never retry AbortError
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }

      // Determine retry eligibility
      const retryable = shouldRetry ? shouldRetry(err) : classifyError(err) === 'TRANSIENT';

      if (!retryable || attempt >= maxRetries) {
        throw err;
      }

      // Calculate delay with jitter
      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs);

      logger.warn(
        { err, attempt: attempt + 1, maxRetries, delayMs: delay },
        'Retrying operation after transient error',
      );

      // Wait for the delay, but abort early if signal fires
      await sleepWithSignal(delay, signal);

      // If the signal fired during sleep, abort
      if (signal?.aborted) {
        throw err;
      }
    }
  }

  // TypeScript control-flow guard (unreachable)
  throw lastError;
}

/**
 * Promise-based delay that short-circuits when an AbortSignal fires.
 */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, ms);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ── Circuit Breaker ─────────────────────────────────────────────────────────

interface CircuitBreakerOptions {
  /** Sliding window size (default: 10) */
  windowSize?: number;
  /** Failure rate threshold to trip the breaker (default: 0.8) */
  failureThreshold?: number;
  /** Cooldown period in ms before auto-reset (default: 60000) */
  cooldownMs?: number;
}

interface WindowEntry {
  success: boolean;
  timestamp: number;
}

/**
 * Sliding-window circuit breaker.
 *
 * Tracks the success/failure ratio of the last N calls. When the failure rate
 * exceeds the configured threshold, the circuit opens and all subsequent calls
 * fail fast with `CircuitBreakerOpenError`. After the cooldown period elapses,
 * the circuit auto-resets and allows calls through again.
 *
 * Thread safety is not required (single-threaded Node.js).
 */
export class CircuitBreaker {
  private readonly windowSize: number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private window: WindowEntry[] = [];
  private lastOpenAt: number | null = null;

  constructor(options?: CircuitBreakerOptions) {
    this.windowSize = options?.windowSize ?? 10;
    this.failureThreshold = options?.failureThreshold ?? 0.8;
    this.cooldownMs = options?.cooldownMs ?? 60000;
  }

  /** Record a successful call. */
  recordSuccess(): void {
    this.trimWindow();
    this.window.push({ success: true, timestamp: Date.now() });
  }

  /** Record a failed call. */
  recordFailure(): void {
    this.trimWindow();
    this.window.push({ success: false, timestamp: Date.now() });
  }

  /**
   * Check whether the circuit is currently open.
   *
   * Computes the failure rate over the sliding window. If it exceeds the
   * threshold, the circuit opens. Once the cooldown period has elapsed,
   * the circuit auto-resets (even without any intervening successes).
   */
  isOpen(): boolean {
    this.trimWindow();

    if (this.window.length === 0) {
      this.lastOpenAt = null;
      return false;
    }

    const failureCount = this.window.filter((e) => !e.success).length;
    const failureRate = failureCount / this.window.length;

    if (failureRate > this.failureThreshold) {
      // First detection — record the moment we opened
      this.lastOpenAt ??= Date.now();

      // Auto-reset after cooldown period
      if (Date.now() - this.lastOpenAt >= this.cooldownMs) {
        this.reset();
        return false;
      }

      return true;
    }

    // Failure rate is under threshold — close the circuit
    this.lastOpenAt = null;
    return false;
  }

  /**
   * Execute an async function through the circuit breaker.
   *
   * Throws `CircuitBreakerOpenError` immediately if the circuit is open,
   * otherwise runs the function and records success or failure.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen()) {
      throw new CircuitBreakerOpenError();
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /** Manually reset the circuit breaker to closed state. */
  reset(): void {
    this.window = [];
    this.lastOpenAt = null;
  }

  /**
   * Keep only the most recent `windowSize` entries, dropping older ones.
   */
  private trimWindow(): void {
    if (this.window.length > this.windowSize) {
      this.window = this.window.slice(-this.windowSize);
    }
  }
}
