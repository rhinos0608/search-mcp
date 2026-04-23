import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractionConfigSchema,
} from '../src/utils/extractionConfig.js';

test('extractionConfigSchema accepts valid css_schema', () => {
  const result = extractionConfigSchema.safeParse({
    type: 'css_schema',
    schema: { name: 'Jobs', baseSelector: 'article', fields: [{ name: 'title', selector: 'h2' }] },
  });
  assert.equal(result.success, true);
});

test('extractionConfigSchema rejects unknown regex pattern', () => {
  const result = extractionConfigSchema.safeParse({
    type: 'regex',
    patterns: ['email', 'not-a-real-pattern'],
  });
  assert.equal(result.success, false);
});

test('extractionConfigSchema rejects llm with empty instruction', () => {
  const result = extractionConfigSchema.safeParse({
    type: 'llm',
    instruction: '',
  });
  assert.equal(result.success, false);
});