import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchWithBackends,
  type WebSearchDeps,
} from '../src/tools/webSearch.js';
import { resetConfig } from '../src/config.js';
import type { SearchResult } from '../src/types.js';

function makeResult(
  url: string,
  position: number,
  age: string | null = null,
  deepLinks: { title: string; url: string }[] | null = null,
): SearchResult {
  return {
    title: `title-${url}`,
    url,
    description: `desc-${url}`,
    position,
    domain: new URL(url).hostname,
    source: 'brave',
    age,
    extraSnippet: null,
    deepLinks,
  };
}

test('skips unconfigured backends when overrideBackends is omitted', async () => {
  const origBrave = process.env.BRAVE_API_KEY;
  const origSearx = process.env.SEARXNG_BASE_URL;

  try {
    process.env.BRAVE_API_KEY = 'test-key';
    delete process.env.SEARXNG_BASE_URL;
    resetConfig();

    const deps: WebSearchDeps = {
      braveSearch: async () => [makeResult('https://example.com/x', 1)],
      searxngSearch: async () => {
        throw new Error('should not be called');
      },
    };

    const results = await searchWithBackends('query', 1, 'moderate', deps);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.url, 'https://example.com/x');
  } finally {
    if (origBrave !== undefined) process.env.BRAVE_API_KEY = origBrave;
    else delete process.env.BRAVE_API_KEY;
    if (origSearx !== undefined) process.env.SEARXNG_BASE_URL = origSearx;
    else delete process.env.SEARXNG_BASE_URL;
    resetConfig();
  }
});

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
  assert.equal(results[0]!.position, 1, 'position should be remapped after fusion');
  assert.equal(results[1]!.url, a.url, 'a should be second');
  assert.equal(results[1]!.position, 2, 'position should be remapped after fusion');
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
  assert.equal(results[0]!.url, r1.url);
  assert.equal(results[0]!.position, 1);
  assert.equal(results[1]!.url, r4.url);
  assert.equal(results[1]!.position, 2);
});

test('searchWithBackends with rescoring: fresher results bubble up', async () => {
  // Arrange backends so RRF is tied, letting recency break the tie
  const braveResults: SearchResult[] = [
    makeResult('https://example.com/old', 1, '30 days ago'),
    makeResult('https://example.com/new', 2, '1 day ago'),
  ];
  const searxResults: SearchResult[] = [
    makeResult('https://example.com/new', 1, '1 day ago'),
    makeResult('https://example.com/old', 2, '30 days ago'),
  ];

  const results = await searchWithBackends(
    'test',
    2,
    'moderate',
    {
      braveSearch: async () => braveResults,
      searxngSearch: async () => searxResults,
    },
    ['brave', 'searxng'],
  );

  // With rescoring, newer result should outrank older one
  assert.equal(results[0]!.url, 'https://example.com/new');
});
