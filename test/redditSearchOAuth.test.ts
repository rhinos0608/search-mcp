import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { redditSearch, resetRedditSearchCache } from '../src/tools/redditSearch.js';
import { resetTrackers, getTracker } from '../src/rateLimit.js';
import { resetRedditAuthCache } from '../src/tools/redditClient.js';
import { resetConfig } from '../src/config.js';
import { redditSearchListingFixture } from './fixtures/redditFixtures.js';

const REDDIT_ENV_KEYS = ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'] as const;
const originalFetch = globalThis.fetch;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of REDDIT_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetConfig();
  resetRedditAuthCache();
  resetRedditSearchCache();
  resetTrackers();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of REDDIT_ENV_KEYS) {
    const prior = saved.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  resetConfig();
  resetRedditAuthCache();
  resetRedditSearchCache();
  resetTrackers();
});

test('redditSearch routes through oauth.reddit.com with a bearer token when OAuth credentials are configured', async () => {
  process.env.REDDIT_CLIENT_ID = 'id-oauth';
  process.env.REDDIT_CLIENT_SECRET = 'secret-oauth';
  process.env.REDDIT_USER_AGENT = 'node:search-mcp:0.1.0 (by /u/tester)';

  const urls: string[] = [];
  const authHeaders: (string | null)[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    const headers = new Headers(init?.headers);
    authHeaders.push(headers.get('authorization'));
    if (url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok-oauth', token_type: 'bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(redditSearchListingFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const results = await redditSearch('oauth-query', 'typescript', 'top', 'week', 5);

  assert.equal(results.length, 2);
  const contentUrls = urls.filter((u) => !u.includes('/api/v1/access_token'));
  assert.equal(contentUrls.length, 1);
  const parsed = new URL(contentUrls[0] as string);
  assert.equal(parsed.origin, 'https://oauth.reddit.com');
  assert.equal(parsed.pathname, '/r/typescript/search');
  assert.equal(parsed.searchParams.get('q'), 'oauth-query');
  assert.equal(parsed.searchParams.get('sort'), 'top');
  assert.equal(parsed.searchParams.get('t'), 'week');
  assert.equal(parsed.searchParams.get('limit'), '5');

  const contentAuth = authHeaders.filter((h) => h !== null && h.startsWith('bearer'));
  assert.equal(contentAuth.length, 1);
  assert.equal(contentAuth[0], 'bearer tok-oauth');
});

test('redditSearch fails fast when OAuth is configured but the token endpoint rejects the credentials', async () => {
  process.env.REDDIT_CLIENT_ID = 'bad-id';
  process.env.REDDIT_CLIENT_SECRET = 'bad-secret';

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      return new Response(JSON.stringify({ message: 'Unauthorized', error: 401 }), { status: 401 });
    }
    throw new Error('content endpoint must not be called when token acquisition fails');
  };

  await assert.rejects(
    () => redditSearch('fail-fast-query', 'typescript', 'top', 'week', 5),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string; retryable?: boolean };
      assert.equal(typed.code, 'VALIDATION_ERROR');
      assert.equal(typed.retryable, false);
      return true;
    },
  );
});

test('redditSearch preserves Reddit rate-limit tracker updates when using the OAuth transport', async () => {
  process.env.REDDIT_CLIENT_ID = 'id-oauth';
  process.env.REDDIT_CLIENT_SECRET = 'secret-oauth';

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(redditSearchListingFixture), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '42',
        'x-ratelimit-used': '58',
        'x-ratelimit-reset': '120',
      },
    });
  };

  await redditSearch('rate-limit-query', 'typescript', 'top', 'week', 5);

  const info = getTracker('reddit').getInfo();
  assert.ok(info !== null, 'tracker must record rate-limit info from OAuth responses');
  assert.equal(info.remaining, 42);
  assert.equal(info.limit, 100);
});

test('redditSearch surfaces a 429 from the OAuth transport as a non-retryable RATE_LIMIT ToolError', async () => {
  process.env.REDDIT_CLIENT_ID = 'id-oauth';
  process.env.REDDIT_CLIENT_SECRET = 'secret-oauth';

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{"error":"rate limited"}', { status: 429 });
  };

  await assert.rejects(
    () => redditSearch('rl-429', 'typescript', 'top', 'week', 5),
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

test('redditSearch surfaces a 403 from the OAuth transport as UNAVAILABLE', async () => {
  process.env.REDDIT_CLIENT_ID = 'id-oauth';
  process.env.REDDIT_CLIENT_SECRET = 'secret-oauth';

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{"reason":"private"}', { status: 403, statusText: 'Forbidden' });
  };

  await assert.rejects(
    () => redditSearch('rl-403', 'typescript', 'top', 'week', 5),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string; statusCode?: number };
      assert.equal(typed.code, 'UNAVAILABLE');
      assert.equal(typed.statusCode, 403);
      return true;
    },
  );
});

test('redditSearch surfaces an AbortError from the OAuth transport as a TIMEOUT ToolError', async () => {
  process.env.REDDIT_CLIENT_ID = 'id-oauth';
  process.env.REDDIT_CLIENT_SECRET = 'secret-oauth';

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };

  await assert.rejects(
    () => redditSearch('rl-timeout', 'typescript', 'top', 'week', 5),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string };
      assert.equal(typed.code, 'TIMEOUT');
      return true;
    },
  );
});

test('redditSearch throws a VALIDATION_ERROR on the runtime path when OAuth is partially configured', async () => {
  process.env.REDDIT_CLIENT_ID = 'only-id';
  // intentionally leave REDDIT_CLIENT_SECRET unset
  globalThis.fetch = async () => {
    throw new Error('fetch should not be invoked when config is partial');
  };

  await assert.rejects(
    () => redditSearch('partial-config-query', 'typescript', 'top', 'week', 5),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string; retryable?: boolean };
      assert.equal(typed.code, 'VALIDATION_ERROR');
      assert.equal(typed.retryable, false);
      return true;
    },
  );
});

test('redditSearch produces the same normalized result shape whether OAuth is configured or not', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(redditSearchListingFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const publicResults = await redditSearch('shape-query', 'typescript', 'top', 'week', 2);

  resetRedditSearchCache();
  resetRedditAuthCache();
  resetConfig();

  process.env.REDDIT_CLIENT_ID = 'id-oauth';
  process.env.REDDIT_CLIENT_SECRET = 'secret-oauth';

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(redditSearchListingFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const oauthResults = await redditSearch('shape-query', 'typescript', 'top', 'week', 2);

  assert.deepEqual(oauthResults, publicResults);
});
