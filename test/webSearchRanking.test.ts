import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBoundedCodexPreference, restoreRrfProvenance } from '../src/tools/webSearch.js';
import type { ScoredResult } from '../src/utils/rescore.js';
import type { RrfMergeResult } from '../src/utils/fusion.js';
import type { SearchResult } from '../src/types.js';
import { formatWebSearchMarkdown } from '../src/tools/webSearchResultFormatter.js';

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
    ...overrides,
  };
}

function scored(item: SearchResult, combinedScore: number): ScoredResult<SearchResult> {
  return { item, combinedScore, breakdown: { rrfAnchor: combinedScore, signals: {} } };
}

test('applyBoundedCodexPreference: score sorts first; low-score Codex stays below high-score fallback', () => {
  const fallback = makeResult({ url: 'https://rich.com', source: 'exa', description: 'short' });
  const codexItem = makeResult({
    url: 'https://codex.com',
    source: 'codex',
    description: 'A fairly long snippet that is not materially thinner than the fallback at all',
  });
  const out = applyBoundedCodexPreference([scored(codexItem, 0.1), scored(fallback, 0.9)]);
  assert.equal(out[0]?.url, 'https://rich.com', 'higher-score fallback ranks first');
  assert.equal(out[1]?.url, 'https://codex.com', 'low-score Codex not promoted');
});

test('applyBoundedCodexPreference: Codex tiebreaks only (near-)equal scores', () => {
  const exaItem = makeResult({
    url: 'https://e.com',
    source: 'exa',
    description: 'Equal length content',
  });
  const codexItem = makeResult({
    url: 'https://c.com',
    source: 'codex',
    description: 'Equal length content',
  });
  const out = applyBoundedCodexPreference([scored(exaItem, 0.5), scored(codexItem, 0.5)]);
  assert.equal(out[0]?.source, 'codex', 'Codex wins the equal-score tiebreak');
});

test('applyBoundedCodexPreference: materially less rich Codex loses the tiebreak', () => {
  const richExa = makeResult({
    url: 'https://e.com',
    source: 'exa',
    description:
      'A much much richer full-text description that is at least double the codex snippet length',
  });
  const codexItem = makeResult({ url: 'https://c.com', source: 'codex', description: 'x' });
  const out = applyBoundedCodexPreference([scored(codexItem, 0.5), scored(richExa, 0.5)]);
  assert.equal(out[0]?.source, 'exa', 'rich fallback outranks materially thinner Codex');
});

test('restoreRrfProvenance: re-stamps full richest record when extraSnippet determines richness', () => {
  const mergedItem: SearchResult = makeResult({
    url: 'https://x.com',
    source: 'exa',
    description: 'same',
    extraSnippet: null,
    engines: ['exa'],
  });
  const merged: RrfMergeResult<SearchResult>[] = [{ item: mergedItem, rrfScore: 0.1 }];
  const richestInRanking: SearchResult = makeResult({
    url: 'https://x.com',
    source: 'exa',
    description: 'same',
    extraSnippet: 'A long extra snippet that makes this representation genuinely richer',
    engines: ['exa'],
  });
  const rankings: SearchResult[][] = [[richestInRanking]];

  const out = restoreRrfProvenance(merged, rankings);
  assert.equal(
    out[0]?.item.extraSnippet,
    richestInRanking.extraSnippet,
    'richer extraSnippet retained via full-record comparison',
  );
});

test('restoreRrfProvenance: unions SearXNG upstream engines when a richer non-SearXNG donor wins', () => {
  const mergedItem: SearchResult = makeResult({
    url: 'https://x.com',
    source: 'exa',
    description: 'same',
    engines: ['exa'],
  });
  const merged: RrfMergeResult<SearchResult>[] = [{ item: mergedItem, rrfScore: 0.1 }];
  const searxngRanking: SearchResult = makeResult({
    url: 'https://x.com',
    source: 'searxng',
    description: 'short searxng snippet',
    engines: ['searxng'],
    upstreamEngines: ['google', 'bing', 'google'],
  });
  const richerExa: SearchResult = makeResult({
    url: 'https://x.com',
    source: 'exa',
    description: 'a much richer full page representation from exa that wins the richness rule',
    engines: ['exa'],
  });
  const rankings: SearchResult[][] = [[searxngRanking], [richerExa]];

  const out = restoreRrfProvenance(merged, rankings);

  assert.equal(out[0]?.item.source, 'exa', 'richer Exa representation wins');
  assert.deepEqual(
    out[0]?.item.upstreamEngines,
    ['bing', 'google'],
    'SearXNG upstream engines survive RRF provenance union',
  );
  const md = formatWebSearchMarkdown(out.map((entry) => entry.item));
  assert.match(md, /via: Exa \(content\), SearXNG \[bing, google\]/);
  assert.ok(
    !md.includes('SearXNG \[bing, google\] \(content\)'),
    'richer Exa donor remains content marker',
  );
});
