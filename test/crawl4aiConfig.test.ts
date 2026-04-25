import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, resetConfig } from '../src/config.js';
import { DEFAULT_SEMANTIC_MAX_BYTES } from '../src/semanticLimits.js';

const CRAWL4AI_ENV_KEYS = [
  'CRAWL4AI_BASE_URL',
  'CRAWL4AI_API_TOKEN',
  'SEARCH_MCP_CONFIG_KEY',
] as const;

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

test('loadConfig exposes empty crawl4ai fields when no env vars are set', () => {
  const cfg = loadConfig();

  assert.equal(cfg.crawl4ai.baseUrl, '');
  assert.equal(cfg.crawl4ai.apiToken, '');
  assert.equal(cfg.semanticCrawl.defaultMaxBytes, DEFAULT_SEMANTIC_MAX_BYTES);
  assert.equal(cfg.semanticCrawl.maxMaxBytes, DEFAULT_SEMANTIC_MAX_BYTES);
});

test('loadConfig picks up CRAWL4AI_BASE_URL from env', () => {
  process.env.CRAWL4AI_BASE_URL = 'http://localhost:11235';

  const cfg = loadConfig();

  assert.equal(cfg.crawl4ai.baseUrl, 'http://localhost:11235');
  assert.equal(cfg.crawl4ai.apiToken, '');
});

test('loadConfig picks up CRAWL4AI_API_TOKEN from env', () => {
  process.env.CRAWL4AI_API_TOKEN = 'secret-token';

  const cfg = loadConfig();

  assert.equal(cfg.crawl4ai.baseUrl, '');
  assert.equal(cfg.crawl4ai.apiToken, 'secret-token');
});

test('loadConfig picks up both CRAWL4AI_BASE_URL and CRAWL4AI_API_TOKEN from env', () => {
  process.env.CRAWL4AI_BASE_URL = 'http://crawl4ai.internal:11235';
  process.env.CRAWL4AI_API_TOKEN = 'my-api-token';

  const cfg = loadConfig();

  assert.equal(cfg.crawl4ai.baseUrl, 'http://crawl4ai.internal:11235');
  assert.equal(cfg.crawl4ai.apiToken, 'my-api-token');
});

test('loadConfig uses default apiToken when only CRAWL4AI_BASE_URL is set', () => {
  process.env.CRAWL4AI_BASE_URL = 'http://localhost:11235';
  // CRAWL4AI_API_TOKEN is intentionally not set

  const cfg = loadConfig();

  assert.equal(cfg.crawl4ai.baseUrl, 'http://localhost:11235');
  assert.equal(cfg.crawl4ai.apiToken, '', 'apiToken should fall back to default empty string');
});

test('loadConfig accepts empty-string CRAWL4AI_BASE_URL', () => {
  process.env.CRAWL4AI_BASE_URL = '';

  const cfg = loadConfig();

  assert.equal(cfg.crawl4ai.baseUrl, '');
});

test('resetConfig allows crawl4ai config to be re-read from env on next loadConfig', () => {
  const first = loadConfig();
  assert.equal(first.crawl4ai.baseUrl, '');

  process.env.CRAWL4AI_BASE_URL = 'http://after-reset:11235';

  const cachedStill = loadConfig();
  assert.equal(
    cachedStill.crawl4ai.baseUrl,
    '',
    'config should stay cached until resetConfig() is called',
  );

  resetConfig();
  const reloaded = loadConfig();
  assert.equal(reloaded.crawl4ai.baseUrl, 'http://after-reset:11235');
});
