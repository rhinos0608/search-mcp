import test from 'node:test';
import assert from 'node:assert/strict';

import {
  contentRichness,
  richerThan,
  contentRichnessEqual,
  contentKindRank,
  hasMinimumContent,
  contentDepthScore,
} from '../src/utils/searchRichness.js';
import type { SearchResult } from '../src/types.js';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: overrides.title ?? 'Test Title',
    url: overrides.url ?? 'https://example.com',
    description: overrides.description ?? '',
    position: overrides.position ?? 1,
    domain: overrides.domain ?? 'example.com',
    source: overrides.source ?? 'brave',
    age: overrides.age ?? null,
    extraSnippet: overrides.extraSnippet ?? null,
    deepLinks: overrides.deepLinks ?? null,
    ...overrides,
  };
}

// ── contentRichness ─────────────────────────────────────────────────────────

test('contentRichness: returns [kindRank, length] tuple', () => {
  const result = makeResult({
    description: 'abc',
    extraSnippet: 'de',
    contentKind: 'full',
  });
  const key = contentRichness(result);
  assert.equal(key[0], 3, 'full ranks 3');
  assert.equal(key[1], 5, 'length = description + extraSnippet');
});

test('contentRichness: kind rank dominates; longer snippet does not outrank full', () => {
  const snippet = makeResult({ description: 'x'.repeat(100), contentKind: 'snippet' });
  const full = makeResult({ description: 'y', contentKind: 'full' });
  const [snippetRank, snippetLen] = contentRichness(snippet);
  const [fullRank] = contentRichness(full);
  assert.ok(fullRank > snippetRank, 'full rank beats snippet rank');
  assert.ok(snippetLen > 1, 'snippet is longer');
});

test('contentKindRank: snippet and unset both rank 1, summary 2, full 3', () => {
  assert.equal(contentKindRank('snippet'), 1);
  assert.equal(contentKindRank(undefined), 1);
  assert.equal(contentKindRank('summary'), 2);
  assert.equal(contentKindRank('full'), 3);
});

// ── richerThan ──────────────────────────────────────────────────────────────

test('richerThan: kind rank takes precedence over length', () => {
  const fullShort = makeResult({ description: 'a', contentKind: 'full' });
  const snippetLong = makeResult({ description: 'x'.repeat(50), contentKind: 'snippet' });
  assert.ok(richerThan(fullShort, snippetLong), 'full beats longer snippet');
  assert.ok(!richerThan(snippetLong, fullShort), 'longer snippet loses to full');
});

test('richerThan: same kind, longer length wins', () => {
  const short = makeResult({ description: 'abc', contentKind: 'summary' });
  const long = makeResult({ description: 'abcdef', contentKind: 'summary' });
  assert.ok(richerThan(long, short));
  assert.ok(!richerThan(short, long));
});

test('richerThan: same kind and same length is not strictly richer', () => {
  const a = makeResult({ description: 'same', contentKind: 'full' });
  const b = makeResult({ description: 'same', contentKind: 'full' });
  assert.ok(!richerThan(a, b));
  assert.ok(!richerThan(b, a));
});

test('richerThan: extraSnippet contributes to length tiebreak', () => {
  const base = makeResult({ description: 'same', contentKind: 'full' });
  const withSnippet = makeResult({
    description: 'same',
    extraSnippet: 'extra',
    contentKind: 'full',
  });
  assert.ok(richerThan(withSnippet, base), 'extraSnippet makes richer');
  assert.ok(!richerThan(base, withSnippet));
});

// ── contentRichnessEqual ────────────────────────────────────────────────────

test('contentRichnessEqual: true only when both kind rank and length match', () => {
  const a = makeResult({ description: 'same', contentKind: 'full' });
  const b = makeResult({ description: 'same', contentKind: 'full' });
  assert.ok(contentRichnessEqual(a, b));
});

test('contentRichnessEqual: false when lengths differ', () => {
  const a = makeResult({ description: 'abc', contentKind: 'full' });
  const b = makeResult({ description: 'abcdef', contentKind: 'full' });
  assert.ok(!contentRichnessEqual(a, b));
});

test('contentRichnessEqual: false when kinds differ even if lengths match', () => {
  const snippet = makeResult({ description: 'same', contentKind: 'snippet' });
  const full = makeResult({ description: 'same', contentKind: 'full' });
  assert.ok(!contentRichnessEqual(snippet, full));
});

// ── Edge cases ──────────────────────────────────────────────────────────────

test('edge: zero-length content ranks as snippet and compares by rank', () => {
  const empty = makeResult({ description: '', contentKind: undefined });
  const [rank, len] = contentRichness(empty);
  assert.equal(rank, 1, 'unset kind ranks as snippet');
  assert.equal(len, 0);
  const full = makeResult({ description: '', contentKind: 'full' });
  assert.ok(richerThan(full, empty), 'full with empty text still richer than snippet');
  assert.ok(!contentRichnessEqual(empty, full));
});

test('edge: zero-length same kind and length are equal', () => {
  const a = makeResult({ description: '', contentKind: 'snippet' });
  const b = makeResult({ description: '', contentKind: 'snippet' });
  assert.ok(contentRichnessEqual(a, b));
  assert.ok(!richerThan(a, b));
});

test('edge: different contentKinds with equal length are not equal', () => {
  const summary = makeResult({ description: 'same', contentKind: 'summary' });
  const full = makeResult({ description: 'same', contentKind: 'full' });
  assert.ok(richerThan(full, summary), 'full richer than summary at same length');
  assert.ok(!contentRichnessEqual(summary, full));
});

// ── hasMinimumContent ───────────────────────────────────────────────────────

test('hasMinimumContent: rejects when both title and body are below thresholds', () => {
  const empty = makeResult({ title: '', description: '', extraSnippet: null });
  assert.equal(hasMinimumContent(empty), false, 'no title and no body rejected');

  const whitespace = makeResult({ title: '  ', description: '  ', extraSnippet: null });
  assert.equal(hasMinimumContent(whitespace), false, 'whitespace-only title and body rejected');

  // One-char title with 20-char body: both below thresholds (title ≤ 1, body < 20).
  const oneCharTitleThinBody = makeResult({
    title: 't',
    description: 'a'.repeat(19),
    extraSnippet: null,
  });
  assert.equal(
    hasMinimumContent(oneCharTitleThinBody),
    false,
    '1-char title + 19-char body rejected',
  );

  // One-char title with 20-char body: body meets threshold, kept.
  const oneCharTitleOkBody = makeResult({
    title: 't',
    description: 'a'.repeat(20),
    extraSnippet: null,
  });
  assert.equal(
    hasMinimumContent(oneCharTitleOkBody),
    true,
    '1-char title + 20-char body kept (body substantial)',
  );

  // Two-char title with empty body: title meets threshold, kept.
  const twoCharTitle = makeResult({ title: 'ab', description: '', extraSnippet: null });
  assert.equal(
    hasMinimumContent(twoCharTitle),
    true,
    '2-char title alone kept (title substantial)',
  );
});

test('hasMinimumContent: conservative — keeps short-but-real abstract', () => {
  const abstract = makeResult({
    title: 'Attention Is All You Need',
    description:
      'We propose a new simple network architecture, the Transformer, based ' +
      'solely on attention mechanisms, dispensing with recurrence.',
    extraSnippet: null,
  });
  assert.equal(hasMinimumContent(abstract), true, 'substantive abstract kept');
});

test('hasMinimumContent: keeps long body with short title, and short body with long title', () => {
  const longBody = makeResult({ title: 'x', description: 'a'.repeat(61), extraSnippet: null });
  assert.equal(hasMinimumContent(longBody), true, 'body >= 60 kept despite short title');

  const longTitle = makeResult({
    title: 'A comprehensive reference',
    description: '',
    extraSnippet: null,
  });
  assert.equal(hasMinimumContent(longTitle), true, 'substantive title kept despite empty body');
});

// ── contentDepthScore ───────────────────────────────────────────────────────

test('contentDepthScore: full outranks snippet at the same length', () => {
  const snippet = makeResult({ description: 'a'.repeat(100), contentKind: 'snippet' });
  const full = makeResult({ description: 'a'.repeat(100), contentKind: 'full' });
  assert.ok(contentDepthScore(full) > contentDepthScore(snippet), 'full kind boosts depth');
});

test('contentDepthScore: in range [0,1] and grows sub-linearly with length', () => {
  const small = contentDepthScore(makeResult({ description: 'x', contentKind: 'snippet' }));
  const medium = contentDepthScore(
    makeResult({ description: 'x'.repeat(2000), contentKind: 'snippet' }),
  );
  const huge = contentDepthScore(
    makeResult({ description: 'x'.repeat(20000), contentKind: 'snippet' }),
  );
  for (const s of [small, medium, huge]) {
    assert.ok(s >= 0 && s <= 1, `depth ${s} in [0,1]`);
  }
  assert.ok(medium > small, 'longer is deeper');
  assert.ok(huge - medium < medium - small, 'diminishing returns (saturating)');
});

test('contentDepthScore: full with modest length beats short snippet', () => {
  const rich = contentDepthScore(makeResult({ description: 'y'.repeat(500), contentKind: 'full' }));
  const thin = contentDepthScore(
    makeResult({ description: 'x'.repeat(40), contentKind: 'snippet' }),
  );
  assert.ok(rich > thin, 'full result gets more depth than a thin snippet');
});
