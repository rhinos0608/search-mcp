import { logger } from '../logger.js';
import { safeResponseJson } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError } from '../errors.js';
import type { SearchResult } from '../types.js';
import { strOrNull } from './providerFields.js';

const cache = new ToolCache<SearchResult[]>({ maxSize: 200, ttlMs: 60 * 60 * 1000 });

interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string;
  /** Unknown external value: may be an array of strings, contain null/number/
   * non-string members, or not be an array at all. Validated at runtime. */
  engines?: unknown;
  score?: number;
}

/**
 * Safely extract SearXNG upstream engine names from an untrusted value.
 * Accepts only trimmed nonempty strings from an array; dedupes and sorts
 * deterministically. Any malformed shape (non-array, null/number members)
 * yields `undefined` rather than throwing.
 */
function sanitizeUpstreamEngines(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = new Set<string>();
  for (const e of value) {
    if (typeof e === 'string') {
      const trimmed = e.trim();
      if (trimmed.length > 0) out.add(trimmed);
    }
  }
  return out.size > 0 ? [...out].sort() : undefined;
}

interface SearxResponse {
  results?: SearxResult[];
}

export async function searxngSearch(
  query: string,
  baseUrl: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
): Promise<SearchResult[]> {
  logger.info({ baseUrl, limit, safeSearch }, 'Running SearXNG search');

  const key = cacheKey('searxng', query, String(limit), safeSearch);
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'SearXNG search cache hit');
    return cached;
  }

  const safeness = safeSearch === 'strict' ? '2' : safeSearch === 'off' ? '0' : '1';

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    safesearch: safeness,
  });

  const url = `${baseUrl.replace(/\/+$/, '')}/search?${params.toString()}`;
  // SearXNG base URLs are operator-configured and intentionally bypass the
  // SSRF guard used for arbitrary user-supplied URLs.

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        throw unavailableError(`SearXNG returned ${String(res.status)}: ${res.statusText}`, {
          statusCode: res.status,
          backend: 'searxng',
        });
      }

      return res;
    },
    { label: 'searxng-search', maxAttempts: 2 },
  );

  const body = (await safeResponseJson(response, url)) as SearxResponse;
  const results = body.results ?? [];

  const mapped: SearchResult[] = results.slice(0, limit).map((r, i) => {
    let domain = '';
    try {
      domain = new URL(r.url ?? '').hostname;
    } catch {
      /* invalid URL — leave domain empty */
    }
    // Untrusted provider date: only a validated non-empty string is accepted.
    // Numeric/malformed publishedDate coerces to null/unknown so it never
    // reaches SearchResult.age (where the formatter's `.trim()` would crash).
    const publishedDate = (() => {
      const v = strOrNull(r.publishedDate);
      return v !== null && v.length > 0 ? v : null;
    })();
    return {
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.content ?? '',
      position: i + 1,
      domain,
      source: 'searxng' as const,
      age: publishedDate,
      ageKind: publishedDate !== null ? ('published' as const) : ('unknown' as const),
      // SearXNG upstream engines (Google/Bing/etc.) are structured metadata, never
      // body prose — rendered as bracketed labels after `SearXNG`, not cited text.
      extraSnippet: null,
      upstreamEngines: sanitizeUpstreamEngines(r.engines),
      deepLinks: null,
      contentKind: 'snippet' as const,
    };
  });

  cache.set(key, mapped);
  logger.debug({ count: mapped.length }, 'SearXNG search complete');
  return mapped;
}
