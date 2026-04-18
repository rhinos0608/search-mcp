import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, resetConfig } from '../src/config.js';
import { runHealthProbes, configHealth } from '../src/health.js';
import { getTracker, resetTrackers } from '../src/rateLimit.js';

const REDDIT_ENV_KEYS = ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'] as const;
const originalFetch = globalThis.fetch;
const saved = new Map<string, string | undefined>();

/**
 * Replace network fetch with a stub so `runHealthProbes()` doesn't
 * actually hit github/hn/npm and make these tests hermetic.
 */
function stubNetworkFetch(): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  for (const key of REDDIT_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetConfig();
  resetTrackers();
  stubNetworkFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of REDDIT_ENV_KEYS) {
    const prior = saved.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  resetConfig();
  resetTrackers();
});

test('configHealth lists reddit_comments and reddit_search as healthy free tools', () => {
  const cfg = loadConfig();
  const health = configHealth(cfg);

  assert.ok(health.reddit_search, 'reddit_search should appear in config health');
  assert.ok(health.reddit_comments, 'reddit_comments should appear in config health');
  assert.equal(health.reddit_search?.status, 'healthy');
  assert.equal(health.reddit_comments?.status, 'healthy');
});

test('runHealthProbes: no Reddit OAuth configured is healthy and reports reddit_oauth "not configured"', async () => {
  const cfg = loadConfig();
  const report = await runHealthProbes(cfg);

  assert.equal(report.tools.reddit_search?.status, 'healthy');
  assert.equal(report.tools.reddit_comments?.status, 'healthy');

  const oauth = report.tools.reddit_oauth;
  assert.ok(oauth, 'reddit_oauth entry should be present in the health report');
  assert.equal(oauth.status, 'healthy');
  assert.match(
    oauth.message,
    /not configured/i,
    `reddit_oauth message should mention "not configured"; got: ${oauth.message}`,
  );
  assert.match(
    oauth.message,
    /public/i,
    `reddit_oauth message should note public API is being used; got: ${oauth.message}`,
  );
});

test('runHealthProbes: both Reddit OAuth creds set reports reddit_oauth "configured" and healthy', async () => {
  process.env.REDDIT_CLIENT_ID = 'test-client-id';
  process.env.REDDIT_CLIENT_SECRET = 'test-client-secret';
  resetConfig();
  const cfg = loadConfig();

  const report = await runHealthProbes(cfg);

  const oauth = report.tools.reddit_oauth;
  assert.ok(oauth, 'reddit_oauth entry should be present');
  assert.equal(oauth.status, 'healthy');
  assert.match(oauth.message, /oauth\.reddit\.com/i);
  assert.doesNotMatch(oauth.message, /not configured/i);
  assert.equal(report.tools.reddit_search?.status, 'healthy');
  assert.equal(report.tools.reddit_comments?.status, 'healthy');
});

test('runHealthProbes: partial Reddit OAuth (only CLIENT_ID) reports degraded with remediation', async () => {
  process.env.REDDIT_CLIENT_ID = 'test-client-id';
  resetConfig();
  const cfg = loadConfig();

  const report = await runHealthProbes(cfg);

  const oauth = report.tools.reddit_oauth;
  assert.ok(oauth, 'reddit_oauth entry should be present');
  assert.equal(oauth.status, 'degraded');
  assert.ok(
    typeof oauth.remediation === 'string' && oauth.remediation.length > 0,
    'remediation text should be provided for partial OAuth config',
  );
  assert.match(
    oauth.remediation as string,
    /REDDIT_CLIENT_SECRET/,
    `remediation should mention the missing REDDIT_CLIENT_SECRET; got: ${String(oauth.remediation)}`,
  );
});

test('runHealthProbes: partial Reddit OAuth (only CLIENT_SECRET) reports degraded with remediation', async () => {
  process.env.REDDIT_CLIENT_SECRET = 'test-client-secret';
  resetConfig();
  const cfg = loadConfig();

  const report = await runHealthProbes(cfg);

  const oauth = report.tools.reddit_oauth;
  assert.ok(oauth, 'reddit_oauth entry should be present');
  assert.equal(oauth.status, 'degraded');
  assert.match(
    oauth.remediation as string,
    /REDDIT_CLIENT_ID/,
    `remediation should mention the missing REDDIT_CLIENT_ID; got: ${String(oauth.remediation)}`,
  );
});

test('runHealthProbes: reddit_comments is reported rate_limited when the shared reddit tracker has remaining=0', async () => {
  const cfg = loadConfig();

  // Simulate a prior 429 on the shared reddit tracker — the same tracker
  // reddit_search uses. reddit_comments must surface this too.
  getTracker('reddit').recordLimitHit(60_000);

  const report = await runHealthProbes(cfg);

  assert.equal(report.tools.reddit_search?.status, 'rate_limited');
  assert.equal(
    report.tools.reddit_comments?.status,
    'rate_limited',
    'reddit_comments must be mapped to the shared reddit rate-limit tracker',
  );
});
