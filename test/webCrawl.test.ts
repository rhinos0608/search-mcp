import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { webCrawl } from '../src/tools/webCrawl.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMockResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
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

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.ok(result.pages[0]);
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

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.ok(result.pages[0]);
  assert.equal(result.pages[0].markdown, '# Fit');
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

  await webCrawl('https://example.com', 'https://crawl4ai.example.com', 'my-secret-token', defaultOpts);

  assert.ok(capturedHeaders);
  assert.equal(capturedHeaders.get('Authorization'), 'Bearer my-secret-token');
});

// ── Test 9: Deep crawl config sent when maxDepth > 1 ─────────────────────────

test('webCrawl sends deep_crawl_config in request body when maxDepth > 1', async () => {
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
  const body = capturedBody as { crawler_config: { deep_crawl_config: Record<string, unknown> } };
  assert.ok(body.crawler_config.deep_crawl_config);
  assert.equal(body.crawler_config.deep_crawl_config.strategy, 'bfs');
  assert.equal(body.crawler_config.deep_crawl_config.max_depth, 3);
  assert.equal(body.crawler_config.deep_crawl_config.max_pages, 20);
  assert.equal(body.crawler_config.deep_crawl_config.filter_external_links, true);
});
