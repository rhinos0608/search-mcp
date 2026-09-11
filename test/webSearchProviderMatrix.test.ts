import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWithBackends, type WebSearchDeps, type ProvenanceResult } from '../src/tools/webSearch.js';
import { createMockConfig } from './helpers/mocks.js';
import { isToolError } from '../src/errors.js';
import type { SearchResult } from '../src/types.js';

function makeResult(
  source: SearchResult['source'],
  url: string,
  position: number,
  extraSnippet: string | null = null,
): SearchResult {
  return {
    title: `title-${url}`,
    url,
    description: `desc-${url}`,
    position,
    domain: new URL(url).hostname,
    source,
    age: null,
    extraSnippet,
    deepLinks: null,
    contentKind: 'snippet',
    generatedSummary: null,
  };
}

const keysConfig = () =>
  createMockConfig({
    jina: { apiKey: 'jina-key' },
    firecrawl: { apiKey: 'fc-key', scrapeFallback: { enabled: false } },
    diffbot: { apiKey: 'diffbot-key' },
  });

function stubDeps(
  jina: SearchResult[] = [],
  firecrawl: SearchResult[] = [],
  diffbot: SearchResult[] = [],
  brave: SearchResult[] = [],
): WebSearchDeps & { calls: Record<'brave' | 'jina' | 'firecrawl' | 'diffbot', number> } {
  const calls: Record<'brave' | 'jina' | 'firecrawl' | 'diffbot', number> = {
    brave: 0,
    jina: 0,
    firecrawl: 0,
    diffbot: 0,
  };
  return {
    calls,
    braveSearch: async () => {
      calls.brave++;
      return brave;
    },
    searxngSearch: async () => [],
    exaSearch: async () => [],
    tavilySearch: async () => [],
    jinaSearch: async () => {
      calls.jina++;
      return jina;
    },
    firecrawlSearch: async (query: string, apiKey: string, limit?: number) => {
      void query;
      void apiKey;
      void limit;
      calls.firecrawl++;
      return firecrawl as import('../src/tools/firecrawlSearch.js').FirecrawlSearchResult[];
    },
    diffbotSearch: async () => {
      calls.diffbot++;
      return diffbot;
    },
    config: keysConfig(),
  };
}

test('fanout: jina backend runs via key and provenance records source', async () => {
  const jinaResult = makeResult('jina', 'https://example.com/a', 1);
  const deps = stubDeps([jinaResult]);
  const provenance: { current: ProvenanceResult | null } = { current: null };
  const results = await searchWithBackends(
    'query',
    5,
    'off',
    deps,
    ['jina'],
    false,
    true,
    provenance,
  );
  assert.equal(deps.calls.jina, 1);
  assert.equal(deps.calls.firecrawl, 0);
  assert.equal(deps.calls.diffbot, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.source, 'jina');
  assert.equal(provenance.current?.usedBackend, 'jina');
  assert.equal(provenance.current?.usedFallback, false);
  assert.ok(provenance.current?.servedBackends.includes('jina'));
});

test('fanout: all three providers run in a single fanout pass and merge with engine provenance', async () => {
  const deps = stubDeps(
    [makeResult('jina', 'https://example.com/j', 1)],
    [makeResult('firecrawl', 'https://example.com/f', 1)],
    [makeResult('diffbot', 'https://example.com/d', 1)],
  );
  const provenance: { current: ProvenanceResult | null } = { current: null };
  const results = await searchWithBackends(
    'query',
    5,
    'off',
    deps,
    ['jina', 'firecrawl', 'diffbot'],
    false,
    true,
    provenance,
  );
  assert.equal(deps.calls.jina, 1);
  assert.equal(deps.calls.firecrawl, 1);
  assert.equal(deps.calls.diffbot, 1);
  const sources = new Set(results.map((r) => r.source));
  for (const s of ['jina', 'firecrawl', 'diffbot']) assert.ok(sources.has(s as never));
  for (const r of results) {
    assert.ok((r.engines ?? []).length >= 1);
  }
  assert.ok(provenance.current?.servedBackends.includes('jina'));
});

test('fanout: same URL from jina + brave dedupes to richest representation with unioned engines', async () => {
  const sharedUrl = 'https://example.com/shared';
  const deps = stubDeps(
    [makeResult('jina', sharedUrl, 1)],
    [],
    [],
    [makeResult('brave', sharedUrl, 1, 'brave-extra-snippet-makes-this-richer')],
  );
  const results = await searchWithBackends(
    'query',
    5,
    'off',
    deps,
    ['jina', 'brave'],
    false,
    true,
  );
  assert.equal(results.length, 1);
  const merged = results[0];
  assert.ok(merged);
  // Richer representation (extraSnippet) wins as content truth.
  assert.equal(merged.extraSnippet, 'brave-extra-snippet-makes-this-richer');
  const engines = merged.engines ?? [];
  assert.ok(engines.includes('jina'));
  assert.ok(engines.includes('brave'));
});

test('fanout: strict safe-search excludes all three and errors when nothing supported remains', async () => {
  const deps = stubDeps();
  await assert.rejects(
    () => searchWithBackends('query', 5, 'strict', deps, ['jina', 'firecrawl', 'diffbot'], false),
    (err: unknown) => {
      assert.ok(isToolError(err));
      assert.match(err.message, /strict/);
      return true;
    },
  );
  assert.equal(deps.calls.jina, 0);
  assert.equal(deps.calls.firecrawl, 0);
  assert.equal(deps.calls.diffbot, 0);
});

test('fanout: aiSummary="only" scope stays exa+tavily — new providers never contribute summaries', async () => {
  const deps = stubDeps();
  await assert.rejects(
    () => searchWithBackends('query', 5, 'moderate', deps, undefined, false, true, undefined, undefined, 'only'),
    (err: unknown) => {
      assert.ok(isToolError(err));
      assert.match(err.message, /EXA_API_KEY \(Exa\) or TAVILY_API_KEY \(Tavily\)/);
      return true;
    },
  );
  assert.equal(deps.calls.jina, 0);
  assert.equal(deps.calls.firecrawl, 0);
  assert.equal(deps.calls.diffbot, 0);
});

test('fanout: unconfigured new providers — real adapter empty-key guard throws, no fetch', async () => {
  const { jinaSearch } = await import('../src/tools/jinaSearch.js');
  const emptyCfg = createMockConfig(); // jina.apiKey = ''
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('LIVE CALL ATTEMPTED');
  }) as typeof fetch;
  const deps: WebSearchDeps = {
    ...stubDeps(),
    jinaSearch,
    config: emptyCfg,
  };
  try {
    await assert.rejects(
      () => searchWithBackends('query', 5, 'off', deps, ['jina'], false),
      (err: unknown) => err instanceof Error,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fanout: adapter empty-key guard — firecrawlSearch/diffbotSearch unavailable without key', async () => {
  const { firecrawlSearch } = await import('../src/tools/firecrawlSearch.js');
  const { diffbotSearch } = await import('../src/tools/diffbotSearch.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('LIVE CALL ATTEMPTED');
  }) as typeof fetch;
  try {
    await assert.rejects(() => firecrawlSearch('q', ''), /not configured/);
    await assert.rejects(() => diffbotSearch('q', ''), /DIFFBOT_API_KEY/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fanout: query expansion multiplies billable calls per provider (regression guard)', async () => {
  const { expandQuery } = await import('../src/tools/queryExpansion.js');
  const query = 'best rust web framework';
  const variationCount = expandQuery(query).length;
  assert.ok(variationCount > 1, 'sanity: query expands to multiple variations');

  const deps = stubDeps(
    [makeResult('jina', 'https://example.com/j1', 1)],
    [makeResult('firecrawl', 'https://example.com/f1', 1)],
    [makeResult('diffbot', 'https://example.com/d1', 1)],
  );
  await searchWithBackends(query, 5, 'off', deps, ['jina', 'firecrawl', 'diffbot'], true);

  // Each billable backend is called once per query variation — the cost
  // warning in README/config.example.json depends on this exact shape.
  assert.equal(deps.calls.jina, variationCount);
  assert.equal(deps.calls.firecrawl, variationCount);
  assert.equal(deps.calls.diffbot, variationCount);
});
