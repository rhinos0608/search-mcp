import test from 'node:test';
import assert from 'node:assert/strict';
import { readBody } from '../../src/server/dashboard-router.js';
import { Readable } from 'node:stream';
import type http from 'node:http';

test('readBody: reads body within limit', async () => {
  const stream = Readable.from(['{"key":"value"}']);
  const result = await readBody(stream as unknown as http.IncomingMessage, 1024);
  assert.ok(result !== null);
  assert.equal(result.toString(), '{"key":"value"}');
});

test('readBody: returns null and stops reading over limit', async () => {
  const big = 'x'.repeat(100);
  const stream = Readable.from([big]);
  const result = await readBody(stream as unknown as http.IncomingMessage, 10);
  assert.equal(result, null);
});
