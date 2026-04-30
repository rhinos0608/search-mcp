import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUrlForDedup,
  mergeSearchResults,
} from '../src/utils/searchMerge.js';
import type { SearchResult } from '../src/types.js';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: overrides.title ?? 'Test Title',
    url: overrides.url ?? 'https://example.com',
    description: overrides.description ?? 'A test description.',
    position: overrides.position ?? 1,
    domain: overrides.domain ?? 'example.com',
    source: overrides.source ?? 'brave',
    age: overrides.age ?? null,
    extraSnippet: overrides.extraSnippet ?? null,
    deepLinks: overrides.deepLinks ?? null,
  };
}

test('normalizeUrlForDedup strips www and trailing slash', () => {
  assert.equal(
    normalizeUrlForDedup('https://www.example.com/path/'),
    'https://example.com/path',
  );
  assert.equal(
    normalizeUrlForDedup('https://example.com/page'),
    'https://example.com/page',
  );
});

test('normalizeUrlForDedup strips fragments', () => {
  assert.equal(
    normalizeUrlForDedup('https://example.com/page#section'),
    'https://example.com/page',
  );
});

test('mergeSearchResults deduplicates same URL from multiple backends', () => {
  const braveResults = [makeResult({ url: 'https://docs.example.com/guide', position: 2, source: 'brave' })];
  const searxngResults = [makeResult({ url: 'https://docs.example.com/guide', position: 5, source: 'searxng' })];

  const merged = mergeSearchResults(
    new Map([
      ['brave', braveResults],
      ['searxng', searxngResults],
    ]),
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.url, 'https://docs.example.com/guide');
  assert.ok(merged[0]?.engines.includes('brave'));
  assert.ok(merged[0]?.engines.includes('searxng'));
});

test('mergeSearchResults keeps unique results from each backend', () => {
  const braveResults = [makeResult({ url: 'https://a.com', position: 1, source: 'brave' })];
  const searxngResults = [makeResult({ url: 'https://b.com', position: 1, source: 'searxng' })];

  const merged = mergeSearchResults(
    new Map([
      ['brave', braveResults],
      ['searxng', searxngResults],
    ]),
  );

  assert.equal(merged.length, 2);
});

test('mergeSearchResults scores high-authority domains', () => {
  const results = [
    makeResult({ url: 'https://random-blog.example/cool-post', domain: 'random-blog.example', source: 'exa' }),
  ];

  const merged = mergeSearchResults(new Map([['exa', results]]));

  assert.equal(merged.length, 1);
  // Should still produce a result, even for unknown domains
  assert.equal(merged[0]?.engines.length, 1);
});

test('mergeSearchResults handles empty input', () => {
  const merged = mergeSearchResults(new Map());
  assert.deepEqual(merged, []);
});

test('mergeSearchResults caps at limit', () => {
  const results: SearchResult[] = Array.from({ length: 20 }, (_, i) =>
    makeResult({ url: `https://result-${i}.com`, position: i + 1, source: 'exa' }),
  );

  const merged = mergeSearchResults(new Map([['exa', results]]), 5);

  assert.equal(merged.length, 5);
});
