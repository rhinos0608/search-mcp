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
import { arcticShiftSearch } from './arcticShiftClient.js';
import { parseRedditSearchListing } from './redditSearchParser.js';
import { rrfMerge } from '../utils/fusion.js';
import { multiSignalRescore, extractRedditSignals } from '../utils/rescore.js';
import { loadConfig } from '../config.js';

const cache = new ToolCache<RedditPost[]>({ maxSize: 100, ttlMs: 10 * 60 * 1000 });

export function resetRedditSearchCache(): void {
  cache.clear();
}

export async function redditSearch(
  query: string,
  subreddit: string,
  sort: 'relevance' | 'hot' | 'top' | 'new' | 'comments' = 'relevance',
  timeframe: 'all' | 'year' | 'month' | 'week' | 'day' | 'hour' = 'year',
  limit = 25,
  clientOptions: RedditClientOptions = {},
): Promise<RedditPost[]> {
  if (!/^[A-Za-z0-9_]{1,21}$/.test(subreddit)) {
    throw new Error(
      `Invalid subreddit name: "${subreddit}". Must be 1–21 alphanumeric/underscore characters.`,
    );
  }

  const key = cacheKey(
    'reddit',
    query,
    subreddit,
    sort,
    timeframe,
    String(limit),
  );
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Reddit search cache hit');
    return cached;
  }

  const client = createRedditClient(mergeRedditClientOptions(clientOptions));
  const path = `/r/${encodeURIComponent(subreddit)}/search`;
  const queryParams = {
    q: query,
    restrict_sr: 1,
    sort,
    t: timeframe,
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
          let bodyText = '';
          try {
            bodyText = await res.clone().text();
          } catch { /* body read failure is non-fatal */ }
          const isNetworkBlock = /blocked\s+by\s+network\s+security/i.test(bodyText);
          if (isNetworkBlock) {
            logger.warn(
              { subreddit, query },
              'Reddit public API blocked, falling back to Arctic Shift for search',
            );
            const fallbackJson = await arcticShiftSearch(query, subreddit, sort, limit, timeframe);
            return { __fallback: true as const, json: fallbackJson };
          }
          throw new ToolError(
            `Reddit returned 403. The subreddit "${subreddit}" may be private, banned, or quarantined.`,
            {
              code: 'UNAVAILABLE',
              retryable: false as const,
              statusCode: 403,
              backend: 'reddit',
            },
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

  let json: unknown;
  if ('__fallback' in response) {
    json = (response as { __fallback: true; json: unknown }).json;
  } else {
    const httpResponse = response as { response: Response; url: string };
    json = await safeResponseJson(httpResponse.response, httpResponse.url);
  }
  let results = parseRedditSearchListing(json);

  // Single-source RRF + rescoring
  const rescoreSort: 'relevance' | 'date' | 'top' =
    sort === 'new'
      ? 'date'
      : sort === 'hot' || sort === 'top'
        ? 'top'
        : 'relevance'; // covers 'relevance' and 'comments'

  const merged = rrfMerge([[...results]], { k: 60 });
  const allSignals = extractRedditSignals(results, rescoreSort);
  const signaled = merged.map((m, i) => ({
    item: m.item,
    rrfScore: m.rrfScore,
    signals: allSignals[i] ?? {},
  }));
  const rescoreWeights = loadConfig().rescoreWeights.redditSearch;
  const rescored = multiSignalRescore(signaled, rescoreWeights, limit);
  results = rescored.map((r) => r.item);

  cache.set(key, results);
  logger.debug({ resultCount: results.length }, 'Reddit search complete');

  return results;
}
