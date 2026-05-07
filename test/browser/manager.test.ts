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
