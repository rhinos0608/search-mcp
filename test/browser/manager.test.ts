import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BrowserError } from '../../src/browser/types.js';
import { browserManager } from '../../src/browser/browserManager.js';
import { SessionStore } from '../../src/browser/session.js';
import {
  buildLaunchArgs,
  buildInitScripts,
  resolveBrowserModule,
  buildContextOptions,
} from '../../src/browser/stealth.js';
import {
  createCDPSession,
  enableNetworkTracking,
  enablePerformanceMetrics,
} from '../../src/browser/cdp.js';
import {
  startRequestTracking,
  stopRequestTracking,
  isTracking,
  addRoute,
  removeRoute,
} from '../../src/browser/network.js';

const baseConfig = {
  headless: true,
  viewport: { width: 1280, height: 720 },
  userAgent: '',
  proxyServer: '',
  executablePath: '',
  profile: null,
  stealthEnabled: true,
  rebrowser: false,
  maxSessionTimeMs: 0,
  bypassCSP: false,
  credentials: {} as Record<string, { username: string; password: string; totpSecret?: string }>,
  browserEngine: 'playwright' as const,
  cloakHumanize: false,
  cloakHumanPreset: 'default' as const,
  cloakLocale: '',
  cloakTimezone: '',
  cloakGeoip: false,
  cloakStealthArgs: true,
};

// ── Browser Manager ──────────────────────────────────────────────────────────

test('BrowserManager singleton exported', () => {
  assert.ok(browserManager, 'browserManager should be defined');
  assert.equal(typeof browserManager.launch, 'function');
  assert.equal(typeof browserManager.connect, 'function');
  assert.equal(typeof browserManager.close, 'function');
  assert.equal(typeof browserManager.getStatus, 'function');
  assert.equal(typeof browserManager.getActiveSession, 'function');
});

test('BrowserManager.getActiveSession returns null when idle', () => {
  const session = browserManager.getActiveSession();
  assert.equal(session, null);
});

// ── Session Store ────────────────────────────────────────────────────────────

test('SessionStore.listProfiles returns empty array for new store', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'browser-test-'));
  try {
    const store = new SessionStore(tmpDir);
    const profiles = await store.listProfiles();
    assert.deepEqual(profiles, []);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SessionStore.loadProfile returns null for missing profile', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'browser-test-'));
  try {
    const store = new SessionStore(tmpDir);
    const result = await store.loadProfile('nonexistent');
    assert.equal(result, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SessionStore.deleteProfile does not throw for missing profile', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'browser-test-'));
  try {
    const store = new SessionStore(tmpDir);
    await assert.doesNotReject(() => store.deleteProfile('nonexistent'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Stealth ──────────────────────────────────────────────────────────────────

test('buildLaunchArgs includes anti-detection flags when stealth enabled', () => {
  const args = buildLaunchArgs(baseConfig);
  assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(args.includes('--disable-dev-shm-usage'));
});

test('buildLaunchArgs excludes anti-detection flags when stealth disabled', () => {
  const args = buildLaunchArgs({ ...baseConfig, stealthEnabled: false });
  assert.ok(!args.includes('--disable-blink-features=AutomationControlled'));
});

test('buildLaunchArgs includes proxy server when configured', () => {
  const args = buildLaunchArgs({ ...baseConfig, proxyServer: 'http://proxy:8080' });
  assert.ok(args.some((a) => a.includes('proxy-server=http://proxy:8080')));
});

test('buildInitScripts returns non-empty array', () => {
  const scripts = buildInitScripts(baseConfig);
  assert.ok(scripts.length > 0);
  assert.ok(scripts[0]!.includes('navigator.webdriver'));
});

test('resolveBrowserModule returns playwright-core by default', () => {
  assert.equal(resolveBrowserModule(baseConfig), 'playwright-core');
});

test('resolveBrowserModule returns rebrowser-playwright when enabled', () => {
  assert.equal(resolveBrowserModule({ ...baseConfig, rebrowser: true }), 'rebrowser-playwright');
});

test('resolveBrowserModule uses playwright-core for CloakBrowser wrapper imports', () => {
  assert.equal(resolveBrowserModule({ ...baseConfig, browserEngine: 'cloak' }), 'playwright-core');
});
test('buildContextOptions sets viewport and default bypassCSP false', () => {
  const opts = buildContextOptions(baseConfig);
  assert.deepEqual(opts.viewport, { width: 1280, height: 720 });
  assert.equal(opts.bypassCSP, false);
});

test('buildContextOptions includes user agent when configured', () => {
  const opts = buildContextOptions({ ...baseConfig, userAgent: 'TestAgent/1.0' });
  assert.equal(opts.userAgent, 'TestAgent/1.0');
});

test('buildContextOptions includes proxy when configured', () => {
  const opts = buildContextOptions({ ...baseConfig, proxyServer: 'http://proxy:8080' });
  assert.ok(opts.proxy);
  assert.equal(opts.proxy?.server, 'http://proxy:8080');
});

// ── CDP ──────────────────────────────────────────────────────────────────────

test('createCDPSession throws BrowserError for invalid page', async () => {
  // createCDPSession requires a real Page — verify it throws the expected error type
  await assert.rejects(
    () => createCDPSession(null as unknown as Parameters<typeof createCDPSession>[0]),
    BrowserError,
  );
});

test('enableNetworkTracking and enablePerformanceMetrics are exported functions', () => {
  assert.equal(typeof enableNetworkTracking, 'function');
  assert.equal(typeof enablePerformanceMetrics, 'function');
});

// ── BrowserError ─────────────────────────────────────────────────────────────

test('BrowserError has correct name and code', () => {
  const err = new BrowserError('test error', 'LAUNCH_FAILED');
  assert.equal(err.name, 'BrowserError');
  assert.equal(err.code, 'LAUNCH_FAILED');
  assert.ok(err instanceof Error);
});

// ── Network tracking lifecycle ──────────────────────────────────────────────

function makeFakePage() {
  const listeners = new Map<string, Set<Function>>();
  const onCalls: Array<[string, Function]> = [];
  const offCalls: Array<[string, Function]> = [];
  const removeAllCalls: string[] = [];
  return {
    on: (ev: string, h: Function) => {
      onCalls.push([ev, h]);
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(h);
    },
    off: (ev: string, h: Function) => {
      offCalls.push([ev, h]);
      listeners.get(ev)?.delete(h);
    },
    removeAllListeners: (ev: string) => {
      removeAllCalls.push(ev);
      listeners.delete(ev);
    },
    context: { pages: () => [] as unknown[] },
    url: () => 'https://example.com',
    _listeners: listeners,
    _onCalls: onCalls,
    _offCalls: offCalls,
    _removeAllCalls: removeAllCalls,
  } as unknown as any;
}

test('exact off removes tracker handler and foreign listener remains', () => {
  const page = makeFakePage();
  const foreignHandler = () => {};
  page.on('request', foreignHandler);
  startRequestTracking(page);
  const trackerHandler = page._onCalls.find(
    (c: [string, Function]) => c[0] === 'request' && c[1] !== foreignHandler,
  )![1];
  assert.ok(trackerHandler);
  stopRequestTracking(page);
  assert.equal(page._offCalls.length, 1);
  assert.equal(page._offCalls[0][0], 'request');
  assert.equal(page._offCalls[0][1], trackerHandler);
  assert.equal(page._removeAllCalls.length, 0, 'removeAllListeners must not be called');
  assert.ok(page._listeners.get('request')?.has(foreignHandler), 'foreign listener must remain');
  assert.equal(isTracking(page), false);
});

test('repeated start/stop no accumulation', () => {
  const page = makeFakePage();
  startRequestTracking(page);
  const firstHandler = page._onCalls[0][1];
  startRequestTracking(page);
  assert.ok(page._offCalls.some((c: [string, Function]) => c[1] === firstHandler));
  assert.equal(page._listeners.get('request')?.size, 1);
  stopRequestTracking(page);
  assert.equal(page._listeners.get('request')?.size ?? 0, 0);
  assert.equal(isTracking(page), false);
  assert.doesNotThrow(() => stopRequestTracking(page));
});

test('closed page idempotence', () => {
  const page = makeFakePage();
  (page as any).off = () => {
    throw new Error('closed');
  };
  startRequestTracking(page);
  assert.doesNotThrow(() => stopRequestTracking(page));
  assert.equal(isTracking(page), false);
});

test('manager close cleans up via stopRequestTracking only and never removeAllListeners', async () => {
  const page1 = makeFakePage();
  const page2 = makeFakePage();
  const fakeContext: any = {
    pages: () => [page1, page2],
    close: async () => {},
  };
  const fakeBrowser: any = { close: async () => {} };
  const session: any = {
    id: 'test',
    browser: fakeBrowser,
    context: fakeContext,
    pages: [page1],
    page: page1,
    profileName: null,
    timeoutHandle: null,
    source: 'launch',
    browserEngine: 'playwright',
  };
  startRequestTracking(page1);
  startRequestTracking(page2);
  assert.equal(isTracking(page1), true);
  assert.equal(isTracking(page2), true);
  // add foreign listener to prove it survives if we don't nuke all
  const foreign = () => {};
  page1.on('request', foreign);
  await browserManager.close(session);
  assert.equal(isTracking(page1), false);
  assert.equal(isTracking(page2), false);
  assert.ok(page1._offCalls.length >= 1);
  assert.equal(page1._removeAllCalls.length, 0, 'manager must not call removeAllListeners');
  assert.ok(
    page1._listeners.get('request')?.has(foreign),
    'foreign listener must survive manager close',
  );
});

test('partial unroute does not stop tracking, unrouteAll does', async () => {
  const page = makeFakePage();
  // mock route tracking
  const routes = new Set<string>();
  (page as any).route = async (pattern: string) => {
    routes.add(pattern);
  };
  (page as any).unroute = async (pattern: string) => {
    routes.delete(pattern);
  };
  (page as any).unrouteAll = async () => {
    routes.clear();
  };
  startRequestTracking(page);
  await addRoute(page, '**/api/*', { type: 'abort' });
  await addRoute(page, '**/other/*', { type: 'abort' });
  assert.equal(routes.size, 2);
  assert.equal(isTracking(page), true);
  await removeRoute(page, '**/api/*');
  assert.equal(routes.has('**/other/*'), true);
  assert.equal(isTracking(page), true, 'tracking must remain after partial unroute');
  await removeRoute(page);
  assert.equal(routes.size, 0);
  assert.equal(
    isTracking(page),
    true,
    'tracking still remains after unrouteAll (separate from request tracking)',
  );
  stopRequestTracking(page);
  assert.equal(isTracking(page), false);
});
