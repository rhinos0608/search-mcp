import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { ToolError, unavailableError } from '../errors.js';
import type { SearchResult } from '../types.js';

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

const cache = new ToolCache<SearchResult[]>({ maxSize: 200, ttlMs: 60 * 60 * 1000 });

interface BraveDeepButton {
  title?: string;
  url?: string;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  page_age?: string;
  page_fetched?: string;
  extra_snippets?: string[];
  deep_results?: { buttons?: BraveDeepButton[] };
  meta_url?: { hostname?: string };
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
}

export async function braveSearch(
  query: string,
  apiKey: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
): Promise<SearchResult[]> {
  logger.info({ limit, safeSearch }, 'Running Brave search');

  const key = cacheKey('brave', query, String(limit), safeSearch);
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Brave search cache hit');
    return cached;
  }

  await assertRateLimitOk('brave');

  const safeness = safeSearch === 'strict' ? 'strict' : safeSearch === 'off' ? 'off' : 'moderate';

  const params = new URLSearchParams({
    q: query,
    count: String(limit),
    safesearch: safeness,
    extra_snippets: 'true',
  });

  const url = `${BRAVE_API_URL}?${params.toString()}`;
  assertSafeUrl(url);

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(15_000),
      });

      getTracker('brave').update(res.headers);

      if (res.status === 429) {
        getTracker('brave').recordLimitHit();
        // Non-retryable inside retry loop — do not hammer rate-limited API
        throw new ToolError('Brave Search API rate limit exceeded (429)', {
          code: 'RATE_LIMIT',
          retryable: false,
          statusCode: 429,
          backend: 'brave',
        });
      }

      if (!res.ok) {
        throw unavailableError(
          `Brave Search API returned ${String(res.status)}: ${res.statusText}`,
          { statusCode: res.status, backend: 'brave' },
        );
      }

      return res;
    },
    { label: 'brave-search', maxAttempts: 3 },
  );

  const body = (await safeResponseJson(response, url)) as BraveSearchResponse;
  const webResults = body.web?.results ?? [];

  const mapped: SearchResult[] = webResults.slice(0, limit).map((r, i) => {
    let domain = '';
    try {
      domain = r.meta_url?.hostname ?? new URL(r.url ?? '').hostname;
    } catch {
      /* invalid URL — leave domain empty */
    }
    const buttons = r.deep_results?.buttons;
    const deepLinks =
      buttons && buttons.length > 0
        ? buttons
            .filter(
              (b): b is BraveDeepButton & { title: string; url: string } =>
                typeof b.title === 'string' && typeof b.url === 'string',
            )
            .map((b) => ({ title: b.title, url: b.url }))
        : null;

    return {
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.description ?? '',
      position: i + 1,
      domain,
      source: 'brave' as const,
      age: r.age ?? r.page_age ?? r.page_fetched ?? null,
      extraSnippet: r.extra_snippets?.length ? r.extra_snippets.join('\n\n') : null,
      deepLinks: deepLinks && deepLinks.length > 0 ? deepLinks : null,
    };
  });

  cache.set(key, mapped);
  logger.debug({ count: mapped.length }, 'Brave search complete');
  return mapped;
}
