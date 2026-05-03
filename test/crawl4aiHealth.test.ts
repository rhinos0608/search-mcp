import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, resetConfig } from '../src/config.js';
import { getGatedTools, getNetworkProbes } from '../src/health.js';

const CRAWL4AI_ENV_KEYS = ['CRAWL4AI_BASE_URL', 'CRAWL4AI_API_TOKEN'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of CRAWL4AI_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetConfig();
});

afterEach(() => {
  for (const key of CRAWL4AI_ENV_KEYS) {
    const prior = saved.get(key);
    if (prior === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prior;
    }
  }
  resetConfig();
});

// ── getGatedTools: web_crawl gating ─────────────────────────────────────────

test('getGatedTools does NOT include web_crawl when CRAWL4AI_BASE_URL is set', () => {
  process.env.CRAWL4AI_BASE_URL = 'http://localhost:11235';
  resetConfig();
  const cfg = loadConfig();

  const gated = getGatedTools(cfg);

  assert.ok(
    !gated.has('web_crawl'),
    'web_crawl should NOT be in gated tools when CRAWL4AI_BASE_URL is configured',
  );
});

test('getGatedTools includes web_crawl when CRAWL4AI_BASE_URL is empty', () => {
  // CRAWL4AI_BASE_URL is intentionally not set (deleted in beforeEach)
  const cfg = loadConfig();

  const gated = getGatedTools(cfg);

  assert.ok(
    gated.has('web_crawl'),
    'web_crawl SHOULD be in gated tools when CRAWL4AI_BASE_URL is not configured',
  );
});

// ── getNetworkProbes: crawl4ai probe ─────────────────────────────────────────

// Note: CRAWL4AI does not expose a /health endpoint. It is probed separately
// via probeExtractionSupport against the /crawl API, so it's not included in getNetworkProbes().
test.skip('getNetworkProbes includes a crawl4ai probe when CRAWL4AI_BASE_URL is set', () => {
  process.env.CRAWL4AI_BASE_URL = 'http://localhost:11235';
  resetConfig();
  const cfg = loadConfig();

  const probes = getNetworkProbes(cfg);
  const crawl4aiProbe = probes.find((p) => p.label === 'crawl4ai');

  assert.equal(crawl4aiProbe, undefined, 'getNetworkProbes should NOT return a crawl4ai probe (no /health endpoint)');
});

test('getNetworkProbes does NOT include a crawl4ai probe when CRAWL4AI_BASE_URL is empty', () => {
  // CRAWL4AI_BASE_URL is intentionally not set (deleted in beforeEach)
  const cfg = loadConfig();

  const probes = getNetworkProbes(cfg);
  const crawl4aiProbe = probes.find((p) => p.label === 'crawl4ai');

  assert.equal(
    crawl4aiProbe,
    undefined,
    'getNetworkProbes should NOT return a crawl4ai probe when URL is not configured',
  );
});

// Note: CRAWL4AI does not expose a /health endpoint. It is probed separately
// via probeExtractionSupport against the /crawl API, so it's not included in getNetworkProbes().
test.skip('getNetworkProbes crawl4ai probe URL strips trailing slashes', () => {
  process.env.CRAWL4AI_BASE_URL = 'http://localhost:11235///';
  resetConfig();
  const cfg = loadConfig();

  const probes = getNetworkProbes(cfg);
  const crawl4aiProbe = probes.find((p) => p.label === 'crawl4ai');

  assert.equal(crawl4aiProbe, undefined, 'getNetworkProbes should NOT return a crawl4ai probe (no /health endpoint)');
});
