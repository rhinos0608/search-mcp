/**
 * Jina Search provider.
 *
 * API: POST https://s.jina.ai/
 * Auth: Bearer token via Authorization header
 * Body: { q, num } JSON; Accept: application/json; X-Respond-With: no-content
 * (no-content keeps the response to search snippets — full page content is
 * never requested and never mapped).
 *
 * Response: JSON object with a `data` result array (a bare top-level array is
 * also accepted defensively). Each result's `title`, `description`, and `url`
 * are validated and mapped to a bounded snippet SearchResult; the `content`
 * field is ignored.
 *
 * Vendor cache note: Jina retains queries/results in its own server-side cache.
 * The documented `X-No-Cache: true` opt-out is deliberately not sent — the
 * local ToolCache below already dedupes repeat queries, and forcing fresh
 * vendor fetches would raise billable volume. Reviewed trade-off; add the
 * header if operator policy requires vendor-side cache bypass.
 */

import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { ToolError, isToolError, parseError, timeoutError, unavailableError } from '../errors.js';
import type { SearchResult } from '../types.js';
import { strField, safeDomain } from './providerFields.js';

const JINA_API_URL = 'https://s.jina.ai/';
const TIMEOUT_MS = 20_000;
/** Jina caps `num` at 20 results. */
const MAX_RESULTS = 20;

const cache = new ToolCache<SearchResult[]>({ maxSize: 200, ttlMs: 60 * 60 * 1000 });

interface JinaSearchResponse {
  data?: unknown;
}

function mapResults(raw: unknown, limit: number): SearchResult[] {
  // Untrusted payload: only an array is mapped, only plain-object elements with
  // a usable url are kept. Non-objects, nulls, and empty/missing urls are
  // skipped — never a throw. Positions stay contiguous over survivors.
  const results: SearchResult[] = [];
  if (!Array.isArray(raw)) return results;
  for (const item of raw) {
    if (results.length >= limit) break;
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const url = strField(record.url).trim();
    if (url.length === 0) continue;
    results.push({
      title: strField(record.title),
      url,
      description: strField(record.description),
      position: results.length + 1,
      domain: safeDomain(url),
      source: 'jina',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet' as const,
      generatedSummary: null,
    });
  }
  return results;
}

export async function jinaSearch(
  query: string,
  apiKey: string,
  limit = 10,
): Promise<SearchResult[]> {
  logger.info({ limit }, 'Running Jina search');

  // Fail closed on a missing key BEFORE any cache read: an empty key must
  // always surface the actionable unavailable error, never a cached result path.
  if (apiKey.length === 0) {
    throw unavailableError('Jina search is not configured. Set JINA_API_KEY.', {
      backend: 'jina',
    });
  }

  const key = cacheKey('jina', query, String(limit));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Jina search cache hit');
    return cached;
  }

  assertSafeUrl(JINA_API_URL);

  const num = Math.min(Math.max(limit, 1), MAX_RESULTS);
  const body = { q: query, num };

  const response = await retryWithBackoff(
    async () => {
      let res: Response;
      try {
        res = await fetch(JINA_API_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'X-Respond-With': 'no-content',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        // AbortSignal.timeout rejects with a TimeoutError-named DOMException;
        // surface it as the standard TIMEOUT error instead of a raw throw.
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          throw timeoutError(`Jina search request timed out after ${String(TIMEOUT_MS)}ms`, {
            backend: 'jina',
            cause: err,
          });
        }
        throw err;
      }

      if (res.status === 429) {
        throw new ToolError('Jina Search API rate limit exceeded (429)', {
          code: 'RATE_LIMIT',
          retryable: true,
          statusCode: 429,
          backend: 'jina',
        });
      }

      if (res.status === 401 || res.status === 403) {
        throw unavailableError(`Jina Search API authentication failed (${String(res.status)})`, {
          retryable: false,
          statusCode: res.status,
          backend: 'jina',
        });
      }

      if (!res.ok) {
        throw unavailableError(
          `Jina Search API returned ${String(res.status)}: ${res.statusText}`,
          {
            statusCode: res.status,
            backend: 'jina',
          },
        );
      }

      return res;
    },
    { label: 'jina-search', maxAttempts: 3 },
  );

  let data: unknown;
  try {
    data = await safeResponseJson(response, JINA_API_URL);
  } catch (err) {
    if (isToolError(err)) throw err;
    throw parseError('Jina Search returned invalid JSON', { backend: 'jina', cause: err });
  }

  // Accept either the documented `{ data: [...] }` wrapper or a bare top-level
  // array; anything else yields no results.
  const rawResults: unknown = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null
      ? (data as JinaSearchResponse).data
      : undefined;

  const mapped = mapResults(rawResults, num);
  cache.set(key, mapped);
  logger.debug({ count: mapped.length }, 'Jina search complete');
  return mapped;
}
