import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError } from '../errors.js';
import type { SearchResult } from '../types.js';

const cache = new ToolCache<SearchResult[]>({ maxSize: 200, ttlMs: 60 * 60 * 1000 });

interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string;
  engines?: string[];
  score?: number;
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
  assertSafeUrl(url);

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
    return {
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.content ?? '',
      position: i + 1,
      domain,
      source: 'searxng' as const,
      age: r.publishedDate ?? null,
      extraSnippet: r.engines ? `via ${r.engines.join(', ')}` : null,
      deepLinks: null,
    };
  });

  cache.set(key, mapped);
  logger.debug({ count: mapped.length }, 'SearXNG search complete');
  return mapped;
}
