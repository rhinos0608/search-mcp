import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SentryGuardMiddleware,
  DomainTrustMiddleware,
  Crawl4aiClientMiddleware,
  ResponseQualityMiddleware,
  StatsRecorderMiddleware,
} from '../../src/crawl/middlewares.js';
import { resetStats, getStatsSnapshot } from '../../src/crawl/stats.js';
import type { CrawlRequest, CrawlResponse, CrawlContext } from '../../src/crawl/types.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeReq(url = 'https://example.com'): CrawlRequest {
  return {
    url,
    baseUrl: 'http://crawl4ai:8080',
    apiToken: '',
    opts: { strategy: 'bfs', maxDepth: 1, maxPages: 1, includeExternalLinks: false },
    attempt: 1,
  };
}

function makeCtx(req: CrawlRequest): CrawlContext {
  return {
    startTime: Date.now(),
    request: req,
    warnings: [],
    metadata: new Map(),
  };
}

function makeEmptyResp(url = 'https://example.com'): CrawlResponse {
  return {
    result: {
      seedUrl: url,
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 1,
      pages: [],
      totalPages: 0,
      successfulPages: 0,
    },
  };
}

function makePageResp(url = 'https://example.com', totalPages = 1): CrawlResponse {
  return {
    result: {
      seedUrl: url,
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 1,
      pages: [
        {
          url,
          success: true,
          markdown:
            '# Hello World\n\nThis is a test page with meaningful content.\n\nMore text here to ensure quality check passes.',
          title: 'Test',
          description: null,
          links: [],
          statusCode: 200,
          errorMessage: null,
        },
      ],
      totalPages,
      successfulPages: 1,
    },
  };
}

// ── SentryGuardMiddleware ──────────────────────────────────────────────────

test('SentryGuardMiddleware: allows valid HTTPS URL in request', async () => {
  const mw = new SentryGuardMiddleware();
  const req = makeReq('https://example.com');
  const result = await mw.processRequest(req);
  assert.ok(result !== null);
  assert.equal(result.url, 'https://example.com');
});

test('SentryGuardMiddleware: rejects private IP in request', async () => {
  const mw = new SentryGuardMiddleware();
  const req = makeReq('http://192.168.1.1');
  await assert.rejects(() => mw.processRequest(req));
});

test('SentryGuardMiddleware: rejects localhost in request', async () => {
  const mw = new SentryGuardMiddleware();
  const req = makeReq('http://localhost:8080');
  await assert.rejects(() => mw.processRequest(req));
});

test('SentryGuardMiddleware: filters unsafe URLs from response pages', async () => {
  const mw = new SentryGuardMiddleware();
  const resp: CrawlResponse = {
    result: {
      seedUrl: 'https://example.com',
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 1,
      pages: [
        {
          url: 'https://example.com/page1',
          success: true,
          markdown: 'content',
          title: null,
          description: null,
          links: [],
          statusCode: 200,
          errorMessage: null,
        },
        {
          url: 'http://localhost/admin',
          success: true,
          markdown: 'admin',
          title: null,
          description: null,
          links: [],
          statusCode: 200,
          errorMessage: null,
        },
      ],
      totalPages: 2,
      successfulPages: 2,
    },
  };
  const result = await mw.processResponse(resp);
  assert.ok(result !== null);
  assert.equal(result.result.pages.length, 1);
  assert.equal(result.result.pages[0]?.url, 'https://example.com/page1');
});

test('SentryGuardMiddleware: passes through clean response unchanged', async () => {
  const mw = new SentryGuardMiddleware();
  const resp = makePageResp();
  const result = await mw.processResponse(resp);
  assert.ok(result !== null);
  assert.equal(result.result.pages.length, 1);
});

// ── DomainTrustMiddleware ──────────────────────────────────────────────────

test('DomainTrustMiddleware: allows URLs not in blocked list', async () => {
  const mw = new DomainTrustMiddleware({ blockedDomains: ['evil.com'] });
  const req = makeReq('https://example.com');
  const result = await mw.processRequest(req);
  assert.ok(result !== null);
});

test('DomainTrustMiddleware: blocks URLs in blocked domains', async () => {
  const mw = new DomainTrustMiddleware({ blockedDomains: ['evil.com'] });
  const req = makeReq('https://evil.com');
  const result = await mw.processRequest(req);
  assert.equal(result, null);
});

test('DomainTrustMiddleware: blocks subdomains of blocked domains', async () => {
  const mw = new DomainTrustMiddleware({ blockedDomains: ['evil.com'] });
  const req = makeReq('https://sub.evil.com');
  const result = await mw.processRequest(req);
  assert.equal(result, null);
});

test('DomainTrustMiddleware: no-op when no config provided', async () => {
  const mw = new DomainTrustMiddleware();
  const req = makeReq('https://example.com');
  const result = await mw.processRequest(req);
  assert.ok(result !== null);
});

// ── Crawl4aiClientMiddleware ───────────────────────────────────────────────

test('Crawl4aiClientMiddleware: rejects missing baseUrl', async () => {
  const mw = new Crawl4aiClientMiddleware('', '');
  const req = makeReq('https://example.com');
  await assert.rejects(() => mw.processRequest(req));
});

test('Crawl4aiClientMiddleware: accepts valid baseUrl', async () => {
  const mw = new Crawl4aiClientMiddleware('http://crawl4ai:8080', '');
  const req = makeReq('https://example.com');
  const result = await mw.processRequest(req);
  assert.ok(result !== null);
});

test('Crawl4aiClientMiddleware: processResponse always returns resp', async () => {
  const mw = new Crawl4aiClientMiddleware('http://crawl4ai:8080', '');
  const resp = makeEmptyResp();
  const ctx = makeCtx(makeReq());
  const result = await mw.processResponse(resp, ctx);
  assert.ok(result !== null);
  assert.equal(result.result.totalPages, 0);
});

// ── ResponseQualityMiddleware ──────────────────────────────────────────────

test('ResponseQualityMiddleware: empty response passes through', async () => {
  const mw = new ResponseQualityMiddleware();
  const resp = makeEmptyResp();
  const result = await mw.processResponse(resp);
  assert.ok(result !== null);
});

test('ResponseQualityMiddleware: meaningful content passes through', async () => {
  const mw = new ResponseQualityMiddleware();
  const resp = makePageResp();
  const result = await mw.processResponse(resp);
  assert.ok(result !== null);
  assert.equal(result.result.totalPages, 1);
});

test('ResponseQualityMiddleware: adds warning for low quality content', async () => {
  const mw = new ResponseQualityMiddleware();
  const resp: CrawlResponse = {
    result: {
      seedUrl: 'https://example.com',
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 1,
      pages: [
        {
          url: 'https://example.com',
          success: true,
          markdown: 'x',
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
  };
  const result = await mw.processResponse(resp);
  assert.ok(result !== null);
  assert.ok((result.result.warnings?.length ?? 0) > 0);
  assert.ok(result.result.warnings?.[0]?.includes('Low quality'));
});

// ── StatsRecorderMiddleware ────────────────────────────────────────────────

test('StatsRecorderMiddleware: records crawler metrics', async () => {
  resetStats();
  const mw = new StatsRecorderMiddleware();
  const req = makeReq('https://example.com');
  const resp = makePageResp('https://example.com', 3);
  const ctx = makeCtx(req);

  await mw.processResponse(resp, ctx);

  const snap = getStatsSnapshot();
  assert.equal(snap.counters['crawl.pages.total'], 3);
  assert.equal(snap.counters['crawl.pages.successful'], 1);
  assert.equal(snap.counters['crawl.seeds.attempted'], 1);
  assert.ok(snap.histograms['crawl.pages.per_seed'] !== undefined);
});

test('StatsRecorderMiddleware: empty response recorded correctly', async () => {
  resetStats();
  const mw = new StatsRecorderMiddleware();
  const req = makeReq('https://example.com');
  const resp = makeEmptyResp();
  const ctx = makeCtx(req);

  await mw.processResponse(resp, ctx);

  const snap = getStatsSnapshot();
  assert.equal(snap.counters['crawl.pages.total'], 0);
  assert.equal(snap.counters['crawl.pages.successful'], 0);
});
