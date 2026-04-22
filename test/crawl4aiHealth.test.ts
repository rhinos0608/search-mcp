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

test('getNetworkProbes includes a crawl4ai probe when CRAWL4AI_BASE_URL is set', () => {
  process.env.CRAWL4AI_BASE_URL = 'http://localhost:11235';
  resetConfig();
  const cfg = loadConfig();

  const probes = getNetworkProbes(cfg);
  const crawl4aiProbe = probes.find((p) => p.label === 'crawl4ai');

  assert.ok(crawl4aiProbe, 'getNetworkProbes should return a crawl4ai probe when URL is configured');
  assert.ok(
    crawl4aiProbe.url.includes('/health'),
    `probe URL should end with /health; got: ${crawl4aiProbe.url}`,
  );
  assert.ok(
    crawl4aiProbe.tools.includes('web_crawl'),
    'crawl4ai probe should list web_crawl as an affected tool',
  );
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

test('getNetworkProbes crawl4ai probe URL strips trailing slashes', () => {
  process.env.CRAWL4AI_BASE_URL = 'http://localhost:11235///';
  resetConfig();
  const cfg = loadConfig();

  const probes = getNetworkProbes(cfg);
  const crawl4aiProbe = probes.find((p) => p.label === 'crawl4ai');

  assert.ok(crawl4aiProbe, 'crawl4ai probe should be present');
  assert.equal(
    crawl4aiProbe.url,
    'http://localhost:11235/health',
    'probe URL should strip trailing slashes before appending /health',
  );
});
