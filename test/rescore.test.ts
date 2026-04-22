import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRecencyDecay,
  applyLogTransform,
  minMaxNormalize,
  multiSignalRescore,
} from '../src/utils/rescore.js';

// --- applyRecencyDecay ---

test('applyRecencyDecay: 0 days → 1.0', () => {
  assert.equal(applyRecencyDecay(0, 10), 1.0);
});

test('applyRecencyDecay: half_life → ≈0.368', () => {
  const result = applyRecencyDecay(10, 10);
  assert.ok(Math.abs(result - 0.367879) < 0.001, `Expected ≈0.368, got ${result}`);
});

test('applyRecencyDecay: 3x half_life → ≈0.050', () => {
  const result = applyRecencyDecay(30, 10);
  assert.ok(Math.abs(result - 0.049787) < 0.001, `Expected ≈0.050, got ${result}`);
});

// --- applyLogTransform ---

test('applyLogTransform: 0 → 0', () => {
  assert.equal(applyLogTransform(0), 0);
});

test('applyLogTransform: 100 → ≈4.615', () => {
  const result = applyLogTransform(100);
  assert.ok(Math.abs(result - 4.61512) < 0.001, `Expected ≈4.615, got ${result}`);
});

test('applyLogTransform: negative input clipped to 0', () => {
  assert.equal(applyLogTransform(-5), 0);
});

// --- minMaxNormalize ---

test('minMaxNormalize: [1,2,3] → [0, 0.5, 1.0]', () => {
  const result = minMaxNormalize([1, 2, 3]);
  assert.deepEqual(result, [0, 0.5, 1.0]);
});

test('minMaxNormalize: all equal → all 0', () => {
  const result = minMaxNormalize([5, 5, 5]);
  assert.deepEqual(result, [0, 0, 0]);
});

test('minMaxNormalize: single element → [0]', () => {
  const result = minMaxNormalize([42]);
  assert.deepEqual(result, [0]);
});

test('minMaxNormalize: empty → []', () => {
  const result = minMaxNormalize([]);
  assert.deepEqual(result, []);
});

// --- multiSignalRescore ---

test('multiSignalRescore with homogeneous signals preserves order', () => {
  const items = [
    { item: 'a', rrfScore: 3, signals: { recency: 0.5 } },
    { item: 'b', rrfScore: 2, signals: { recency: 0.5 } },
    { item: 'c', rrfScore: 1, signals: { recency: 0.5 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 0.5, recency: 0.5 }, 10);
  assert.equal(result.length, 3);
  assert.equal(result[0]!.item, 'a');
  assert.equal(result[1]!.item, 'b');
  assert.equal(result[2]!.item, 'c');
});

test('multiSignalRescore with recency bias bubbles up newer items', () => {
  const items = [
    { item: 'old', rrfScore: 3, signals: { recency: 0.2 } },
    { item: 'new', rrfScore: 1, signals: { recency: 1.0 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 0.2, recency: 0.8 }, 10);
  assert.equal(result[0]!.item, 'new');
  assert.equal(result[1]!.item, 'old');
});

test('multiSignalRescore with rrfAnchor:1 → pure RRF', () => {
  const items = [
    { item: 'a', rrfScore: 2, signals: { recency: 0.1 } },
    { item: 'b', rrfScore: 1, signals: { recency: 1.0 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 1.0, recency: 0 }, 10);
  assert.equal(result[0]!.item, 'a');
  assert.equal(result[1]!.item, 'b');
});

test('multiSignalRescore respects limit', () => {
  const items = [
    { item: 'a', rrfScore: 3, signals: {} },
    { item: 'b', rrfScore: 2, signals: {} },
    { item: 'c', rrfScore: 1, signals: {} },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 1.0 }, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.item, 'a');
  assert.equal(result[1]!.item, 'b');
});

test('multiSignalRescore single item', () => {
  const items = [{ item: 'only', rrfScore: 5, signals: { recency: 0.5 } }];
  const result = multiSignalRescore(items, { rrfAnchor: 0.5, recency: 0.5 }, 10);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.item, 'only');
  assert.equal(result[0]!.combinedScore, 0.25);
  assert.equal(result[0]!.breakdown.rrfAnchor, 0);
});

test('multiSignalRescore all equal signals → stable sort', () => {
  const items = [
    { item: 'first', rrfScore: 1, signals: { recency: 0.5 } },
    { item: 'second', rrfScore: 1, signals: { recency: 0.5 } },
    { item: 'third', rrfScore: 1, signals: { recency: 0.5 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 0.5, recency: 0.5 }, 10);
  assert.equal(result[0]!.item, 'first');
  assert.equal(result[1]!.item, 'second');
  assert.equal(result[2]!.item, 'third');
});
