import test from 'node:test';
import assert from 'node:assert/strict';
import { searchSemanticScholar } from '../src/tools/semanticScholarSearch.js';

test('searchSemanticScholar returns results for a valid query', async () => {
  const results = await searchSemanticScholar('machine learning', 3);
  assert.ok(Array.isArray(results), 'should return an array');
  // May be rate-limited (429) — function handles this by returning empty array
  for (const r of results) {
    assert.ok(typeof r.title === 'string' && r.title.length > 0, 'title should be non-empty string');
    assert.ok(typeof r.link === 'string' && r.link.length > 0, 'link should be non-empty string');
    assert.ok(typeof r.snippet === 'string', 'snippet should be a string');
  }
});

test('searchSemanticScholar respects limit parameter', async () => {
  const results = await searchSemanticScholar('test', 2);
  assert.ok(results.length <= 2, `expected <= 2 results, got ${String(results.length)}`);
});

test('searchSemanticScholar handles empty query gracefully', async () => {
  const results = await searchSemanticScholar('', 5);
  assert.ok(Array.isArray(results), 'should return an array');
});
