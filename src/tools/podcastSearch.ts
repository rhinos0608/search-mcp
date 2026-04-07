import { logger } from '../logger.js';
import { safeResponseJson, assertSafeUrl, TRUNCATED_MARKER } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { ToolError, unavailableError, timeoutError } from '../errors.js';
import type { PodcastResult } from '../types.js';

const LISTENNOTES_API_URL = 'https://listen-api.listennotes.com/api/v2/search';

const cache = new ToolCache<PodcastResult[]>({ maxSize: 100, ttlMs: 30 * 60 * 1000 });

// ── ListenNotes response types ───────────────────────────────────────────────

interface ListenNotesPodcast {
  title_original?: string;
  publisher_original?: string;
}

interface ListenNotesEpisode {
  title_original?: string;
  description_original?: string;
  podcast?: ListenNotesPodcast;
  listennotes_url?: string;
  audio?: string;
  audio_length_sec?: number;
  pub_date_ms?: number;
}

interface ListenNotesResponse {
  results?: ListenNotesEpisode[];
  count?: number;
  total?: number;
  next_offset?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip HTML tags from a string using a simple regex. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function podcastSearch(
  query: string,
  apiKey: string,
  sort: 'relevance' | 'date' = 'relevance',
  limit = 20,
): Promise<PodcastResult[]> {
  if (!apiKey) {
    throw unavailableError(
      'Podcast search requires a ListenNotes API key. Set LISTENNOTES_API_KEY env var.',
    );
  }

  const key = cacheKey('podcast', query, sort, String(limit));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Podcast search cache hit');
    return cached;
  }

  const params = new URLSearchParams({
    q: query,
    type: 'episode',
    sort_by_date: sort === 'date' ? '1' : '0',
    offset: '0',
    len_min: '0',
    len_max: '0',
    only_in: 'title,description',
    safe_mode: '1',
    page_size: String(limit),
  });

  const url = `${LISTENNOTES_API_URL}?${params.toString()}`;
  assertSafeUrl(url);

  logger.info({ tool: 'podcast_search', sort, limit }, 'Searching podcasts via ListenNotes');

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 30_000);

      try {
        const res = await fetch(url, {
          headers: {
            'X-ListenAPI-Key': apiKey,
            'User-Agent': 'search-mcp/1.0',
          },
          signal: controller.signal,
        });

        if (res.status === 401) {
          throw new ToolError(
            'ListenNotes API returned 401: Invalid or expired API key. Check LISTENNOTES_API_KEY.',
            {
              code: 'UNAVAILABLE',
              retryable: false,
              statusCode: 401,
              backend: 'listennotes',
            },
          );
        }

        if (res.status === 429) {
          throw new ToolError('ListenNotes API rate limit exceeded (429). Wait before retrying.', {
            code: 'RATE_LIMIT',
            retryable: false,
            statusCode: 429,
            backend: 'listennotes',
          });
        }

        if (!res.ok) {
          throw unavailableError(
            `ListenNotes API returned ${String(res.status)}: ${res.statusText}`,
            { statusCode: res.status, backend: 'listennotes' },
          );
        }

        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError('ListenNotes API request timed out after 30 seconds', {
            backend: 'listennotes',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'podcast-search', maxAttempts: 2 },
  );

  const json: unknown = await safeResponseJson(response, url);

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Unexpected ListenNotes API response shape');
  }

  const body = json as ListenNotesResponse;
  const episodes = body.results ?? [];

  const results: PodcastResult[] = (episodes as unknown[])
    .map((ep): PodcastResult | null => {
      if (typeof ep !== 'object' || ep === null) return null;
      const episode = ep as ListenNotesEpisode;

      const rawDescription =
        typeof episode.description_original === 'string'
          ? stripHtml(episode.description_original)
          : '';
      const description =
        rawDescription.length > 1000
          ? rawDescription.slice(0, 1000) + TRUNCATED_MARKER
          : rawDescription;

      let publishedDate: string | null = null;
      if (typeof episode.pub_date_ms === 'number' && episode.pub_date_ms > 0) {
        publishedDate = new Date(episode.pub_date_ms).toISOString();
      }

      return {
        title: typeof episode.title_original === 'string' ? episode.title_original : '',
        description,
        podcast:
          typeof episode.podcast?.title_original === 'string' ? episode.podcast.title_original : '',
        publisher:
          typeof episode.podcast?.publisher_original === 'string'
            ? episode.podcast.publisher_original
            : '',
        url: typeof episode.listennotes_url === 'string' ? episode.listennotes_url : '',
        audioUrl: typeof episode.audio === 'string' ? episode.audio : null,
        duration: typeof episode.audio_length_sec === 'number' ? episode.audio_length_sec : 0,
        publishedDate,
      };
    })
    .filter((r): r is PodcastResult => r !== null && Boolean(r.title));

  cache.set(key, results);
  logger.debug({ resultCount: results.length }, 'Podcast search complete');

  return results;
}
