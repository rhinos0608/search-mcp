import test from 'node:test';
import assert from 'node:assert/strict';

import { getDomainAuthority, getSourceBasis, getSourceQuality } from '../src/utils/sourceTier.js';

test('explicit authority scores and bases unchanged', () => {
  assert.equal(getDomainAuthority('openai.com'), 0.75);
  assert.equal(getSourceBasis('openai.com'), 'official company source');
  assert.equal(getSourceQuality('openai.com'), 'high');

  assert.equal(getDomainAuthority('arxiv.org'), 0.9);
  assert.equal(getSourceBasis('arxiv.org'), 'recognized technical authority');
  assert.equal(getSourceQuality('arxiv.org'), 'high');
});

test('existing two-arg callers behave identically', () => {
  // getSourceBasis with only (domain, category) — no content signals.
  assert.equal(getSourceBasis('developer.mozilla.org'), 'recognized technical authority');
  assert.equal(getSourceBasis('nasa.gov'), 'government domain');
  assert.equal(getSourceBasis('someuniversity.edu'), 'academic domain');
  assert.equal(getSourceBasis('stackoverflow.com'), 'recognized technical authority');
});

test('suspicious TLD (.xyz) is downgraded and labeled', () => {
  assert.equal(getDomainAuthority('example.xyz'), 0.15);
  assert.equal(getSourceQuality('example.xyz'), 'low');
  assert.equal(getSourceBasis('example.xyz'), 'suspicious TLD');
});

test('lookalike domain is downgraded and labeled', () => {
  assert.equal(getDomainAuthority('githb.com'), 0.1);
  assert.equal(getSourceQuality('githb.com'), 'low');
  assert.equal(getSourceBasis('githb.com'), 'possible lookalike');
});

test('high-authority suffixes are never downgraded by domain trust', () => {
  assert.equal(getDomainAuthority('nasa.gov'), 0.85);
  assert.equal(getSourceBasis('nasa.gov'), 'government domain');
  assert.equal(getDomainAuthority('stanford.edu'), 0.7);
  assert.equal(getSourceBasis('stanford.edu'), 'academic domain');
});

test('generic domain prior is null without content signals', () => {
  const domain = 'somedomain.com';
  assert.equal(getDomainAuthority(domain), 0.4);
  assert.equal(getSourceQuality(domain), 'low');
  assert.equal(getSourceBasis(domain), null);
});

test('content-aware qualifier labels substantive content', () => {
  const domain = 'somedomain.com';
  assert.equal(getSourceBasis(domain, undefined, { contentKind: 'full' }), 'substantive content');
  assert.equal(
    getSourceBasis(domain, undefined, { contentKind: 'summary' }),
    'substantive content',
  );
  assert.equal(getSourceBasis(domain, undefined, { contentLength: 600 }), 'substantive content');
  assert.equal(
    getSourceBasis(domain, undefined, { contentKind: 'full', contentLength: 60 }),
    'substantive content',
  );
});

test('content-aware qualifier labels thin content', () => {
  const domain = 'somedomain.com';
  assert.equal(getSourceBasis(domain, undefined, { contentLength: 50 }), 'thin content');
  assert.equal(
    getSourceBasis(domain, undefined, { contentKind: 'snippet', contentLength: 40 }),
    'thin content',
  );
});

test('content signals never change the numeric authority score', () => {
  const domain = 'somedomain.com';
  assert.equal(getDomainAuthority(domain), 0.4);
  assert.equal(getSourceBasis(domain, undefined, { contentKind: 'full' }), 'substantive content');
  assert.equal(getDomainAuthority(domain), 0.4);
});

test('content qualifier stays null for mid-length snippet content', () => {
  const domain = 'somedomain.com';
  assert.equal(getSourceBasis(domain, undefined, { contentKind: 'snippet' }), null);
  assert.equal(getSourceBasis(domain, undefined, { contentLength: 250 }), null);
  assert.equal(getSourceBasis(domain, undefined, { contentLength: 500 }), null);
});
