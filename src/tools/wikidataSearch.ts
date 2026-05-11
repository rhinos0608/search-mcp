/**
 * Wikidata entity search via the wbsearchentities API.
 *
 * Free, no API key required. Returns Q-number entities with
 * label, description, and aliases.
 * See https://www.wikidata.org/w/api.php?action=help&modules=wbsearchentities
 */

import { safeResponseJson } from '../httpGuards.js';
import { logger } from '../logger.js';

const REQUEST_TIMEOUT_MS = 10_000;

export interface WikidataResult {
  title: string;
  link: string;
  snippet: string;
  qid?: string | undefined;
  aliases?: string[] | undefined;
}

/**
 * Search Wikidata for entities matching the query.
 */
export async function searchWikidata(query: string, language = 'en', limit = 10): Promise<WikidataResult[]> {
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=${language}&limit=${String(limit)}&format=json&origin=*`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'search-mcp/5.4.0 (research agent)' },
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, query }, 'Wikidata search API failed');
      return [];
    }

    const json: unknown = await safeResponseJson(resp, url);
    const body = json as Record<string, unknown>;
    const search = body.search;

    if (!Array.isArray(search)) return [];

    return (search as Record<string, unknown>[]).slice(0, limit).map((item) => {
      const title = typeof item.label === 'string' ? item.label : 'Untitled';
      const id = typeof item.id === 'string' ? item.id : '';
      const link = `https://www.wikidata.org/wiki/${id}`;
      const snippet = typeof item.description === 'string' ? item.description : '';
      const aliasesRaw = item.aliases;
      let aliases: string[] | undefined;
      if (Array.isArray(aliasesRaw)) {
        aliases = (aliasesRaw as string[]).filter((a): a is string => typeof a === 'string');
      }

      return {
        title,
        link,
        snippet,
        qid: id || undefined,
        aliases: aliases?.length ? aliases : undefined,
      };
    });
  } catch (err) {
    logger.warn({ err, query }, 'Wikidata search error');
    return [];
  }
}
