import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { webCrawl } from '../src/tools/webCrawl.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMockResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

const defaultOpts = {
  strategy: 'bfs' as const,
  maxDepth: 1,
  maxPages: 10,
  includeExternalLinks: false,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── SSRF defense-in-depth: unsafe page URLs are skipped ──────────────────────

test('webCrawl skips pages with localhost URLs', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://example.com', success: true, markdown: 'Safe page' },
        { url: 'http://localhost/admin', success: true, markdown: 'Internal page' },
        { url: 'https://example.com/about', success: true, markdown: 'Another safe page' },
      ],
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.totalPages, 2);
  const urls = result.pages.map((p) => p.url);
  assert.ok(urls.includes('https://example.com'));
  assert.ok(urls.includes('https://example.com/about'));
  assert.ok(!urls.includes('http://localhost/admin'));
});

test('webCrawl skips pages with 127.0.0.1 URLs', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://example.com', success: true, markdown: 'Safe' },
        { url: 'http://127.0.0.1:8080/internal', success: true, markdown: 'Internal' },
      ],
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.totalPages, 1);
  assert.equal(result.pages[0]!.url, 'https://example.com');
});

test('webCrawl skips pages with private IPv4 (10.x) URLs', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://example.com', success: true, markdown: 'Safe' },
        { url: 'http://10.0.0.5/secret', success: true, markdown: 'Private' },
      ],
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.totalPages, 1);
  assert.equal(result.pages[0]!.url, 'https://example.com');
});

test('webCrawl skips pages with private IPv4 (192.168.x) URLs', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://example.com', success: true, markdown: 'Safe' },
        { url: 'http://192.168.1.1/router', success: true, markdown: 'Router' },
      ],
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.totalPages, 1);
  assert.equal(result.pages[0]!.url, 'https://example.com');
});

test('webCrawl skips pages with private IPv4 (172.16-31.x) URLs', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://example.com', success: true, markdown: 'Safe' },
        { url: 'http://172.16.0.1/internal', success: true, markdown: 'Private' },
        { url: 'http://172.31.255.255/internal', success: true, markdown: 'Private' },
      ],
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.totalPages, 1);
  assert.equal(result.pages[0]!.url, 'https://example.com');
});

test('webCrawl skips pages with cloud metadata URLs (169.254.x)', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://example.com', success: true, markdown: 'Safe' },
        { url: 'http://169.254.169.254/latest/meta-data/', success: true, markdown: 'Metadata' },
      ],
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.totalPages, 1);
  assert.equal(result.pages[0]!.url, 'https://example.com');
});

test('webCrawl skips pages with non-http schemes (file://, javascript:, data:)', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://example.com', success: true, markdown: 'Safe' },
        { url: 'file:///etc/passwd', success: true, markdown: 'File' },
        { url: 'javascript:alert(1)', success: true, markdown: 'JS' },
        { url: 'data:text/html,<h1>Hi</h1>', success: true, markdown: 'Data' },
      ],
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.totalPages, 1);
  assert.equal(result.pages[0]!.url, 'https://example.com');
});

test('webCrawl skips pages with invalid URLs', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://example.com', success: true, markdown: 'Safe' },
        { url: 'not-a-valid-url', success: true, markdown: 'Bad' },
      ],
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.totalPages, 1);
  assert.equal(result.pages[0]!.url, 'https://example.com');
});

test('webCrawl does not fail entirely when one page has an unsafe URL', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'http://localhost/evil', success: true, markdown: 'Evil' },
        { url: 'https://example.com', success: true, markdown: 'Safe' },
        { url: 'http://10.0.0.1/internal', success: true, markdown: 'Private' },
        { url: 'https://example.com/page2', success: true, markdown: 'Safe2' },
      ],
    });

  // Should not throw
  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.totalPages, 2);
  const urls = result.pages.map((p) => p.url);
  assert.ok(urls.includes('https://example.com'));
  assert.ok(urls.includes('https://example.com/page2'));
});

test('webCrawl keeps all pages when all URLs are safe', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      results: [
        { url: 'https://example.com', success: true, markdown: 'Page 1' },
        { url: 'https://example.com/page2', success: true, markdown: 'Page 2' },
        { url: 'https://other-site.com', success: true, markdown: 'Page 3' },
      ],
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.totalPages, 3);
});

test('webCrawl single-result response with unsafe URL returns empty pages', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({
      result: { url: 'http://localhost/admin', success: true, markdown: 'Internal' },
    });

  const result = await webCrawl('https://example.com', 'https://crawl4ai.example.com', '', defaultOpts);

  assert.equal(result.totalPages, 0);
  assert.equal(result.successfulPages, 0);
});
