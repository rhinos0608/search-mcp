import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchWithBackends,
  type WebSearchDeps,
} from '../src/tools/webSearch.js';
import type { SearchResult } from '../src/types.js';

function makeResult(url: string, position: number): SearchResult {
  return {
    title: `title-${url}`,
    url,
    description: `desc-${url}`,
    position,
    domain: new URL(url).hostname,
    source: 'brave',
    age: null,
    extraSnippet: null,
    deepLinks: null,
  };
}

test('merges and dedupes results from both backends', async () => {
  const a = makeResult('https://example.com/a', 1);
  const b = makeResult('https://example.com/b', 2);
  const c = makeResult('https://example.com/c', 2);

  const deps: WebSearchDeps = {
    braveSearch: async () => [a, b],
    searxngSearch: async () => [c, { ...b, source: 'searxng' as const }],
  };

  const results = await searchWithBackends('query', 2, 'moderate', deps, [
    'brave',
    'searxng',
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0]!.url, b.url, 'b should be first (RRF winner via both lists)');
  assert.equal(results[1]!.url, a.url, 'a should be second');
});

test('returns surviving results when one backend fails', async () => {
  const x = makeResult('https://example.com/x', 1);
  const y = makeResult('https://example.com/y', 2);

  const deps: WebSearchDeps = {
    braveSearch: async () => [x, y],
    searxngSearch: async () => {
      throw new Error('searxng down');
    },
  };

  const results = await searchWithBackends('query', 2, 'moderate', deps, [
    'brave',
    'searxng',
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0]!.url, x.url);
  assert.equal(results[1]!.url, y.url);
});

test('throws when all backends fail', async () => {
  const deps: WebSearchDeps = {
    braveSearch: async () => {
      throw new Error('brave down');
    },
    searxngSearch: async () => {
      throw new Error('searxng down');
    },
  };

  await assert.rejects(
    async () =>
      searchWithBackends('query', 2, 'moderate', deps, ['brave', 'searxng']),
    /All search backends failed/,
  );
});

test('limits results to requested count', async () => {
  const r1 = makeResult('https://example.com/1', 1);
  const r2 = makeResult('https://example.com/2', 2);
  const r3 = makeResult('https://example.com/3', 3);
  const r4 = makeResult('https://example.com/4', 1);
  const r5 = makeResult('https://example.com/5', 2);
  const r6 = makeResult('https://example.com/6', 3);

  const deps: WebSearchDeps = {
    braveSearch: async () => [r1, r2, r3],
    searxngSearch: async () => [r4, r5, r6],
  };

  const results = await searchWithBackends('query', 2, 'moderate', deps, [
    'brave',
    'searxng',
  ]);

  assert.equal(results.length, 2);
});
