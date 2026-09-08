import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeUrl } from '../src/httpGuards.js';

test('fix2 blocks IPv4-compatible IPv6 loopback encoding', () => {
  assert.throws(() => assertSafeUrl('http://[::7f00:1]/'), /private IPv6 address/);
});

test('fix2 blocks IPv4-compatible IPv6 private-network encoding', () => {
  assert.throws(() => assertSafeUrl('http://[::c0a8:101]/'), /private IPv6 address/);
});
