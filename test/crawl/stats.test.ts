import test from 'node:test';
import assert from 'node:assert/strict';
import {
  incCounter,
  setGauge,
  recordHistogram,
  getStatsSnapshot,
  resetStats,
} from '../../src/crawl/stats.js';

test('StatsCollector: counters start at zero', () => {
  resetStats();
  const snap = getStatsSnapshot();
  assert.equal(snap.counters['test.counter'], undefined);
  assert.equal(Object.keys(snap.counters).length, 0);
});

test('StatsCollector: incCounter increments', () => {
  resetStats();
  incCounter('test.count');
  const snap1 = getStatsSnapshot();
  assert.equal(snap1.counters['test.count'], 1);

  incCounter('test.count', 5);
  const snap2 = getStatsSnapshot();
  assert.equal(snap2.counters['test.count'], 6);
});

test('StatsCollector: setGauge stores absolute value', () => {
  resetStats();
  setGauge('test.gauge', 42);
  const snap = getStatsSnapshot();
  assert.equal(snap.gauges['test.gauge'], 42);
});

test('StatsCollector: setGauge overwrites previous value', () => {
  resetStats();
  setGauge('test.gauge', 10);
  setGauge('test.gauge', 20);
  const snap = getStatsSnapshot();
  assert.equal(snap.gauges['test.gauge'], 20);
});

test('StatsCollector: recordHistogram tracks stats', () => {
  resetStats();
  recordHistogram('test.latency', 10);
  recordHistogram('test.latency', 20);
  recordHistogram('test.latency', 30);

  const snap = getStatsSnapshot();
  const h = snap.histograms['test.latency'];
  assert.ok(h !== undefined);
  if (h === undefined) throw new Error('histogram not found');
  assert.equal(h.count, 3);
  assert.equal(h.min, 10);
  assert.equal(h.max, 30);
  assert.equal(h.sum, 60);
  assert.equal(h.avg, 20);
});

test('StatsCollector: single histogram observation', () => {
  resetStats();
  recordHistogram('test.single', 100);

  const snap = getStatsSnapshot();
  const h = snap.histograms['test.single'];
  if (h === undefined) throw new Error('histogram not found');
  assert.equal(h.count, 1);
  assert.equal(h.min, 100);
  assert.equal(h.max, 100);
  assert.equal(h.avg, 100);
});

test('StatsCollector: reset clears all stats', () => {
  incCounter('test.a', 10);
  setGauge('test.b', 5);
  recordHistogram('test.c', 1);

  resetStats();
  const snap = getStatsSnapshot();
  assert.equal(Object.keys(snap.counters).length, 0);
  assert.equal(Object.keys(snap.gauges).length, 0);
  assert.equal(Object.keys(snap.histograms).length, 0);
});

test('StatsCollector: multiple counters are independent', () => {
  resetStats();
  incCounter('alpha');
  incCounter('beta', 3);
  incCounter('gamma', 10);

  const snap = getStatsSnapshot();
  assert.equal(snap.counters['alpha'], 1);
  assert.equal(snap.counters['beta'], 3);
  assert.equal(snap.counters['gamma'], 10);
});

test('StatsCollector: snapshot returns deep copy semantics', () => {
  resetStats();
  incCounter('mutate', 5);
  const snap1 = getStatsSnapshot();
  incCounter('mutate', 3);
  const snap2 = getStatsSnapshot();

  assert.equal(snap1.counters['mutate'], 5);
  assert.equal(snap2.counters['mutate'], 8);
});
