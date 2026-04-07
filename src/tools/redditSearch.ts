import { logger } from '../logger.js';
import { safeResponseJson, TRUNCATED_MARKER } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { ToolError, unavailableError, timeoutError } from '../errors.js';
import type { RedditPost } from '../types.js';

const REDDIT_USER_AGENT = 'search-mcp/1.0 (MCP server for local use)';

const cache = new ToolCache<RedditPost[]>({ maxSize: 100, ttlMs: 10 * 60 * 1000 });

export async function redditSearch(
  query: string,
  subreddit = '',
  sort: 'relevance' | 'hot' | 'top' | 'new' | 'comments' = 'relevance',
  timeframe: 'all' | 'year' | 'month' | 'week' | 'day' | 'hour' = 'year',
  limit = 25,
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

  const key = cacheKey('reddit', query, subreddit, effectiveSort, effectiveTimeframe, String(limit));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Reddit search cache hit');
    return cached;
  }

  const url = subreddit
    ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=${effectiveSort}&t=${effectiveTimeframe}&limit=${String(limit)}&include_over_18=0`
    : `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${effectiveSort}&t=${effectiveTimeframe}&limit=${String(limit)}&include_over_18=0`;

  logger.info({ tool: 'reddit_search', subreddit, sort, timeframe, limit }, 'Searching Reddit');

  await assertRateLimitOk('reddit');

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 30_000);

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': REDDIT_USER_AGENT },
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

        return res;
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

  const json: unknown = await safeResponseJson(response, url);

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Unexpected Reddit API response shape');
  }
  const top = json as Record<string, unknown>;
  const data = top.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Unexpected Reddit API response shape');
  }
  const dataObj = data as Record<string, unknown>;
  if (!Array.isArray(dataObj.children)) {
    throw new Error('Unexpected Reddit API response shape');
  }

  const children = dataObj.children as unknown[];

  const results: RedditPost[] = children
    .map((child) => {
      if (typeof child !== 'object' || child === null) return null;
      const c = child as Record<string, unknown>;
      const d = c.data;
      if (typeof d !== 'object' || d === null) return null;
      const post = d as Record<string, unknown>;

      const rawSelftext = typeof post.selftext === 'string' ? post.selftext.trim() : '';
      const selftext =
        rawSelftext.length > 2000 ? rawSelftext.slice(0, 2000) + TRUNCATED_MARKER : rawSelftext;

      return {
        title: typeof post.title === 'string' ? post.title : '',
        url: typeof post.url === 'string' ? post.url : '',
        selftext,
        score: typeof post.score === 'number' ? post.score : 0,
        numComments: typeof post.num_comments === 'number' ? post.num_comments : 0,
        subreddit: typeof post.subreddit === 'string' ? post.subreddit : '',
        author: typeof post.author === 'string' ? post.author : '',
        createdUtc: typeof post.created_utc === 'number' ? post.created_utc : 0,
        permalink:
          typeof post.permalink === 'string' ? `https://www.reddit.com${post.permalink}` : '',
        isVideo: typeof post.is_video === 'boolean' ? post.is_video : false,
      } satisfies RedditPost;
    })
    .filter((post): post is RedditPost => post !== null && Boolean(post.title));

  cache.set(key, results);
  logger.debug({ resultCount: results.length }, 'Reddit search complete');

  return results;
}
