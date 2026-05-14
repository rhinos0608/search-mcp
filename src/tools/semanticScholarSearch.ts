/**
 * Semantic Scholar paper search via Graph API v1.
 *
 * Free tier: 100 requests per 5 minutes (unauthenticated).
 * See https://api.semanticscholar.org/api-docs/graph#tag/Paper-Data/operation/get_graph_get_paper_search
 */

import { safeResponseJson } from '../httpGuards.js';
import { logger } from '../logger.js';

const REQUEST_TIMEOUT_MS = 10_000;

export interface SemanticScholarResult {
  title: string;
  link: string;
  snippet: string;
  publishedDate?: string | undefined;
  authors?: string[] | undefined;
  citationCount?: number | undefined;
  doi?: string | undefined;
  paperId?: string | undefined;
}

/**
 * Search Semantic Scholar for papers matching the query.
 * Rate limit: 100 requests per 5 minutes without an API key.
 */
export async function searchSemanticScholar(
  query: string,
  limit = 10,
): Promise<SemanticScholarResult[]> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${String(limit)}&fields=title,year,authors,abstract,url,externalIds,citationCount`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'search-mcp/5.4.0 (research agent)' },
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, query }, 'Semantic Scholar search API failed');
      return [];
    }

    const json: unknown = await safeResponseJson(resp, url);
    const body = json as Record<string, unknown>;
    const data = body.data;

    if (!Array.isArray(data)) return [];

    return (data as Record<string, unknown>[]).slice(0, limit).map((item) => {
      const title = typeof item.title === 'string' ? item.title : 'Untitled';
      const pId = typeof item.paperId === 'string' ? item.paperId : '';
      const link =
        typeof item.url === 'string' ? item.url : `https://www.semanticscholar.org/paper/${pId}`;
      const snippet = typeof item.abstract === 'string' ? item.abstract.slice(0, 500) : '';

      // Extract authors
      const authorsRaw = item.authors;
      let authors: string[] | undefined;
      if (Array.isArray(authorsRaw)) {
        authors = (authorsRaw as Record<string, unknown>[])
          .map((a) => a.name)
          .filter((n): n is string => typeof n === 'string');
      }

      // Extract DOI from externalIds
      const externalIds = item.externalIds as Record<string, unknown> | undefined;
      const doi = typeof externalIds?.DOI === 'string' ? externalIds.DOI : undefined;

      // Build publishedDate from year (approximate)
      const year = typeof item.year === 'number' ? String(item.year) : undefined;

      return {
        title,
        link,
        snippet,
        publishedDate: year,
        authors: authors?.length ? authors : undefined,
        citationCount: typeof item.citationCount === 'number' ? item.citationCount : undefined,
        doi,
        paperId: typeof item.paperId === 'string' ? item.paperId : undefined,
      };
    });
  } catch (err) {
    logger.warn({ err, query }, 'Semantic Scholar search error');
    return [];
  }
}
