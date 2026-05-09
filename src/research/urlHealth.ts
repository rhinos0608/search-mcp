/**
 * URL Health Validation — HTTP HEAD + Wayback Machine classifier.
 *
 * Inspired by the urlhealth paper (arXiv 2604.03173v1) which shows 3–13% of
 * deep-research citation URLs are hallucinated. This module reduces non-resolving
 * URLs by 6–79× via live-check + stale-vs-hallucinated classification.
 */

import { logger } from '../logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type UrlHealth = 'LIVE' | 'DEAD' | 'LIKELY_HALLUCINATED' | 'UNKNOWN';

export interface UrlHealthResult {
  url: string;
  status: UrlHealth;
  httpStatus?: number;
  /** URL to the Wayback Machine archived snapshot, if one exists. */
  waybackSnapshot?: string;
  checkedAt: string;
}

export interface CheckUrlOptions {
  timeoutMs?: number;
}

export interface ValidateUrlsOptions {
  concurrency?: number;
  timeoutMs?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 10;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

function isValidUrl(raw: string): boolean {
  try {
    new URL(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrapper around fetch() that enforces a timeout via AbortController.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attempt an HTTP HEAD request; fall back to GET on 405/403/501 or on any
 * network / timeout error from HEAD.
 *
 * Returns the status code and which method produced it.
 */
async function tryHeadWithFallback(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; method: 'HEAD' | 'GET' }> {
  // Try HEAD first
  try {
    const res = await fetchWithTimeout(
      url,
      { method: 'HEAD', headers: { 'User-Agent': BROWSER_UA } },
      timeoutMs,
    );
    // If HEAD succeeded with a usable response code, use it
    if (res.status !== 405 && res.status !== 403 && res.status !== 501) {
      return { status: res.status, method: 'HEAD' };
    }
    // Otherwise fall through to GET
  } catch {
    // HEAD failed (timeout / network error) — fall through to GET
  }

  // Fallback: GET request
  const getRes = await fetchWithTimeout(
    url,
    { method: 'GET', headers: { 'User-Agent': BROWSER_UA } },
    timeoutMs,
  );
  return { status: getRes.status, method: 'GET' };
}

/**
 * Query the Wayback Machine API to see whether an archived snapshot exists.
 *
 * Throws on network errors or non-200 responses so callers can distinguish
 * "no snapshot" (clean result) from "couldn't check" (propagates as error).
 */
async function checkWayback(
  url: string,
  timeoutMs: number,
): Promise<{ archived: boolean; snapshotUrl?: string }> {
  const waybackUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const res = await fetchWithTimeout(
    waybackUrl,
    { headers: { 'User-Agent': BROWSER_UA } },
    timeoutMs,
  );

  if (!res.ok) {
    throw new Error(`Wayback Machine API returned HTTP ${String(res.status)}`);
  }

  const data = (await res.json()) as {
    archived_snapshots?: {
      closest?: {
        available?: boolean;
        url?: string;
        status?: string;
      };
    };
  };

  const closest = data.archived_snapshots?.closest;
  if (closest?.available && closest.url) {
    return { archived: true, snapshotUrl: closest.url };
  }
  return { archived: false };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check the health / liveness of a single URL.
 *
 * Classification:
 * - 2xx/3xx                              → LIVE
 * - 403/429                              → LIVE (likely bot-blocking)
 * - 404 + Wayback snapshot exists        → DEAD (stale — content is gone)
 * - 404 + no Wayback snapshot            → LIKELY_HALLUCINATED
 * - Other 4xx/5xx / network errors       → UNKNOWN
 */
export async function checkUrl(url: string, options?: CheckUrlOptions): Promise<UrlHealthResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checkedAt = nowISO();

  // Malformed URL → UNKNOWN
  if (!isValidUrl(url)) {
    logger.warn({ url }, 'URL health: malformed URL');
    return { url, status: 'UNKNOWN', checkedAt };
  }

  try {
    const { status } = await tryHeadWithFallback(url, timeoutMs);

    // 2xx/3xx — LIVE
    if (status >= 200 && status < 400) {
      return { url, status: 'LIVE', httpStatus: status, checkedAt };
    }

    // 403/429 — likely bot-blocking, treat as LIVE
    if (status === 403 || status === 429) {
      return { url, status: 'LIVE', httpStatus: status, checkedAt };
    }

    // 404 — check Wayback Machine to distinguish stale from hallucinated
    if (status === 404) {
      try {
        const wb = await checkWayback(url, timeoutMs);
        if (wb.archived && wb.snapshotUrl) {
          return {
            url,
            status: 'DEAD',
            httpStatus: status,
            waybackSnapshot: wb.snapshotUrl,
            checkedAt,
          };
        }
        return { url, status: 'LIKELY_HALLUCINATED', httpStatus: status, checkedAt };
      } catch (waybackErr) {
        // Wayback check failed — can't determine, fall through to UNKNOWN
        logger.warn({ err: waybackErr, url }, 'URL health: Wayback check failed');
        return { url, status: 'UNKNOWN', httpStatus: status, checkedAt };
      }
    }

    // Other 4xx/5xx → UNKNOWN
    return { url, status: 'UNKNOWN', httpStatus: status, checkedAt };
  } catch (err) {
    // Connection errors, timeouts → UNKNOWN
    logger.warn({ err, url }, 'URL health: network error');
    return { url, status: 'UNKNOWN', checkedAt };
  }
}

/**
 * Validate multiple URLs with configurable concurrency.
 *
 * Results are returned in the same order as the input array.
 * An empty input array returns an empty array.
 */
export async function validateUrls(
  urls: string[],
  options?: ValidateUrlsOptions,
): Promise<UrlHealthResult[]> {
  if (urls.length === 0) {
    return [];
  }

  const concurrency = Math.min(options?.concurrency ?? DEFAULT_CONCURRENCY, urls.length);
  const timeoutMs = options?.timeoutMs;

  const results = new Array<UrlHealthResult | undefined>(urls.length);
  const indices = Array.from({ length: urls.length }, (_, i) => i);

  async function worker(): Promise<void> {
    while (indices.length > 0) {
      const idx = indices.shift();
      if (idx === undefined) break;
      const url = urls[idx];
      if (url === undefined) continue;

      try {
        results[idx] = await checkUrl(url, opts);
      } catch {
        // checkUrl catches everything, but guard against the unexpected
        results[idx] = {
          url,
          status: 'UNKNOWN',
          checkedAt: nowISO(),
        };
      }
    }
  }

  const opts: CheckUrlOptions = {};
  if (timeoutMs !== undefined) {
    opts.timeoutMs = timeoutMs;
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return results.filter((r): r is UrlHealthResult => r !== undefined);
}

/**
 * Aggregate URL health results into summary counts.
 */
export function summarizeUrlHealth(results: UrlHealthResult[]): {
  live: number;
  dead: number;
  hallucinated: number;
  unknown: number;
  total: number;
} {
  let live = 0;
  let dead = 0;
  let hallucinated = 0;
  let unknown = 0;

  for (const r of results) {
    if (r.status === 'LIVE') live++;
    else if (r.status === 'DEAD') dead++;
    else if (r.status === 'LIKELY_HALLUCINATED') hallucinated++;
    else unknown++;
  }

  return { live, dead, hallucinated, unknown, total: results.length };
}
