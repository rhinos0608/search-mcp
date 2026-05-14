/**
 * Crossref REST API search for scholarly works, DOIs, and metadata.
 *
 * Free, no API key required (rate-limited to ~50/s). Returns citation metadata
 * including authors, DOI, publisher, and publication date.
 */

import { safeResponseJson } from '../httpGuards.js';
import { logger } from '../logger.js';

const REQUEST_TIMEOUT_MS = 10_000;

export interface CrossrefResult {
  title: string;
  link: string;
  snippet: string;
  publishedDate?: string | undefined;
  authors?: string[] | undefined;
  doi?: string | undefined;
  publisher?: string | undefined;
  type?: string | undefined;
}

/**
 * Search Crossref for works matching the query.
 */
export async function searchCrossref(query: string, limit = 10): Promise<CrossrefResult[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${String(limit)}`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'search-mcp/5.4.0 (research agent)' },
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, query }, 'Crossref search API failed');
      return [];
    }

    const json: unknown = await safeResponseJson(resp, url);
    const body = json as Record<string, unknown>;
    const message = body.message as Record<string, unknown> | undefined;
    const items = message?.items;

    if (!Array.isArray(items)) return [];

    return (items as Record<string, unknown>[]).slice(0, limit).map((item) => {
      const titleArr = item.title;
      const title =
        Array.isArray(titleArr) && typeof titleArr[0] === 'string' ? titleArr[0] : 'Untitled';

      const doi = typeof item.DOI === 'string' ? item.DOI : '';
      const link = doi ? `https://doi.org/${doi}` : '';

      // Build snippet from abstract
      const snippet = typeof item.abstract === 'string' ? item.abstract.slice(0, 500) : '';

      // Extract authors: combine given + family
      const authorEntries = item.author;
      let authors: string[] | undefined;
      if (Array.isArray(authorEntries)) {
        authors = (authorEntries as Record<string, unknown>[])
          .map((a) => {
            const given = typeof a.given === 'string' ? a.given : '';
            const family = typeof a.family === 'string' ? a.family : '';
            return [given, family].filter(Boolean).join(' ');
          })
          .filter(Boolean);
      }

      // Extract date from created, published-print, or issued
      let publishedDate: string | undefined;
      const created = item.created as Record<string, unknown> | undefined;
      const publishedPrint = item['published-print'] as Record<string, unknown> | undefined;
      const issued = item.issued as Record<string, unknown> | undefined;

      if (publishedPrint?.dateParts) {
        const parts = (publishedPrint.dateParts as unknown[])[0] as number[] | undefined;
        if (parts) publishedDate = parts.join('-');
      } else if (created?.dateParts) {
        const parts = (created.dateParts as unknown[])[0] as number[] | undefined;
        if (parts) publishedDate = parts.join('-');
      } else if (issued?.dateParts) {
        const parts = (issued.dateParts as unknown[])[0] as number[] | undefined;
        if (parts) publishedDate = parts.join('-');
      }

      return {
        title,
        link,
        snippet,
        publishedDate,
        authors: authors?.length ? authors : undefined,
        doi: doi || undefined,
        publisher: typeof item.publisher === 'string' ? item.publisher : undefined,
        type: typeof item.type === 'string' ? item.type : undefined,
      };
    });
  } catch (err) {
    logger.warn({ err, query }, 'Crossref search error');
    return [];
  }
}
