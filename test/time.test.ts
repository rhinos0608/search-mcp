import test from "node:test";
import assert from "node:assert/strict";
import { parseAgeToDays } from "../src/utils/time.js";

test("parseAgeToDays parses '2 days ago'", () => {
  assert.strictEqual(parseAgeToDays("2 days ago"), 2);
});

test("parseAgeToDays parses '1 week ago'", () => {
  assert.strictEqual(parseAgeToDays("1 week ago"), 7);
});

test("parseAgeToDays parses '1 hour ago'", () => {
  const result = parseAgeToDays("1 hour ago");
  assert.ok(result !== null);
  assert.ok(Math.abs(result - 1 / 24) < 0.001);
});

test("parseAgeToDays parses ISO date '2024-01-15'", () => {
  const result = parseAgeToDays("2024-01-15");
  assert.ok(result !== null);
  assert.ok(result > 0);
});

test("parseAgeToDays returns null for null", () => {
  assert.strictEqual(parseAgeToDays(null), null);
});

test("parseAgeToDays returns null for empty string", () => {
  assert.strictEqual(parseAgeToDays(""), null);
});

test("parseAgeToDays returns null for unknown", () => {
  assert.strictEqual(parseAgeToDays("unknown"), null);
});
