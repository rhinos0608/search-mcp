/**
 * Tavily search provider.
 *
 * API: POST https://api.tavily.com/search
 * Auth: Bearer token via Authorization header (tvly-... prefix)
 * Credits: basic/fast/ultra-fast = 1 credit, advanced = 2 credits
 *
 * See: https://docs.tavily.com/documentation/api-reference/endpoint/search
 */

import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { ToolError, unavailableError } from '../errors.js';
import type { SearchResult } from '../types.js';

const TAVILY_API_URL = 'https://api.tavily.com/search';

const cache = new ToolCache<SearchResult[]>({ maxSize: 200, ttlMs: 60 * 60 * 1000 });

interface TavilyResult {
  title?: string | null;
  url?: string | null;
  content?: string | null;
  score?: number;
  raw_content?: string | null;
}

interface TavilySearchResponse {
  results?: TavilyResult[];
  query?: string;
  answer?: string;
  response_time?: string;
  usage?: { credits: number };
  request_id?: string;
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export async function tavilySearch(
  query: string,
  apiKey: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
): Promise<SearchResult[]> {
  logger.info({ limit, safeSearch }, 'Running Tavily search');

  const key = cacheKey('tavily', query, String(limit), safeSearch);
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Tavily search cache hit');
    return cached;
  }

  if (apiKey.length === 0) {
    throw unavailableError('Tavily search is not configured. Set TAVILY_API_KEY.', {
      backend: 'tavily',
    });
  }

  assertSafeUrl(TAVILY_API_URL);

  const effectiveTopic = safeSearch === 'strict' ? 'news' : 'general';

  // Tavily's own max is 20; clamp to that
  const clampedLimit = Math.min(limit, 20);

  const body: Record<string, unknown> = {
    query,
    max_results: clampedLimit,
    search_depth: 'basic',
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    topic: effectiveTopic,
  };

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status === 429) {
        throw new ToolError('Tavily Search API rate limit exceeded (429)', {
          code: 'RATE_LIMIT',
          retryable: false,
          statusCode: 429,
          backend: 'tavily',
        });
      }

      if (res.status === 401) {
        throw new ToolError('Tavily Search API authentication failed (401)', {
          code: 'UNAVAILABLE',
          retryable: false,
          statusCode: 401,
          backend: 'tavily',
        });
      }

      if (!res.ok) {
        throw unavailableError(
          `Tavily Search API returned ${String(res.status)}: ${res.statusText}`,
          { statusCode: res.status, backend: 'tavily' },
        );
      }

      return res;
    },
    { label: 'tavily-search', maxAttempts: 3 },
  );

  const data = (await safeResponseJson(response, TAVILY_API_URL)) as TavilySearchResponse;
  const results = data.results ?? [];

  const mapped: SearchResult[] = results.slice(0, limit).map((r, i) => {
    const url = r.url ?? '';
    return {
      title: r.title ?? '',
      url,
      description: r.content ?? '',
      position: i + 1,
      domain: safeDomain(url),
      source: 'tavily' as const,
      age: null,
      extraSnippet: r.score !== undefined ? `relevance: ${String(r.score)}` : null,
      deepLinks: null,
    };
  });

  cache.set(key, mapped);
  logger.debug({ count: mapped.length }, 'Tavily search complete');
  return mapped;
}
