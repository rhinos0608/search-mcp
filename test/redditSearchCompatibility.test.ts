import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { redditSearch, resetRedditSearchCache } from '../src/tools/redditSearch.js';
import { resetTrackers } from '../src/rateLimit.js';
import { redditSearchListingFixture } from './fixtures/redditFixtures.js';

const originalFetch = globalThis.fetch;

function parseRequestUrl(input: string): URL {
  return new URL(input);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetRedditSearchCache();
  resetTrackers();
});

test('redditSearch preserves subreddit-scoped request parameters and restrict_sr behavior', async () => {
  let requestUrl = '';

  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify(redditSearchListingFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await redditSearch('round1-subreddit-query', 'typescript', 'top', 'all', 2);

  const parsedUrl = parseRequestUrl(requestUrl);
  assert.equal(parsedUrl.origin, 'https://www.reddit.com');
  assert.equal(parsedUrl.pathname, '/r/typescript/search.json');
  assert.equal(parsedUrl.searchParams.get('q'), 'round1-subreddit-query');
  assert.equal(parsedUrl.searchParams.get('restrict_sr'), '1');
  assert.equal(parsedUrl.searchParams.get('sort'), 'top');
  assert.equal(parsedUrl.searchParams.get('t'), 'all');
  assert.equal(parsedUrl.searchParams.get('limit'), '2');
  assert.equal(parsedUrl.searchParams.get('include_over_18'), '0');
});
