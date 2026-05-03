import test from 'node:test';
import assert from 'node:assert/strict';
import { DropChunk } from '../../src/crawl/types.js';

test('DropChunk: constructs with reason', () => {
  const err = new DropChunk('consent-wall');
  assert.equal(err.name, 'DropChunk');
  assert.equal(err.reason, 'consent-wall');
  assert.equal(err.message, 'Chunk dropped: consent-wall');
  assert(err instanceof Error);
});

test('DropChunk: different reasons produce different messages', () => {
  const err1 = new DropChunk('http-404');
  const err2 = new DropChunk('cookie-banner');
  assert.notEqual(err1.message, err2.message);
  assert.equal(err1.reason, 'http-404');
  assert.equal(err2.reason, 'cookie-banner');
});
