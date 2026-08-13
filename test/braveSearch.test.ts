import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { braveSearch } from '../src/tools/braveSearch.js';
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

test('braveSearch coerces numeric/untrusted date fields to null/unknown and never crashes the formatter path', async () => {
  mockFetch({
    web: {
      results: [
        {
          title: 'T',
          url: 'https://example.com/a',
          description: 'snippet a',
          age: 20260423,
          page_age: 7,
          page_fetched: 1234567890,
        },
        {
          title: 'T2',
          url: 'https://example.com/b',
          description: 'snippet b',
          page_age: null,
          page_fetched: '2026-01-01',
        },
      ],
    },
  });

  const results = await braveSearch('numeric-date-regression-brave', 'key', 5, 'moderate');
  const numeric = results[0]!;
  assert.equal(numeric.age, null, 'numeric age/page_age/page_fetched all ignored');
  assert.equal(numeric.ageKind, 'unknown');

  const fetched = results[1]!;
  assert.equal(fetched.age, '2026-01-01', 'valid string page_fetched preserved');
  assert.equal(fetched.ageKind, 'fetched');

  // Downstream formatter path must not crash and must not claim publication.
  const md = formatWebSearchMarkdown(results);
  assert.ok(md.includes('snippet a'), 'result body still formatted');
  assert.ok(!md.includes('published:'), 'no publication claim for unknown/fetched ages');
});
