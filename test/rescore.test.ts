import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchResult, AcademicPaper, HackerNewsItem, RedditPost } from '../src/types.js';
import {
  applyRecencyDecay,
  applyLogTransform,
  minMaxNormalize,
  multiSignalRescore,
  extractWebSearchSignals,
  extractAcademicSignals,
  extractHNSignals,
  extractRedditSignals,
} from '../src/utils/rescore.js';
import { loadConfig, resetConfig } from '../src/config.js';

// --- applyRecencyDecay ---

test('applyRecencyDecay: 0 days → 1.0', () => {
  assert.equal(applyRecencyDecay(0, 10), 1.0);
});

test('applyRecencyDecay: half_life → ≈0.368', () => {
  const result = applyRecencyDecay(10, 10);
  assert.ok(Math.abs(result - 0.367879) < 0.001, `Expected ≈0.368, got ${result}`);
});

test('applyRecencyDecay: 3x half_life → ≈0.050', () => {
  const result = applyRecencyDecay(30, 10);
  assert.ok(Math.abs(result - 0.049787) < 0.001, `Expected ≈0.050, got ${result}`);
});

// --- applyLogTransform ---

test('applyLogTransform: 0 → 0', () => {
  assert.equal(applyLogTransform(0), 0);
});

test('applyLogTransform: 100 → ≈4.615', () => {
  const result = applyLogTransform(100);
  assert.ok(Math.abs(result - 4.61512) < 0.001, `Expected ≈4.615, got ${result}`);
});

test('applyLogTransform: negative input clipped to 0', () => {
  assert.equal(applyLogTransform(-5), 0);
});

// --- minMaxNormalize ---

test('minMaxNormalize: [1,2,3] → [0, 0.5, 1.0]', () => {
  const result = minMaxNormalize([1, 2, 3]);
  assert.deepEqual(result, [0, 0.5, 1.0]);
});

test('minMaxNormalize: all equal → all 0', () => {
  const result = minMaxNormalize([5, 5, 5]);
  assert.deepEqual(result, [0, 0, 0]);
});

test('minMaxNormalize: single element → [0]', () => {
  const result = minMaxNormalize([42]);
  assert.deepEqual(result, [0]);
});

test('minMaxNormalize: empty → []', () => {
  const result = minMaxNormalize([]);
  assert.deepEqual(result, []);
});

// --- multiSignalRescore ---

test('multiSignalRescore with homogeneous signals preserves order', () => {
  const items = [
    { item: 'a', rrfScore: 3, signals: { recency: 0.5 } },
    { item: 'b', rrfScore: 2, signals: { recency: 0.5 } },
    { item: 'c', rrfScore: 1, signals: { recency: 0.5 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 0.5, recency: 0.5 }, 10);
  assert.equal(result.length, 3);
  assert.equal(result[0]!.item, 'a');
  assert.equal(result[1]!.item, 'b');
  assert.equal(result[2]!.item, 'c');
});

test('multiSignalRescore with recency bias bubbles up newer items', () => {
  const items = [
    { item: 'old', rrfScore: 3, signals: { recency: 0.2 } },
    { item: 'new', rrfScore: 1, signals: { recency: 1.0 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 0.2, recency: 0.8 }, 10);
  assert.equal(result[0]!.item, 'new');
  assert.equal(result[1]!.item, 'old');
});

test('multiSignalRescore with rrfAnchor:1 → pure RRF', () => {
  const items = [
    { item: 'a', rrfScore: 2, signals: { recency: 0.1 } },
    { item: 'b', rrfScore: 1, signals: { recency: 1.0 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 1.0, recency: 0 }, 10);
  assert.equal(result[0]!.item, 'a');
  assert.equal(result[1]!.item, 'b');
});

test('multiSignalRescore respects limit', () => {
  const items = [
    { item: 'a', rrfScore: 3, signals: {} },
    { item: 'b', rrfScore: 2, signals: {} },
    { item: 'c', rrfScore: 1, signals: {} },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 1.0 }, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.item, 'a');
  assert.equal(result[1]!.item, 'b');
});

test('multiSignalRescore single item', () => {
  const items = [{ item: 'only', rrfScore: 5, signals: { recency: 0.5 } }];
  const result = multiSignalRescore(items, { rrfAnchor: 0.5, recency: 0.5 }, 10);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.item, 'only');
  assert.equal(result[0]!.combinedScore, 0.25);
  assert.equal(result[0]!.breakdown.rrfAnchor, 0);
});

test('multiSignalRescore all equal signals → stable sort', () => {
  const items = [
    { item: 'first', rrfScore: 1, signals: { recency: 0.5 } },
    { item: 'second', rrfScore: 1, signals: { recency: 0.5 } },
    { item: 'third', rrfScore: 1, signals: { recency: 0.5 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 0.5, recency: 0.5 }, 10);
  assert.equal(result[0]!.item, 'first');
  assert.equal(result[1]!.item, 'second');
  assert.equal(result[2]!.item, 'third');
});

// --- extractWebSearchSignals ---

test('extractWebSearchSignals: recency from age, hasDeepLinks', () => {
  const results: SearchResult[] = [
    { title: 'a', url: 'http://a', description: 'a', position: 1, domain: 'a.com', source: 'brave', age: '2 days ago', extraSnippet: null, deepLinks: [{ title: 'a', url: 'b' }] },
    { title: 'b', url: 'http://b', description: 'b', position: 2, domain: 'b.com', source: 'brave', age: '14 days ago', extraSnippet: null, deepLinks: null },
  ];
  const signals = extractWebSearchSignals(results);
  assert.equal(signals.length, 2);
  const s0 = signals[0]!;
  const s1 = signals[1]!;
  assert.ok(s0.recency! > 0, `expected recency > 0, got ${s0.recency}`);
  assert.equal(s0.hasDeepLinks, 1);
  assert.ok(s1.recency! >= 0);
  assert.equal(s1.hasDeepLinks, 0);
});

test('extractWebSearchSignals: missing age → recency = 0', () => {
  const results: SearchResult[] = [
    { title: 'a', url: 'http://a', description: 'a', position: 1, domain: 'a.com', source: 'brave', age: null, extraSnippet: null, deepLinks: null },
  ];
  const signals = extractWebSearchSignals(results);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.recency, 0);
});

// --- extractAcademicSignals ---

test('extractAcademicSignals: citations, venue, recency', () => {
  const papers: AcademicPaper[] = [
    { title: 'a', authors: [], abstract: '', url: '', year: 2024, venue: 'NeurIPS', citationCount: 100, source: 'arxiv', doi: null, pdfUrl: null },
    { title: 'b', authors: [], abstract: '', url: '', year: 2020, venue: null, citationCount: 10, source: 'arxiv', doi: null, pdfUrl: null },
  ];
  const signals = extractAcademicSignals(papers, 2026);
  assert.equal(signals.length, 2);
  const s0 = signals[0]!;
  assert.ok(s0.citations! > 0, `expected citations > 0, got ${s0.citations}`);
  assert.equal(s0.venue, 1);
  assert.ok(s0.recency! > 0, `expected recency > 0, got ${s0.recency}`);
});

test('extractAcademicSignals: missing venue → venue = 0', () => {
  const papers: AcademicPaper[] = [
    { title: 'a', authors: [], abstract: '', url: '', year: 2024, venue: null, citationCount: 0, source: 'arxiv', doi: null, pdfUrl: null },
  ];
  const signals = extractAcademicSignals(papers, 2026);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.venue, 0);
});

// --- extractHNSignals ---

test('extractHNSignals relevance mode: all signals present', () => {
  const items: HackerNewsItem[] = [
    { id: 1, title: 'a', url: 'http://a', author: 'a', points: 100, numComments: 50, createdAt: '2025-01-01', storyText: null, type: 'story', objectId: '1' },
    { id: 2, title: 'b', url: 'http://b', author: 'b', points: 10, numComments: 5, createdAt: '2024-01-01', storyText: null, type: 'story', objectId: '2' },
  ];
  const signals = extractHNSignals(items, 'relevance');
  assert.equal(signals.length, 2);
  const s0 = signals[0]!;
  assert.ok(s0.recency! > 0, `expected recency > 0, got ${s0.recency}`);
  assert.ok(s0.engagement! > 0, `expected engagement > 0, got ${s0.engagement}`);
  assert.ok(s0.commentEngagement! > 0, `expected commentEngagement > 0, got ${s0.commentEngagement}`);
});

test('extractHNSignals date mode: recency omitted', () => {
  const items: HackerNewsItem[] = [
    { id: 1, title: 'a', url: 'http://a', author: 'a', points: 100, numComments: 50, createdAt: '2025-01-01', storyText: null, type: 'story', objectId: '1' },
    { id: 2, title: 'b', url: 'http://b', author: 'b', points: 10, numComments: 5, createdAt: '2024-01-01', storyText: null, type: 'story', objectId: '2' },
  ];
  const signals = extractHNSignals(items, 'date');
  assert.equal(signals.length, 2);
  const s0 = signals[0]!;
  assert.equal('recency' in s0, false);
  assert.ok(s0.engagement! > 0, `expected engagement > 0, got ${s0.engagement}`);
});

// --- extractRedditSignals ---

test('extractRedditSignals top mode: engagement omitted', () => {
  const posts: RedditPost[] = [
    { title: 'a', url: 'http://a', selftext: '', score: 100, numComments: 50, subreddit: 'a', author: 'a', createdUtc: 1700000000, permalink: '/r/a/1', isVideo: false },
    { title: 'b', url: 'http://b', selftext: '', score: 10, numComments: 5, subreddit: 'b', author: 'b', createdUtc: 1600000000, permalink: '/r/b/2', isVideo: false },
  ];
  const signals = extractRedditSignals(posts, 'top');
  assert.equal(signals.length, 2);
  const s0 = signals[0]!;
  assert.equal('engagement' in s0, false);
  assert.ok(s0.commentEngagement! > 0, `expected commentEngagement > 0, got ${s0.commentEngagement}`);
});

// --- loadConfig rescore weights ---

test('loadConfig returns default rescore weights', () => {
  resetConfig();
  const config = loadConfig();
  assert.equal(config.rescoreWeights.webSearch.rrfAnchor, 0.5);
  assert.equal(config.rescoreWeights.academicSearch.citations, 0.3);
  assert.equal(config.rescoreWeights.hackernewsSearch.engagement, 0.2);
  assert.equal(config.rescoreWeights.redditSearch.commentEngagement, 0.15);
});

test('loadConfig rescore weights pass guardrail (rrfAnchor >= maxOther)', () => {
  resetConfig();
  const config = loadConfig();
  for (const [tool, weights] of Object.entries(config.rescoreWeights)) {
    const otherWeights = (Object.entries(weights) as [string, number][])
      .filter(([k]) => k !== 'rrfAnchor')
      .map(([, v]) => v);
    const maxOther = otherWeights.length > 0 ? Math.max(...otherWeights) : 0;
    assert.ok(
      weights.rrfAnchor >= maxOther,
      `Tool "${tool}": rrfAnchor (${weights.rrfAnchor}) should be >= maxOther (${maxOther})`,
    );
  }
});
