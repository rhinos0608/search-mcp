import test from 'node:test';
import assert from 'node:assert/strict';
import { webCrawl } from '../../src/tools/webCrawl.js';

test('webCrawl: rejects crawl without sidecar configured', async () => {
  await assert.rejects(
    () =>
      webCrawl('https://example.com', '', '', {
        strategy: 'bfs',
        maxDepth: 1,
        maxPages: 1,
        includeExternalLinks: false,
      }),
    (err: unknown) => {
      assert(err instanceof Error);
      assert(err.message.includes('crawl4ai sidecar is not configured'));
      return true;
    },
  );
});

test('webCrawl: rejects invalid URL', async () => {
  await assert.rejects(() =>
    webCrawl('not-a-url', 'http://crawl4ai:8080', '', {
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 1,
      includeExternalLinks: false,
    }),
  );
});

test('webCrawl: rejects private IP', async () => {
  await assert.rejects(() =>
    webCrawl('http://192.168.1.1', 'http://crawl4ai:8080', '', {
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 1,
      includeExternalLinks: false,
    }),
  );
});

test('webCrawl: rejects localhost', async () => {
  await assert.rejects(() =>
    webCrawl('http://localhost:3000', 'http://crawl4ai:8080', '', {
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 1,
      includeExternalLinks: false,
    }),
  );
});

import { computeCrawlTimeout } from '../../src/tools/webCrawl.js';

test('webCrawl: re-exports computeCrawlTimeout', () => {
  assert.equal(typeof computeCrawlTimeout, 'function');
  assert.equal(computeCrawlTimeout(1), 80_000);
});

test('webCrawl: options shape preserved through chain', async () => {
  // This test verifies the option types are correctly mapped through
  // the middleware chain by testing that invalid options are caught
  // at the SSRF guard (first middleware) before any crawl attempt.

  // Valid options with all fields
  await assert.rejects(
    () =>
      webCrawl('http://169.254.169.254', 'http://crawl4ai:8080', '', {
        strategy: 'bfs',
        maxDepth: 2,
        maxPages: 5,
        includeExternalLinks: true,
        maxBytes: 100000,
        waitFor: 'css:.content',
        delayBeforeReturnHtml: 1.5,
        pageTimeout: 30000,
        jsCode: 'window.scrollTo(0, 100);',
        domainTrust: { enabled: false, trustedDomains: [], blockedDomains: [] },
      }),
    (err: Error) => {
      // SSRF guard should catch this before any crawl attempt
      assert(err.message.includes('Blocked request'));
      return true;
    },
  );
});

test('webCrawl: domain trust silently blocks blocked domains (short-circuit)', async () => {
  // Domain Trust middleware returns null (short-circuit) — no error thrown,
  // instead a successful-but-empty result is returned.
  const result = await webCrawl('https://evil.com/malware', 'http://crawl4ai:8080', '', {
    strategy: 'bfs',
    maxDepth: 1,
    maxPages: 1,
    includeExternalLinks: false,
    domainTrust: { enabled: true, trustedDomains: [], blockedDomains: ['evil.com'] },
  });
  assert.equal(result.totalPages, 0);
  assert.equal(result.pages.length, 0);
  assert.equal(result.seedUrl, 'https://evil.com/malware');
});
