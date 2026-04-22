import { logger } from '../logger.js';
import { safeResponseJson } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { ToolError, unavailableError, timeoutError } from '../errors.js';
import type { RedditPost } from '../types.js';
import {
  createRedditClient,
  mergeRedditClientOptions,
  type RedditClientOptions,
} from './redditClient.js';
import { parseRedditSearchListing } from './redditSearchParser.js';
import { rrfMerge } from '../utils/fusion.js';
import { multiSignalRescore, extractRedditSignals } from '../utils/rescore.js';

const cache = new ToolCache<RedditPost[]>({ maxSize: 100, ttlMs: 10 * 60 * 1000 });

export function resetRedditSearchCache(): void {
  cache.clear();
}

export async function redditSearch(
  query: string,
  subreddit = '',
  sort: 'relevance' | 'hot' | 'top' | 'new' | 'comments' = 'relevance',
  timeframe: 'all' | 'year' | 'month' | 'week' | 'day' | 'hour' = 'year',
  limit = 25,
  clientOptions: RedditClientOptions = {},
): Promise<RedditPost[]> {
  if (subreddit && !/^[A-Za-z0-9_]{1,21}$/.test(subreddit)) {
    throw new Error(
      `Invalid subreddit name: "${subreddit}". Must be 1–21 alphanumeric/underscore characters.`,
    );
  }

  // When searching globally (no subreddit), Reddit's API returns all-time
  // highest-karma posts regardless of query. For any unscoped call with a
  // broad timeframe (year/all), cap to 'week' — this covers sort=top,
  // sort=relevance, etc. which are all equally broken without subreddit scoping.
  const unscoped = !subreddit;
  const broadTimeframe = timeframe === 'all' || timeframe === 'year';
  const effectiveTimeframe = unscoped && broadTimeframe ? 'week' : timeframe;
  const effectiveSort = unscoped && sort === 'relevance' ? 'new' : sort;

  const key = cacheKey(
    'reddit',
    query,
    subreddit,
    effectiveSort,
    effectiveTimeframe,
    String(limit),
  );
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Reddit search cache hit');
    return cached;
  }

  const client = createRedditClient(mergeRedditClientOptions(clientOptions));
  const path = subreddit ? `/r/${encodeURIComponent(subreddit)}/search` : '/search';
  const queryParams = {
    q: query,
    restrict_sr: subreddit ? 1 : undefined,
    sort: effectiveSort,
    t: effectiveTimeframe,
    limit,
    include_over_18: 0,
  };

  logger.info({ tool: 'reddit_search', subreddit, sort, timeframe, limit }, 'Searching Reddit');

  await assertRateLimitOk('reddit');

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 30_000);

      try {
        const { response: res, url } = await client.fetch(path, queryParams, {
          signal: controller.signal,
        });

        getTracker('reddit').update(res.headers);

        if (res.status === 429) {
          getTracker('reddit').recordLimitHit();
          // Non-retryable inside retry loop — do not hammer rate-limited API
          throw new ToolError('Reddit API rate limit hit (100 req/10min). Wait before retrying.', {
            code: 'RATE_LIMIT',
            retryable: false,
            statusCode: 429,
            backend: 'reddit',
          });
        }

        if (res.status === 403) {
          throw new ToolError(
            `Reddit returned 403. The subreddit "${subreddit}" may be private, banned, or quarantined.`,
            { code: 'UNAVAILABLE', retryable: false, statusCode: 403, backend: 'reddit' },
          );
        }

        if (!res.ok) {
          throw unavailableError(`Reddit API error ${String(res.status)}: ${res.statusText}`, {
            statusCode: res.status,
            backend: 'reddit',
          });
        }

        return { response: res, url };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError('Reddit API request timed out after 30 seconds', {
            backend: 'reddit',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'reddit-search', maxAttempts: 2 },
  );

  const json: unknown = await safeResponseJson(response.response, response.url);
  let results = parseRedditSearchListing(json);

  // Single-source RRF + rescoring
  const rescoreSort: 'relevance' | 'date' | 'top' =
    effectiveSort === 'new' ? 'date' :
    effectiveSort === 'hot' || effectiveSort === 'top' ? 'top' :
    'relevance'; // covers 'relevance' and 'comments'

  const merged = rrfMerge([[...results]], { k: 60 });
  const allSignals = extractRedditSignals(results, rescoreSort);
  const signaled = merged.map((m, i) => ({
    item: m.item,
    rrfScore: m.rrfScore,
    signals: allSignals[i] ?? {},
  }));
  const rescoreWeights = {
    rrfAnchor: 0.5,
    recency: 0.1,
    engagement: 0.25,
    commentEngagement: 0.15,
  };
  const rescored = multiSignalRescore(signaled, rescoreWeights, limit);
  results = rescored.map(r => r.item);

  cache.set(key, results);
  logger.debug({ resultCount: results.length }, 'Reddit search complete');

  return results;
}
