import test from 'node:test';
import assert from 'node:assert/strict';
import { readBody } from '../../src/server/dashboard-router.js';
import { Readable } from 'node:stream';

test('readBody: reads body within limit', async () => {
  const stream = Readable.from(['{"key":"value"}']);
  const result = await readBody(stream as never, 1024);
  assert.ok(result !== null);
  assert.equal(result.toString(), '{"key":"value"}');
});

test('readBody: returns null and stops reading over limit', async () => {
  const big = 'x'.repeat(100);
  const stream = Readable.from([big]);
  const result = await readBody(stream as never, 10);
  assert.equal(result, null);
});
