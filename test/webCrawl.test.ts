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

  assert.equal(result.pages[0]?.markdown, '# Hello');
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

  assert.equal(result.pages[0]?.markdown, '# Fit');
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
  assert.equal(result.pages[0]?.markdown, 'A');
  assert.equal(result.pages[1]?.markdown, 'B');
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
