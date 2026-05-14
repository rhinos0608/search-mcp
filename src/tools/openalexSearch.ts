/**
 * OpenAlex REST API search for scholarly works.
 *
 * Free, no API key required. Returns works with abstract, authorship, citation data.
 * Uses abstract_inverted_index reconstruction for full abstract snippet.
 */

import { safeResponseJson } from '../httpGuards.js';
import { logger } from '../logger.js';

const REQUEST_TIMEOUT_MS = 10_000;

export interface OpenAlexResult {
  title: string;
  link: string;
  snippet: string;
  publishedDate?: string | undefined;
  authors?: string[] | undefined;
  doi?: string | undefined;
  citedByCount?: number | undefined;
  type?: string | undefined;
}

/**
 * Reconstruct an abstract string from OpenAlex's inverted index format.
 * The index is a map of word -> position arrays, e.g. {"Machine": [0], "learning": [1]}.
 */
function reconstructAbstract(index: Record<string, number[]> | undefined): string | null {
  if (!index) return null;

  try {
    const words: { word: string; position: number }[] = [];

    for (const [word, positions] of Object.entries(index)) {
      for (const pos of positions) {
        words.push({ word, position: pos });
      }
    }

    if (words.length === 0) return null;

    words.sort((a, b) => a.position - b.position);
    return words.map((w) => w.word).join(' ');
  } catch {
    return null;
  }
}

/**
 * Search OpenAlex for scholarly works matching the query.
 */
export async function searchOpenAlex(query: string, limit = 10): Promise<OpenAlexResult[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${String(limit)}`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'search-mcp/5.4.0 (research agent)' },
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, query }, 'OpenAlex search API failed');
      return [];
    }

    const json: unknown = await safeResponseJson(resp, url);
    const body = json as Record<string, unknown>;
    const results = body.results;

    if (!Array.isArray(results)) return [];

    return (results as Record<string, unknown>[]).slice(0, limit).map((item) => {
      const title = typeof item.title === 'string' ? item.title : 'Untitled';

      // Build link from the OpenAlex work ID (URL)
      const link =
        typeof item.id === 'string'
          ? item.id
          : `https://openalex.org/W${typeof item.id === 'string' ? item.id : ''}`;

      // Reconstruct abstract from inverted index
      const abstractIndex = item.abstract_inverted_index as Record<string, number[]> | undefined;
      const reconstructedAbstract = reconstructAbstract(abstractIndex);

      // Fallback snippet: reconstructed abstract or topic description
      let snippet = reconstructedAbstract ?? '';
      if (!snippet) {
        const primaryTopic = item.primary_topic as Record<string, unknown> | undefined;
        if (primaryTopic && typeof primaryTopic.description === 'string') {
          snippet = primaryTopic.description;
        }
      }

      // Extract authors
      const authorships = item.authorships;
      let authors: string[] | undefined;
      if (Array.isArray(authorships)) {
        authors = (authorships as Record<string, unknown>[])
          .map((a) => {
            const author = a.author as Record<string, unknown> | undefined;
            return author?.display_name;
          })
          .filter((n): n is string => typeof n === 'string');
      }

      const doi = typeof item.doi === 'string' ? item.doi : undefined;

      return {
        title,
        link,
        snippet: snippet.slice(0, 500),
        publishedDate:
          typeof item.publication_date === 'string' ? item.publication_date : undefined,
        authors: authors?.length ? authors : undefined,
        doi,
        citedByCount: typeof item.cited_by_count === 'number' ? item.cited_by_count : undefined,
        type: typeof item.type === 'string' ? item.type : undefined,
      };
    });
  } catch (err) {
    logger.warn({ err, query }, 'OpenAlex search error');
    return [];
  }
}
