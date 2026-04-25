import test from 'node:test';
import assert from 'node:assert/strict';
import { getProfileSettings } from '../src/rag/profiles.js';

test('code profile settings expose lexical-heavy tuning', () => {
  const balanced = getProfileSettings('balanced');
  const lexicalHeavy = getProfileSettings('lexical-heavy' as never);

  assert.equal(lexicalHeavy.profile, 'lexical-heavy');
  assert.equal(lexicalHeavy.topK, balanced.topK);
  assert.ok(lexicalHeavy.lexicalWeight > balanced.lexicalWeight);
  assert.ok(lexicalHeavy.vectorWeight <= balanced.vectorWeight);
});
