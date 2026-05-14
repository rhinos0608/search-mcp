/**
 * DataCite REST API search for research data DOIs and datasets.
 *
 * Free, no API key required. Uses JSON:API format. Returns DOI metadata
 * including titles, descriptions, publication year, and resource type.
 */

import { safeResponseJson } from '../httpGuards.js';
import { logger } from '../logger.js';

const REQUEST_TIMEOUT_MS = 10_000;

export interface DataCiteResult {
  title: string;
  link: string;
  snippet: string;
  publishedDate?: string | undefined;
  publisher?: string | undefined;
  doi?: string | undefined;
  resourceType?: string | undefined;
}

/**
 * Search DataCite for DOIs matching the query.
 */
export async function searchDataCite(query: string, limit = 10): Promise<DataCiteResult[]> {
  const url = `https://api.datacite.org/dois?query=${encodeURIComponent(query)}&page[size]=${String(limit)}`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'search-mcp/5.4.0 (research agent)' },
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, query }, 'DataCite search API failed');
      return [];
    }

    const json: unknown = await safeResponseJson(resp, url);
    const body = json as Record<string, unknown>;
    const data = body.data;

    if (!Array.isArray(data)) return [];

    return (data as Record<string, unknown>[]).slice(0, limit).map((entry) => {
      const id = typeof entry.id === 'string' ? entry.id : '';
      const attributes = entry.attributes as Record<string, unknown> | undefined;

      // Extract title from titles array: [{ title: '...' }]
      const titles = attributes?.titles;
      let title = 'Untitled';
      if (Array.isArray(titles)) {
        const first = (titles as Record<string, unknown>[])[0];
        if (first && typeof first.title === 'string') {
          title = first.title;
        }
      }

      // Build link from DOI
      const link = id ? `https://doi.org/${id}` : '';

      // Extract snippet from descriptions array: [{ description: '...' }]
      const descriptions = attributes?.descriptions;
      let snippet = '';
      if (Array.isArray(descriptions)) {
        const first = (descriptions as Record<string, unknown>[])[0];
        if (first && typeof first.description === 'string') {
          snippet = first.description;
        }
      }

      // Extract resource type from types object
      const types = attributes?.types as Record<string, unknown> | undefined;
      const resourceType = typeof types?.resourceType === 'string' ? types.resourceType : undefined;

      return {
        title,
        link,
        snippet: snippet.slice(0, 500),
        publishedDate:
          typeof attributes?.publicationYear === 'number'
            ? String(attributes.publicationYear)
            : undefined,
        publisher: typeof attributes?.publisher === 'string' ? attributes.publisher : undefined,
        doi: id || undefined,
        resourceType,
      };
    });
  } catch (err) {
    logger.warn({ err, query }, 'DataCite search error');
    return [];
  }
}
