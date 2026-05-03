import test from 'node:test';
import assert from 'node:assert/strict';
import { CrawlMiddlewareChain, MiddlewareChainError } from '../../src/crawl/middleware.js';
import { resetStats, getStatsSnapshot } from '../../src/crawl/stats.js';
import type {
  CrawlMiddleware,
  CrawlRequest,
  CrawlResponse,
  CrawlContext,
} from '../../src/crawl/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeReq(url = 'https://example.com'): CrawlRequest {
  return {
    url,
    baseUrl: 'http://crawl4ai:8080',
    apiToken: '',
    opts: {
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 1,
      includeExternalLinks: false,
    },
    attempt: 1,
  };
}

function noopCrawl(req: CrawlRequest): Promise<CrawlResponse> {
  return Promise.resolve({
    result: {
      seedUrl: req.url,
      strategy: req.opts.strategy,
      maxDepth: req.opts.maxDepth,
      maxPages: req.opts.maxPages,
      pages: [],
      totalPages: 0,
      successfulPages: 0,
    },
  });
}

class SpyMiddleware implements CrawlMiddleware {
  readonly name: string;
  readonly priority: number;
  requestCalls: CrawlRequest[] = [];
  responseCalls: { resp: CrawlResponse; ctx: CrawlContext }[] = [];

  constructor(name: string, priority: number) {
    this.name = name;
    this.priority = priority;
  }

  async processRequest(req: CrawlRequest): Promise<CrawlRequest | null> {
    this.requestCalls.push(req);
    return req;
  }

  async processResponse(resp: CrawlResponse, ctx: CrawlContext): Promise<CrawlResponse | null> {
    this.responseCalls.push({ resp, ctx });
    return resp;
  }
}

class BlockMiddleware implements CrawlMiddleware {
  readonly name = 'blocker';
  readonly priority = 300;

  async processRequest(_req: CrawlRequest): Promise<CrawlRequest | null> {
    return null; // Short-circuit
  }
}

class ModRequestMiddleware implements CrawlMiddleware {
  readonly name = 'mod-request';
  readonly priority = 400;

  async processRequest(req: CrawlRequest): Promise<CrawlRequest | null> {
    return { ...req, url: req.url + '/modified' };
  }
}

class ModResponseMiddleware implements CrawlMiddleware {
  readonly name = 'mod-response';
  readonly priority = 600;

  async processResponse(resp: CrawlResponse, _ctx: CrawlContext): Promise<CrawlResponse | null> {
    return {
      ...resp,
      result: { ...resp.result, totalPages: resp.result.totalPages + 10 },
    };
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('CrawlMiddlewareChain: executes middlewares in priority order (request)', async () => {
  const a = new SpyMiddleware('a', 300);
  const b = new SpyMiddleware('b', 100);
  const c = new SpyMiddleware('c', 200);

  const chain = new CrawlMiddlewareChain([a, b, c]);
  await chain.execute('https://test.com', '', '', makeReq('https://test.com').opts, noopCrawl);

  // b (100), c (200), a (300)
  assert.equal(b.requestCalls.length, 1);
  assert.equal(c.requestCalls.length, 1);
  assert.equal(a.requestCalls.length, 1);

  // Check order by seeing their index in the chain's middleware list
  assert.equal(chain.names[0], 'b');
  assert.equal(chain.names[1], 'c');
  assert.equal(chain.names[2], 'a');
});

test('CrawlMiddlewareChain: response phase runs in reverse order', async () => {
  const a = new SpyMiddleware('a', 100);
  const b = new SpyMiddleware('b', 200);
  const c = new SpyMiddleware('c', 300);

  const chain = new CrawlMiddlewareChain([a, b, c]);
  await chain.execute('https://test.com', '', '', makeReq('https://test.com').opts, noopCrawl);

  // Response phase runs reverse: c (300), b (200), a (100)
  assert.equal(c.responseCalls.length, 1);
  assert.equal(b.responseCalls.length, 1);
  assert.equal(a.responseCalls.length, 1);
});

test('CrawlMiddlewareChain: short-circuit with null from request', async () => {
  const blocker = new BlockMiddleware();
  const spy = new SpyMiddleware('spy', 500);

  const chain = new CrawlMiddlewareChain([blocker, spy]);
  const result = await chain.execute(
    'https://test.com',
    '',
    '',
    makeReq('https://test.com').opts,
    noopCrawl,
  );

  // spy should not have been called (blocker short-circuited)
  assert.equal(spy.requestCalls.length, 0);
  assert.equal(result.result.pages.length, 0);
  assert.equal(result.result.totalPages, 0);
});

test('CrawlMiddlewareChain: null from request still returns valid result', async () => {
  const chain = new CrawlMiddlewareChain([new BlockMiddleware()]);
  const result = await chain.execute(
    'https://test.com',
    '',
    '',
    makeReq('https://test.com').opts,
    noopCrawl,
  );

  assert.ok(result.result !== undefined);
  assert.equal(result.result.seedUrl, 'https://test.com');
});

test('CrawlMiddlewareChain: request modifications flow through chain', async () => {
  const mod = new ModRequestMiddleware();
  const spy = new SpyMiddleware('spy', 500);
  let capturedUrl = '';

  const chain = new CrawlMiddlewareChain([mod, spy]);
  await chain.execute('https://test.com', '', '', makeReq('https://test.com').opts, async (req) => {
    capturedUrl = req.url;
    return noopCrawl(req);
  });

  assert.equal(capturedUrl, 'https://test.com/modified');
});

test('CrawlMiddlewareChain: response modifications flow through chain', async () => {
  const mod = new ModResponseMiddleware();
  const chain = new CrawlMiddlewareChain([mod]);
  const result = await chain.execute(
    'https://test.com',
    '',
    '',
    makeReq('https://test.com').opts,
    noopCrawl,
  );

  assert.equal(result.result.totalPages, 10); // 0 + 10 from ModResponseMiddleware
});

test('CrawlMiddlewareChain: add middleware dynamically', async () => {
  const chain = new CrawlMiddlewareChain();
  assert.equal(chain.names.length, 0);

  const a = new SpyMiddleware('a', 100);
  chain.add(a);
  assert.equal(chain.names.length, 1);
  assert.equal(chain.names[0], 'a');
});

test('CrawlMiddlewareChain: remove middleware by name', async () => {
  const a = new SpyMiddleware('a', 100);
  const b = new SpyMiddleware('b', 200);
  const chain = new CrawlMiddlewareChain([a, b]);

  assert.equal(chain.names.length, 2);
  const removed = chain.remove('a');
  assert.equal(removed, true);
  assert.equal(chain.names.length, 1);
  assert.equal(chain.names[0], 'b');
});

test('CrawlMiddlewareChain: remove non-existent returns false', () => {
  const chain = new CrawlMiddlewareChain();
  assert.equal(chain.remove('nope'), false);
});

test('CrawlMiddlewareChain: get middleware by name', () => {
  const a = new SpyMiddleware('a', 100);
  const chain = new CrawlMiddlewareChain([a]);

  const found = chain.get('a');
  assert.ok(found !== undefined);
  assert.equal(found?.name, 'a');

  const notFound = chain.get('nonexistent');
  assert.equal(notFound, undefined);
});

test('CrawlMiddlewareChain: middleware chain error wraps exception', async () => {
  class ErrorMiddleware implements CrawlMiddleware {
    readonly name = 'error-mw';
    readonly priority = 100;

    async processRequest(_req: CrawlRequest): Promise<CrawlRequest | null> {
      throw new Error('something broke');
    }
  }

  const chain = new CrawlMiddlewareChain([new ErrorMiddleware()]);
  await assert.rejects(
    () => chain.execute('https://test.com', '', '', makeReq('https://test.com').opts, noopCrawl),
    (err: unknown) => {
      assert(err instanceof MiddlewareChainError);
      assert.equal(err.middlewareName, 'error-mw');
      assert.equal(err.phase, 'request');
      assert(err.message.includes('something broke'));
      return true;
    },
  );
});

test('CrawlMiddlewareChain: records stats on execution', async () => {
  resetStats();
  const chain = new CrawlMiddlewareChain([new SpyMiddleware('stats-test', 100)]);
  await chain.execute('https://test.com', '', '', makeReq('https://test.com').opts, noopCrawl);

  const snap = getStatsSnapshot();
  assert.equal(snap.counters['chain.executions'], 1);
  assert.ok(snap.histograms['chain.duration_ms'] !== undefined);
  assert.equal(snap.histograms['chain.duration_ms'].count, 1);
});

test('CrawlMiddlewareChain: crawlFn stored in context metadata', async () => {
  let capturedMeta: CrawlContext['metadata'] | undefined;

  class MetaCaptureMiddleware implements CrawlMiddleware {
    readonly name = 'meta-capture';
    readonly priority = 100;

    async processResponse(_resp: CrawlResponse, ctx: CrawlContext): Promise<CrawlResponse | null> {
      capturedMeta = ctx.metadata;
      return _resp;
    }
  }

  const chain = new CrawlMiddlewareChain([new MetaCaptureMiddleware()]);
  await chain.execute('https://test.com', '', '', makeReq('https://test.com').opts, noopCrawl);

  assert.ok(capturedMeta !== undefined);
  assert.ok(capturedMeta.get('crawlFn') !== undefined);
  assert.equal(typeof capturedMeta.get('crawlFn'), 'function');
});
