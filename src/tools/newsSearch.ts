import { logger } from '../logger.js';
import { safeResponseJson, assertSafeUrl } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, timeoutError } from '../errors.js';
import type { NewsArticle } from '../types.js';

const GDELT_API_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const USER_AGENT = 'search-mcp/1.0';
const REQUEST_TIMEOUT_MS = 20_000;

const cache = new ToolCache<NewsArticle[]>({ maxSize: 100, ttlMs: 5 * 60 * 1000 });

/**
 * Format a date string (YYYY-MM-DD) into GDELT format (YYYYMMDDHHMMSS).
 */
function toGdeltDate(dateStr: string, endOfDay = false): string {
  const clean = dateStr.replace(/-/g, '');
  return endOfDay ? `${clean}235959` : `${clean}000000`;
}

/**
 * Extract domain from a URL string.
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export async function newsSearch(
  query: string,
  dateFrom: string | null = null,
  dateTo: string | null = null,
  language = 'english',
  limit = 20,
): Promise<NewsArticle[]> {
  const key = cacheKey('news', query, dateFrom ?? '', dateTo ?? '', language, String(limit));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'News search cache hit');
    return cached;
  }

  const params = new URLSearchParams({
    query,
    mode: 'artlist',
    maxrecords: String(Math.min(limit, 250)),
    format: 'json',
    sort: 'datedesc',
  });

  if (language) {
    params.set('sourcelang', language);
  }

  if (dateFrom) {
    params.set('startdatetime', toGdeltDate(dateFrom));
  }

  if (dateTo) {
    params.set('enddatetime', toGdeltDate(dateTo, true));
  }

  const url = `${GDELT_API_URL}?${params.toString()}`;
  assertSafeUrl(url);

  logger.info(
    { tool: 'news_search', dateFrom, dateTo, language, limit },
    'Searching news via GDELT',
  );

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });

        if (!res.ok) {
          throw unavailableError(`GDELT API returned ${String(res.status)}: ${res.statusText}`, {
            statusCode: res.status,
            backend: 'gdelt',
          });
        }

        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError('GDELT API request timed out after 20 seconds', {
            backend: 'gdelt',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'news-search', maxAttempts: 2 },
  );

  const json: unknown = await safeResponseJson(response, url);

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Unexpected GDELT API response shape');
  }

  const body = json as Record<string, unknown>;
  const articles = body.articles;

  if (!Array.isArray(articles)) {
    // GDELT returns empty object when no results found
    logger.debug('GDELT returned no articles array — likely no results');
    cache.set(key, []);
    return [];
  }

  const results: NewsArticle[] = (articles as unknown[])
    .map((article) => {
      if (typeof article !== 'object' || article === null) return null;
      const a = article as Record<string, unknown>;

      const title = typeof a.title === 'string' ? a.title.trim() : '';
      if (!title) return null;

      const articleUrl = typeof a.url === 'string' ? a.url : '';
      if (!articleUrl) return null;

      const source = typeof a.source === 'string' ? a.source : '';
      const domain = typeof a.domain === 'string' ? a.domain : extractDomain(articleUrl);
      const lang = typeof a.language === 'string' ? a.language : null;
      const imageUrl =
        typeof a.socialimage === 'string' && a.socialimage.length > 0 ? a.socialimage : null;

      // GDELT date format: YYYYMMDDTHHMMSSZ → ISO
      let publishedDate: string | null = null;
      if (typeof a.seendate === 'string' && a.seendate.length >= 8) {
        const d = a.seendate;
        publishedDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
        if (d.length >= 15) {
          publishedDate += `T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`;
        }
      }

      return {
        title,
        url: articleUrl,
        source,
        domain,
        publishedDate,
        language: lang,
        imageUrl,
      } satisfies NewsArticle;
    })
    .filter((a): a is NewsArticle => a !== null)
    .slice(0, limit);

  cache.set(key, results);
  logger.debug({ resultCount: results.length }, 'News search complete');

  return results;
}
