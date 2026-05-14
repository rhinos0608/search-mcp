/**
 * GDELT 2.0 Doc API news/event search.
 *
 * Free, no API key required. Returns global news coverage.
 * Uses ArtList mode with a 30-day lookback window.
 * See https://blog.gdeltproject.org/gdelt-doc-api-2-0-prototype/
 *
 * Note: GDELT responses can be irregular — missing fields are handled gracefully.
 */

import { safeResponseJson } from '../httpGuards.js';
import { logger } from '../logger.js';

const REQUEST_TIMEOUT_MS = 10_000;

export interface GdeltResult {
  title: string;
  link: string;
  snippet: string;
  publishedDate?: string | undefined;
  sourceCountry?: string | undefined;
  tone?: string | undefined;
  domain?: string | undefined;
}

/**
 * Search GDELT for news articles and events matching the query.
 * Results span the last 30 days by default.
 */
export async function searchGdelt(
  query: string,
  timespan = '30d',
  limit = 10,
): Promise<GdeltResult[]> {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&format=json&maxrecords=${String(limit)}&timespan=${timespan}`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'search-mcp/5.4.0 (research agent)' },
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, query }, 'GDELT search API failed');
      return [];
    }

    const json: unknown = await safeResponseJson(resp, url);
    const body = json as Record<string, unknown>;
    const articles = body.articles;

    if (!Array.isArray(articles)) return [];

    return (articles as Record<string, unknown>[]).slice(0, limit).map((item) => {
      const title = typeof item.title === 'string' ? item.title : 'Untitled';
      const link = typeof item.url === 'string' ? item.url : '';
      const snippet = '';
      const publishedDate = typeof item.seendate === 'string' ? item.seendate : undefined;

      return {
        title,
        link,
        snippet,
        publishedDate,
        sourceCountry: typeof item.sourcecountry === 'string' ? item.sourcecountry : undefined,
        tone: typeof item.tone === 'string' ? item.tone : undefined,
        domain: typeof item.domain === 'string' ? item.domain : undefined,
      };
    });
  } catch (err) {
    logger.warn({ err, query }, 'GDELT search error');
    return [];
  }
}
