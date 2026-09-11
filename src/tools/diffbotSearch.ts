/**
 * Diffbot Web Search provider.
 *
 * API: GET https://llm.diffbot.com/api/v1/web_search?text=<encoded query>&size=<n>
 * Auth: Bearer token via Authorization header ONLY (never in the query string —
 * URLs get logged, and Diffbot's Extract API query-param token pattern is the
 * known leak vector this adapter deliberately avoids).
 *
 * `content` per result is a spliced chunk highlight from the original page
 * contents, not an AI summary (Diffbot docs: "Not an AI summary"). It is mapped
 * as a bounded excerpt snippet, never as a generated summary.
 *
 * See: https://www.diffbot.com/docs/web-search/get
 */

import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { ToolError, timeoutError, unavailableError } from '../errors.js';
import type { SearchResult } from '../types.js';
import { strField, strOrNull, safeDomain } from './providerFields.js';

const DIFFBOT_API_URL = 'https://llm.diffbot.com/api/v1/web_search';
const DIFFBOT_TIMEOUT_MS = 20_000;

/** Shared excerpt cap (matches the Exa highlights maxCharacters budget). */
const SNIPPET_MAX_CHARS = 2560;

/** Bound a highlight chunk to the shared excerpt cap, marking truncation. */
function boundSnippet(content: string): string {
  if (content.length <= SNIPPET_MAX_CHARS) return content;
  return `${content.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
}

export async function diffbotSearch(
  query: string,
  apiKey: string,
  limit = 10,
): Promise<SearchResult[]> {
  logger.info({ limit }, 'Running Diffbot web search');

  if (apiKey.length === 0) {
    throw unavailableError('Diffbot web search is not configured. Set DIFFBOT_API_KEY.', {
      backend: 'diffbot',
    });
  }

  assertSafeUrl(DIFFBOT_API_URL);

  const url = `${DIFFBOT_API_URL}?text=${encodeURIComponent(query)}&size=${encodeURIComponent(String(Math.max(1, limit)))}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(DIFFBOT_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError-named DOMException;
    // surface it as the standard TIMEOUT error instead of a raw throw (same
    // classification contract as the Jina/Firecrawl adapters).
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw timeoutError(
        `Diffbot web search request timed out after ${String(DIFFBOT_TIMEOUT_MS)}ms`,
        { backend: 'diffbot', cause: err },
      );
    }
    throw err;
  }

  if (response.status === 429) {
    throw new ToolError('Diffbot Web Search API rate limit exceeded (429)', {
      code: 'RATE_LIMIT',
      retryable: false,
      statusCode: 429,
      backend: 'diffbot',
    });
  }

  if (response.status === 401) {
    throw new ToolError('Diffbot Web Search API authentication failed (401)', {
      code: 'UNAVAILABLE',
      retryable: false,
      statusCode: 401,
      backend: 'diffbot',
    });
  }

  if (!response.ok) {
    throw unavailableError(
      `Diffbot Web Search API returned ${String(response.status)}: ${response.statusText}`,
      { statusCode: response.status, backend: 'diffbot' },
    );
  }

  const data = await safeResponseJson(response, DIFFBOT_API_URL);
  // `search_results` is untrusted: only an array on a plain-object response body
  // is mapped, and only plain-object elements are kept. null, `{}`, scalars, or
  // null entries safely yield `[]` / are skipped — never a throw.
  const mapped: SearchResult[] = [];
  const rawResults: unknown =
    typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>).search_results
      : undefined;
  if (Array.isArray(rawResults)) {
    for (const r of rawResults) {
      if (mapped.length >= limit) break;
      if (typeof r !== 'object' || r === null) continue;
      const record = r as Record<string, unknown>;
      const pageUrl = strField(record.pageUrl).trim();
      // Sibling adapters (jina/firecrawl) skip empty urls — an entry without a
      // usable link would occupy a result slot and collapse onto one dedupe key.
      if (pageUrl.length === 0) continue;
      // Normalize an empty date to null so an empty value yields age: null with
      // ageKind: 'unknown' (matching other providers). RFC 1123 string kept as-is.
      const date = (() => {
        const v = strOrNull(record.date);
        return v !== null && v.length > 0 ? v : null;
      })();
      mapped.push({
        title: strField(record.title),
        url: pageUrl,
        description: boundSnippet(strField(record.content)),
        position: mapped.length + 1,
        domain: safeDomain(pageUrl),
        source: 'diffbot',
        age: date,
        ageKind: date !== null ? ('published' as const) : ('unknown' as const),
        extraSnippet: null,
        deepLinks: null,
        // Highlight splice content is an excerpt, not an AI summary.
        contentKind: 'snippet' as const,
        generatedSummary: null,
      });
    }
  }

  logger.debug({ count: mapped.length }, 'Diffbot web search complete');
  return mapped;
}
