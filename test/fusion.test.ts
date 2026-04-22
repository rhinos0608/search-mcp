import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, rrfMerge } from '../src/utils/fusion.js';

// --- normalizeUrl ---

test('normalizeUrl strips tracking params', () => {
  const result = normalizeUrl('https://example.com/article?utm_source=twitter&id=123');
  assert.ok(result.includes('?id=123'), 'Expected id param preserved');
  assert.ok(!result.includes('utm_source'), 'Expected utm param stripped');
});

test('normalizeUrl strips trailing slash and www', () => {
  const result = normalizeUrl('https://www.example.com/path/');
  assert.equal(result, 'https://example.com/path');
});

test('normalizeUrl lower-cases hostname', () => {
  const result = normalizeUrl('https://EXAMPLE.COM/path');
  assert.ok(result.startsWith('https://example.com/'), `Expected lowercase hostname, got ${result}`);
});

test('normalizeUrl returns raw URL on malformed input', () => {
  const result = normalizeUrl('not-a-url');
  assert.equal(result, 'not-a-url');
});

test('normalizeUrl handles root path with trailing slash', () => {
  const result = normalizeUrl('https://www.example.com/');
  assert.equal(result, 'https://example.com');
});

// --- rrfMerge ---

test('rrfMerge with two rankings produces correct RRF scores', () => {
  const rankings = [
    [{ url: 'a' }, { url: 'b' }],
    [{ url: 'b' }, { url: 'c' }],
  ];
  const merged = rrfMerge(rankings as unknown as any[][], { k: 60, keyFn: r => (r as { url: string }).url });
  assert.equal(merged.length, 3, `Expected 3 results, got ${merged.length}`);

  // score(b) = 1/(60+2) + 1/(60+1) = 1/62 + 1/61; score(a) = 1/61; score(c) = 1/62
  const b = merged.find(m => (m.item as { url: string }).url === 'b')!;
  assert.ok(b, 'Expected b in merged results');
  assert.equal(merged[0]!.item.url, 'b', 'Expected b first (highest RRF score)');
  assert.ok(
    Math.abs(b.rrfScore - (1 / 61 + 1 / 62)) < 1e-9,
    `Expected b rrfScore ≈ ${1 / 61 + 1 / 62}, got ${b.rrfScore}`,
  );

  const a = merged.find(m => (m.item as { url: string }).url === 'a')!;
  assert.ok(a, 'Expected a in merged results');
  assert.ok(
    Math.abs(a.rrfScore - 1 / 61) < 1e-9,
    `Expected a rrfScore ≈ ${1 / 61}, got ${a.rrfScore}`,
  );

  const c = merged.find(m => (m.item as { url: string }).url === 'c')!;
  assert.ok(c, 'Expected c in merged results');
  assert.ok(
    Math.abs(c.rrfScore - 1 / 62) < 1e-9,
    `Expected c rrfScore ≈ ${1 / 62}, got ${c.rrfScore}`,
  );
});

test('rrfMerge with one ranking preserves order and scores', () => {
  const rankings = [[{ url: 'x' }, { url: 'y' }]];
  const merged = rrfMerge(rankings as unknown as any[][], { k: 60, keyFn: r => (r as { url: string }).url });
  assert.equal(merged.length, 2, 'Expected 2 results');
  assert.equal((merged[0]!.item as { url: string }).url, 'x');
  assert.equal((merged[1]!.item as { url: string }).url, 'y');

  assert.ok(
    Math.abs(merged[0]!.rrfScore - 1 / 61) < 1e-9,
    `Expected x rrfScore ≈ ${1 / 61}, got ${merged[0]!.rrfScore}`,
  );
  assert.ok(
    Math.abs(merged[1]!.rrfScore - 1 / 62) < 1e-9,
    `Expected y rrfScore ≈ ${1 / 62}, got ${merged[1]!.rrfScore}`,
  );
});

test('rrfMerge with duplicate items deduplicates', () => {
  const rankings = [[{ url: 'a' }], [{ url: 'a' }]];
  const merged = rrfMerge(rankings as unknown as any[][], { k: 60, keyFn: r => (r as { url: string }).url });
  assert.equal(merged.length, 1, `Expected 1 deduped result, got ${merged.length}`);
  assert.ok(
    Math.abs(merged[0]!.rrfScore - 2 / 61) < 1e-9,
    `Expected deduped rrfScore ≈ ${2 / 61}, got ${merged[0]!.rrfScore}`,
  );
});

test('rrfMerge empty rankings returns empty array', () => {
  const merged = rrfMerge([], { k: 60, keyFn: () => 'x' });
  assert.equal(merged.length, 0);
});

test('rrfMerge with one empty ranking returns empty array', () => {
  const merged = rrfMerge([[]], { k: 60, keyFn: () => 'x' });
  assert.equal(merged.length, 0);
});

// --- rrfMerge getId tests ---

test('rrfMerge getId: same ID in two rankings → boosted entry', () => {
  const rankings = [
    [{ id: 'a', url: 'x' }, { id: 'b', url: 'y' }],
    [{ id: 'b', url: 'z' }, { id: 'c', url: 'w' }],
  ];
  const merged = rrfMerge(rankings, {
    k: 60,
    keyFn: r => r.url,
    getId: r => r.id,
  });
  assert.equal(merged.length, 3, `Expected 3 results, got ${merged.length}`);

  // b appears in both rankings with same ID, should have highest score
  // score(b) = 1/(60+2) + 1/(60+1) = 1/62 + 1/61
  const b = merged.find(m => m.item.id === 'b')!;
  assert.ok(b, 'Expected b in merged results');
  assert.equal(merged[0]!.item.id, 'b', 'Expected b first (highest RRF score)');
  assert.ok(
    Math.abs(b.rrfScore - (1 / 61 + 1 / 62)) < 1e-9,
    `Expected b rrfScore ≈ ${1 / 61 + 1 / 62}, got ${b.rrfScore}`,
  );

  const a = merged.find(m => m.item.id === 'a')!;
  assert.ok(a, 'Expected a in merged results');
  assert.ok(
    Math.abs(a.rrfScore - 1 / 61) < 1e-9,
    `Expected a rrfScore ≈ ${1 / 61}, got ${a.rrfScore}`,
  );

  const c = merged.find(m => m.item.id === 'c')!;
  assert.ok(c, 'Expected c in merged results');
  assert.ok(
    Math.abs(c.rrfScore - 1 / 62) < 1e-9,
    `Expected c rrfScore ≈ ${1 / 62}, got ${c.rrfScore}`,
  );
});

test('rrfMerge getId: no match → no cross-source accumulation', () => {
  const rankings = [
    [{ id: 'a', url: 'x' }],
    [{ id: 'b', url: 'y' }],
  ];
  const merged = rrfMerge(rankings, {
    k: 60,
    getId: r => r.id,
  });
  assert.equal(merged.length, 2, `Expected 2 results, got ${merged.length}`);
  assert.ok(merged.some(m => m.item.id === 'a'), 'Expected a present');
  assert.ok(merged.some(m => m.item.id === 'b'), 'Expected b present');
  assert.ok(
    Math.abs(merged.find(m => m.item.id === 'a')!.rrfScore - 1 / 61) < 1e-9,
    'Expected a score 1/61',
  );
  assert.ok(
    Math.abs(merged.find(m => m.item.id === 'b')!.rrfScore - 1 / 61) < 1e-9,
    'Expected b score 1/61',
  );
});

test('rrfMerge getId: collision → last ranking metadata wins', () => {
  const rankings = [
    [{ id: 'b', url: 'first', meta: 'old' }],
    [{ id: 'b', url: 'second', meta: 'new' }],
  ];
  const merged = rrfMerge(rankings, {
    k: 60,
    getId: r => r.id,
  });
  assert.equal(merged.length, 1, `Expected 1 result, got ${merged.length}`);
  // Last ranking's item wins
  assert.equal(merged[0]!.item.meta, 'new', `Expected meta='new', got ${merged[0]!.item.meta}`);
  assert.equal(merged[0]!.item.url, 'second', `Expected url='second', got ${merged[0]!.item.url}`);
  // Score should be sum of both ranks
  assert.ok(
    Math.abs(merged[0]!.rrfScore - (1 / 61 + 1 / 61)) < 1e-9,
    `Expected rrfScore ≈ ${2 / 61}, got ${merged[0]!.rrfScore}`,
  );
});
