import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDomainTrust, isBlockedUrl } from '../src/utils/domainTrust.js';
import { filterSafeUrls } from '../src/tools/semanticCrawl.js';

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ['DOMAIN_TRUST_ENABLED', 'TRUSTED_DOMAINS', 'BLOCKED_DOMAINS']) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ['DOMAIN_TRUST_ENABLED', 'TRUSTED_DOMAINS', 'BLOCKED_DOMAINS']) {
    const prior = saved.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
});

test('evaluateDomainTrust trusts established HTTPS domains', () => {
  const trust = evaluateDomainTrust('https://github.com/search-mcp');

  assert.equal(trust.domain, 'github.com');
  assert.equal(trust.tier, 'trusted');
  assert.equal(trust.https, true);
  assert.ok(trust.reasons.includes('trusted_domain'));
});

test('evaluateDomainTrust flags suspicious TLDs and non-HTTPS', () => {
  const trust = evaluateDomainTrust('http://example.xyz/page');

  assert.equal(trust.domain, 'example.xyz');
  assert.equal(trust.tier, 'suspicious');
  assert.equal(trust.https, false);
  assert.ok(trust.reasons.some((reason) => reason.startsWith('suspicious_tld:')));
  assert.ok(trust.reasons.includes('non_https'));
});

test('evaluateDomainTrust blocks obvious lookalikes', () => {
  const trust = evaluateDomainTrust('https://githb.com/login');

  assert.equal(trust.tier, 'blocked');
  assert.equal(trust.lookalikeOf, 'github');
  assert.ok(trust.reasons.some((reason) => reason.startsWith('lookalike:')));
  assert.equal(isBlockedUrl('https://githb.com/login'), true);
});

test('evaluateDomainTrust respects custom blocklists and allowlists', () => {
  const trust = evaluateDomainTrust('https://news.example.com', {
    trustedDomains: ['example.com'],
    blockedDomains: ['news.example.com'],
  });

  assert.equal(trust.tier, 'blocked');
  assert.ok(trust.reasons.includes('explicit_blocklist'));
});

test('filterSafeUrls keeps sources available when trust config is disabled', () => {
  const urls = [
    'https://github.com/search-mcp',
    'https://githb.com/login',
    'http://example.xyz/page',
  ];

  const filtered = filterSafeUrls(urls, { enabled: false, trustedDomains: [], blockedDomains: [] });
  assert.deepEqual(filtered, urls);
});

test('filterSafeUrls drops only blocked URLs when trust config is enabled', () => {
  const urls = [
    'https://github.com/search-mcp',
    'https://githb.com/login',
    'http://example.xyz/page',
  ];

  const filtered = filterSafeUrls(urls, {
    enabled: true,
    trustedDomains: ['example.xyz'],
    blockedDomains: ['githb.com'],
  });

  assert.deepEqual(filtered, ['https://github.com/search-mcp', 'http://example.xyz/page']);
});
