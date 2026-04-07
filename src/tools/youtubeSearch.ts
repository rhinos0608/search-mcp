import { logger } from '../logger.js';
import { safeResponseJson, assertSafeUrl } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, timeoutError, validationError } from '../errors.js';
import type { YouTubeVideo } from '../types.js';

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/search';
const USER_AGENT = 'search-mcp/1.0';
const REQUEST_TIMEOUT_MS = 15_000;

const cache = new ToolCache<YouTubeVideo[]>({ maxSize: 100, ttlMs: 10 * 60 * 1000 });

export async function youtubeSearch(
  query: string,
  apiKey: string,
  order: 'relevance' | 'date' | 'viewCount' | 'rating' = 'relevance',
  limit = 10,
): Promise<YouTubeVideo[]> {
  if (!apiKey) {
    throw validationError(
      'YouTube search requires YOUTUBE_API_KEY env var. Get one at https://console.cloud.google.com/apis/credentials',
      { backend: 'youtube' },
    );
  }

  const key = cacheKey('youtube', query, order, String(limit));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'YouTube search cache hit');
    return cached;
  }

  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(Math.min(limit, 50)),
    order,
    key: apiKey,
  });

  const url = `${YOUTUBE_API_URL}?${params.toString()}`;
  assertSafeUrl(url);

  logger.info({ tool: 'youtube_search', order, limit }, 'Searching YouTube');

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

        if (res.status === 403) {
          throw unavailableError(
            'YouTube API quota exceeded or key invalid. Check YOUTUBE_API_KEY.',
            { statusCode: 403, backend: 'youtube' },
          );
        }

        if (!res.ok) {
          throw unavailableError(`YouTube API returned ${String(res.status)}: ${res.statusText}`, {
            statusCode: res.status,
            backend: 'youtube',
          });
        }

        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError('YouTube API request timed out after 15 seconds', {
            backend: 'youtube',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'youtube-search', maxAttempts: 2 },
  );

  const json: unknown = await safeResponseJson(response, url);

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Unexpected YouTube API response shape');
  }

  const body = json as Record<string, unknown>;
  const items = body.items;

  if (!Array.isArray(items)) {
    throw new Error('Unexpected YouTube API response: missing items array');
  }

  const results: YouTubeVideo[] = (items as unknown[])
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null;
      const i = item as Record<string, unknown>;

      // Extract videoId from id object
      let videoId = '';
      if (typeof i.id === 'object' && i.id !== null) {
        const idObj = i.id as Record<string, unknown>;
        if (typeof idObj.videoId === 'string') {
          videoId = idObj.videoId;
        }
      }

      if (!videoId) return null;

      // Extract snippet
      const snippet =
        typeof i.snippet === 'object' && i.snippet !== null
          ? (i.snippet as Record<string, unknown>)
          : {};

      const title = typeof snippet.title === 'string' ? snippet.title : '';
      const description = typeof snippet.description === 'string' ? snippet.description : '';
      const channelTitle = typeof snippet.channelTitle === 'string' ? snippet.channelTitle : '';
      const publishedAt = typeof snippet.publishedAt === 'string' ? snippet.publishedAt : '';

      // Thumbnail URL
      let thumbnailUrl: string | null = null;
      if (typeof snippet.thumbnails === 'object' && snippet.thumbnails !== null) {
        const thumbs = snippet.thumbnails as Record<string, unknown>;
        const high = thumbs.high;
        const medium = thumbs.medium;
        const def = thumbs.default;
        const thumb = high ?? medium ?? def;
        if (typeof thumb === 'object' && thumb !== null) {
          const thumbObj = thumb as Record<string, unknown>;
          if (typeof thumbObj.url === 'string') {
            thumbnailUrl = thumbObj.url;
          }
        }
      }

      return {
        videoId,
        title,
        description,
        channelTitle,
        publishedAt,
        thumbnailUrl,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      } satisfies YouTubeVideo;
    })
    .filter((v): v is YouTubeVideo => v !== null && Boolean(v.title));

  cache.set(key, results);
  logger.debug({ resultCount: results.length }, 'YouTube search complete');

  return results;
}
