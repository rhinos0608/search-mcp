import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaimCache } from '../../src/research/claimCache.js';
import type { StructuredClaimResult } from '../../src/research/llm/schemas.js';

function makeClaim(i: number): StructuredClaimResult {
  return {
    subject: `Subject ${i}`,
    predicate: 'does something important',
    polarity: 'asserted',
    hedge: 'certain',
    evidenceType: 'claim',
    sourceSpan: `Subject ${i} does something important in the document`,
  };
}

test('ClaimCache evicts the oldest entry in insertion order', () => {
  const cache = createClaimCache({ maxEntries: 2 });

  cache.set('https://a.example', 'alpha', [makeClaim(1)]);
  cache.set('https://b.example', 'beta', [makeClaim(2)]);
  cache.set('https://c.example', 'gamma', [makeClaim(3)]);

  assert.equal(cache.get('https://a.example', 'alpha'), undefined);
  assert.ok(cache.get('https://b.example', 'beta'));
  assert.ok(cache.get('https://c.example', 'gamma'));
});

test('ClaimCache clear removes all entries', () => {
  const cache = createClaimCache();

  cache.set('https://example.com', 'content', [makeClaim(1)]);
  assert.ok(cache.get('https://example.com', 'content'));

  cache.clear();
  assert.equal(cache.get('https://example.com', 'content'), undefined);
  assert.equal(cache.stats().entries, 0);
});
