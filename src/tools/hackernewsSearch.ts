import { logger } from '../logger.js';
import { safeResponseJson, assertSafeUrl, TRUNCATED_MARKER } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, timeoutError } from '../errors.js';
import type { HackerNewsItem } from '../types.js';
import { rrfMerge } from '../utils/fusion.js';
import { multiSignalRescore, extractHNSignals } from '../utils/rescore.js';
import { loadConfig } from '../config.js';

const HN_ALGOLIA_URL = 'https://hn.algolia.com/api/v1';
const USER_AGENT = 'search-mcp/1.0';
const REQUEST_TIMEOUT_MS = 15_000;
const TEXT_MAX_LENGTH = 2000;

const cache = new ToolCache<HackerNewsItem[]>({ maxSize: 100, ttlMs: 5 * 60 * 1000 });

export async function hackernewsSearch(
  query: string,
  type: 'story' | 'comment' | 'all' = 'story',
  sort: 'relevance' | 'date' = 'relevance',
  dateRange: { from?: string; to?: string } | null = null,
  limit = 20,
): Promise<HackerNewsItem[]> {
  const key = cacheKey(
    'hackernews',
    query,
    type,
    sort,
    dateRange?.from ?? '',
    dateRange?.to ?? '',
    String(limit),
  );
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'HN search cache hit');
    return cached;
  }

  // Use search (relevance) or search_by_date (chronological)
  const endpoint = sort === 'date' ? 'search_by_date' : 'search';

  const params = new URLSearchParams({
    query,
    hitsPerPage: String(Math.min(limit, 50)),
  });

  // Type filter
  if (type !== 'all') {
    params.set('tags', type);
  }

  // Date range via numeric filters (created_at_i is Unix timestamp)
  const numericFilters: string[] = [];
  if (dateRange?.from) {
    const fromTs = Math.floor(new Date(dateRange.from).getTime() / 1000);
    if (!isNaN(fromTs)) {
      numericFilters.push(`created_at_i>${String(fromTs)}`);
    }
  }
  if (dateRange?.to) {
    const toTs = Math.floor(new Date(dateRange.to).getTime() / 1000);
    if (!isNaN(toTs)) {
      numericFilters.push(`created_at_i<${String(toTs)}`);
    }
  }
  if (numericFilters.length > 0) {
    params.set('numericFilters', numericFilters.join(','));
  }

  const url = `${HN_ALGOLIA_URL}/${endpoint}?${params.toString()}`;
  assertSafeUrl(url);

  logger.info({ tool: 'hackernews_search', type, sort, limit }, 'Searching Hacker News');

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });

        if (!res.ok) {
          throw unavailableError(
            `HN Algolia API returned ${String(res.status)}: ${res.statusText}`,
            { statusCode: res.status, backend: 'hackernews' },
          );
        }

        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError('HN Algolia API request timed out after 15 seconds', {
            backend: 'hackernews',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'hackernews-search', maxAttempts: 2 },
  );

  const json: unknown = await safeResponseJson(response, url);

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Unexpected HN Algolia API response shape');
  }

  const body = json as Record<string, unknown>;
  const hits = body.hits;

  if (!Array.isArray(hits)) {
    throw new Error('Unexpected HN Algolia API response: missing hits array');
  }

  let results: HackerNewsItem[] = (hits as unknown[])
    .map((hit) => {
      if (typeof hit !== 'object' || hit === null) return null;
      const h = hit as Record<string, unknown>;

      const rawText = typeof h.story_text === 'string' ? h.story_text.trim() : null;
      const storyText =
        rawText !== null && rawText.length > TEXT_MAX_LENGTH
          ? rawText.slice(0, TEXT_MAX_LENGTH) + TRUNCATED_MARKER
          : rawText;

      return {
        id: typeof h.objectID === 'string' ? parseInt(h.objectID, 10) : 0,
        title:
          typeof h.title === 'string'
            ? h.title
            : typeof h.story_title === 'string'
              ? h.story_title
              : '',
        url: typeof h.url === 'string' && h.url.length > 0 ? h.url : null,
        author: typeof h.author === 'string' ? h.author : '',
        points: typeof h.points === 'number' ? h.points : 0,
        numComments: typeof h.num_comments === 'number' ? h.num_comments : 0,
        createdAt: typeof h.created_at === 'string' ? h.created_at : '',
        storyText,
        type:
          typeof h._tags === 'object' &&
          Array.isArray(h._tags) &&
          (h._tags as unknown[]).includes('comment')
            ? 'comment'
            : 'story',
        objectId: typeof h.objectID === 'string' ? h.objectID : '',
      } satisfies HackerNewsItem;
    })
    .filter(
      (item): item is HackerNewsItem =>
        item !== null && (Boolean(item.title) || Boolean(item.storyText)),
    );

  // Single-source RRF + rescoring
  const merged = rrfMerge([results], { k: 60 });
  const allSignals = extractHNSignals(results, sort);
  const signaled = merged.map((m, i) => ({
    item: m.item,
    rrfScore: m.rrfScore,
    signals: allSignals[i] ?? {},
  }));
  const rescoreWeights = loadConfig().rescoreWeights.hackernewsSearch;
  const rescored = multiSignalRescore(signaled, rescoreWeights, limit);
  results = rescored.map((r) => r.item);

  cache.set(key, results);
  logger.debug({ resultCount: results.length }, 'HN search complete');

  return results;
}
