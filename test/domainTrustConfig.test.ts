import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resetConfig } from '../src/config.js';

const ENV_KEYS = ['DOMAIN_TRUST_ENABLED', 'TRUSTED_DOMAINS', 'BLOCKED_DOMAINS'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetConfig();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prior = saved.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  resetConfig();
});

test('domain trust config defaults to disabled and empty lists', () => {
  const cfg = loadConfig();

  assert.equal(cfg.domainTrust.enabled, false);
  assert.deepEqual(cfg.domainTrust.trustedDomains, []);
  assert.deepEqual(cfg.domainTrust.blockedDomains, []);
});

test('domain trust config reads env vars and stays opt-in', () => {
  process.env.DOMAIN_TRUST_ENABLED = 'true';
  process.env.TRUSTED_DOMAINS = 'example.com, docs.example.org';
  process.env.BLOCKED_DOMAINS = 'bad.example.net,tracker.example.net';
  resetConfig();

  const cfg = loadConfig();

  assert.equal(cfg.domainTrust.enabled, true);
  assert.deepEqual(cfg.domainTrust.trustedDomains, ['example.com', 'docs.example.org']);
  assert.deepEqual(cfg.domainTrust.blockedDomains, ['bad.example.net', 'tracker.example.net']);
});
