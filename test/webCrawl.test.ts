import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { webCrawl, computeCrawlTimeout } from '../src/tools/webCrawl.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMockResponse(
  body: unknown,
  init?: { status?: number; statusText?: string },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

const defaultOpts = {
  strategy: 'bfs' as const,
  maxDepth: 1,
  maxPages: 10,
  includeExternalLinks: false,
};

// ── Restore fetch after each test ─────────────────────────────────────────────

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Test 1: Missing baseUrl ───────────────────────────────────────────────────

test('webCrawl throws unavailableError when baseUrl is empty', async () => {
  await assert.rejects(
    async () => webCrawl('https://example.com', '', '', defaultOpts),
    (err: unknown) => {
      return err instanceof Error && /not configured/i.test(err.message);
    },
  );
});

// ── Test 2: Markdown string shape ─────────────────────────────────────────────

test('webCrawl returns markdown string unchanged when API returns markdown as a string', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: '# Hello',
      },
    });

  const result = await webCrawl(
    'https://example.com',
    'https://crawl4ai.example.com',
    '',
    defaultOpts,
  );

  assert.ok(result.pages[0]);
  assert.equal(result.successfulPages, 1);
  assert.equal(result.pages[0].success, true);
  assert.equal(result.pages[0].markdown, '# Hello');
});

// ── Test 3: Markdown object shape ─────────────────────────────────────────────

test('webCrawl prefers fit_markdown over raw_markdown when markdown is an object', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: { fit_markdown: '# Fit', raw_markdown: '# Raw' },
      },
    });

  const result = await webCrawl(
    'https://example.com',
    'https://crawl4ai.example.com',
    '',
    defaultOpts,
  );

  assert.ok(result.pages[0]);
  assert.equal(result.pages[0].markdown, '# Fit');
});

test('webCrawl falls back to raw_markdown when fit_markdown is blank', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: { fit_markdown: '', raw_markdown: '# Raw\n\nUseful page content.' },
      },
    });

  const result = await webCrawl(
    'https://example.com',
    'https://crawl4ai.example.com',
    '',
    defaultOpts,
  );

  assert.ok(result.pages[0]);
  assert.equal(result.pages[0].markdown, '# Raw\n\nUseful page content.');
});

test('webCrawl treats contentful pages with omitted success flag as successful', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      result: {
        url: 'https://example.com',
        markdown: '# Content\n\nUseful page content.',
      },
    });

  const result = await webCrawl(
    'https://example.com',
    'https://crawl4ai.example.com',
    '',
    defaultOpts,
  );

  assert.ok(result.pages[0]);
  assert.equal(result.pages[0].success, true);
  assert.equal(result.successfulPages, 1);
});

// ── Test 4: Deep crawl response with results array ────────────────────────────

test('webCrawl handles deep crawl results array and computes totalPages/successfulPages', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://a.com', success: true, markdown: 'A' },
        { url: 'https://b.com', success: true, markdown: 'B' },
      ],
    });

  const result = await webCrawl('https://a.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.totalPages, 2);
  assert.equal(result.successfulPages, 2);
  assert.ok(result.pages[0]);
  assert.equal(result.pages[0].markdown, 'A');
  assert.ok(result.pages[1]);
  assert.equal(result.pages[1].markdown, 'B');
});

// ── Test 5: Unexpected response shape ─────────────────────────────────────────

test('webCrawl throws parseError when API response has neither result nor results', async () => {
  globalThis.fetch = async () => buildMockResponse({});

  await assert.rejects(
    async () => webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts),
    (err: unknown) => {
      return err instanceof Error && /unexpected response shape/i.test(err.message);
    },
  );
});

// ── Test 6: HTTP 503 response ─────────────────────────────────────────────────

test('webCrawl throws unavailableError with Docker container message on HTTP 503', async () => {
  globalThis.fetch = async () =>
    new Response(null, { status: 503, statusText: 'Service Unavailable' });

  await assert.rejects(
    async () => webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts),
    (err: unknown) => {
      return (
        err instanceof Error &&
        /unavailable/i.test(String((err as { code?: string }).code)) &&
        /docker container/i.test(err.message)
      );
    },
  );
});

// ── Test 7: HTTP 500 response ─────────────────────────────────────────────────

test('webCrawl throws networkError on HTTP 500', async () => {
  globalThis.fetch = async () =>
    new Response(null, { status: 500, statusText: 'Internal Server Error' });

  await assert.rejects(
    async () => webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts),
    (err: unknown) => {
      return err instanceof Error && /network/i.test(String((err as { code?: string }).code));
    },
  );
});

// ── Test 8: Auth header set ────────────────────────────────────────────────────

test('webCrawl sets Authorization header when apiToken is non-empty', async () => {
  let capturedHeaders: Headers | undefined;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    capturedHeaders = req.headers;
    return buildMockResponse({
      result: { url: 'https://example.com', success: true, markdown: '# Test' },
    });
  };

  await webCrawl(
    'https://example.com',
    'https://crawl4ai.example.com',
    'my-secret-token',
    defaultOpts,
  );

  assert.ok(capturedHeaders);
  assert.equal(capturedHeaders.get('Authorization'), 'Bearer my-secret-token');
});

// ── Test 9: Deep crawl strategy always sent ─────────────────────────────────

test('webCrawl sends deep_crawl_strategy in request body', async () => {
  let capturedBody: unknown = null;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    capturedBody = JSON.parse(await req.text());
    return buildMockResponse({
      results: [
        { url: 'https://example.com', success: true, markdown: '# Root' },
        { url: 'https://example.com/child', success: true, markdown: '# Child' },
      ],
    });
  };

  const deepOpts = { ...defaultOpts, maxDepth: 3, maxPages: 20, includeExternalLinks: false };
  await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', deepOpts);

  assert.ok(capturedBody);
  const body = capturedBody as {
    browser_config: { type: string; params: Record<string, unknown> };
    crawler_config: {
      type: string;
      params: { deep_crawl_strategy: { type: string; params: Record<string, unknown> } };
    };
  };
  // browser_config uses {type, params} wrapper
  assert.equal(body.browser_config.type, 'BrowserConfig');
  assert.equal(body.browser_config.params.headless, true);
  // crawler_config uses {type, params} wrapper
  assert.equal(body.crawler_config.type, 'CrawlerRunConfig');
  const deepStrategy = body.crawler_config.params.deep_crawl_strategy;
  assert.ok(deepStrategy);
  assert.equal(deepStrategy.type, 'BFSDeepCrawlStrategy');
  assert.equal(deepStrategy.params.max_depth, 3);
  assert.equal(deepStrategy.params.max_pages, 20);
  assert.equal(deepStrategy.params.include_external, false);
});

// ── Test 10: Dynamic content options passthrough ──────────────────────────────

test('webCrawl passes waitFor, delayBeforeReturnHtml, pageTimeout, and jsCode to crawl4ai', async () => {
  let capturedBody: unknown = null;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    capturedBody = JSON.parse(await req.text());
    return buildMockResponse({
      result: { url: 'https://example.com', success: true, markdown: '# Loaded' },
    });
  };

  await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', {
    ...defaultOpts,
    waitFor: 'css:.dynamic-content',
    delayBeforeReturnHtml: 2.5,
    pageTimeout: 120000,
    jsCode: 'window.scrollTo(0, document.body.scrollHeight);',
  });

  assert.ok(capturedBody);
  const body = capturedBody as {
    crawler_config: {
      type: string;
      params: {
        wait_for?: string;
        delay_before_return_html?: number;
        page_timeout?: number;
        js_code?: string;
      };
    };
  };
  assert.equal(body.crawler_config.type, 'CrawlerRunConfig');
  assert.equal(body.crawler_config.params.wait_for, 'css:.dynamic-content');
  assert.equal(body.crawler_config.params.delay_before_return_html, 2.5);
  assert.equal(body.crawler_config.params.page_timeout, 120000);
  assert.equal(body.crawler_config.params.js_code, 'window.scrollTo(0, document.body.scrollHeight);');
});

// ── HTML field threading ──────────────────────────────────────────────────────

test('webCrawl sets html from fit_html when all three HTML fields present', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: '# Hello',
        fit_html: '<html><body><h1>Fit</h1></body></html>',
        cleaned_html: '<html><body><h1>Cleaned</h1></body></html>',
        html: '<html><body><h1>Raw</h1></body></html>',
      },
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);
  assert.ok(result.pages[0]);
  assert.equal(result.pages[0].html, '<html><body><h1>Fit</h1></body></html>');
});

test('webCrawl falls back to cleaned_html when fit_html absent', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: '# Hello',
        cleaned_html: '<html><body><h1>Cleaned</h1></body></html>',
        html: '<html><body><h1>Raw</h1></body></html>',
      },
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);
  assert.ok(result.pages[0]);
  assert.equal(result.pages[0].html, '<html><body><h1>Cleaned</h1></body></html>');
});

test('webCrawl falls back to html when cleaned_html absent', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: '# Hello',
        html: '<html><body><h1>Raw</h1></body></html>',
      },
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);
  assert.ok(result.pages[0]);
  assert.equal(result.pages[0].html, '<html><body><h1>Raw</h1></body></html>');
});

test('webCrawl sets html to undefined when no HTML fields present', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      result: {
        url: 'https://example.com',
        success: true,
        markdown: '# Hello',
      },
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);
  assert.ok(result.pages[0]);
  assert.equal(result.pages[0].html, undefined);
});

// ── Timeout formula ───────────────────────────────────────────────────────────

test('computeCrawlTimeout: 1 page → 45s (30s base + 15s/page)', () => {
  assert.equal(computeCrawlTimeout(1), 45_000);
});

test('computeCrawlTimeout: 10 pages → 180s (30s base + 15s/page)', () => {
  assert.equal(computeCrawlTimeout(10), 180_000);
});

test('computeCrawlTimeout: 25 pages → capped at 300s', () => {
  assert.equal(computeCrawlTimeout(25), 300_000);
});

test('computeCrawlTimeout: 50 pages → capped at 300s', () => {
  assert.equal(computeCrawlTimeout(50), 300_000);
});

// ── Challenge page filtering ────────────────────────────────

test('webCrawl filters out Cloudflare challenge pages and reports count', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://a.com', success: true, markdown: '# Real page\n\nUseful content here.' },
        {
          url: 'https://challenge.com',
          success: true,
          title: 'Just a moment',
          markdown: 'Checking your browser before accessing the site.',
        },
        { url: 'https://b.com', success: true, markdown: '# Another real page' },
      ],
    });

  const result = await webCrawl('https://a.com', 'https://crawl4ai.example.com', '', defaultOpts);

  // Only non-challenge pages should be in the result
  assert.equal(result.pages.length, 2);
  assert.ok(result.pages[0]);
  assert.ok(result.pages[1]);
  assert.equal(result.pages[0]!.url, 'https://a.com');
  assert.equal(result.pages[1]!.url, 'https://b.com');
  // Challenge page should be filtered out
  assert.ok(!result.pages.some((p) => p.url === 'https://challenge.com'));
  // filteredChallenges count should reflect the number removed
  assert.equal(result.filteredChallenges, 1);
});

test('webCrawl sets filteredChallenges to 0 when no challenge pages are present', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://a.com', success: true, markdown: '# Real page' },
        { url: 'https://b.com', success: true, markdown: '# Another real page' },
      ],
    });

  const result = await webCrawl('https://a.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.pages.length, 2);
  assert.equal(result.filteredChallenges, 0);
});

test('webCrawl filters multiple challenge pages in a single crawl', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://a.com', success: true, markdown: '# Real page' },
        { url: 'https://cf.com', success: true, title: 'Attention Required', markdown: 'Cloudflare' },
        { url: 'https://b.com', success: true, markdown: '# Real page 2' },
        { url: 'https://captcha.com', success: true, markdown: 'CAPTCHA verify you are human' },
      ],
    });

  const result = await webCrawl('https://a.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.pages.length, 2);
  assert.ok(!result.pages.some((p) => p.url === 'https://cf.com'));
  assert.ok(!result.pages.some((p) => p.url === 'https://captcha.com'));
  assert.equal(result.filteredChallenges, 2);
});

test('webCrawl handles pages with null title in challenge detection', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        {
          url: 'https://challenge.com',
          success: true,
          title: null,
          markdown: 'access denied checking your browser',
        },
        { url: 'https://real.com', success: true, markdown: '# Real page' },
      ],
    });

  const result = await webCrawl('https://real.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.pages.length, 1);
  assert.ok(result.pages[0]);
  assert.equal(result.pages[0]!.url, 'https://real.com');
  assert.equal(result.filteredChallenges, 1);
});
