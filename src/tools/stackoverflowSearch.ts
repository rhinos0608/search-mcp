import { logger } from '../logger.js';
import { safeResponseJson, assertSafeUrl, TRUNCATED_MARKER } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, timeoutError, ToolError } from '../errors.js';
import type { StackOverflowQuestion } from '../types.js';
import { safeExtractFromHtml } from '../utils/elementHelpers.js';

const SE_API_URL = 'https://api.stackexchange.com/2.3';
const USER_AGENT = 'search-mcp/1.0';
const REQUEST_TIMEOUT_MS = 15_000;
const BODY_MAX_LENGTH = 3000;

const cache = new ToolCache<StackOverflowQuestion[]>({ maxSize: 100, ttlMs: 10 * 60 * 1000 });

function stripHtml(html: string): string {
  return html
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function stackoverflowSearch(
  query: string,
  apiKey: string,
  sort: 'relevance' | 'votes' | 'creation' | 'activity' = 'relevance',
  tagged = '',
  accepted = false,
  limit = 20,
): Promise<StackOverflowQuestion[]> {
  const key = cacheKey('stackoverflow', query, sort, tagged, String(accepted), String(limit));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'SO search cache hit');
    return cached;
  }

  const params = new URLSearchParams({
    order: 'desc',
    sort,
    site: 'stackoverflow',
    q: query,
    pagesize: String(Math.min(limit, 100)),
    filter: '!nNPvSNdWme', // includes body
  });

  if (tagged) {
    params.set('tagged', tagged);
  }

  if (accepted) {
    params.set('accepted', 'True');
  }

  if (apiKey) {
    params.set('key', apiKey);
  }

  const url = `${SE_API_URL}/search/advanced?${params.toString()}`;
  assertSafeUrl(url);

  logger.info({ tool: 'stackoverflow_search', sort, tagged, limit }, 'Searching Stack Overflow');

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept-Encoding': 'gzip',
          },
          signal: controller.signal,
        });

        if (res.status === 429) {
          throw new ToolError('Stack Exchange API rate limit hit. Wait before retrying.', {
            code: 'RATE_LIMIT',
            retryable: false,
            statusCode: 429,
            backend: 'stackoverflow',
          });
        }

        if (!res.ok) {
          throw unavailableError(
            `Stack Exchange API returned ${String(res.status)}: ${res.statusText}`,
            { statusCode: res.status, backend: 'stackoverflow' },
          );
        }

        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError('Stack Exchange API request timed out after 15 seconds', {
            backend: 'stackoverflow',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'stackoverflow-search', maxAttempts: 2 },
  );

  const json: unknown = await safeResponseJson(response, url);

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Unexpected Stack Exchange API response shape');
  }

  const body = json as Record<string, unknown>;
  const items = body.items;

  if (!Array.isArray(items)) {
    throw new Error('Unexpected Stack Exchange API response: missing items array');
  }

  const results: StackOverflowQuestion[] = (items as unknown[])
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null;
      const q = item as Record<string, unknown>;

      const questionId = typeof q.question_id === 'number' ? q.question_id : 0;
      const title = typeof q.title === 'string' ? q.title : '';
      if (!title) return null;

      // Strip HTML from body and truncate
      const rawBody = typeof q.body === 'string' ? stripHtml(q.body) : '';
      const questionBody =
        rawBody.length > BODY_MAX_LENGTH
          ? rawBody.slice(0, BODY_MAX_LENGTH) + TRUNCATED_MARKER
          : rawBody;

      // Extract elements from raw HTML body (before stripping to plain text)
      const rawHtml = typeof q.body === 'string' ? q.body : '';
      const elements = rawHtml.length > 0 ? safeExtractFromHtml(rawHtml) : undefined;

      // Extract owner name
      let author = '';
      if (typeof q.owner === 'object' && q.owner !== null) {
        const owner = q.owner as Record<string, unknown>;
        if (typeof owner.display_name === 'string') {
          author = owner.display_name;
        }
      }

      return {
        questionId,
        title,
        body: questionBody,
        link:
          typeof q.link === 'string' ? q.link : `https://stackoverflow.com/q/${String(questionId)}`,
        score: typeof q.score === 'number' ? q.score : 0,
        answerCount: typeof q.answer_count === 'number' ? q.answer_count : 0,
        isAnswered: typeof q.is_answered === 'boolean' ? q.is_answered : false,
        acceptedAnswerId: typeof q.accepted_answer_id === 'number' ? q.accepted_answer_id : null,
        tags: Array.isArray(q.tags)
          ? (q.tags as unknown[]).filter((t): t is string => typeof t === 'string')
          : [],
        creationDate: typeof q.creation_date === 'number' ? q.creation_date : 0,
        author,
        viewCount: typeof q.view_count === 'number' ? q.view_count : 0,
        ...(elements !== undefined && elements.length > 0 && { elements }),
      } satisfies StackOverflowQuestion;
    })
    .filter((q): q is StackOverflowQuestion => q !== null);

  cache.set(key, results);
  logger.debug({ resultCount: results.length }, 'SO search complete');

  return results;
}
