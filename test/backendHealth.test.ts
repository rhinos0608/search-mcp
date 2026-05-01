import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordOutcome,
  isHealthy,
  isDegraded,
  getHealth,
  reset,
} from '../src/utils/backendHealth.js';

afterEach(() => {
  reset();
});

test('isHealthy returns true for backend with no recorded outcomes', () => {
  assert.equal(isHealthy('duckduckgo'), true);
});

test('isDegraded returns false for backend with no recorded outcomes', () => {
  assert.equal(isDegraded('duckduckgo'), false);
});

test('getHealth returns unknown for backend with no recorded outcomes', () => {
  const health = getHealth('duckduckgo');
  assert.equal(health.status, 'unknown');
  assert.equal(health.errorCount, 0);
  assert.equal(health.errorRate, 0);
});

test('50 successes out of 50 outcomes is healthy', () => {
  for (let i = 0; i < 50; i++) {
    recordOutcome('duckduckgo', 'success');
  }
  assert.equal(isHealthy('duckduckgo'), true);
  assert.equal(isDegraded('duckduckgo'), false);
});

test('11 errors out of 50 outcomes (>20%) is degraded', () => {
  for (let i = 0; i < 39; i++) recordOutcome('searxng', 'success');
  for (let i = 0; i < 11; i++) recordOutcome('searxng', 'error');
  assert.equal(isHealthy('searxng'), false);
  assert.equal(isDegraded('searxng'), true);
});

test('exactly 20% errors (10/50) is not degraded', () => {
  for (let i = 0; i < 40; i++) recordOutcome('brave', 'success');
  for (let i = 0; i < 10; i++) recordOutcome('brave', 'error');
  assert.equal(isHealthy('brave'), true);
  assert.equal(isDegraded('brave'), false);
});

test('recovery hysteresis: 21% degraded, then drops to 10% but does NOT recover until <10%', () => {
  // 11 errors out of 50 = 22% → degraded
  for (let i = 0; i < 39; i++) recordOutcome('exa', 'success');
  for (let i = 0; i < 11; i++) recordOutcome('exa', 'error');
  assert.equal(isDegraded('exa'), true);

  // Slide window: add more successes, pushing out leading errors.
  // We have 11 errors in 50 slots. To get to exactly 5/50 (10%),
  // we need to add 45 successes to slide out the initial 39 successes AND 6 errors.
  for (let i = 0; i < 45; i++) recordOutcome('exa', 'success');
  // Now we have 5 errors out of 50 = 10% — still degraded (hysteresis requires <10%)
  assert.equal(isDegraded('exa'), true);

  // Add one more success to reach 4/50 < 10%
  recordOutcome('exa', 'success');
  assert.equal(isDegraded('exa'), false);
});

test('recovery: after dropping below 10% errors, recovers to healthy', () => {
  // 11 errors out of 50 = 22% → degraded
  for (let i = 0; i < 39; i++) recordOutcome('ollama', 'success');
  for (let i = 0; i < 11; i++) recordOutcome('ollama', 'error');
  assert.equal(isDegraded('ollama'), true);

  // Slide window: push out all errors by adding enough successes to get below 10%
  // Need to push >45 successes to get error rate < 10% in a 50-entry window
  for (let i = 0; i < 50; i++) recordOutcome('ollama', 'success');
  // 11 errors pushed out, only successes remain
  assert.equal(isHealthy('ollama'), true);
  assert.equal(isDegraded('ollama'), false);
});

test('bot_challenge counts as an error outcome', () => {
  for (let i = 0; i < 39; i++) recordOutcome('duckduckgo', 'success');
  for (let i = 0; i < 11; i++) recordOutcome('duckduckgo', 'bot_challenge');
  assert.equal(isDegraded('duckduckgo'), true);
});

test('timeout counts as an error outcome', () => {
  for (let i = 0; i < 39; i++) recordOutcome('brave', 'success');
  for (let i = 0; i < 11; i++) recordOutcome('brave', 'timeout');
  assert.equal(isDegraded('brave'), true);
});

test('single outcome: one success is healthy', () => {
  recordOutcome('searxng', 'success');
  assert.equal(isHealthy('searxng'), true);
});

test('single outcome: one error is degraded (100% error rate exceeds 20% threshold)', () => {
  recordOutcome('exa', 'error');
  assert.equal(isHealthy('exa'), false);
  assert.equal(isDegraded('exa'), true);
});

test('reset clears all backends', () => {
  recordOutcome('duckduckgo', 'error');
  recordOutcome('brave', 'error');
  // 1/1 = 100% error rate > 20% → degraded
  assert.equal(isDegraded('duckduckgo'), true);
  assert.equal(isDegraded('brave'), true);
  reset();
  assert.equal(isDegraded('duckduckgo'), false);
  assert.equal(isDegraded('brave'), false);
});

test('reset clears single backend', () => {
  recordOutcome('backend-a', 'error');
  recordOutcome('backend-b', 'success');
  reset('backend-a');
  assert.equal(isDegraded('backend-a'), false);
  assert.equal(isHealthy('backend-b'), true);
});

test('getHealth returns accurate counts', () => {
  for (let i = 0; i < 40; i++) recordOutcome('test-backend', 'success');
  for (let i = 0; i < 10; i++) recordOutcome('test-backend', 'error');

  const health = getHealth('test-backend');
  assert.equal(health.windowSize, 50);
  assert.equal(health.errorCount, 10);
  assert.ok(health.errorRate > 0.19 && health.errorRate < 0.21);
  assert.equal(health.status, 'healthy');
});

test('multiple backends are independent', () => {
  for (let i = 0; i < 50; i++) recordOutcome('healthy-backend', 'success');
  for (let i = 0; i < 30; i++) recordOutcome('healthy-backend', 'success');
  for (let i = 0; i < 11; i++) recordOutcome('degraded-backend', 'error');

  assert.equal(isHealthy('healthy-backend'), true);
  assert.equal(isDegraded('degraded-backend'), true);
  assert.equal(isHealthy('degraded-backend'), false);
});
