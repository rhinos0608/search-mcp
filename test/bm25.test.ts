import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBm25Index } from '../src/utils/bm25.js';

// --- empty corpus ---

test('empty corpus: search returns empty array', () => {
  const idx = buildBm25Index([]);
  const results = idx.search('anything');
  assert.deepEqual(results, []);
});

// --- query with no matches ---

test('query with no matches returns empty array', () => {
  const idx = buildBm25Index([
    { id: 'a', text: 'the quick brown fox' },
    { id: 'b', text: 'jumps over the lazy dog' },
  ]);
  const results = idx.search('zzzyyyxxx');
  assert.deepEqual(results, []);
});

// --- ranking: more occurrences → higher score ---

test('ranking: doc with more query-term occurrences ranks higher', () => {
  const idx = buildBm25Index([
    { id: 'few', text: 'cat sat' },
    { id: 'many', text: 'cat cat cat sat on the mat with another cat' },
  ]);
  const results = idx.search('cat');
  assert.equal(results.length, 2);
  assert.equal(results[0]!.id, 'many', `Expected 'many' to rank first, got '${results[0]!.id}'`);
});

// --- exact match ranks above unrelated ---

test('exact match ranks above unrelated doc', () => {
  const idx = buildBm25Index([
    { id: 'unrelated', text: 'banana bread recipe' },
    { id: 'exact', text: 'machine learning neural networks' },
  ]);
  const results = idx.search('machine learning');
  assert.ok(results.length > 0, 'Expected at least one result');
  assert.equal(results[0]!.id, 'exact', `Expected 'exact' to rank first, got '${results[0]!.id}'`);
});

// --- TF saturation ---

test('TF saturation: doubling term count does not double the score', () => {
  const baseText = 'dog '.repeat(10);
  const doubleText = 'dog '.repeat(20);
  const idx = buildBm25Index([
    { id: 'base', text: baseText },
    { id: 'double', text: doubleText },
  ]);
  const results = idx.search('dog');
  const baseResult = results.find(r => r.id === 'base')!;
  const doubleResult = results.find(r => r.id === 'double')!;
  assert.ok(baseResult, 'Expected base doc in results');
  assert.ok(doubleResult, 'Expected double doc in results');
  // double has more occurrences so it should score higher, but not 2x more
  assert.ok(
    doubleResult.score > baseResult.score,
    `Expected double (${doubleResult.score}) > base (${baseResult.score})`,
  );
  assert.ok(
    doubleResult.score < 2 * baseResult.score,
    `Expected TF saturation: double (${doubleResult.score}) < 2 * base (${baseResult.score})`,
  );
});

// --- topK limits results ---

test('topK limits the number of returned results', () => {
  const docs = Array.from({ length: 10 }, (_, i) => ({
    id: `doc${i}`,
    text: `word${i} common common common`,
  }));
  const idx = buildBm25Index(docs);
  const results = idx.search('common', 3);
  assert.equal(results.length, 3, `Expected 3 results with topK=3, got ${results.length}`);
});

test('topK defaults to returning all matching docs when not specified', () => {
  const docs = Array.from({ length: 5 }, (_, i) => ({
    id: `doc${i}`,
    text: `token${i} shared`,
  }));
  const idx = buildBm25Index(docs);
  const results = idx.search('shared');
  assert.equal(results.length, 5, `Expected 5 results (all docs match), got ${results.length}`);
});

// --- score sanity ---

test('scores are finite numbers (not NaN or Infinity)', () => {
  const idx = buildBm25Index([
    { id: 'a', text: 'hello world' },
    { id: 'b', text: 'foo bar baz' },
  ]);
  const results = idx.search('hello');
  for (const r of results) {
    assert.equal(typeof r.score, 'number', `Expected number score, got ${typeof r.score}`);
    assert.ok(Number.isFinite(r.score), `Expected finite score, got ${r.score}`);
  }
});

// --- results sorted descending by score ---

test('results are sorted in descending score order', () => {
  const idx = buildBm25Index([
    { id: 'a', text: 'cat' },
    { id: 'b', text: 'cat cat cat' },
    { id: 'c', text: 'cat cat' },
  ]);
  const results = idx.search('cat');
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1]!.score >= results[i]!.score,
      `Scores not descending at index ${i}: ${results[i - 1]!.score} < ${results[i]!.score}`,
    );
  }
});

// --- topK=0 edge case ---

test('topK=0 returns empty array', () => {
  const idx = buildBm25Index([{ id: 'a', text: 'hello world' }]);
  const results = idx.search('hello', 0);
  assert.deepEqual(results, []);
});
