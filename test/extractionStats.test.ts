import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordOutcome,
  getDomainStats,
  shouldSkipDomain,
  resetStats,
} from '../src/utils/extractionStats.js';

beforeEach(() => {
  resetStats();
});

afterEach(() => {
  resetStats();
});

test('recordOutcome and getDomainStats track success rates', () => {
  recordOutcome({
    url: 'https://good.example.com/page',
    domain: 'good.example.com',
    success: true,
    strategy: 'baseline',
    timestamp: Date.now(),
    chars: 5000,
  });
  recordOutcome({
    url: 'https://good.example.com/page2',
    domain: 'good.example.com',
    success: true,
    strategy: 'baseline',
    timestamp: Date.now(),
    chars: 3000,
  });

  const stats = getDomainStats();
  const goodStats = stats.get('good.example.com');
  assert.equal(goodStats?.total, 2);
  assert.equal(goodStats?.successRate, 1);
});

test('getDomainStats aggregates by domain', () => {
  recordOutcome({
    url: 'https://a.com/1',
    domain: 'a.com',
    success: true,
    strategy: 'baseline',
    timestamp: Date.now(),
    chars: 10,
  });
  recordOutcome({
    url: 'https://b.com/1',
    domain: 'b.com',
    success: false,
    strategy: 'baseline',
    timestamp: Date.now(),
    chars: 10,
  });

  const stats = getDomainStats();
  assert.equal(stats.get('a.com')?.successRate, 1);
  assert.equal(stats.get('b.com')?.successRate, 0);
});

test('shouldSkipDomain returns true below 5% success rate after 5+ attempts', () => {
  // Record 6 failures out of 6 attempts
  for (let i = 0; i < 6; i++) {
    recordOutcome({
      url: `https://bad.example.com/${i}`,
      domain: 'bad.example.com',
      success: false,
      strategy: 'baseline',
      timestamp: Date.now(),
      chars: 0,
    });
  }

  assert.equal(shouldSkipDomain('bad.example.com'), true);
});

test('shouldSkipDomain returns false when below threshold', () => {
  recordOutcome({
    url: 'https://rare.example.com/1',
    domain: 'rare.example.com',
    success: false,
    strategy: 'baseline',
    timestamp: Date.now(),
    chars: 0,
  });
  recordOutcome({
    url: 'https://rare.example.com/2',
    domain: 'rare.example.com',
    success: false,
    strategy: 'baseline',
    timestamp: Date.now(),
    chars: 0,
  });

  assert.equal(shouldSkipDomain('rare.example.com'), false);
});

test('shouldSkipDomain returns false for domains not in stats', () => {
  assert.equal(shouldSkipDomain('unknown.example.com'), false);
});

test('getDomainStats filters by days', () => {
  const now = Date.now();
  recordOutcome({
    url: 'https://old.example.com/1',
    domain: 'old.example.com',
    success: true,
    strategy: 'baseline',
    timestamp: now - 2 * 24 * 60 * 60 * 1000,
    chars: 10,
  });
  recordOutcome({
    url: 'https://old.example.com/2',
    domain: 'old.example.com',
    success: true,
    strategy: 'baseline',
    timestamp: now,
    chars: 10,
  });

  const recent = getDomainStats(1); // last 24 hours
  assert.equal(recent.get('old.example.com')?.total, 1);

  const allTime = getDomainStats();
  assert.equal(allTime.get('old.example.com')?.total, 2);
});

test('resetStats clears all data', () => {
  recordOutcome({
    url: 'https://test.example.com',
    domain: 'test.example.com',
    success: true,
    strategy: 'baseline',
    timestamp: Date.now(),
    chars: 42,
  });

  resetStats();
  assert.equal(shouldSkipDomain('test.example.com'), false);
  assert.equal(getDomainStats().size, 0);
});

test('shouldSkipDomain with mixed success and failure above threshold', () => {
  // 1 success, 5 failures = 16.7% success rate — above 5%
  recordOutcome({
    url: 'https://mixed.example.com/ok',
    domain: 'mixed.example.com',
    success: true,
    strategy: 'baseline',
    timestamp: Date.now(),
    chars: 100,
  });
  for (let i = 0; i < 5; i++) {
    recordOutcome({
      url: `https://mixed.example.com/bad-${i}`,
      domain: 'mixed.example.com',
      success: false,
      strategy: 'baseline',
      timestamp: Date.now(),
      chars: 0,
    });
  }

  assert.equal(shouldSkipDomain('mixed.example.com'), false);
});
