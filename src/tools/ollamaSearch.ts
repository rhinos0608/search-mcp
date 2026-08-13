/**
 * Ollama web-search provider.
 *
 * Queries Ollama's experimental web-search API to retrieve search results.
 * Requires explicit configuration (SEARCH_OLLAMA_BASE_URL + optional
 * SEARCH_OLLAMA_API_KEY) and is disabled by default.
 *
 * API contract:
 *   POST {baseUrl}/api/experimental/web_search
 *   Body: { "query": "...", "max_results": N }
 *   Response: { "results": [{ "title": "...", "url": "...", "content": "..." }] }
 *
 * Reference: @ollama/pi-web-search (npm)
 */

import { logger } from '../logger.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, parseError } from '../errors.js';
import type { SearchResult } from '../types.js';

const cache = new ToolCache<SearchResult[]>({ maxSize: 200, ttlMs: 60 * 60 * 1000 });

/** Maximum excerpt length in UTF-8 bytes for an Ollama result. */
const OLLAMA_EXCERPT_MAX_BYTES = 2560;

/** Largest code-point-aligned index whose UTF-8 prefix fits within `maxBytes`. */
function byteSafeCut(content: string, maxBytes: number): number {
  let bytes = 0;
  let i = 0;
  for (const ch of content) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) break;
    bytes += b;
    i += ch.length;
  }
  return i;
}

/**
 * Cap arbitrary provider content to a concise excerpt so full page bodies are
 * never passed downstream labeled as snippets. Prefers a paragraph boundary,
 * then a sentence boundary, then a hard safe cut. Never splits a surrogate
 * pair / code point, and the result is always within the UTF-8 byte budget.
 */
function truncateExcerpt(content: string): string {
  if (Buffer.byteLength(content, 'utf8') <= OLLAMA_EXCERPT_MAX_BYTES) return content;
  const floor = Math.floor(OLLAMA_EXCERPT_MAX_BYTES * 0.5);
  const hardCut = byteSafeCut(content, OLLAMA_EXCERPT_MAX_BYTES);
  const prefix = content.slice(0, hardCut);

  // Prefer a paragraph boundary, then a sentence boundary, whose prefix is at
  // least `floor` bytes in (so we don't cut absurdly early) and within budget.
  const para = prefix.lastIndexOf('\n\n');
  if (para >= 0 && Buffer.byteLength(prefix.slice(0, para), 'utf8') >= floor) {
    return prefix.slice(0, para).trimEnd();
  }
  const best = Math.max(
    prefix.lastIndexOf('. '),
    prefix.lastIndexOf('? '),
    prefix.lastIndexOf('! '),
  );
  if (best >= 0 && Buffer.byteLength(prefix.slice(0, best + 1), 'utf8') >= floor) {
    return prefix.slice(0, best + 1).trimEnd();
  }
  return prefix.trimEnd();
}

interface OllamaSearchConfig {
  baseUrl: string;
  apiKey?: string;
}

interface OllamaSearchResponse {
  results?: OllamaResultItem[];
}

interface OllamaResultItem {
  title?: string;
  url?: string;
  content?: string;
}

export async function ollamaSearch(
  query: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
  config: OllamaSearchConfig,
): Promise<SearchResult[]> {
  logger.info({ baseUrl: config.baseUrl, limit, safeSearch }, 'Running Ollama web search');

  const key = cacheKey('ollama', config.baseUrl, query, String(limit), safeSearch);
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Ollama search cache hit');
    return cached;
  }

  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const searchUrl = `${baseUrl}/api/experimental/web_search`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (config.apiKey?.length) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const body = JSON.stringify({
    query,
    max_results: limit,
  });

  const response = await retryWithBackoff(
    async () => {
      let res: Response;
      try {
        res = await fetch(searchUrl, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        // Network error — host unreachable, DNS failure, etc.
        throw unavailableError(
          `Ollama search host unreachable at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
          { backend: 'ollama-search', retryable: true },
        );
      }

      // Ollama's experimental API returns 401 when not signed in via `ollama signin`
      if (res.status === 401) {
        throw unavailableError(
          `Ollama search returned 401: Unauthorized. Run \`ollama signin\` to authenticate.`,
          { statusCode: 401, backend: 'ollama-search', retryable: false },
        );
      }

      if (!res.ok) {
        const isTransient = res.status >= 500 || res.status === 429;
        throw unavailableError(`Ollama search returned ${String(res.status)}: ${res.statusText}`, {
          statusCode: res.status,
          backend: 'ollama-search',
          ...(isTransient ? { retryable: true } : {}),
        });
      }

      return res;
    },
    { label: 'ollama-search', maxAttempts: 2, initialDelayMs: 2000 },
  );

  let data: OllamaSearchResponse;
  try {
    data = (await response.json()) as OllamaSearchResponse;
  } catch (err) {
    throw parseError(
      `Ollama search returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { backend: 'ollama-search' },
    );
  }

  const results = data.results ?? [];
  if (results.length === 0) {
    // Metadata only — never the raw query (which is user content).
    logger.debug({ backend: 'ollama-search' }, 'Ollama search returned no results');
  }

  const mapped: SearchResult[] = results
    .filter((r) => {
      if (!r.url) return false;
      try {
        new URL(r.url);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, limit)
    .map((r, i) => {
      let domain = '';
      try {
        domain = r.url ? new URL(r.url).hostname : '';
      } catch {
        /* should not happen due to filter */
      }

      return {
        title: r.title ?? '',
        url: r.url ?? '',
        description: truncateExcerpt(r.content ?? ''),
        position: i + 1,
        domain,
        source: 'ollama-search' as const,
        age: null,
        ageKind: 'unknown' as const,
        extraSnippet: null,
        deepLinks: null,
        contentKind: 'snippet' as const,
      };
    });

  cache.set(key, mapped);
  logger.info({ count: mapped.length, backend: 'ollama-search' }, 'Ollama search complete');
  return mapped;
}
