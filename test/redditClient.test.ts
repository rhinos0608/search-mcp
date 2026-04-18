import test from 'node:test';
import assert from 'node:assert/strict';

import { createRedditClient } from '../src/tools/redditClient.js';

test('createRedditClient builds public reddit json URLs and sends the shared user agent', async () => {
  let requestUrl = '';
  let requestHeaders = new Headers();

  const client = createRedditClient({
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const response = await client.getJson('/r/typescript/comments/abc123/example_post', {
    sort: 'new',
    depth: 4,
    limit: 20,
  });

  assert.deepEqual(response, { ok: true });
  assert.equal(
    requestUrl,
    'https://www.reddit.com/r/typescript/comments/abc123/example_post.json?sort=new&depth=4&limit=20',
  );
  assert.equal(requestHeaders.get('user-agent'), 'search-mcp/1.0 (MCP server for local use)');
});

test('createRedditClient preserves canonical trailing-slash permalinks when appending .json', () => {
  const client = createRedditClient();

  const url = client.buildUrl('/r/typescript/comments/abc123/example_post/');

  assert.equal(url, 'https://www.reddit.com/r/typescript/comments/abc123/example_post.json');
});

test('createRedditClient.fetchJson returns parsed json metadata without exposing a consumed response body', async () => {
  const client = createRedditClient({
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });

  const result = await client.fetchJson('/r/typescript/comments/abc123/example_post');

  assert.deepEqual(result, {
    json: { ok: true },
    url: 'https://www.reddit.com/r/typescript/comments/abc123/example_post.json',
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal('response' in result, false);
});

test('createRedditClient rejects protocol-relative paths that could escape the reddit host', () => {
  const client = createRedditClient();

  assert.throws(() => client.buildUrl('//evil.example/steal'), /Invalid Reddit request path/);
});
