/**
 * Wikipedia search via REST API v1.
 *
 * Free, no API key required. Two-phase lookup: direct page summary,
 * fallback to search API when exact title doesn't match.
 *
 * Modeled on LDR's search_engine_wikipedia.py.
 */

import { safeResponseJson } from '../httpGuards.js';
import { logger } from '../logger.js';

const REQUEST_TIMEOUT_MS = 10_000;

export interface WikipediaResult {
  title: string;
  link: string;
  snippet: string;
  pageId?: number | undefined;
  language?: string | undefined;
}

/**
 * Search Wikipedia. Tries direct page lookup first, falls back to search API.
 */
export async function searchWikipedia(query: string, language = 'en'): Promise<WikipediaResult[]> {
  // ── Phase 1: Direct page summary lookup ─────────────────────────────
  const summaryUrl = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query.replace(/\s+/g, '_'))}`;

  try {
    const resp = await fetch(summaryUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'search-mcp/5.4.0 (research agent)' },
    });

    if (resp.ok) {
      const json: unknown = await safeResponseJson(resp, summaryUrl);
      const page = json as {
        title?: string;
        extract?: string;
        pageid?: number;
        content_urls?: {
          desktop?: {
            page?: string;
          };
        };
      };
      const title = page.title ?? query;
      const extract = page.extract ?? '';
      const contentUrl =
        page.content_urls?.desktop?.page ??
        `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`;

      return [
        {
          title,
          link: contentUrl,
          snippet: extract.slice(0, 500),
          pageId: typeof page.pageid === 'number' ? page.pageid : undefined,
          language,
        },
      ];
    }

    if (resp.status === 404) {
      // Exact title not found — fall through to search
    } else {
      logger.warn({ status: resp.status, query }, 'Wikipedia summary lookup failed');
    }
  } catch (err) {
    logger.warn({ err, query }, 'Wikipedia direct lookup error');
  }

  // ── Phase 2: Search API fallback ────────────────────────────────────
  return searchWikipediaFallback(query, language);
}

async function searchWikipediaFallback(query: string, language = 'en'): Promise<WikipediaResult[]> {
  const searchUrl = `https://${language}.wikipedia.org/w/api.php?${new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: '5',
    format: 'json',
    origin: '*',
  }).toString()}`;

  try {
    const resp = await fetch(searchUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'search-mcp/5.4.0 (research agent)' },
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, query }, 'Wikipedia search API failed');
      return [];
    }

    const json: unknown = await safeResponseJson(resp, searchUrl);
    const body = json as Record<string, unknown>;
    const queryResult = body.query as Record<string, unknown> | undefined;
    const searchResults = queryResult?.search;

    if (!Array.isArray(searchResults)) return [];

    return (searchResults as Record<string, unknown>[]).slice(0, 5).map((item) => {
      const title = typeof item.title === 'string' ? item.title : 'Untitled';
      return {
        title,
        link: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`,
        snippet: typeof item.snippet === 'string' ? item.snippet.replace(/<[^>]*>/g, '') : '',
        pageId: typeof item.pageid === 'number' ? item.pageid : undefined,
        language,
      };
    });
  } catch (err) {
    logger.warn({ err, query }, 'Wikipedia search fallback error');
    return [];
  }
}
