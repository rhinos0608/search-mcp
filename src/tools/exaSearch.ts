import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { ToolError, unavailableError } from '../errors.js';
import type { SearchResult } from '../types.js';
import type { AiSummaryMode } from './webSearch.js';
import { strArray, strField, strOrNull } from './providerFields.js';

const EXA_API_URL = 'https://api.exa.ai/search';

// Concise bounded highlight budget per URL (provider character units, within
// Exa's documented "rich" range). Excerpt-only: requests query-relevant
// highlights, never full page text/raw content.
const EXA_HIGHLIGHTS_MAX_CHARACTERS = 2560;

const cache = new ToolCache<SearchResult[]>({ maxSize: 200, ttlMs: 60 * 60 * 1000 });

interface ExaResult {
  title?: unknown;
  url?: unknown;
  text?: unknown;
  publishedDate?: unknown;
  author?: unknown;
  score?: number;
  highlights?: unknown;
  highlightScores?: number[];
  summary?: unknown;
  image?: unknown;
  favicon?: unknown;
}

interface ExaSearchResponse {
  results?: ExaResult[];
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  // Reserve space for the ellipsis before slicing so the returned string
  // (including the ellipsis) never exceeds max.
  const budget = max - 1;
  let head = text.slice(0, budget);
  const space = head.lastIndexOf(' ');
  if (space > 0) head = head.slice(0, space);
  return `${head}…`;
}

export async function exaSearch(
  query: string,
  apiKey: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
  aiSummary: AiSummaryMode = 'no',
): Promise<SearchResult[]> {
  logger.info({ limit, safeSearch, aiSummary }, 'Running Exa search');

  const key = cacheKey('exa', query, String(limit), safeSearch, aiSummary);
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Exa search cache hit');
    return cached;
  }

  if (apiKey.length === 0) {
    throw unavailableError('Exa search is not configured. Set EXA_API_KEY.', { backend: 'exa' });
  }

  assertSafeUrl(EXA_API_URL);

  // `no` (default): highlights only (excerpt), no generated summary.
  // `yes`: highlights + generated summary (still no full `text`).
  // `only`: generated summary only — never request text/highlights.
  // strict maps to Exa's documented `moderation` filter (blocks NSFW results);
  // moderate/off send no moderation parameter (existing request behavior).
  const body = {
    query,
    numResults: limit,
    type: 'auto',
    ...(safeSearch === 'strict' ? { moderation: true } : {}),
    contents:
      aiSummary === 'only'
        ? { summary: true }
        : {
            // Excerpt-only: request bounded query-relevant highlights and a
            // bounded slice of the full page text (both capped via maxCharacters),
            // never unbounded raw content. `yes` additionally requests the
            // URL-attributable generated summary.
            highlights: { maxCharacters: EXA_HIGHLIGHTS_MAX_CHARACTERS },
            text: { maxCharacters: EXA_HIGHLIGHTS_MAX_CHARACTERS },
            ...(aiSummary === 'yes' ? { summary: true } : {}),
          },
  };

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(EXA_API_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status === 429) {
        throw new ToolError('Exa Search API rate limit exceeded (429)', {
          code: 'RATE_LIMIT',
          retryable: false,
          statusCode: 429,
          backend: 'exa',
        });
      }

      if (!res.ok) {
        throw unavailableError(`Exa Search API returned ${String(res.status)}: ${res.statusText}`, {
          statusCode: res.status,
          backend: 'exa',
        });
      }

      return res;
    },
    { label: 'exa-search', maxAttempts: 3 },
  );

  const data = (await safeResponseJson(response, EXA_API_URL)) as ExaSearchResponse;
  // `data.results` is untrusted: only an array is mapped, and only plain-object
  // elements are kept. `{}`, null, scalars, or null entries safely yield `[]` /
  // are skipped — never a throw.
  const mapped: SearchResult[] = [];
  const rawResults: unknown = (data as Record<string, unknown>).results;
  if (Array.isArray(rawResults)) {
    for (const result of rawResults) {
      if (mapped.length >= limit) break;
      if (typeof result !== 'object' || result === null) continue;
      const record = result as Record<string, unknown>;
      const url = strField(record.url);
      // Excerpt-only: the body is the query-relevant highlights (snippet), never
      // the full page text. `only` mode contains only the per-URL generated
      // summary: no Author/highlights extras are surfaced into the body.
      const highlights = aiSummary === 'only' ? [] : strArray(record.highlights);
      // Excerpt-only: prefer query-relevant highlights; when a newly published
      // page has none yet, fall back to a bounded slice of the full page text
      // (never more than the highlights cap) so the body is not empty.
      const text = aiSummary === 'only' ? '' : strField(record.text);
      const body =
        aiSummary === 'only'
          ? strField(record.summary)
          : highlights.length > 0
            ? highlights.join('\n\n')
            : truncateText(text, EXA_HIGHLIGHTS_MAX_CHARACTERS);
      const author = aiSummary === 'only' ? '' : strField(record.author);
      const extraSnippet = author ? `Author: ${author}` : null;
      const publishedDate = (() => {
        // Normalize an empty publishedDate to null (empty strings are not valid
        // ages). Computed once for reuse in both `age` and `ageKind`.
        const v = strOrNull(record.publishedDate);
        return v !== null && v.length > 0 ? v : null;
      })();
      mapped.push({
        title: strField(record.title),
        url,
        description: body,
        position: mapped.length + 1,
        domain: safeDomain(url),
        source: 'exa',
        age: publishedDate,
        ageKind: publishedDate !== null ? ('published' as const) : ('unknown' as const),
        extraSnippet,
        deepLinks: null,
        contentKind: aiSummary === 'only' ? ('summary' as const) : ('snippet' as const),
        generatedSummary: aiSummary === 'yes' ? strOrNull(record.summary) : null,
        generatedSummaryProvider: aiSummary === 'yes' ? 'exa' : undefined,
      });
    }
  }

  cache.set(key, mapped);
  logger.debug({ count: mapped.length }, 'Exa search complete');
  return mapped;
}
