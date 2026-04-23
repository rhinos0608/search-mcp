import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { redditSearch, resetRedditSearchCache } from '../src/tools/redditSearch.js';
import { resetTrackers } from '../src/rateLimit.js';
import { TRUNCATED_MARKER } from '../src/httpGuards.js';
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

test('redditSearch preserves global-search heuristics and result shape through the shared reddit transport', async () => {
  let requestUrl = '';
  let requestHeaders = new Headers();

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify(redditSearchListingFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const results = await redditSearch('round1-global-query', '', 'relevance', 'year', 2);

  const parsedUrl = parseRequestUrl(requestUrl);
  assert.equal(parsedUrl.origin, 'https://www.reddit.com');
  assert.equal(parsedUrl.pathname, '/search.json');
  assert.equal(parsedUrl.searchParams.get('q'), 'round1-global-query');
  assert.equal(parsedUrl.searchParams.get('sort'), 'new');
  assert.equal(parsedUrl.searchParams.get('t'), 'week');
  assert.equal(parsedUrl.searchParams.get('limit'), '2');
  assert.equal(parsedUrl.searchParams.get('include_over_18'), '0');
  assert.equal(requestHeaders.get('user-agent'), 'search-mcp/1.0 (MCP server for local use)');
  assert.deepEqual(results, [
    {
      title: 'TypeScript 5.8 released',
      url: 'https://example.com/typescript-5-8',
      selftext: `${'x'.repeat(2000)}${TRUNCATED_MARKER}`,
      score: 420,
      numComments: 84,
      subreddit: 'typescript',
      author: 'anders',
      createdUtc: 1710000000,
      permalink: 'https://www.reddit.com/r/typescript/comments/abc123/typescript_58_released/',
      isVideo: false,
      elements: [{ type: 'text', text: `${'x'.repeat(2000)}${TRUNCATED_MARKER}` }],
    },
    {
      title: 'Typed linting pipeline',
      url: 'https://example.com/typed-linting',
      selftext: 'Short body',
      score: 73,
      numComments: 12,
      subreddit: 'typescript',
      author: 'compilerfan',
      createdUtc: 1710000123,
      permalink: 'https://www.reddit.com/r/typescript/comments/def456/typed_linting_pipeline/',
      isVideo: true,
      elements: [{ type: 'text', text: 'Short body' }],
    },
  ]);
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
