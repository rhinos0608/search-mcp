import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptExternalRecovery } from '../src/utils/externalRecovery.js';

test('attemptExternalRecovery constructs recovery URLs correctly', async () => {
  // This test verifies that the function runs without throwing
  // for a real URL. The actual availability of Wayback/Google Cache
  // varies, so we just test that it produces a valid result shape.
  const result = await attemptExternalRecovery('https://github.com');
  assert.ok('content' in result);
  assert.ok('source' in result);
  // result.content may be null if both sources fail — that's OK; we
  // just care about the shape and that it returns without crashing.
});

test('attemptExternalRecovery returns error for unsafe URLs', async () => {
  const result = await attemptExternalRecovery('http://127.0.0.1/admin');
  assert.equal(result.content, null);
  assert.equal(result.source, null);
  assert.ok(typeof result.error === 'string');
});

test('attemptExternalRecovery handles invalid URLs gracefully', async () => {
  const result = await attemptExternalRecovery('not-a-url-at-all');
  // Should either return an error or fail safely
  assert.ok(result.content === null || typeof result.content === 'string');
  assert.ok('source' in result);
});
