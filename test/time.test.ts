import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgeToDays, formatRelativeAge } from '../src/utils/time.js';

test("parseAgeToDays parses '2 days ago'", () => {
  assert.strictEqual(parseAgeToDays('2 days ago'), 2);
});

test("parseAgeToDays parses '1 week ago'", () => {
  assert.strictEqual(parseAgeToDays('1 week ago'), 7);
});

test("parseAgeToDays parses '1 hour ago'", () => {
  const result = parseAgeToDays('1 hour ago');
  assert.ok(result !== null);
  assert.ok(Math.abs(result - 1 / 24) < 0.001);
});

test("parseAgeToDays parses ISO date '2024-01-15'", () => {
  const result = parseAgeToDays('2024-01-15');
  assert.ok(result !== null);
  assert.ok(result > 0);
});

test('parseAgeToDays returns null for null', () => {
  assert.strictEqual(parseAgeToDays(null), null);
});

test('parseAgeToDays returns null for empty string', () => {
  assert.strictEqual(parseAgeToDays(''), null);
});

test('parseAgeToDays returns null for unknown', () => {
  assert.strictEqual(parseAgeToDays('unknown'), null);
});

test('formatRelativeAge yields exact natural labels for recent published ages', () => {
  assert.strictEqual(formatRelativeAge('1 hour ago'), '1 hour ago');
  assert.strictEqual(formatRelativeAge('5 hours ago'), '5 hours ago');
  assert.strictEqual(formatRelativeAge('1 day ago'), '1 day ago');
  assert.strictEqual(formatRelativeAge('4 days ago'), '4 days ago');
});

test('formatRelativeAge normalizes existing relative provider strings without clock drift', () => {
  assert.strictEqual(formatRelativeAge('3 days ago'), '3 days ago');
  assert.strictEqual(formatRelativeAge('2 weeks ago'), '2 weeks ago');
  assert.strictEqual(formatRelativeAge('3 months ago'), '3 months ago');
  assert.strictEqual(formatRelativeAge('2 years ago'), '2 years ago');
});

test('formatRelativeAge resolves absolute dates against injected now (deterministic)', () => {
  const now = Date.parse('2026-01-05T00:00:00Z');
  assert.strictEqual(formatRelativeAge('2026-01-01', { now }), '4 days ago');
  assert.strictEqual(formatRelativeAge('2026-01-05', { now }), 'less than an hour ago');
});

test('formatRelativeAge returns null for future, invalid, absent, and unknown ages', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.strictEqual(formatRelativeAge('2030-01-01', { now }), null, 'future date yields null');
  assert.strictEqual(formatRelativeAge('not-a-date', { now }), null);
  assert.strictEqual(formatRelativeAge('unknown', { now }), null);
  assert.strictEqual(formatRelativeAge('', { now }), null);
  assert.strictEqual(formatRelativeAge(null, { now }), null);
});

test('formatRelativeAge floors elapsed units at boundaries (never rounds up)', () => {
  const now = Date.parse('2026-01-05T00:00:00Z');
  const iso = (ms: number) => new Date(now - ms).toISOString();
  // 23.5 hours ago → 23 hours (floor, not round to 24h/1 day)
  assert.strictEqual(formatRelativeAge(iso(23.5 * 3600_000), { now }), '23 hours ago');
  // 1.5 days (36h) ago → 1 day (floor of 1.5)
  assert.strictEqual(formatRelativeAge(iso(36 * 3600_000), { now }), '1 day ago');
  // 13 days ago → 1 week (floor of 13/7)
  assert.strictEqual(formatRelativeAge(iso(13 * 24 * 3600_000), { now }), '1 week ago');
  // 45 days ago → 1 month (floor of 1.5 months, not rounded to 2)
  assert.strictEqual(formatRelativeAge(iso(45 * 24 * 3600_000), { now }), '1 month ago');
});
