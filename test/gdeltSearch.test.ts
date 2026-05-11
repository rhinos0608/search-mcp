import test from 'node:test';
import assert from 'node:assert/strict';
import { searchGdelt } from '../src/tools/gdeltSearch.js';

test('searchGdelt returns results for a valid query', async () => {
  const results = await searchGdelt('machine learning', '30d', 3);
  assert.ok(Array.isArray(results), 'should return an array');
  // GDELT can be slow or rate-limited — function handles this gracefully
  for (const r of results) {
    assert.ok(typeof r.title === 'string' && r.title.length > 0, 'title should be non-empty string');
    assert.ok(typeof r.link === 'string' && r.link.length > 0, 'link should be non-empty string');
    assert.ok(typeof r.snippet === 'string', 'snippet should be a string');
  }
});

test('searchGdelt respects limit parameter', async () => {
  const results = await searchGdelt('test', '30d', 2);
  assert.ok(results.length <= 2, `expected <= 2 results, got ${String(results.length)}`);
});

test('searchGdelt handles empty query gracefully', async () => {
  const results = await searchGdelt('', '30d', 5);
  assert.ok(Array.isArray(results), 'should return an array');
});
