/**
 * Rate limit tracking for external API backends.
 *
 * Parses rate-limit headers from HTTP responses, tracks remaining quota,
 * and provides pre-request gating (short backoff or fail-fast).
 */

import { logger } from './logger.js';
import { rateLimitError } from './errors.js';

export interface RateLimitInfo {
  /** Requests remaining in the current window. */
  remaining: number;
  /** Total request quota for the current window. */
  limit: number;
  /** Unix timestamp (ms) when the rate limit window resets. */
  resetAt: number;
  /** Which backend this applies to. */
  backend: string;
}

export type RateLimitedBackend = 'brave' | 'github' | 'github_search' | 'reddit' | 'semantic_scholar' | 'arxiv';

const LOW_REMAINING_THRESHOLD = 5;
const MAX_SHORT_BACKOFF_MS = 5_000;

// ── Header parsing ──────────────────────────────────────────────────────────

function parseBraveHeaders(headers: Headers): RateLimitInfo | null {
  const remaining = headers.get('x-ratelimit-remaining');
  if (remaining === null) return null;

  const remainingNum = parseInt(remaining, 10);
  if (isNaN(remainingNum)) return null;

  const limitStr = headers.get('x-ratelimit-limit');
  const limitNum = limitStr !== null ? parseInt(limitStr, 10) : 0;

  // Brave reset is seconds-from-now (relative)
  const resetStr = headers.get('x-ratelimit-reset');
  const resetSeconds = resetStr !== null ? parseInt(resetStr, 10) : 1;
  const resetAt = Date.now() + (isNaN(resetSeconds) ? 1000 : resetSeconds * 1000);

  return {
    remaining: remainingNum,
    limit: isNaN(limitNum) ? 0 : limitNum,
    resetAt,
    backend: 'brave',
  };
}

function parseGitHubHeaders(headers: Headers): RateLimitInfo | null {
  const remaining = headers.get('x-ratelimit-remaining');
  if (remaining === null) return null;

  const remainingNum = parseInt(remaining, 10);
  if (isNaN(remainingNum)) return null;

  const limitStr = headers.get('x-ratelimit-limit');
  const limitNum = limitStr !== null ? parseInt(limitStr, 10) : 0;

  // GitHub reset is absolute Unix timestamp in seconds
  const resetStr = headers.get('x-ratelimit-reset');
  const resetEpochSec = resetStr !== null ? parseInt(resetStr, 10) : 0;

  // Compensate for clock skew using the Date header
  let clockSkewMs = 0;
  const serverDateStr = headers.get('date');
  if (serverDateStr) {
    const serverTime = new Date(serverDateStr).getTime();
    if (!isNaN(serverTime)) {
      clockSkewMs = Date.now() - serverTime;
    }
  }

  const resetAt =
    isNaN(resetEpochSec) || resetEpochSec === 0
      ? Date.now() + 60_000
      : resetEpochSec * 1000 + clockSkewMs;

  return {
    remaining: remainingNum,
    limit: isNaN(limitNum) ? 0 : limitNum,
    resetAt,
    backend: 'github',
  };
}

function parseGitHubSearchHeaders(headers: Headers): RateLimitInfo | null {
  const result = parseGitHubHeaders(headers);
  if (result === null) return null;
  return { ...result, backend: 'github_search' };
}

function parseRedditHeaders(headers: Headers): RateLimitInfo | null {
  const remaining = headers.get('x-ratelimit-remaining');
  if (remaining === null) return null;

  // Reddit sends remaining as a float (e.g. "98.0")
  const remainingNum = Math.floor(parseFloat(remaining));
  if (isNaN(remainingNum)) return null;

  const usedStr = headers.get('x-ratelimit-used');
  const usedNum = usedStr !== null ? parseInt(usedStr, 10) : 0;
  const limitNum = isNaN(usedNum) ? 100 : remainingNum + usedNum;

  // Reddit reset is seconds-from-now (relative)
  const resetStr = headers.get('x-ratelimit-reset');
  const resetSeconds = resetStr !== null ? parseInt(resetStr, 10) : 600;
  const resetAt = Date.now() + (isNaN(resetSeconds) ? 600_000 : resetSeconds * 1000);

  return {
    remaining: remainingNum,
    limit: limitNum,
    resetAt,
    backend: 'reddit',
  };
}

function parseSemanticScholarHeaders(headers: Headers): RateLimitInfo | null {
  // Semantic Scholar uses the same format as GitHub: x-ratelimit-* with absolute Unix epoch reset
  const remaining = headers.get('x-ratelimit-remaining');
  if (remaining === null) return null;

  const remainingNum = parseInt(remaining, 10);
  if (isNaN(remainingNum)) return null;

  const limitStr = headers.get('x-ratelimit-limit');
  const limitNum = limitStr !== null ? parseInt(limitStr, 10) : 100;

  const resetStr = headers.get('x-ratelimit-reset');
  const resetEpochSec = resetStr !== null ? parseInt(resetStr, 10) : 0;
  const resetAt =
    isNaN(resetEpochSec) || resetEpochSec === 0
      ? Date.now() + 300_000 // default 5-minute window
      : resetEpochSec * 1000;

  return {
    remaining: remainingNum,
    limit: isNaN(limitNum) ? 100 : limitNum,
    resetAt,
    backend: 'semantic_scholar',
  };
}

function parseRateLimitHeaders(
  backend: RateLimitedBackend,
  headers: Headers,
): RateLimitInfo | null {
  switch (backend) {
    case 'brave':
      return parseBraveHeaders(headers);
    case 'github':
      return parseGitHubHeaders(headers);
    case 'github_search':
      return parseGitHubSearchHeaders(headers);
    case 'reddit':
      return parseRedditHeaders(headers);
    case 'semantic_scholar':
      return parseSemanticScholarHeaders(headers);
    case 'arxiv':
      // ArXiv doesn't send rate-limit headers; throttling is time-based (see academicSearch)
      return null;
  }
}

// ── Tracker ─────────────────────────────────────────────────────────────────

export class RateLimitTracker {
  private info: RateLimitInfo | null = null;

  constructor(private readonly backend: RateLimitedBackend) {}

  /** Parse rate limit headers from a response and update internal state. */
  update(headers: Headers): void {
    const parsed = parseRateLimitHeaders(this.backend, headers);
    if (parsed !== null) {
      this.info = parsed;

      if (parsed.remaining <= LOW_REMAINING_THRESHOLD) {
        logger.warn(
          {
            backend: this.backend,
            remaining: parsed.remaining,
            limit: parsed.limit,
            resetAt: new Date(parsed.resetAt).toISOString(),
          },
          'Rate limit running low',
        );
      }
    }
  }

  /** Returns true if a request can proceed without hitting the limit. */
  canProceed(): boolean {
    if (this.info === null) return true;
    if (this.info.remaining > 0) return true;
    return Date.now() >= this.info.resetAt;
  }

  /** Milliseconds until the rate limit resets. 0 if canProceed() is true. */
  waitTime(): number {
    if (this.canProceed()) return 0;
    return Math.max(0, (this.info?.resetAt ?? 0) - Date.now());
  }

  /** Current rate limit snapshot, or null if no headers seen yet. */
  getInfo(): RateLimitInfo | null {
    return this.info ? { ...this.info } : null;
  }

  /** Force-set state when a 429 is received but headers are missing. */
  recordLimitHit(defaultCooldownMs = 60_000): void {
    const now = Date.now();
    const existingResetAt = this.info?.resetAt;
    const resetAt =
      existingResetAt !== undefined && existingResetAt > now
        ? existingResetAt
        : now + defaultCooldownMs;
    this.info = {
      remaining: 0,
      limit: this.info?.limit ?? 0,
      resetAt,
      backend: this.backend,
    };
  }
}

// ── Singleton registry ──────────────────────────────────────────────────────

const trackers = new Map<RateLimitedBackend, RateLimitTracker>();

export function getTracker(backend: RateLimitedBackend): RateLimitTracker {
  let tracker = trackers.get(backend);
  if (!tracker) {
    tracker = new RateLimitTracker(backend);
    trackers.set(backend, tracker);
  }
  return tracker;
}

/** Reset all trackers (for testing). */
export function resetTrackers(): void {
  trackers.clear();
}

// ── Pre-request gate ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Check rate limit state before making an API call.
 *
 * - If canProceed() is true, returns immediately.
 * - If waitTime <= 5s, sleeps and then returns.
 * - If waitTime > 5s, throws a ToolError with code RATE_LIMIT.
 */
export async function assertRateLimitOk(backend: RateLimitedBackend): Promise<void> {
  const tracker = getTracker(backend);

  if (tracker.canProceed()) return;

  const wait = tracker.waitTime();

  if (wait <= MAX_SHORT_BACKOFF_MS) {
    logger.info({ backend, waitMs: wait }, 'Rate limit active — short backoff before request');
    await sleep(wait);
    return;
  }

  const info = tracker.getInfo();
  const resetDate = info ? new Date(info.resetAt).toISOString() : 'unknown';
  const waitSeconds = Math.ceil(wait / 1000);
  throw rateLimitError(
    `${backend} API rate limit exhausted. Resets at ${resetDate} (${String(waitSeconds)}s). Retry after that time.`,
    { backend },
  );
}
