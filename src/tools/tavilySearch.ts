/**
 * Tavily search provider.
 *
 * API: POST https://api.tavily.com/search
 * Auth: Bearer token via Authorization header (tvly-... prefix)
 * Credits: basic/fast/ultra-fast = 1 credit, advanced = 2 credits
 *
 * See: https://docs.tavily.com/documentation/api-reference/endpoint/search
 */

import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { ToolError, unavailableError } from '../errors.js';
import type { SearchResult } from '../types.js';
import type { AiSummaryMode } from './webSearch.js';
import { strField, strOrNull } from './providerFields.js';

const TAVILY_API_URL = 'https://api.tavily.com/search';

const cache = new ToolCache<SearchResult[]>({ maxSize: 200, ttlMs: 60 * 60 * 1000 });

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: number;
  raw_content?: unknown;
}

interface TavilySearchResponse {
  results?: TavilyResult[];
  query?: string;
  answer?: string;
  response_time?: string;
  usage?: { credits: number };
  request_id?: string;
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Normalize Tavily's literal URL-attributed chunk-join delimiter `[...]` to a
 * paragraph boundary. Snippet-mode content joins multiple query-relevant
 * chunks with `[...]`; without normalization it renders as a fake-looking
 * ellipsis. Only applied in snippet mode (default/yes): Tavily's ultra-fast
 * `only` summary is a single NLP summary where `[...]` is not a chunk join.
 *
 * Only the provider chunk-join delimiter is rewritten, and only when the
 * literal `[...]` is surrounded by whitespace on both sides (documented chunks
 * are joined with ` [...] `). Non-whitespace-adjacent literals inside prose,
 * code, or quotes such as `'[...]'`, `` `[...]` ``, `array[...]`, or a
 * standalone `[...]` are preserved unchanged.
 */
function normalizeChunkJoinDelimiter(text: string): string {
  return text.replace(/\s+\[\.\.\.\]\s+/g, '\n\n');
}

export async function tavilySearch(
  query: string,
  apiKey: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
  aiSummary: AiSummaryMode = 'no',
): Promise<SearchResult[]> {
  logger.info({ limit, safeSearch, aiSummary }, 'Running Tavily search');

  const key = cacheKey('tavily', query, String(limit), safeSearch, aiSummary);
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Tavily search cache hit');
    return cached;
  }

  if (apiKey.length === 0) {
    throw unavailableError('Tavily search is not configured. Set TAVILY_API_KEY.', {
      backend: 'tavily',
    });
  }

  assertSafeUrl(TAVILY_API_URL);

  const effectiveTopic = safeSearch === 'strict' ? 'news' : 'general';

  // Tavily's own max is 20; clamp to that
  const clampedLimit = Math.min(limit, 20);

  const body: Record<string, unknown> = {
    query,
    max_results: clampedLimit,
    // `only` uses Tavily's per-result NLP summary mode: content is summary-only.
    search_depth: aiSummary === 'only' ? 'ultra-fast' : 'basic',
    // Excerpt-only by default: `include_raw_content` is left unset (default
    // false) so full page HTML is never requested. For `basic`, request a few
    // query-relevant snippets per source (URL-attributed, joined by Tavily).
    ...(aiSummary === 'only' ? {} : { chunks_per_source: 3 }),
    // Tavily's query-level `answer` has no per-URL grounding, so it is never
    // requested nor mapped.
    include_answer: false,
    include_images: false,
    topic: effectiveTopic,
  };

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status === 429) {
        throw new ToolError('Tavily Search API rate limit exceeded (429)', {
          code: 'RATE_LIMIT',
          retryable: false,
          statusCode: 429,
          backend: 'tavily',
        });
      }

      if (res.status === 401) {
        throw new ToolError('Tavily Search API authentication failed (401)', {
          code: 'UNAVAILABLE',
          retryable: false,
          statusCode: 401,
          backend: 'tavily',
        });
      }

      if (!res.ok) {
        throw unavailableError(
          `Tavily Search API returned ${String(res.status)}: ${res.statusText}`,
          { statusCode: res.status, backend: 'tavily' },
        );
      }

      return res;
    },
    { label: 'tavily-search', maxAttempts: 3 },
  );

  const data = (await safeResponseJson(response, TAVILY_API_URL)) as TavilySearchResponse;
  // `data.results` is untrusted: only an array is mapped, and only plain-object
  // elements are kept. `{}`, null, scalars, or null entries safely yield `[]` /
  // are skipped — never a throw.
  const mapped: SearchResult[] = [];
  const rawResults: unknown = (data as Record<string, unknown>).results;
  if (Array.isArray(rawResults)) {
    for (const r of rawResults) {
      if (mapped.length >= limit) break;
      if (typeof r !== 'object' || r === null) continue;
      const record = r as Record<string, unknown>;
      const url = strField(record.url);
      // Normalize an empty published_date/publishedDate to null so an empty
      // value yields age: null with ageKind: 'unknown' (matching other providers).
      const publishedDate = (() => {
        const v = strOrNull(record.published_date ?? record.publishedDate);
        return v !== null && v.length > 0 ? v : null;
      })();
      const rawContent = strField(record.content);
      // Snippet mode joins URL-attributed chunks with `[...]`; normalize those
      // to paragraph breaks. Ultra-fast `only` summary keeps `[...]` literal.
      const description =
        aiSummary === 'only' ? rawContent : normalizeChunkJoinDelimiter(rawContent);
      mapped.push({
        title: strField(record.title),
        url,
        description,
        position: mapped.length + 1,
        domain: safeDomain(url),
        source: 'tavily' as const,
        age: publishedDate,
        ageKind: publishedDate !== null ? ('published' as const) : ('unknown' as const),
        extraSnippet: null,
        deepLinks: null,
        contentKind: aiSummary === 'only' ? ('summary' as const) : ('snippet' as const),
        generatedSummary: null,
      });
    }
  }

  cache.set(key, mapped);
  logger.debug({ count: mapped.length }, 'Tavily search complete');
  return mapped;
}
