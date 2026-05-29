import test from 'node:test';
import assert from 'node:assert/strict';
import {
  correctQuery,
  levenshteinDistance,
  maxEditDistance,
} from '../src/utils/fuzzyCorrection.js';

test('levenshteinDistance returns 0 for identical strings', () => {
  assert.equal(levenshteinDistance('test', 'test'), 0);
});

test('levenshteinDistance returns correct distance for single edits', () => {
  assert.equal(levenshteinDistance('test', 'tst'), 1); // delete
  assert.equal(levenshteinDistance('test', 'tests'), 1); // insert
  assert.equal(levenshteinDistance('test', 'tent'), 1); // substitute
});

test('levenshteinDistance returns length for empty strings', () => {
  assert.equal(levenshteinDistance('', 'abc'), 3);
  assert.equal(levenshteinDistance('abc', ''), 3);
});

test('maxEditDistance returns 1 for short words (≤ 4 chars)', () => {
  assert.equal(maxEditDistance(3), 1);
  assert.equal(maxEditDistance(4), 1);
});

test('maxEditDistance returns 2 for medium words (5–12 chars)', () => {
  assert.equal(maxEditDistance(5), 2);
  assert.equal(maxEditDistance(12), 2);
});

test('maxEditDistance returns 3 for long words (> 12 chars)', () => {
  assert.equal(maxEditDistance(13), 3);
  assert.equal(maxEditDistance(16), 3);
});

test('correctQuery returns unchanged for empty query', () => {
  const r = correctQuery('');
  assert.equal(r.corrected, '');
  assert.equal(r.changes.length, 0);
});

test('correctQuery leaves short words (≤ 2 chars) alone', () => {
  assert.equal(correctQuery('go').corrected, 'go');
  assert.equal(correctQuery('to').corrected, 'to');
  assert.equal(correctQuery('a').corrected, 'a');
  assert.equal(correctQuery('py').corrected, 'py');
});

test('correctQuery corrects legitimate typos against vocabulary', () => {
  assert.equal(correctQuery('javacript').corrected, 'javascript');
  assert.equal(correctQuery('reackt').corrected, 'react');
  assert.equal(correctQuery('tuorial').corrected, 'tutorial');
  assert.equal(correctQuery('typescrip').corrected, 'typescript');
  assert.equal(correctQuery('typscript').corrected, 'typescript');
});

test('correctQuery does NOT correct recognized English words — recession', () => {
  const r = correctQuery('recession');
  assert.equal(r.corrected, 'recession');
  assert.equal(r.changes.length, 0);
});

test('correctQuery does NOT correct recognized English words — hours', () => {
  const r = correctQuery('hours');
  assert.equal(r.corrected, 'hours');
  assert.equal(r.changes.length, 0);
});

test('correctQuery does NOT correct common words like query', () => {
  assert.equal(correctQuery('query').corrected, 'query');
  assert.equal(correctQuery('normal query').corrected, 'normal query');
});

test('correctQuery preserves multi-word queries, correcting only unknown words', () => {
  const r = correctQuery('how to code in reackt');
  assert.equal(r.corrected, 'how to code in react');
});

test('correctQuery leaves vocabulary words alone', () => {
  assert.equal(correctQuery('javascript').corrected, 'javascript');
  assert.equal(correctQuery('regression').corrected, 'regression');
  assert.equal(correctQuery('docker').corrected, 'docker');
});

test('correctQuery corrects non-English words with distance-1 matches', () => {
  assert.equal(correctQuery('javascrpt').corrected, 'javascript');
  const r = correctQuery('moch');
  assert.equal(r.changes.length, 1);
});

test('correctQuery respects maxCorrections (default 3)', () => {
  const r = correctQuery('javacript reackt tuorial javascrpt');
  assert.ok(r.changes.length <= 3);
});

test('correctQuery respects custom vocabulary', () => {
  const r = correctQuery('javacript', { vocabulary: ['java', 'javascript'] });
  assert.equal(r.corrected, 'javascript');
  assert.equal(r.changes.length, 1);
});

test('correctQuery preserves original casing', () => {
  assert.equal(correctQuery('Reackt').corrected, 'React');
});
