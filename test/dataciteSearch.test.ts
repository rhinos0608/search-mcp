import test from 'node:test';
import assert from 'node:assert/strict';
import { searchDataCite } from '../src/tools/dataciteSearch.js';
import { dataciteMockResponse } from './helpers/backendMocks.js';

// Mock fetch for this test file
globalThis.fetch = (async () => dataciteMockResponse()) as typeof fetch;

test('searchDataCite returns results for a valid query', async () => {
  const results = await searchDataCite('machine learning', 3);
  assert.ok(Array.isArray(results), 'should return an array');
  assert.ok(results.length > 0, 'should return at least one result');
  for (const r of results) {
    assert.ok(typeof r.title === 'string' && r.title.length > 0, 'title should be non-empty string');
    assert.ok(typeof r.link === 'string' && r.link.length > 0, 'link should be non-empty string');
    assert.ok(typeof r.snippet === 'string', 'snippet should be a string');
  }
});

test('searchDataCite respects limit parameter', async () => {
  const results = await searchDataCite('test', 2);
  assert.ok(results.length <= 2, `expected <= 2 results, got ${String(results.length)}`);
});

test('searchDataCite handles empty query gracefully', async () => {
  const results = await searchDataCite('', 5);
  assert.ok(Array.isArray(results), 'should return an array');
});
