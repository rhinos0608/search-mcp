/**
 * ROR (Research Organization Registry) REST API lookup.
 *
 * Free, no API key required. Returns organization metadata including
 * names, locations, types, and establishment dates.
 */

import { safeResponseJson } from '../httpGuards.js';
import { logger } from '../logger.js';

const REQUEST_TIMEOUT_MS = 10_000;

export interface RorResult {
  title: string;
  link: string;
  snippet: string;
  types?: string[] | undefined;
  country?: string | undefined;
  city?: string | undefined;
  established?: number | undefined;
  rorId?: string | undefined;
}

/**
 * Search ROR for organizations matching the query.
 */
export async function searchRor(query: string, limit = 10): Promise<RorResult[]> {
  const url = `https://api.ror.org/v2/organizations?query=${encodeURIComponent(query)}`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'search-mcp/5.4.0 (research agent)' },
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, query }, 'ROR search API failed');
      return [];
    }

    const json: unknown = await safeResponseJson(resp, url);
    const body = json as Record<string, unknown>;
    const items = body.items;

    if (!Array.isArray(items)) return [];

    return (items as Record<string, unknown>[]).slice(0, limit).map((item) => {
      const name = typeof item.name === 'string' ? item.name : 'Unnamed Organization';
      const rorId = typeof item.id === 'string' ? item.id : '';

      // Build link
      const link = rorId || '';

      // Extract types (string array)
      const types = item.types;
      const typeList: string[] | undefined = Array.isArray(types)
        ? (types as string[]).filter((t): t is string => typeof t === 'string')
        : undefined;

      // Extract country
      const countryObj = item.country as Record<string, unknown> | undefined;
      const country =
        typeof countryObj?.country_name === 'string' ? countryObj.country_name : undefined;

      // Extract city from first address
      const addresses = item.addresses;
      let city: string | undefined;
      if (Array.isArray(addresses)) {
        const first = (addresses as Record<string, unknown>[])[0];
        if (first) {
          const geonames = first.geonames_details as Record<string, unknown> | undefined;
          if (geonames && typeof geonames.name === 'string') {
            city = geonames.name;
          } else if (typeof first.city === 'string') {
            city = first.city;
          }
        }
      }

      // Build snippet: types — location
      const snippetParts: string[] = [];
      if (typeList?.length) {
        snippetParts.push(typeList.join(', '));
      }
      if (city || country) {
        snippetParts.push([city, country].filter(Boolean).join(', '));
      }
      const snippet = snippetParts.join(' — ') || name;

      return {
        title: name,
        link,
        snippet,
        types: typeList?.length ? typeList : undefined,
        country,
        city,
        established: typeof item.established === 'number' ? item.established : undefined,
        rorId: rorId || undefined,
      };
    });
  } catch (err) {
    logger.warn({ err, query }, 'ROR search error');
    return [];
  }
}
