import test from 'node:test';
import assert from 'node:assert/strict';
import { withFirecrawlScrapeFallback } from '../src/tools/firecrawlScrapeFallback.js';
import type { CrawlRequest, CrawlResponse } from '../src/crawl/types.js';
import type { CrawlOptions } from '../src/crawl/types.js';
import { unavailableError } from '../src/errors.js';

const originalFetch = globalThis.fetch;

function baseOpts(overrides: Partial<CrawlOptions> = {}): CrawlOptions {
  return {
    strategy: 'bfs',
    maxDepth: 1,
    maxPages: 1,
    includeExternalLinks: false,
    ...overrides,
  };
}

function makeReq(overrides: Partial<CrawlOptions> = {}): CrawlRequest {
  return {
    url: 'https://example.com/page',
    baseUrl: 'http://127.0.0.1:8051',
    apiToken: '',
    opts: baseOpts(overrides),
    attempt: 1,
  };
}

function primaryOk(): Promise<CrawlResponse> {
  return Promise.resolve({
    result: {
      seedUrl: 'https://example.com/page',
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 1,
      pages: [
        {
          url: 'https://example.com/page',
          success: true,
          markdown: '# ok',
          title: null,
          description: null,
          links: [],
          statusCode: 200,
          errorMessage: null,
        },
      ],
      totalPages: 1,
      successfulPages: 1,
    },
  });
}

function primaryFails(): Promise<CrawlResponse> {
  return Promise.reject(unavailableError('crawl4ai sidecar returned HTTP 503'));
}

function mockScrapeFetch(markdown: string): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    state.calls++;
    const body = {
      success: true,
      data: { markdown, metadata: { statusCode: 200 } },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return state;
}

const FALLBACK = { apiKey: 'fc-test' };

test('fallback: primary throw → firecrawl scrape served with accurate counts and provenance', async () => {
  const state = mockScrapeFetch('# recovered content');
  try {
    const wrapped = withFirecrawlScrapeFallback(primaryFails, FALLBACK);
    const resp = await wrapped(makeReq());
    assert.equal(state.calls, 1);
    assert.equal(resp.result.totalPages, 1);
    assert.equal(resp.result.successfulPages, 1);
    assert.equal(resp.result.pages.length, 1);
    assert.equal(resp.result.pages[0]?.recoverySource, 'firecrawl');
    assert.equal(resp.recovered, true);
    assert.equal(resp.recoverySource, 'firecrawl');
    assert.ok(resp.result.warnings?.some((w) => w.startsWith('firecrawl-scrape-fallback:')));
    // Single-page request must NOT carry the degraded warning.
    assert.ok(!resp.result.warnings?.some((w) => w.includes('degraded')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallback: primary success → no fallback, no fetch', async () => {
  const state = mockScrapeFetch('# recovered content');
  try {
    const wrapped = withFirecrawlScrapeFallback(primaryOk, FALLBACK);
    const resp = await wrapped(makeReq());
    assert.equal(state.calls, 0);
    assert.equal(resp.result.pages[0]?.markdown, '# ok');
    assert.equal(resp.result.pages[0]?.recoverySource, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallback: gate closed (undefined config) → primary error propagates untouched', async () => {
  const state = mockScrapeFetch('# recovered content');
  try {
    const wrapped = withFirecrawlScrapeFallback(primaryFails, undefined);
    await assert.rejects(() => wrapped(makeReq()), /HTTP 503/);
    assert.equal(state.calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallback: multi-page request degrades to seed with explicit degraded warning', async () => {
  const state = mockScrapeFetch('# seed only');
  try {
    const wrapped = withFirecrawlScrapeFallback(primaryFails, FALLBACK);
    const resp = await wrapped(makeReq({ maxPages: 5, maxDepth: 3 }));
    assert.equal(state.calls, 1);
    assert.equal(resp.result.totalPages, 1);
    assert.equal(resp.result.successfulPages, 1);
    // Requested traversal preserved as metadata.
    assert.equal(resp.result.maxPages, 5);
    assert.equal(resp.result.maxDepth, 3);
    assert.ok(
      resp.result.warnings?.some(
        (w) =>
          w.startsWith('firecrawl-scrape-fallback:') &&
          w.includes('degraded') &&
          w.includes('no link traversal'),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const [label, opts] of [
  ['waitFor', { waitFor: 'css:.loaded' }],
  ['jsCode', { jsCode: 'window.scrollTo(0, document.body.scrollHeight)' }],
  ['jsCodeBeforeWait', { jsCodeBeforeWait: 'window.scrollBy(0, 500)' }],
  ['extractionConfig', { extractionConfig: { strategy: 'css_schema' as const, schema: {} } }],
  ['llmFallback', { llmFallback: { provider: 'm', apiToken: 't' } }],
  ['includeExternalLinks=true', { includeExternalLinks: true }],
  ['delayBeforeReturnHtml>0.1', { delayBeforeReturnHtml: 2 }],
] as [string, Partial<CrawlOptions>][]) {
  test(`fallback: skipped when ${label} requested — original error rethrown, no fetch`, async () => {
    const state = mockScrapeFetch('# recovered content');
    try {
      const wrapped = withFirecrawlScrapeFallback(primaryFails, FALLBACK);
      await assert.rejects(() => wrapped(makeReq(opts)), /HTTP 503/);
      assert.equal(state.calls, 0, `${label} must not trigger billable fallback`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('fallback: maxBytes is honored via UTF-8-safe truncation (not a skip)', async () => {
  const state = mockScrapeFetch('# recovered content with multibyte caf\u00e9 \u00e9\u00e9\u00e9\u00e9');
  try {
    const wrapped = withFirecrawlScrapeFallback(primaryFails, FALLBACK);
    const resp = await wrapped(makeReq({ maxBytes: 10 }));
    assert.equal(state.calls, 1, 'maxBytes must not skip the billable fallback');
    const markdown = resp.result.pages[0]?.markdown ?? '';
    assert.ok(Buffer.from(markdown, 'utf-8').byteLength <= 10);
    // No replacement characters from a split multibyte sequence.
    assert.ok(!markdown.includes('\ufffd'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallback: caller cancellation (AbortError) is never intercepted', async () => {
  const state = mockScrapeFetch('# recovered content');
  try {
    const cancel = () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    };
    const wrapped = withFirecrawlScrapeFallback(cancel, FALLBACK);
    await assert.rejects(
      () => wrapped(makeReq()),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'AbortError');
        return true;
      },
    );
    assert.equal(state.calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallback: scrape failure rethrows the ORIGINAL primary error', async () => {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'bad' }), { status: 401 });
  }) as typeof fetch;
  try {
    const wrapped = withFirecrawlScrapeFallback(primaryFails, FALLBACK);
    await assert.rejects(() => wrapped(makeReq()), /HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallback: empty scrape content rethrows the ORIGINAL primary error', async () => {
  mockScrapeFetch('');
  try {
    const wrapped = withFirecrawlScrapeFallback(primaryFails, FALLBACK);
    await assert.rejects(() => wrapped(makeReq()), /HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallback: firecrawlScrape sends skipTlsVerification=false, storeInCache=false, maxAge=0', async () => {
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ success: true, data: { markdown: '# x', metadata: {} } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const wrapped = withFirecrawlScrapeFallback(primaryFails, FALLBACK);
    await wrapped(makeReq());
    assert.equal(body?.skipTlsVerification, false);
    assert.equal(body?.storeInCache, false);
    assert.equal(body?.maxAge, 0);
    assert.deepEqual(body?.formats, ['markdown']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallback: page type sanity — success flag computed from non-empty markdown', async () => {
  mockScrapeFetch('   ');
  try {
    const wrapped = withFirecrawlScrapeFallback(primaryFails, FALLBACK);
    await assert.rejects(() => wrapped(makeReq()), /HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fallback logs: log target is hostname-only — query params/userinfo never emitted', async () => {
  const { fallbackLogTarget } = await import('../src/tools/firecrawlScrapeFallback.js');
  // Secrets can live in the query string or userinfo of a crawl target.
  assert.equal(
    fallbackLogTarget('https://user:secret@example.com/path?q=api-key-value&token=x'),
    'example.com',
  );
  assert.equal(fallbackLogTarget('https://example.com/page?token=abc'), 'example.com');
  assert.equal(fallbackLogTarget('not a url'), '<unparseable-target>');
});
