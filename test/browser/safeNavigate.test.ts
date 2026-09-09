import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page, Request, Route } from 'playwright-core';
import {
  assertPublicNavigationUrl,
  continueIfNavigationSafe,
  installNavigationSsrfGuard,
  safeGoto,
} from '../../src/browser/safeNavigate.js';

type Resolver = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;

function makeRequest(url: string, navigation = true): Request {
  return {
    url: () => url,
    isNavigationRequest: () => navigation,
    resourceType: () => (navigation ? 'document' : 'xhr'),
    headers: () => ({}),
  } as unknown as Request;
}

interface RouteSpy {
  continued: boolean;
  aborted: string | null;
  continueOverrides: Record<string, unknown> | undefined;
}

function makeRoute(request: Request): { route: Route; spy: RouteSpy } {
  const spy: RouteSpy = { continued: false, aborted: null, continueOverrides: undefined };
  const route = {
    request: () => request,
    continue: async (overrides?: Record<string, unknown>) => {
      spy.continued = true;
      spy.continueOverrides = overrides;
    },
    abort: async (code?: string) => {
      spy.aborted = code ?? 'aborted';
    },
    fulfill: async () => {},
  } as unknown as Route;
  return { route, spy };
}

const publicResolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

// ── assertPublicNavigationUrl ────────────────────────────────────────────────

test('assertPublicNavigationUrl allows public http(s) URLs', () => {
  assert.doesNotThrow(() => assertPublicNavigationUrl('https://example.com/page'));
  assert.doesNotThrow(() => assertPublicNavigationUrl('http://example.com/'));
});

test('assertPublicNavigationUrl blocks private/loopback/metadata targets', () => {
  for (const url of [
    'http://127.0.0.1:8080/',
    'http://10.1.2.3/',
    'http://192.168.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://localhost/',
  ]) {
    assert.throws(() => assertPublicNavigationUrl(url), /Blocked|private/, url);
  }
});

test('assertPublicNavigationUrl blocks non-http schemes', () => {
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'chrome://settings',
    'devtools://devtools/bundled',
    'ftp://example.com/',
    'not a url',
  ]) {
    assert.throws(() => assertPublicNavigationUrl(url), Error, url);
  }
});

test('assertPublicNavigationUrl allows benign internal schemes', () => {
  assert.doesNotThrow(() => assertPublicNavigationUrl('about:blank'));
  assert.doesNotThrow(() => assertPublicNavigationUrl('about:srcdoc'));
  assert.doesNotThrow(() => assertPublicNavigationUrl('data:text/html,hello'));
  assert.doesNotThrow(() => assertPublicNavigationUrl('blob:https://example.com/uuid'));
  assert.throws(() => assertPublicNavigationUrl('about:config'));
});

// ── continueIfNavigationSafe ─────────────────────────────────────────────────

test('navigation to public URL continues', async () => {
  const { route, spy } = makeRoute(makeRequest('https://example.com/'));
  await continueIfNavigationSafe(route, makeRequest('https://example.com/'), undefined, {
    resolver: publicResolver,
  });
  assert.equal(spy.continued, true);
  assert.equal(spy.aborted, null);
});

test('redirect to loopback/private/metadata aborts before continue', async () => {
  for (const url of [
    'http://127.0.0.1:9222/json',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://10.0.0.1/',
  ]) {
    const { route, spy } = makeRoute(makeRequest(url));
    await continueIfNavigationSafe(route, makeRequest(url), undefined, {
      resolver: publicResolver,
    });
    assert.equal(spy.continued, false, url);
    assert.equal(spy.aborted, 'blockedbyclient', url);
  }
});

test('non-navigation requests continue unchanged', async () => {
  const { route, spy } = makeRoute(makeRequest('https://example.com/api', false));
  await continueIfNavigationSafe(route, makeRequest('https://example.com/api', false), {
    headers: { 'x-a': 'b' },
  });
  assert.equal(spy.continued, true);
  assert.deepEqual(spy.continueOverrides, { headers: { 'x-a': 'b' } });
});

test('iframe navigation requests are checked', async () => {
  const { route, spy } = makeRoute(makeRequest('http://169.254.169.254/'));
  await continueIfNavigationSafe(route, makeRequest('http://169.254.169.254/'), undefined, {
    resolver: publicResolver,
  });
  assert.equal(spy.continued, false);
  assert.equal(spy.aborted, 'blockedbyclient');
});

test('about:blank / data: / blob: navigations continue', async () => {
  for (const url of ['about:blank', 'data:text/html,hi', 'blob:https://example.com/x']) {
    const { route, spy } = makeRoute(makeRequest(url));
    await continueIfNavigationSafe(route, makeRequest(url));
    assert.equal(spy.continued, true, url);
  }
});

test('file: and javascript: navigations abort with blockedbyclient', async () => {
  for (const url of ['file:///etc/passwd', 'javascript:void(0)']) {
    const { route, spy } = makeRoute(makeRequest(url));
    await continueIfNavigationSafe(route, makeRequest(url));
    assert.equal(spy.continued, false, url);
    assert.equal(spy.aborted, 'blockedbyclient', url);
  }
});

test('malformed navigation URL aborts', async () => {
  const { route, spy } = makeRoute(makeRequest('::::not-a-url'));
  await continueIfNavigationSafe(route, makeRequest('::::not-a-url'));
  assert.equal(spy.continued, false);
  assert.equal(spy.aborted, 'blockedbyclient');
});

test('hostname resolving to private A record aborts', async () => {
  const url = 'http://rebind.example.com/';
  const { route, spy } = makeRoute(makeRequest(url));
  await continueIfNavigationSafe(route, makeRequest(url), undefined, {
    resolver: async () => [{ address: '10.0.0.5', family: 4 }],
  });
  assert.equal(spy.continued, false);
  assert.equal(spy.aborted, 'blockedbyclient');
});

test('mixed public/private DNS answers abort (fail closed)', async () => {
  const url = 'http://mixed.example.com/';
  const { route, spy } = makeRoute(makeRequest(url));
  await continueIfNavigationSafe(route, makeRequest(url), undefined, {
    resolver: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ],
  });
  assert.equal(spy.continued, false);
  assert.equal(spy.aborted, 'blockedbyclient');
});

test('public-only DNS answers continue', async () => {
  const url = 'http://public.example.com/';
  const { route, spy } = makeRoute(makeRequest(url));
  await continueIfNavigationSafe(route, makeRequest(url), undefined, {
    resolver: publicResolver,
  });
  assert.equal(spy.continued, true);
});

test('header overrides pass through on safe continue', async () => {
  const { route, spy } = makeRoute(makeRequest('https://example.com/'));
  await continueIfNavigationSafe(
    route,
    makeRequest('https://example.com/'),
    { headers: { 'x-inject': '1' } },
    { resolver: publicResolver },
  );
  assert.equal(spy.continued, true);
  assert.deepEqual(spy.continueOverrides, { headers: { 'x-inject': '1' } });
});

// ── installNavigationSsrfGuard ───────────────────────────────────────────────

interface ContextSpy {
  contextRoutes: string[];
  unrouted: string[];
  pageRoutes: Map<Page, string[]>;
  pageListeners: ((page: Page) => void)[];
}

function makePageSpy(): ContextSpy {
  return { contextRoutes: [], unrouted: [], pageRoutes: new Map(), pageListeners: [] };
}

function makePage(spy: ContextSpy): Page {
  const page = {} as Page;
  spy.pageRoutes.set(page, []);
  (
    page as unknown as {
      route: (pattern: string) => Promise<void>;
      unroute: (pattern: string) => Promise<void>;
      url: () => string;
    }
  ).route = async (pattern: string) => {
    spy.pageRoutes.get(page)?.push(pattern);
  };
  (
    page as unknown as {
      unroute: (pattern: string) => Promise<void>;
    }
  ).unroute = async (pattern: string) => {
    const routes = spy.pageRoutes.get(page);
    if (routes) {
      const i = routes.indexOf(pattern);
      if (i >= 0) routes.splice(i, 1);
    }
  };
  (page as unknown as { url: () => string }).url = () => 'about:blank';
  return page;
}

function makeContext(spy: ContextSpy, pages: Page[]): { context: BrowserContext; spy: ContextSpy } {
  for (const p of pages) {
    // Re-register pre-made pages under this spy
    if (!spy.pageRoutes.has(p)) spy.pageRoutes.set(p, []);
  }
  const context = {
    route: async (pattern: string) => {
      spy.contextRoutes.push(pattern);
    },
    unroute: async (pattern: string) => {
      spy.unrouted.push(pattern);
    },
    pages: () => pages,
    on: (_event: string, cb: (page: Page) => void) => {
      spy.pageListeners.push(cb);
    },
    off: (_event: string, cb: (page: Page) => void) => {
      const i = spy.pageListeners.indexOf(cb);
      if (i >= 0) spy.pageListeners.splice(i, 1);
    },
  } as unknown as BrowserContext;
  return { context, spy };
}

test('guard installs on context and existing pages, disposer cleans up', async () => {
  const spy = makePageSpy();
  const existing = makePage(spy);
  const { context } = makeContext(spy, [existing]);
  const dispose = await installNavigationSsrfGuard(context, { resolver: publicResolver });
  assert.deepEqual(spy.contextRoutes, ['**/*']);
  assert.deepEqual(spy.pageRoutes.get(existing), ['**/*']);

  await dispose();
  assert.deepEqual(spy.unrouted, ['**/*']);
  assert.deepEqual(spy.pageRoutes.get(existing), []);
});

test('guard covers newly opened pages via page event', async () => {
  const spy = makePageSpy();
  const { context } = makeContext(spy, []);
  const dispose = await installNavigationSsrfGuard(context, { resolver: publicResolver });
  assert.equal(spy.pageListeners.length, 1);
  const newPage = makePage(spy);
  spy.pageListeners[0]?.(newPage);
  assert.deepEqual(spy.pageRoutes.get(newPage), ['**/*']);
  await dispose();
});

test('guard install failure propagates (fail closed)', async () => {
  const context = {
    route: async () => {
      throw new Error('route registration failed');
    },
    pages: () => [],
    on: () => {},
  } as unknown as BrowserContext;
  await assert.rejects(() => installNavigationSsrfGuard(context, { resolver: publicResolver }));
});

// ── safeGoto ─────────────────────────────────────────────────────────────────

function makePageWithGoto(gotoImpl: (url: string, opts?: unknown) => Promise<unknown>): Page {
  return { goto: gotoImpl } as unknown as Page;
}

test('safeGoto blocks private initial URL without touching network', async () => {
  let gotoCalled = 0;
  const page = makePageWithGoto(async () => {
    gotoCalled++;
    return null;
  });
  await assert.rejects(() => safeGoto(page, 'http://169.254.169.254/'), /Blocked|private/);
  assert.equal(gotoCalled, 0);
});

test('safeGoto navigates public URLs and returns response', async () => {
  const sentinel = { status: () => 200 };
  const page = makePageWithGoto(async (url, opts) => {
    assert.equal(url, 'https://example.com/');
    assert.ok(opts);
    return sentinel;
  });
  const res = await safeGoto(page, 'https://example.com/');
  assert.equal(res, sentinel);
});

test('safeGoto maps ERR_BLOCKED_BY_CLIENT to sanitized error', async () => {
  const page = makePageWithGoto(async () => {
    throw new Error('net::ERR_BLOCKED_BY_CLIENT at https://example.com/');
  });
  await assert.rejects(
    () => safeGoto(page, 'https://example.com/'),
    /Blocked navigation to non-public URL/,
  );
});

test('safeGoto passes through non-blocked navigation errors', async () => {
  const page = makePageWithGoto(async () => {
    throw new Error('net::ERR_CONNECTION_REFUSED at https://example.com/');
  });
  await assert.rejects(() => safeGoto(page, 'https://example.com/'), /CONNECTION_REFUSED/);
});
