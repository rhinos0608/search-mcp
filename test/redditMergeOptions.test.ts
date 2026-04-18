import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeRedditClientOptions,
  type RedditClientOptions,
} from '../src/tools/redditClient.js';
import { resetConfig } from '../src/config.js';

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

test('mergeRedditClientOptions passes overrides.auth through without consulting config', () => {
  // Even with partial config (which would normally throw), an explicit auth
  // override is trusted and the helper returns cleanly.
  process.env.REDDIT_CLIENT_ID = 'partial-id';
  resetConfig();

  const overrides: RedditClientOptions = {
    auth: { clientId: 'override-id', clientSecret: 'override-secret' },
  };
  const merged = mergeRedditClientOptions(overrides);

  assert.deepEqual(merged.auth, {
    clientId: 'override-id',
    clientSecret: 'override-secret',
  });
});

test('mergeRedditClientOptions throws VALIDATION_ERROR when config is partial and no auth override is provided', () => {
  process.env.REDDIT_CLIENT_ID = 'only-id';
  resetConfig();

  assert.throws(
    () => mergeRedditClientOptions({}),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const typed = err as { code?: string };
      assert.equal(typed.code, 'VALIDATION_ERROR');
      assert.match(err.message, /partially configured/i);
      return true;
    },
  );
});

test('mergeRedditClientOptions auto-fills auth and userAgent from config when OAuth is enabled and overrides are empty', () => {
  process.env.REDDIT_CLIENT_ID = 'env-id';
  process.env.REDDIT_CLIENT_SECRET = 'env-secret';
  process.env.REDDIT_USER_AGENT = 'node:search-mcp:test (by /u/tester)';
  resetConfig();

  const merged = mergeRedditClientOptions({});

  assert.deepEqual(merged.auth, {
    clientId: 'env-id',
    clientSecret: 'env-secret',
  });
  assert.equal(merged.userAgent, 'node:search-mcp:test (by /u/tester)');
});
