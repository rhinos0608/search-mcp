import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { ToolError, unavailableError } from '../errors.js';
import type { SearchResult } from '../types.js';

const EXA_API_URL = 'https://api.exa.ai/search';

const cache = new ToolCache<SearchResult[]>({ maxSize: 200, ttlMs: 60 * 60 * 1000 });

interface ExaResult {
  title?: string | null;
  url?: string | null;
  text?: string | null;
  publishedDate?: string | null;
  author?: string | null;
  score?: number;
}

interface ExaSearchResponse {
  results?: ExaResult[];
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export async function exaSearch(
  query: string,
  apiKey: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
): Promise<SearchResult[]> {
  logger.info({ limit, safeSearch }, 'Running Exa neural search');

  const key = cacheKey('exa', query, String(limit), safeSearch);
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Exa search cache hit');
    return cached;
  }

  if (apiKey.length === 0) {
    throw unavailableError('Exa search is not configured. Set EXA_API_KEY.', { backend: 'exa' });
  }

  assertSafeUrl(EXA_API_URL);

  const body = {
    query,
    numResults: limit,
    type: 'neural',
    useAutoprompt: true,
    contents: {
      text: true,
    },
  };

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(EXA_API_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status === 429) {
        throw new ToolError('Exa Search API rate limit exceeded (429)', {
          code: 'RATE_LIMIT',
          retryable: false,
          statusCode: 429,
          backend: 'exa',
        });
      }

      if (!res.ok) {
        throw unavailableError(`Exa Search API returned ${String(res.status)}: ${res.statusText}`, {
          statusCode: res.status,
          backend: 'exa',
        });
      }

      return res;
    },
    { label: 'exa-search', maxAttempts: 3 },
  );

  const data = (await safeResponseJson(response, EXA_API_URL)) as ExaSearchResponse;
  const mapped = (data.results ?? []).slice(0, limit).map((result, index): SearchResult => {
    const url = result.url ?? '';
    return {
      title: result.title ?? '',
      url,
      description: result.text ?? '',
      position: index + 1,
      domain: safeDomain(url),
      source: 'exa',
      age: result.publishedDate ?? null,
      extraSnippet: result.author ?? null,
      deepLinks: null,
    };
  });

  cache.set(key, mapped);
  logger.debug({ count: mapped.length }, 'Exa search complete');
  return mapped;
}
