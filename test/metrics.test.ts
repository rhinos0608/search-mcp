import test from 'node:test';
import assert from 'node:assert/strict';
import {
  incrementCounter,
  getCounter,
  getAllCounters,
  observeHistogram,
  getHistogram,
  registerHistogram,
  setGauge,
  getGauge,
  takeSnapshot,
  resetMetrics,
  formatMetrics,
  recordRetrievalMetrics,
  recordDedupMetrics,
  recordConstraintMetrics,
  recordAdapterMetrics,
} from '../src/rag/metrics.js';

test.beforeEach(() => {
  resetMetrics();
});

test('counter: increments a counter', () => {
  incrementCounter('test.counter');
  const c = getCounter('test.counter');
  assert.ok(c);
  assert.equal(c.value, 1);
});

test('counter: increments by a custom delta', () => {
  incrementCounter('test.counter', 5);
  assert.equal(getCounter('test.counter')?.value, 5);
});

test('counter: supports labeled counters', () => {
  incrementCounter('test.counter', 1, { env: 'prod' });
  incrementCounter('test.counter', 2, { env: 'dev' });
  assert.equal(getCounter('test.counter', { env: 'prod' })?.value, 1);
  assert.equal(getCounter('test.counter', { env: 'dev' })?.value, 2);
});

test('counter: aggregates by name', () => {
  incrementCounter('test.counter', 1, { env: 'prod' });
  incrementCounter('test.counter', 2, { env: 'dev' });
  const all = getAllCounters(true);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.value, 3);
});

test('counter: returns all individual counters', () => {
  incrementCounter('test.counter', 1, { env: 'prod' });
  incrementCounter('test.counter', 2, { env: 'dev' });
  const all = getAllCounters(false);
  assert.equal(all.length, 2);
});

test('histogram: observes into default buckets', () => {
  observeHistogram('test.hist', 42);
  const h = getHistogram('test.hist');
  assert.ok(h);
  assert.equal(h.count, 1);
  assert.equal(h.sum, 42);
  assert.ok(h.buckets.includes(50));
});

test('histogram: accumulates observations', () => {
  observeHistogram('test.hist', 10);
  observeHistogram('test.hist', 20);
  const h = getHistogram('test.hist');
  assert.equal(h?.count, 2);
  assert.equal(h?.sum, 30);
});

test('histogram: custom buckets when registered', () => {
  registerHistogram('test.custom', 'desc', [10, 20, 30]);
  observeHistogram('test.custom', 15);
  const h = getHistogram('test.custom');
  assert.deepEqual(h?.buckets, [10, 20, 30]);
});

test('histogram: separates labeled histograms', () => {
  observeHistogram('test.hist', 5, { region: 'us' });
  observeHistogram('test.hist', 500, { region: 'eu' });
  const us = getHistogram('test.hist', { region: 'us' });
  const eu = getHistogram('test.hist', { region: 'eu' });
  assert.equal(us?.sum, 5);
  assert.equal(eu?.sum, 500);
});

test('gauge: sets a value', () => {
  setGauge('test.gauge', 42);
  const g = getGauge('test.gauge');
  assert.ok(g);
  assert.equal(g.current, 42);
});

test('gauge: tracks min and max', () => {
  setGauge('test.gauge', 10);
  setGauge('test.gauge', 5);
  setGauge('test.gauge', 20);
  const g = getGauge('test.gauge');
  assert.equal(g?.min, 5);
  assert.equal(g?.max, 20);
});

test('gauge: labeled gauges', () => {
  setGauge('test.gauge', 1, { host: 'a' });
  setGauge('test.gauge', 2, { host: 'b' });
  assert.equal(getGauge('test.gauge', { host: 'a' })?.current, 1);
  assert.equal(getGauge('test.gauge', { host: 'b' })?.current, 2);
});

test('snapshot: captures all metrics', () => {
  incrementCounter('c1');
  observeHistogram('h1', 10);
  setGauge('g1', 5);
  const snap = takeSnapshot();
  assert.equal(snap.counters.length, 1);
  assert.equal(snap.histograms.length, 1);
  assert.equal(snap.gauges.length, 1);
});

test('reset: clears all metrics', () => {
  incrementCounter('c1');
  resetMetrics();
  assert.equal(getCounter('c1'), undefined);
});

test('format: counters', () => {
  incrementCounter('c1', 3);
  const s = formatMetrics();
  assert.ok(s.includes('c1'));
  assert.ok(s.includes('3'));
});

test('format: gauges', () => {
  setGauge('g1', 7);
  const s = formatMetrics();
  assert.ok(s.includes('g1'));
  assert.ok(s.includes('7'));
});

test('format: histograms', () => {
  observeHistogram('h1', 15);
  const s = formatMetrics();
  assert.ok(s.includes('h1'));
  assert.ok(s.includes('count=1'));
});

test('RAG helper: recordRetrievalMetrics', () => {
  recordRetrievalMetrics({
    adapter: 'text',
    totalChunks: 100,
    returnedResults: 10,
    durationMs: 250,
    vectorCandidates: 50,
    lexicalCandidates: 30,
  });
  assert.equal(getCounter("rag.retrieval.total", { adapter: "text" })?.value, 1);
  assert.equal(getGauge("rag.chunks.available", { adapter: "text" })?.current, 100);
  assert.equal(getCounter("rag.results.returned", { adapter: "text" })?.value, 10);
});

test('RAG helper: recordDedupMetrics', () => {
  recordDedupMetrics({
    adapter: 'text',
    documentsBefore: 50,
    documentsAfter: 40,
    urlRemoved: 5,
    fingerprintRemoved: 3,
    semanticRemoved: 2,
  });
  assert.equal(getCounter('rag.dedup.url_removed', { adapter: 'text' })?.value, 5);
  assert.equal(getGauge('rag.documents.after_dedup', { adapter: 'text' })?.current, 40);
});

test('RAG helper: recordConstraintMetrics', () => {
  recordConstraintMetrics({
    adapter: 'text',
    hardConstraints: 3,
    softConstraints: 2,
    passed: 4,
    filtered: 1,
  });
  assert.equal(getCounter('rag.constraints.passed', { adapter: 'text' })?.value, 4);
  assert.equal(getCounter('rag.constraints.filtered', { adapter: 'text' })?.value, 1);
});

test('RAG helper: recordAdapterMetrics', () => {
  recordAdapterMetrics({
    adapter: 'text',
    operation: 'chunk',
    durationMs: 120,
    documentCount: 5,
    chunkCount: 20,
    success: false,
  });
  assert.equal(getCounter("rag.adapter.operations", { adapter: "text", operation: "chunk" })?.value, 1);
  assert.equal(getCounter("rag.adapter.errors", { adapter: "text", operation: "chunk" })?.value, 1);
});
