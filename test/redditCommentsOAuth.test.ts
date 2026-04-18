import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { redditComments } from '../src/tools/redditComments.js';
import { resetTrackers } from '../src/rateLimit.js';
import { resetRedditAuthCache } from '../src/tools/redditClient.js';
import { resetConfig } from '../src/config.js';
import { redditCommentsListingFixture } from './fixtures/redditFixtures.js';

const REDDIT_ENV_KEYS = ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of REDDIT_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetConfig();
  resetRedditAuthCache();
  resetTrackers();
});

afterEach(() => {
  for (const key of REDDIT_ENV_KEYS) {
    const prior = saved.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  resetConfig();
  resetRedditAuthCache();
  resetTrackers();
});

test('redditComments routes to oauth.reddit.com without the .json suffix and reports usedOAuth=true', async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    const headers = new Headers(init?.headers);
    if (url.startsWith('https://www.reddit.com/api/v1/access_token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    assert.equal(headers.get('authorization'), 'bearer tok');
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
    { fetchImpl, auth: { clientId: 'id', clientSecret: 'secret' } },
  );

  const contentUrl = urls.find((u) => u.startsWith('https://oauth.reddit.com/'));
  assert.ok(contentUrl !== undefined, 'expected at least one oauth.reddit.com request');
  const parsed = new URL(contentUrl);
  assert.equal(parsed.origin, 'https://oauth.reddit.com');
  assert.equal(parsed.pathname, '/r/typescript/comments/abc123/example_post');
  assert.equal(parsed.searchParams.get('sort'), 'top');

  assert.equal(result.request.usedOAuth, true);
});

test('redditComments continues to report usedOAuth=false when no auth is configured', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify(redditCommentsListingFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const result = await redditComments(
    { url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post/' },
    { fetchImpl },
  );

  assert.equal(result.request.usedOAuth, false);
});
