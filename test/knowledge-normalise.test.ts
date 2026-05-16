import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolResult } from '../src/knowledge/extractor/normalise.js';
import type { SearchResult } from '../src/types.js';

test('normalizeToolResult extracts text from raw web_search result arrays', () => {
  const results: SearchResult[] = [
    {
      title: 'Example result',
      url: 'https://example.com/docs',
      description: 'Primary search result description.',
      position: 1,
      domain: 'example.com',
      source: 'duckduckgo',
      age: null,
      extraSnippet: 'Additional snippet text.',
      deepLinks: null,
    },
  ];

  const normalized = normalizeToolResult('web_search', results);

  assert.ok(normalized);
  assert.equal(normalized.url, 'https://example.com/docs');
  assert.equal(normalized.title, 'Example result');
  assert.equal(normalized.sourceKind, 'documentation');
  assert.doesNotMatch(normalized.text, /Example result/);
  assert.match(normalized.text, /Primary search result description\./);
  assert.match(normalized.text, /Additional snippet text\./);
});
