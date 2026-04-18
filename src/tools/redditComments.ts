import { logger } from '../logger.js';
import { safeResponseJson } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { ToolError, unavailableError, timeoutError, validationError } from '../errors.js';
import {
  createRedditClient,
  mergeRedditClientOptions,
  type RedditClientOptions,
} from './redditClient.js';
import {
  parseRedditThreadLocator,
  normalizeRedditThreadResponse,
  type RedditThreadLocatorInput,
  type NormalizedRedditComment,
  type NormalizedRedditMore,
  type ParsedRedditThreadRequest,
} from './redditThreadParser.js';

const REQUEST_TIMEOUT_MS = 30_000;

export interface RedditCommentsResult {
  post: {
    id: string;
    fullname: string;
    title: string;
    selftext: string;
    author: string;
    subreddit: string;
    score: number;
    numComments: number;
    createdUtc: number;
    permalink: string;
    url: string;
    isVideo: boolean;
  };
  comments: (NormalizedRedditComment | NormalizedRedditMore)[];
  more: NormalizedRedditMore[];
  request: ParsedRedditThreadRequest;
}

export async function redditComments(
  input: RedditThreadLocatorInput,
  clientOptions: RedditClientOptions = {},
): Promise<RedditCommentsResult> {
  let request: ParsedRedditThreadRequest;
  try {
    request = parseRedditThreadLocator(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw validationError(message, { backend: 'reddit', cause: err });
  }

  const client = createRedditClient(mergeRedditClientOptions(clientOptions));
  request = { ...request, usedOAuth: client.usesOAuth() };
  const queryParams: Record<string, string | number | boolean | undefined> = {
    raw_json: 1,
    sort: request.sort,
    depth: request.depth,
    limit: request.limit,
    context: request.context,
    showmore: request.showMore ? 'true' : undefined,
  };

  logger.info(
    {
      tool: 'reddit_comments',
      source: request.source,
      subreddit: request.subreddit,
      article: request.article,
      comment: request.comment,
      sort: request.sort,
      depth: request.depth,
      limit: request.limit,
    },
    'Fetching Reddit thread',
  );

  await assertRateLimitOk('reddit');

  const { json } = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const { response, url } = await client.fetch(request.permalink, queryParams, {
          signal: controller.signal,
        });

        getTracker('reddit').update(response.headers);

        if (response.status === 429) {
          getTracker('reddit').recordLimitHit();
          throw new ToolError('Reddit API rate limit hit (100 req/10min). Wait before retrying.', {
            code: 'RATE_LIMIT',
            retryable: false,
            statusCode: 429,
            backend: 'reddit',
          });
        }

        if (response.status === 403) {
          throw new ToolError(
            `Reddit returned 403. The subreddit "${request.subreddit}" may be private, banned, or quarantined.`,
            { code: 'UNAVAILABLE', retryable: false, statusCode: 403, backend: 'reddit' },
          );
        }

        if (response.status === 404) {
          throw new ToolError(
            `Reddit returned 404. The thread "${request.subreddit}/${request.article}" was not found.`,
            { code: 'UNAVAILABLE', retryable: false, statusCode: 404, backend: 'reddit' },
          );
        }

        if (!response.ok) {
          throw unavailableError(
            `Reddit API error ${String(response.status)}: ${response.statusText}`,
            {
              statusCode: response.status,
              backend: 'reddit',
            },
          );
        }

        const body: unknown = await safeResponseJson(response, url);
        return { json: body };
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
    { label: 'reddit-comments', maxAttempts: 2 },
  );

  const normalized = normalizeRedditThreadResponse(json, request);

  logger.debug(
    {
      tool: 'reddit_comments',
      commentCount: normalized.comments.length,
      moreCount: normalized.more.length,
    },
    'Reddit thread fetch complete',
  );

  return normalized;
}
