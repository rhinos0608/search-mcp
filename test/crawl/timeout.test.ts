import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCrawlTimeout } from '../../src/crawl/timeout.js';

test('computeCrawlTimeout: base timeout for 1 page', () => {
  const result = computeCrawlTimeout(1);
  // 30_000 + 1 * 15_000 = 45_000
  assert.equal(result, 45_000);
});

test('computeCrawlTimeout: scales with maxPages', () => {
  const result = computeCrawlTimeout(5);
  assert.equal(result, 105_000);
});

test('computeCrawlTimeout: caps at 5 minutes', () => {
  const result = computeCrawlTimeout(20);
  // 30_000 + 20 * 15_000 = 330_000, capped at 300_000
  assert.equal(result, 300_000);
});

test('computeCrawlTimeout: caps for large values', () => {
  const result = computeCrawlTimeout(100);
  assert.equal(result, 300_000);
});

test('computeCrawlTimeout: zero pages', () => {
  const result = computeCrawlTimeout(0);
  assert.equal(result, 30_000);
});
