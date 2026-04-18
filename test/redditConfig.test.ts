import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, resetConfig } from '../src/config.js';

const REDDIT_ENV_KEYS = [
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'REDDIT_USER_AGENT',
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of REDDIT_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetConfig();
});

afterEach(() => {
  for (const key of REDDIT_ENV_KEYS) {
    const prior = saved.get(key);
    if (prior === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prior;
    }
  }
  resetConfig();
});

test('loadConfig exposes empty reddit fields and oauthEnabled=false when nothing is configured', () => {
  const cfg = loadConfig();

  assert.equal(cfg.reddit.clientId, '');
  assert.equal(cfg.reddit.clientSecret, '');
  assert.equal(cfg.reddit.userAgent, '');
  assert.equal(cfg.reddit.oauthEnabled, false);
  assert.equal(cfg.reddit.oauthConfigValid, true);
});

test('loadConfig marks oauthEnabled=true and oauthConfigValid=true when both reddit OAuth creds are set via env', () => {
  process.env.REDDIT_CLIENT_ID = 'test-client-id';
  process.env.REDDIT_CLIENT_SECRET = 'test-client-secret';
  process.env.REDDIT_USER_AGENT = 'node:search-mcp:0.1.0 (by /u/tester)';

  const cfg = loadConfig();

  assert.equal(cfg.reddit.clientId, 'test-client-id');
  assert.equal(cfg.reddit.clientSecret, 'test-client-secret');
  assert.equal(cfg.reddit.userAgent, 'node:search-mcp:0.1.0 (by /u/tester)');
  assert.equal(cfg.reddit.oauthEnabled, true);
  assert.equal(cfg.reddit.oauthConfigValid, true);
});

test('loadConfig marks oauthEnabled=false and oauthConfigValid=false when only REDDIT_CLIENT_ID is set', () => {
  process.env.REDDIT_CLIENT_ID = 'test-client-id';

  const cfg = loadConfig();

  assert.equal(cfg.reddit.clientId, 'test-client-id');
  assert.equal(cfg.reddit.clientSecret, '');
  assert.equal(cfg.reddit.oauthEnabled, false);
  assert.equal(cfg.reddit.oauthConfigValid, false);
});

test('loadConfig marks oauthEnabled=false and oauthConfigValid=false when only REDDIT_CLIENT_SECRET is set', () => {
  process.env.REDDIT_CLIENT_SECRET = 'test-client-secret';

  const cfg = loadConfig();

  assert.equal(cfg.reddit.clientId, '');
  assert.equal(cfg.reddit.clientSecret, 'test-client-secret');
  assert.equal(cfg.reddit.oauthEnabled, false);
  assert.equal(cfg.reddit.oauthConfigValid, false);
});

test('loadConfig treats whitespace-only REDDIT_CLIENT_ID as empty (misquoted .env regression)', () => {
  process.env.REDDIT_CLIENT_ID = '   ';
  process.env.REDDIT_CLIENT_SECRET = '';

  const cfg = loadConfig();

  // Whitespace-only values should be trimmed to empty, so OAuth is simply
  // unset — not "partial" config.
  assert.equal(cfg.reddit.clientId, '');
  assert.equal(cfg.reddit.clientSecret, '');
  assert.equal(cfg.reddit.oauthEnabled, false);
  assert.equal(cfg.reddit.oauthConfigValid, true);
});

test('loadConfig trims surrounding whitespace on reddit OAuth credentials and user agent', () => {
  process.env.REDDIT_CLIENT_ID = '  real-id  ';
  process.env.REDDIT_CLIENT_SECRET = '  real-secret  ';
  process.env.REDDIT_USER_AGENT = '  node:search-mcp:0.1.0 (by /u/tester)  ';

  const cfg = loadConfig();

  assert.equal(cfg.reddit.clientId, 'real-id');
  assert.equal(cfg.reddit.clientSecret, 'real-secret');
  assert.equal(cfg.reddit.userAgent, 'node:search-mcp:0.1.0 (by /u/tester)');
  assert.equal(cfg.reddit.oauthEnabled, true);
  assert.equal(cfg.reddit.oauthConfigValid, true);
});

test('resetConfig allows the reddit OAuth config to be re-read from env on the next loadConfig', () => {
  const first = loadConfig();
  assert.equal(first.reddit.oauthEnabled, false);

  process.env.REDDIT_CLIENT_ID = 'after-reset-client';
  process.env.REDDIT_CLIENT_SECRET = 'after-reset-secret';

  const cachedStill = loadConfig();
  assert.equal(
    cachedStill.reddit.oauthEnabled,
    false,
    'config should stay cached until resetConfig() is called',
  );

  resetConfig();
  const reloaded = loadConfig();
  assert.equal(reloaded.reddit.oauthEnabled, true);
  assert.equal(reloaded.reddit.clientId, 'after-reset-client');
  assert.equal(reloaded.reddit.clientSecret, 'after-reset-secret');
});
