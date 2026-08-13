import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { searxngSearch } from '../src/tools/searxngSearch.js';
import { formatWebSearchMarkdown } from '../src/tools/webSearchResultFormatter.js';

const originalFetch = globalThis.fetch;

function mockFetch(response: unknown): void {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(response), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('searxngSearch coerces numeric publishedDate to null/unknown and never crashes the formatter path', async () => {
  mockFetch({
    results: [
      { title: 'T', url: 'https://example.com', content: 'snippet', publishedDate: 20260423 },
    ],
  });
  const results = await searxngSearch(
    'numeric-date-regression-query',
    'http://localhost:8888',
    5,
    'moderate',
  );
  assert.equal(results[0]?.age, null, 'numeric publishedDate ignored');
  assert.equal(results[0]?.ageKind, 'unknown');
  // Downstream formatter must not crash on the null age and must not claim publication.
  const md = formatWebSearchMarkdown(results);
  assert.ok(md.includes('[1-1]'), 'result still formatted');
  assert.ok(!md.includes('published:'), 'no publication claim for unknown age');
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

test('searxngSearch maps upstream engines to structured metadata, never body prose', async () => {
  globalThis.fetch = async (input: RequestInfo | URL) => {
    void input;
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'SearXNG result',
            url: 'https://example.com/upstream',
            content: 'Real body snippet.',
            engines: ['google', 'bing', 'google', 'yahoo'],
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
  const results = await searxngSearch('q', 'http://localhost:8888', 5, 'moderate');
  assert.deepEqual(
    results[0]!.upstreamEngines,
    ['bing', 'google', 'yahoo'],
    'upstream engines deduped and sorted, stored structurally',
  );
  assert.equal(results[0]!.extraSnippet, null, 'no `via ...` noise in body');
  // Formatter renders them as bracketed metadata after SearXNG, never cited prose.
  const md = formatWebSearchMarkdown(results);
  assert.match(md, /SearXNG \[bing, google, yahoo\] \(content\)/);
  assert.ok(!md.includes('via '), 'no raw upstream engine text in the body');
});

test('searxngSearch tolerates malformed engines arrays without crashing', async () => {
  // Invalid members (null, number, empty) must be dropped; only trimmed nonempty
  // strings survive, deduped and sorted deterministically.
  mockFetch({
    results: [
      {
        title: 'T',
        url: 'https://example.com',
        content: 'snippet',
        engines: ['google', null, 42, '', '  bing  ', 'google'],
      },
    ],
  });
  const results = await searxngSearch('malformed-engines', 'http://localhost:8888', 5, 'moderate');
  assert.deepEqual(
    results[0]?.upstreamEngines,
    ['bing', 'google'],
    'null/number/empty dropped; strings trimmed, deduped, sorted',
  );
});

test('searxngSearch omits upstream engines when the engines field is not an array', async () => {
  mockFetch({
    results: [{ title: 'T2', url: 'https://example.com/2', content: 'x', engines: 'google' }],
  });
  const results = await searxngSearch('non-array-engines', 'http://localhost:8888', 5, 'moderate');
  assert.equal(results[0]?.upstreamEngines, undefined, 'non-array engines omitted');
});
