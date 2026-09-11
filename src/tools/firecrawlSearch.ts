/**
 * Firecrawl v2 search client (snippet-only).
 *
 * POST https://api.firecrawl.dev/v2/search
 * Auth: Bearer token. Web source only — never scrapeOptions or full page content.
 */

import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { ToolError, timeoutError, unavailableError } from '../errors.js';
import { logger } from '../logger.js';
import type { SearchResult } from '../types.js';
import { strField, safeDomain } from './providerFields.js';

const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search';
const SEARCH_TIMEOUT_MS = 20_000;
const SEARCH_MAX_BYTES = 1_000_000;
const SEARCH_LIMIT_CAP = 10;

export type FirecrawlSearchResult = Omit<SearchResult, 'source'> & {
  source: 'firecrawl';
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export async function firecrawlSearch(
  query: string,
  apiKey: string,
  limit = 10,
): Promise<FirecrawlSearchResult[]> {
  if (apiKey.length === 0) {
    throw unavailableError('Firecrawl search is not configured.', { backend: 'firecrawl' });
  }

  assertSafeUrl(FIRECRAWL_SEARCH_URL);

  const clampedLimit = Math.min(Math.max(limit, 1), SEARCH_LIMIT_CAP);
  logger.info({ limit: clampedLimit }, 'Running Firecrawl search');

  let response: Response;
  try {
    response = await fetch(FIRECRAWL_SEARCH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        limit: clampedLimit,
        sources: ['web'],
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError-named DOMException;
    // surface it as the standard TIMEOUT error instead of a raw throw (same
    // classification contract as the Jina adapter).
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw timeoutError(
        `Firecrawl search request timed out after ${String(SEARCH_TIMEOUT_MS)}ms`,
        { backend: 'firecrawl', cause: err },
      );
    }
    throw err;
  }

  if (response.status === 429) {
    throw new ToolError('Firecrawl Search API rate limit exceeded (429)', {
      code: 'RATE_LIMIT',
      retryable: false,
      statusCode: 429,
      backend: 'firecrawl',
    });
  }

  if (response.status === 401) {
    throw new ToolError('Firecrawl Search API authentication failed (401)', {
      code: 'UNAVAILABLE',
      retryable: false,
      statusCode: 401,
      backend: 'firecrawl',
    });
  }

  if (!response.ok) {
    throw unavailableError(`Firecrawl Search API returned ${String(response.status)}`, {
      statusCode: response.status,
      backend: 'firecrawl',
      retryable: false,
    });
  }

  const payload = await safeResponseJson(response, FIRECRAWL_SEARCH_URL, SEARCH_MAX_BYTES);
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const rawWeb: unknown = data?.web;
  const mapped: FirecrawlSearchResult[] = [];
  if (Array.isArray(rawWeb)) {
    for (const item of rawWeb) {
      if (mapped.length >= clampedLimit) break;
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const url = strField(record.url);
      if (url.length === 0) continue;
      mapped.push({
        title: strField(record.title),
        url,
        description: strField(record.description),
        position: mapped.length + 1,
        domain: safeDomain(url),
        source: 'firecrawl',
        age: null,
        ageKind: 'unknown',
        extraSnippet: null,
        deepLinks: null,
        contentKind: 'snippet',
        generatedSummary: null,
      });
    }
  }

  logger.debug({ count: mapped.length }, 'Firecrawl search complete');
  return mapped;
}
