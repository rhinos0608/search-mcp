import { safeResponseJson } from '../httpGuards.js';
import { logger } from '../logger.js';
import { extractKeywords } from './redditQueryUtils.js';

const PULLPUSH_BASE_URL = 'https://api.pullpush.io';
const PULLPUSH_TIMEOUT_MS = 15_000;

interface QueryAttempt {
  query?: string | undefined;
  after?: number | undefined;
  label: string;
}

/**
 * Search Reddit posts via PullPush.io archive.
 * Returns data in Reddit-native search-response format compatible with parseRedditSearchListing.
 * Response shape: { kind: "Listing", data: { children: [{ kind: "t3", data: {...} }, ...] } }
 *
 * Note: PullPush is an archive. Very recent posts (<1h old) may not be available.
 * Rate limits: 15 req/min soft, 30 req/min hard, 1000 req/hr.
 */
export async function pullpushSearch(
  query: string,
  subreddit: string,
  sort = 'relevance',
  limit = 25,
  timeframe?: string,
): Promise<unknown> {
  const after = pullpushTimeframeToAfter(timeframe ?? '');
  const { sortDir, sortType } = pullpushSort(sort);
  const keywords = extractKeywords(query);

  // Query cascade: progressively broaden the search until we get results.
  // PullPush is a literal-matching archive — long natural-language queries
  // and restrictive date filters often return zero matches for niche subreddits.
  const attempts: QueryAttempt[] = [
    { query, after, label: 'full query with timeframe' },
    { query, after: undefined, label: 'full query without timeframe' },
  ];

  // If we extracted keywords that differ from the original, try them.
  // Single keyword first (most likely the main topic), then broader.
  if (keywords.length > 0 && keywords.join(' ') !== query.toLowerCase()) {
    if (keywords[0] && keywords[0] !== query.toLowerCase()) {
      attempts.push({ query: keywords[0], after: undefined, label: `keyword "${keywords[0]}"` });
    }
    if (keywords.length >= 2 && keywords.slice(0, 2).join(' ') !== query.toLowerCase()) {
      attempts.push({
        query: keywords.slice(0, 2).join(' '),
        after: undefined,
        label: `keywords "${keywords.slice(0, 2).join(' ')}"`,
      });
    }
  }

  // Last resort: no query filter, just recent posts from the subreddit
  attempts.push({ query: undefined, after: undefined, label: 'no query (subreddit only)' });

  const params = new URLSearchParams();
  params.set('subreddit', subreddit);
  params.set('size', String(Math.min(limit, 100)));
  params.set('sort', sortDir);
  params.set('sort_type', sortType);

  let posts: unknown[] = [];

  for (const attempt of attempts) {
    if (attempt.query !== undefined) {
      params.set('q', attempt.query);
    } else {
      params.delete('q');
    }
    if (attempt.after !== undefined) {
      params.set('after', String(attempt.after));
    } else {
      params.delete('after');
    }

    const url = `${PULLPUSH_BASE_URL}/reddit/search/submission/?${params.toString()}`;
    logger.info(
      {
        tool: 'reddit_search_fallback',
        backend: 'pullpush',
        subreddit,
        sort,
        limit,
        attempt: attempt.label,
      },
      `PullPush search (${attempt.label})`,
    );

    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      logger.warn(
        { status: response.status, attempt: attempt.label },
        'PullPush search attempt failed, trying next cascade step',
      );
      continue;
    }

    const json: unknown = await safeResponseJson(response, url);
    const data = (json as Record<string, unknown>).data;
    posts = Array.isArray(data) ? data : [];

    if (posts.length > 0) break;
  }

  // Wrap in Reddit-native Listing format
  return {
    kind: 'Listing',
    data: {
      children: posts.map((p: unknown) => ({ kind: 't3', data: p })),
    },
  };
}

function pullpushTimeframeToAfter(timeframe: string): number | undefined {
  const now = Math.floor(Date.now() / 1000);
  switch (timeframe) {
    case 'hour':
      return now - 3600;
    case 'day':
      return now - 86_400;
    case 'week':
      return now - 604_800;
    case 'month':
      return now - 2_592_000;
    case 'year':
      return now - 31_536_000;
    default:
      return undefined;
  }
}

interface PullpushSortMap {
  sortDir: string;
  sortType: string;
}

function pullpushSort(sort: string): PullpushSortMap {
  switch (sort) {
    case 'new':
      return { sortDir: 'desc', sortType: 'created_utc' };
    case 'top':
      return { sortDir: 'desc', sortType: 'score' };
    case 'comments':
      return { sortDir: 'desc', sortType: 'num_comments' };
    case 'relevance':
      return { sortDir: 'desc', sortType: 'created_utc' };
    default:
      return { sortDir: 'desc', sortType: 'created_utc' };
  }
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, PULLPUSH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'search-mcp/7.0 (pullpush-fallback)',
        ...(options.headers as Record<string, string>),
      },
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
