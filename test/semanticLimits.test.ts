import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SEMANTIC_MAX_BYTES,
  applySemanticByteBudget,
} from '../src/semanticLimits.js';

test('default semantic byte budget is 250MB', () => {
  assert.equal(DEFAULT_SEMANTIC_MAX_BYTES, 250_000_000);
});

test('applySemanticByteBudget trims chunks that exceed the byte budget', () => {
  const result = applySemanticByteBudget(
    [{ text: 'abc' }, { text: 'defg' }, { text: 'hijkl' }],
    7,
  );

  assert.equal(result.items.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.droppedCount, 1);
  assert.equal(result.bytesUsed, 7);
});
