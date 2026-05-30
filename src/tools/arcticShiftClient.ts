import { safeResponseJson } from '../httpGuards.js';
import { logger } from '../logger.js';

const ARCTIC_SHIFT_BASE_URL = 'https://arctic-shift.photon-reddit.com/api';
const ARCTIC_SHIFT_TIMEOUT_MS = 15_000;

/**
 * Fetch a Reddit thread's comment tree from the Arctic Shift archive.
 * Returns data in Reddit-native format compatible with normalizeRedditThreadResponse.
 * Response shape: [postListing, commentListing] (same as Reddit's /comments/{id}/ endpoint).
 *
 * Note: Arctic Shift is an archive. Very recent posts (<24h old) may not be available.
 */
export async function arcticShiftFetchComments(
  article: string,
  limit = 50,
): Promise<unknown[]> {
  // Fetch comment tree
  const treeUrl = `${ARCTIC_SHIFT_BASE_URL}/comments/tree?link_id=t3_${article}&limit=${Math.min(limit, 25000)}`;
  logger.info({ tool: 'reddit_comments_fallback', backend: 'arctic-shift', limit }, 'Fetching Reddit thread via Arctic Shift');

  const treeResponse = await fetchWithTimeout(treeUrl);
  if (!treeResponse.ok) {
    throw new Error(`Arctic Shift API returned ${treeResponse.status} for comment tree`);
  }

  const treeJson: unknown = await safeResponseJson(treeResponse, treeUrl);
  const treeData = (treeJson as Record<string, unknown>)?.data;
  const comments = Array.isArray(treeData) ? treeData : [];

  // Fetch post metadata
  const postUrl = `${ARCTIC_SHIFT_BASE_URL}/posts/ids?ids=${article}`;
  let postData: unknown[] = [];
  try {
    const postResponse = await fetchWithTimeout(postUrl);
    if (postResponse.ok) {
      const postJson: unknown = await safeResponseJson(postResponse, postUrl);
      const postResult = (postJson as Record<string, unknown>)?.data;
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
    postData = [{ id: article, title: '', selftext: '', author: '[deleted]', subreddit: '', score: 0, num_comments: comments.length, created_utc: 0, permalink: `/r/_/comments/${article}/`, url: '', is_video: false }];
  }

  return [
    { kind: 'Listing', data: { children: postData.map((p) => ({ kind: 't3', data: p })) } },
    { kind: 'Listing', data: { children: comments } },
  ];
}

function timeframeToAfter(timeframe: string): string | undefined {
  const now = Date.now() / 1000;
  switch (timeframe) {
    case 'hour': return isoDate(now - 3600);
    case 'day': return isoDate(now - 86400);
    case 'week': return isoDate(now - 604800);
    case 'month': return isoDate(now - 2592000);
    case 'year': return isoDate(now - 31536000);
    default: return undefined;
  }
}

function isoDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().split('T')[0]!;
}

function arcticShiftSort(sort: string): string | undefined {
  switch (sort) {
    case 'new': return 'desc';
    case 'top': return 'desc';
    case 'relevance': return undefined; // Arctic Shift sorts by created_utc; no relevance sort
    case 'comments': return undefined;
    default: return undefined;
  }
}

/**
 * Search Reddit posts via Arctic Shift archive.
 * Returns data in Reddit-native search-response format compatible with parseRedditSearchListing.
 * Response shape: { kind: "Listing", data: { children: [{ kind: "t3", data: {...} }, ...] } }
 *
 * Note: Arctic Shift is an archive. Results are sorted by created_utc; relevance sort is not available.
 */
export async function arcticShiftSearch(
  query: string,
  subreddit: string,
  sort = 'relevance',
  limit = 25,
  timeframe?: string,
): Promise<unknown> {
  const params = new URLSearchParams();
  params.set('subreddit', subreddit);
  params.set('query', query);
  params.set('limit', String(Math.min(limit, 100)));

  const arcticSort = arcticShiftSort(sort);
  if (arcticSort) params.set('sort', arcticSort);

  const after = timeframeToAfter(timeframe ?? '');
  if (after) params.set('after', after);

  const url = `${ARCTIC_SHIFT_BASE_URL}/posts/search?${params.toString()}`;
  logger.info({ tool: 'reddit_search_fallback', backend: 'arctic-shift', subreddit, sort, limit }, 'Searching Reddit via Arctic Shift');

  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(`Arctic Shift API returned ${response.status} for search`);
  }

  const json: unknown = await safeResponseJson(response, url);
  const data = (json as Record<string, unknown>)?.data;
  const posts = Array.isArray(data) ? data : [];

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
  const timeout = setTimeout(() => controller.abort(), ARCTIC_SHIFT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': 'search-mcp/7.0 (arctic-shift-fallback)', ...options.headers as Record<string, string> },
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
