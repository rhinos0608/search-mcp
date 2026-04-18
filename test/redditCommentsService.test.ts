import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { redditComments } from '../src/tools/redditComments.js';
import { resetTrackers } from '../src/rateLimit.js';
import { redditCommentsListingFixture } from './fixtures/redditFixtures.js';

afterEach(() => {
  resetTrackers();
});

test('redditComments fetches the public .json endpoint for a url locator with raw_json=1 and normalizes the response', async () => {
  let requestUrl = '';
  let requestHeaders = new Headers();

  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify(redditCommentsListingFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await redditComments(
    {
      url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/',
      sort: 'top',
      depth: 3,
      limit: 25,
    },
    { fetchImpl },
  );

  const parsedUrl = new URL(requestUrl);
  assert.equal(parsedUrl.origin, 'https://www.reddit.com');
  assert.equal(parsedUrl.pathname, '/r/typescript/comments/abc123/example_post.json');
  assert.equal(parsedUrl.searchParams.get('raw_json'), '1');
  assert.equal(parsedUrl.searchParams.get('sort'), 'top');
  assert.equal(parsedUrl.searchParams.get('depth'), '3');
  assert.equal(parsedUrl.searchParams.get('limit'), '25');
  assert.equal(requestHeaders.get('user-agent'), 'search-mcp/1.0 (MCP server for local use)');

  assert.equal(result.post.id, 'abc123');
  assert.equal(result.post.subreddit, 'typescript');
  assert.equal(result.post.title, 'Example Post');
  assert.equal(result.post.permalink, 'https://www.reddit.com/r/typescript/comments/abc123/example_post/');

  assert.equal(result.comments.length, 1);
  const first = result.comments[0];
  assert.ok(first !== undefined);
  assert.ok('body' in first, 'first comment should be a comment node');
  assert.equal(first.id, 'c1');
  assert.equal(first.replies.length, 1);

  assert.equal(result.more.length, 2);

  assert.equal(result.request.source, 'url');
  assert.equal(result.request.subreddit, 'typescript');
  assert.equal(result.request.article, 'abc123');
  assert.equal(result.request.sort, 'top');
  assert.equal(result.request.depth, 3);
  assert.equal(result.request.limit, 25);
  assert.equal(result.request.showMore, false);
  assert.equal(result.request.usedOAuth, false);
});

test('redditComments sends subreddit+article locator with focused comment/context query params', async () => {
  let requestUrl = '';

  const fetchImpl: typeof fetch = async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify(redditCommentsListingFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await redditComments(
    {
      subreddit: 'typescript',
      article: 'abc123',
      comment: 'def456',
      context: 3,
      sort: 'new',
    },
    { fetchImpl },
  );

  const parsedUrl = new URL(requestUrl);
  assert.equal(parsedUrl.pathname, '/r/typescript/comments/abc123/_/def456.json');
  assert.equal(parsedUrl.searchParams.get('raw_json'), '1');
  assert.equal(parsedUrl.searchParams.get('context'), '3');
  assert.equal(parsedUrl.searchParams.get('sort'), 'new');
});

test('redditComments surfaces invalid locator configuration as a VALIDATION_ERROR', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error('fetch should not be called on validation failure');
  };

  await assert.rejects(
    () => redditComments({}, { fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Exactly one Reddit thread locator form is required/);
      assert.equal((err as { code?: string }).code, 'VALIDATION_ERROR');
      return true;
    },
  );
});

test('redditComments surfaces a 429 response as a non-retryable RATE_LIMIT ToolError', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('{"error":"rate limited"}', {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });

  await assert.rejects(
    () =>
      redditComments(
        {
          subreddit: 'typescript',
          article: 'abc123',
        },
        { fetchImpl },
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string; statusCode?: number; retryable?: boolean };
      assert.equal(typed.code, 'RATE_LIMIT');
      assert.equal(typed.statusCode, 429);
      assert.equal(typed.retryable, false);
      return true;
    },
  );
});

test('redditComments surfaces a 403 as UNAVAILABLE with statusCode 403', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('{"reason":"private"}', {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'content-type': 'application/json' },
    });

  await assert.rejects(
    () =>
      redditComments(
        {
          subreddit: 'typescript',
          article: 'abc123',
        },
        { fetchImpl },
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string; statusCode?: number };
      assert.equal(typed.code, 'UNAVAILABLE');
      assert.equal(typed.statusCode, 403);
      return true;
    },
  );
});

test('redditComments surfaces a 404 as UNAVAILABLE with statusCode 404', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('not found', {
      status: 404,
      statusText: 'Not Found',
    });

  await assert.rejects(
    () =>
      redditComments(
        {
          subreddit: 'typescript',
          article: 'abc123',
        },
        { fetchImpl },
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string; statusCode?: number };
      assert.equal(typed.code, 'UNAVAILABLE');
      assert.equal(typed.statusCode, 404);
      return true;
    },
  );
});

test('redditComments surfaces a 503 as retryable UNAVAILABLE and retries the request', async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async () => {
    callCount += 1;
    return new Response('upstream down', { status: 503, statusText: 'Service Unavailable' });
  };
  await assert.rejects(
    () => redditComments({ subreddit: 'typescript', article: 'abc123' }, { fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string; statusCode?: number; retryable?: boolean };
      assert.equal(typed.code, 'UNAVAILABLE');
      assert.equal(typed.statusCode, 503);
      assert.equal(typed.retryable, true);
      return true;
    },
  );
  assert.equal(callCount, 2);
});

test('redditComments surfaces an AbortError as a TIMEOUT ToolError', async () => {
  const fetchImpl: typeof fetch = async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
  await assert.rejects(
    () => redditComments({ subreddit: 'typescript', article: 'abc123' }, { fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string; retryable?: boolean };
      assert.equal(typed.code, 'TIMEOUT');
      assert.equal(typed.retryable, true);
      return true;
    },
  );
});
