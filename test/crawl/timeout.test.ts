import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCrawlTimeout } from '../../src/crawl/timeout.js';

test('computeCrawlTimeout: base timeout for 1 page', () => {
  const result = computeCrawlTimeout(1);
  // 60_000 + 1 * 20_000 = 80_000
  assert.equal(result, 80_000);
});

test('computeCrawlTimeout: scales with maxPages', () => {
  const result = computeCrawlTimeout(5);
  assert.equal(result, 160_000);
});

test('computeCrawlTimeout: caps at 5 minutes', () => {
  const result = computeCrawlTimeout(20);
  // 60_000 + 20 * 20_000 = 460_000, capped at 300_000
  assert.equal(result, 300_000);
});

test('computeCrawlTimeout: caps for large values', () => {
  const result = computeCrawlTimeout(100);
  assert.equal(result, 300_000);
});

test('computeCrawlTimeout: zero pages', () => {
  const result = computeCrawlTimeout(0);
  assert.equal(result, 60_000);
});
