import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { searxngSearch } from '../src/tools/searxngSearch.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('searxngSearch allows operator-configured localhost endpoints', async () => {
  let calledUrl = '';
  globalThis.fetch = async (input: RequestInfo | URL) => {
    calledUrl = String(input);
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'Local result',
            url: 'https://example.com',
            content: 'Example content',
            publishedDate: '2026-04-23',
            engines: ['test-engine'],
          },
        ],
      }),
      {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      },
    );
  };

  const results = await searxngSearch('local query', 'http://localhost:8888', 1, 'moderate');

  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, 'Local result');
  assert.equal(results[0]!.url, 'https://example.com');
  assert.equal(calledUrl.startsWith('http://localhost:8888/search?'), true);
});
