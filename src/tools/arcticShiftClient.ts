import { safeResponseJson } from '../httpGuards.js';
import { logger } from '../logger.js';
import { extractKeywords } from './redditQueryUtils.js';

const ARCTIC_SHIFT_BASE_URL = 'https://arctic-shift.photon-reddit.com/api';
const ARCTIC_SHIFT_TIMEOUT_MS = 15_000;

/**
 * Fetch a Reddit thread's comment tree from the Arctic Shift archive.
 * Returns data in Reddit-native format compatible with normalizeRedditThreadResponse.
 * Response shape: [postListing, commentListing] (same as Reddit's /comments/{id}/ endpoint).
 *
 * Note: Arctic Shift is an archive. Very recent posts (<24h old) may not be available.
 */
export async function arcticShiftFetchComments(article: string, limit = 50): Promise<unknown[]> {
  // Fetch comment tree
  const treeUrl = `${ARCTIC_SHIFT_BASE_URL}/comments/tree?link_id=t3_${article}&limit=${String(Math.min(limit, 25000))}`;
  logger.info(
    { tool: 'reddit_comments_fallback', backend: 'arctic-shift', limit },
    'Fetching Reddit thread via Arctic Shift',
  );

  const treeResponse = await fetchWithTimeout(treeUrl);
  if (!treeResponse.ok) {
    throw new Error(`Arctic Shift API returned ${String(treeResponse.status)} for comment tree`);
  }

  const treeJson: unknown = await safeResponseJson(treeResponse, treeUrl);
  const treeData = (treeJson as Record<string, unknown>).data;
  if (!Array.isArray(treeData)) {
    logger.warn(
      { dataType: typeof treeData },
      'Arctic Shift API returned malformed response: data field is not an array',
    );
  }
  const comments = Array.isArray(treeData) ? treeData : [];

  // Fetch post metadata
  const postUrl = `${ARCTIC_SHIFT_BASE_URL}/posts/ids?ids=${article}`;
  let postData: unknown[] = [];
  try {
    const postResponse = await fetchWithTimeout(postUrl);
    if (postResponse.ok) {
      const postJson: unknown = await safeResponseJson(postResponse, postUrl);
      const postResult = (postJson as Record<string, unknown>).data;
      if (Array.isArray(postResult)) {
        postData = postResult;
      }
    } else {
      logger.warn({ status: postResponse.status }, 'Arctic Shift post lookup failed');
    }
  } catch {
    logger.warn('Arctic Shift post lookup failed (network error)');
  }

  if (postData.length === 0) {
    // Build minimal post stub so normalization doesn't break
    postData = [
      {
        id: article,
        title: '',
        selftext: '',
        author: '[deleted]',
        subreddit: '',
        score: 0,
        num_comments: comments.length,
        created_utc: 0,
        permalink: `/r/_/comments/${article}/`,
        url: '',
        is_video: false,
      },
    ];
  }

  return [
    { kind: 'Listing', data: { children: postData.map((p) => ({ kind: 't3', data: p })) } },
    { kind: 'Listing', data: { children: comments } },
  ];
}

function timeframeToAfter(timeframe: string): string | undefined {
  const now = Date.now() / 1000;
  switch (timeframe) {
    case 'hour':
      return isoDate(now - 3600);
    case 'day':
      return isoDate(now - 86400);
    case 'week':
      return isoDate(now - 604800);
    case 'month':
      return isoDate(now - 2592000);
    case 'year':
      return isoDate(now - 31536000);
    default:
      return undefined;
  }
}

function isoDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().split('T')[0] ?? '';
}

function arcticShiftSort(sort: string): string | undefined {
  switch (sort) {
    case 'new':
      return 'desc';
    case 'top':
      return 'desc';
    case 'relevance':
      return undefined; // Arctic Shift sorts by created_utc; no relevance sort
    case 'comments':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Search Reddit posts via Arctic Shift archive.
 * Returns data in Reddit-native search-response format compatible with parseRedditSearchListing.
 * Response shape: { kind: "Listing", data: { children: [{ kind: "t3", data: {...} }, ...] } }
 *
 * Note: Arctic Shift is an archive. Results are sorted by created_utc; relevance sort is not available.
 */
interface QueryAttempt {
  query?: string | undefined;
  after?: string | undefined;
  label: string;
}

export async function arcticShiftSearch(
  query: string,
  subreddit: string,
  sort = 'relevance',
  limit = 25,
  timeframe?: string,
): Promise<unknown> {
  const arcticSort = arcticShiftSort(sort);
  const after = timeframeToAfter(timeframe ?? '');
  const keywords = extractKeywords(query);

  // Query cascade: progressively broaden the search until we get results.
  // Arctic Shift is a literal-matching archive — long natural-language queries
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
  params.set('limit', String(Math.min(limit, 100)));
  if (arcticSort) params.set('sort', arcticSort);

  let posts: unknown[] = [];
  let anyOk = false;

  for (const attempt of attempts) {
    if (attempt.query !== undefined) {
      params.set('query', attempt.query);
    } else {
      params.delete('query');
    }
    if (attempt.after !== undefined) {
      params.set('after', attempt.after);
    } else {
      params.delete('after');
    }

    const url = `${ARCTIC_SHIFT_BASE_URL}/posts/search?${params.toString()}`;
    logger.info(
      {
        tool: 'reddit_search_fallback',
        backend: 'arctic-shift',
        subreddit,
        sort,
        limit,
        attempt: attempt.label,
      },
      `Arctic Shift search (${attempt.label})`,
    );

    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      logger.warn(
        { status: response.status, attempt: attempt.label },
        'Arctic Shift search attempt failed, trying next cascade step',
      );
      continue;
    }

    const json: unknown = await safeResponseJson(response, url);
    const data = (json as Record<string, unknown>).data;
    posts = Array.isArray(data) ? data : [];

    if (posts.length > 0) {
      anyOk = true;
      break;
    }
  }

  // If no cascade attempt returned a 2xx, throw so outer fallback can proceed
  if (!anyOk && posts.length === 0) {
    throw new Error('Arctic Shift API unavailable — all cascade attempts returned non-2xx');
  }

  // Wrap in Reddit-native Listing format
  return {
    kind: 'Listing',
    data: {
      children: posts.map((p: unknown) => ({ kind: 't3', data: p })),
    },
  };
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, ARCTIC_SHIFT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'search-mcp/7.0 (arctic-shift-fallback)',
        ...(options.headers as Record<string, string>),
      },
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
