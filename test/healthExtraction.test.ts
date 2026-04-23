import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runHealthProbes } from '../src/health.js';
import { loadConfig, resetConfig } from '../src/config.js';

const CRAWL4AI_ENV_KEYS = ['CRAWL4AI_BASE_URL', 'CRAWL4AI_API_TOKEN'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of CRAWL4AI_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of CRAWL4AI_ENV_KEYS) {
    const prior = saved.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  resetConfig();
});

const originalFetch = globalThis.fetch;

test('health probe marks extraction as healthy when sidecar returns extracted_content', async () => {
  process.env.CRAWL4AI_BASE_URL = 'http://localhost:11235';
  resetConfig();

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        result: {
          url: 'data:text/html,...',
          success: true,
          markdown: 'Test',
          extracted_content: [{ text: 'Test' }],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  const cfg = loadConfig();
  const report = await runHealthProbes(cfg);

  assert.equal(report.tools['web_crawl_extraction']?.status, 'healthy');
});

test('health probe marks extraction as degraded when sidecar lacks extraction support', async () => {
  process.env.CRAWL4AI_BASE_URL = 'http://localhost:11235';
  resetConfig();

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        result: {
          url: 'data:text/html,...',
          success: true,
          markdown: 'Test',
          // No extracted_content
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  const cfg = loadConfig();
  const report = await runHealthProbes(cfg);

  assert.equal(report.tools['web_crawl_extraction']?.status, 'degraded');
  assert.ok(report.tools['web_crawl_extraction']?.remediation?.includes('v0.8.x'));
});
