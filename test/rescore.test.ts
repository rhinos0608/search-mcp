import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchResult, AcademicPaper, HackerNewsItem, RedditPost } from '../src/types.js';
import {
  applyRecencyDecay,
  applyLogTransform,
  minMaxNormalize,
  multiSignalRescore,
  extractWebSearchSignals,
  extractYearIntent,
  hasFreshnessIntent,
  extractAcademicSignals,
  extractHNSignals,
  extractRedditSignals,
  applyExplicitYearIntentOrder,
  CONTENT_DEPTH_WEIGHT,
} from '../src/utils/rescore.js';
import { parseArxivYear } from '../src/utils/time.js';
import { authorityWeightedScore } from '../src/utils/semanticMatch.js';
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

test('multiSignalRescore: rich result outranks equally-relevant thin result via contentDepth default weight', () => {
  // Equal on rrfScore and every other signal — only contentDepth differs.
  // CONTENT_DEPTH_WEIGHT (0.05) is applied as the local default since no
  // explicit weight is passed, so the rich result edges ahead.
  const items = [
    { item: 'thin', rrfScore: 2, signals: { recency: 0.5, contentDepth: 0.05 } },
    { item: 'rich', rrfScore: 2, signals: { recency: 0.5, contentDepth: 0.9 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 0.3, recency: 0.3 }, 10);
  assert.equal(result[0]!.item, 'rich');
  assert.equal(result[1]!.item, 'thin');
});

test('multiSignalRescore: explicit contentDepth weight overrides the local default', () => {
  const items = [
    { item: 'a', rrfScore: 1, signals: { contentDepth: 0.2 } },
    { item: 'b', rrfScore: 1, signals: { contentDepth: 0.9 } },
  ];
  const result = multiSignalRescore(items, { contentDepth: 0.5 }, 10);
  assert.equal(result[0]!.item, 'b');
});

test('multiSignalRescore: absent contentDepth signal leaves scoring unchanged (backward compatible)', () => {
  const items = [
    { item: 'a', rrfScore: 3, signals: { recency: 0.5 } },
    { item: 'b', rrfScore: 2, signals: { recency: 0.5 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 0.5, recency: 0.5 }, 10);
  assert.equal(result[0]!.item, 'a');
});

test('CONTENT_DEPTH_WEIGHT default is 0.05', () => {
  assert.equal(CONTENT_DEPTH_WEIGHT, 0.05);
});

test('extractWebSearchSignals emits contentDepth in [0,1] for every result', () => {
  const results: SearchResult[] = [
    { ...makeSignalResult({ description: 'x'.repeat(2000), contentKind: 'full' }) },
    { ...makeSignalResult({ description: 'short', contentKind: 'snippet' }) },
  ];
  const signals = extractWebSearchSignals(results);
  assert.ok(signals[0]!.contentDepth! > signals[1]!.contentDepth!, 'rich has higher depth signal');
  assert.ok(signals[0]!.contentDepth! >= 0 && signals[0]!.contentDepth! <= 1);
  assert.ok(signals[1]!.contentDepth! >= 0 && signals[1]!.contentDepth! <= 1);
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
    {
      title: 'a',
      url: 'http://a',
      description: 'a',
      position: 1,
      domain: 'a.com',
      source: 'brave',
      age: '2 days ago',
      ageKind: 'published',
      extraSnippet: null,
      deepLinks: [{ title: 'a', url: 'b' }],
    },
    {
      title: 'b',
      url: 'http://b',
      description: 'b',
      position: 2,
      domain: 'b.com',
      source: 'brave',
      age: '14 days ago',
      ageKind: 'published',
      extraSnippet: null,
      deepLinks: null,
    },
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

test('extractWebSearchSignals: fetched and unknown ages are neutral recency', () => {
  const results: SearchResult[] = [
    {
      title: 'new',
      url: 'http://new',
      description: 'new',
      position: 1,
      domain: 'new.com',
      source: 'brave',
      age: '1 day ago',
      ageKind: 'published',
      extraSnippet: null,
      deepLinks: null,
    },
    {
      title: 'fetched',
      url: 'http://fetched',
      description: 'fetched',
      position: 2,
      domain: 'fetched.com',
      source: 'brave',
      age: '1 day ago',
      ageKind: 'fetched',
      extraSnippet: null,
      deepLinks: null,
    },
    {
      title: 'unknown',
      url: 'http://unknown',
      description: 'unknown',
      position: 3,
      domain: 'unknown.com',
      source: 'brave',
      age: '2 days ago',
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
    },
    {
      title: 'old',
      url: 'http://old',
      description: 'old',
      position: 4,
      domain: 'old.com',
      source: 'brave',
      age: '60 days ago',
      ageKind: 'published',
      extraSnippet: null,
      deepLinks: null,
    },
  ];
  const signals = extractWebSearchSignals(results);
  assert.ok(signals[0]!.recency! > signals[3]!.recency!);
  assert.equal(signals[1]!.recency!, 0);
  assert.equal(signals[2]!.recency!, 0);
});

test('extractWebSearchSignals: missing age → recency = 0', () => {
  const results: SearchResult[] = [
    {
      title: 'a',
      url: 'http://a',
      description: 'a',
      position: 1,
      domain: 'a.com',
      source: 'brave',
      age: null,
      extraSnippet: null,
      deepLinks: null,
    },
  ];
  const signals = extractWebSearchSignals(results);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.recency, 0);
});

// --- extractAcademicSignals ---

test('extractAcademicSignals: citations, venue, recency', () => {
  const papers: AcademicPaper[] = [
    {
      title: 'a',
      authors: [],
      abstract: '',
      url: '',
      year: 2024,
      venue: 'NeurIPS',
      citationCount: 100,
      source: 'arxiv',
      doi: null,
      pdfUrl: null,
    },
    {
      title: 'b',
      authors: [],
      abstract: '',
      url: '',
      year: 2020,
      venue: null,
      citationCount: 10,
      source: 'arxiv',
      doi: null,
      pdfUrl: null,
    },
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
    {
      title: 'a',
      authors: [],
      abstract: '',
      url: '',
      year: 2024,
      venue: null,
      citationCount: 0,
      source: 'arxiv',
      doi: null,
      pdfUrl: null,
    },
  ];
  const signals = extractAcademicSignals(papers, 2026);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.venue, 0);
});

// --- extractHNSignals ---

test('extractHNSignals relevance mode: all signals present', () => {
  const items: HackerNewsItem[] = [
    {
      id: 1,
      title: 'a',
      url: 'http://a',
      author: 'a',
      points: 100,
      numComments: 50,
      createdAt: '2025-01-01',
      storyText: null,
      type: 'story',
      objectId: '1',
    },
    {
      id: 2,
      title: 'b',
      url: 'http://b',
      author: 'b',
      points: 10,
      numComments: 5,
      createdAt: '2024-01-01',
      storyText: null,
      type: 'story',
      objectId: '2',
    },
  ];
  const signals = extractHNSignals(items, 'relevance');
  assert.equal(signals.length, 2);
  const s0 = signals[0]!;
  assert.ok(s0.recency! > 0, `expected recency > 0, got ${s0.recency}`);
  assert.ok(s0.engagement! > 0, `expected engagement > 0, got ${s0.engagement}`);
  assert.ok(
    s0.commentEngagement! > 0,
    `expected commentEngagement > 0, got ${s0.commentEngagement}`,
  );
});

test('extractHNSignals date mode: recency omitted', () => {
  const items: HackerNewsItem[] = [
    {
      id: 1,
      title: 'a',
      url: 'http://a',
      author: 'a',
      points: 100,
      numComments: 50,
      createdAt: '2025-01-01',
      storyText: null,
      type: 'story',
      objectId: '1',
    },
    {
      id: 2,
      title: 'b',
      url: 'http://b',
      author: 'b',
      points: 10,
      numComments: 5,
      createdAt: '2024-01-01',
      storyText: null,
      type: 'story',
      objectId: '2',
    },
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
    {
      title: 'a',
      url: 'http://a',
      selftext: '',
      score: 100,
      numComments: 50,
      subreddit: 'a',
      author: 'a',
      createdUtc: 1700000000,
      permalink: '/r/a/1',
      isVideo: false,
    },
    {
      title: 'b',
      url: 'http://b',
      selftext: '',
      score: 10,
      numComments: 5,
      subreddit: 'b',
      author: 'b',
      createdUtc: 1600000000,
      permalink: '/r/b/2',
      isVideo: false,
    },
  ];
  const signals = extractRedditSignals(posts, 'top');
  assert.equal(signals.length, 2);
  const s0 = signals[0]!;
  assert.equal('engagement' in s0, false);
  assert.ok(
    s0.commentEngagement! > 0,
    `expected commentEngagement > 0, got ${s0.commentEngagement}`,
  );
});

// --- loadConfig rescore weights ---

test('loadConfig rescore weights pass guardrail (rrfAnchor >= maxOther)', () => {
  resetConfig();
  const config = loadConfig();
  const ws = config.rescoreWeights.webSearch;
  const others = [
    ws.recency ?? 0,
    ws.hasDeepLinks ?? 0,
    ws.domainAuthority ?? 0,
    ws.yearAlignment ?? 0,
  ];
  assert.ok(
    ws.rrfAnchor >= Math.max(...others),
    'rrfAnchor should dominate any single other signal',
  );
});

test('loadConfig returns default rescore weights', () => {
  resetConfig();
  const config = loadConfig();
  assert.equal(config.rescoreWeights.webSearch.rrfAnchor, 0.45);
  assert.equal(config.rescoreWeights.webSearch.domainAuthority, 0.25);
  assert.equal(config.rescoreWeights.webSearch.yearAlignment, 0.12);
  assert.equal(config.rescoreWeights.academicSearch.citations, 0.3);
  assert.equal(config.rescoreWeights.hackernewsSearch.engagement, 0.2);
  assert.equal(config.rescoreWeights.redditSearch.commentEngagement, 0.15);
});

// --- web-search source tier + year intent signals ---

test('extractWebSearchSignals includes domainAuthority and query-sensitive recency', () => {
  const results: SearchResult[] = [
    {
      title: 'a',
      url: 'https://spectrum.ieee.org/x',
      description: 'a',
      position: 1,
      domain: 'spectrum.ieee.org',
      source: 'exa',
      age: null,
      extraSnippet: null,
      deepLinks: null,
    },
    {
      title: 'b',
      url: 'https://blog.blogspot.com/y',
      description: 'b',
      position: 2,
      domain: 'blog.blogspot.com',
      source: 'brave',
      age: null,
      extraSnippet: null,
      deepLinks: null,
    },
  ];
  const signals = extractWebSearchSignals(results);
  assert.equal(signals[0]!.domainAuthority, 0.9, 'ieee family is high-authority');
  assert.equal(signals[1]!.domainAuthority, 0.2, 'blogspot is low-authority');
  assert.equal('yearAlignment' in signals[0]!, false, 'no year alignment without year intent');
});

test('extractWebSearchSignals penalizes wrong known year and treats unknown as neutral', () => {
  const results: SearchResult[] = [
    {
      title: 'match',
      url: 'https://a.com',
      description: 'a',
      position: 1,
      domain: 'a.com',
      source: 'exa',
      age: '2026-03-01',
      ageKind: 'published',
      extraSnippet: null,
      deepLinks: null,
    },
    {
      title: 'wrong',
      url: 'https://b.com',
      description: 'b',
      position: 2,
      domain: 'b.com',
      source: 'brave',
      age: '2024-01-01',
      ageKind: 'published',
      extraSnippet: null,
      deepLinks: null,
    },
    {
      title: 'unknown',
      url: 'https://c.com',
      description: 'c',
      position: 3,
      domain: 'c.com',
      source: 'brave',
      age: null,
      extraSnippet: null,
      deepLinks: null,
    },
  ];
  const signals = extractWebSearchSignals(results, { query: 'best frameworks 2026' });
  assert.equal(signals[0]!.yearAlignment, 1, 'matching year preferred');
  assert.equal(signals[1]!.yearAlignment, 0, 'known wrong year strongly penalized');
  assert.equal(signals[2]!.yearAlignment, 0.5, 'unknown date is neutral, not falsely fresh');
});

test('extractYearIntent reads from the ORIGINAL query, not category-expanded text', () => {
  assert.equal(extractYearIntent('python 3.13 release 2026'), 2026);
  assert.equal(extractYearIntent('best laptops 2026'), 2026);
  assert.equal(extractYearIntent('python 3.13'), null, 'no explicit year -> no intent');
  assert.equal(extractYearIntent('version 2.4.1'), null, 'version numbers are not years');
});

test('hasFreshnessIntent is query-sensitive', () => {
  assert.equal(hasFreshnessIntent('best laptops 2026'), true, 'year implies freshness interest');
  assert.equal(hasFreshnessIntent('latest AI news'), true, 'recency keyword implies interest');
  assert.equal(hasFreshnessIntent('how to sort arrays'), false, 'no freshness interest');
});

test('parseArxivYear reads modern YYMM arXiv IDs as their real year (2310 → 2023, never 2026)', () => {
  assert.equal(parseArxivYear('https://arxiv.org/abs/2310.09386'), 2023, '2310 → 2023');
  assert.equal(parseArxivYear('https://arxiv.org/abs/2403.12345v2'), 2024, '2403 → 2024');
  assert.equal(parseArxivYear('https://arxiv.org/pdf/9501.00001'), 1995, '95xx → 1995');
  assert.equal(parseArxivYear('https://example.com/not-arxiv'), null, 'non-arxiv -> null');
});

test('2026 query does not rank a 2023 arXiv survey as fresh (wrong known year penalized)', () => {
  const results: SearchResult[] = [
    {
      title: 'survey',
      url: 'https://arxiv.org/abs/2310.09386',
      description: 'A survey of techniques.',
      position: 1,
      domain: 'arxiv.org',
      source: 'exa',
      age: null,
      extraSnippet: null,
      deepLinks: null,
    },
    {
      title: 'match',
      url: 'https://d.com',
      description: 'Current guide.',
      position: 2,
      domain: 'd.com',
      source: 'brave',
      age: '2026-02-01',
      ageKind: 'published',
      extraSnippet: null,
      deepLinks: null,
    },
  ];
  const signals = extractWebSearchSignals(results, { query: 'survey 2026' });
  assert.equal(signals[0]!.yearAlignment, 0, '2023 arXiv survey penalized against 2026 intent');
  assert.equal(signals[1]!.yearAlignment, 1, '2026 match preferred');
});

test('extractWebSearchSignals: a fetched (non-published) age never satisfies an explicit year — arXiv ID still falls back honestly', () => {
  const results: SearchResult[] = [
    {
      title: 'survey',
      url: 'https://arxiv.org/abs/2310.09386',
      description: 'A survey of techniques.',
      position: 1,
      domain: 'arxiv.org',
      source: 'exa',
      age: '2026-01-01',
      ageKind: 'fetched',
      extraSnippet: null,
      deepLinks: null,
    },
    {
      title: 'other',
      url: 'https://example.com',
      description: 'Not arXiv.',
      position: 2,
      domain: 'example.com',
      source: 'brave',
      age: '2026-01-01',
      ageKind: 'fetched',
      extraSnippet: null,
      deepLinks: null,
    },
  ];
  const signals = extractWebSearchSignals(results, { query: 'survey 2026' });
  assert.equal(
    signals[0]!.yearAlignment,
    0,
    'arXiv ID (2023) is the honest publication fallback even with a fetched 2026 age; wrong year is penalized',
  );
  assert.equal(
    signals[1]!.yearAlignment,
    0.5,
    'non-arXiv fetched date is not a publication claim — neutral, not falsely fresh',
  );
});

function makeSignalResult(overrides: Partial<SearchResult>): SearchResult {
  return {
    title: 't',
    url: 'https://example.com',
    description: 'd',
    position: 1,
    domain: 'example.com',
    source: 'brave',
    age: null,
    extraSnippet: null,
    deepLinks: null,
    ...overrides,
  };
}

test('applyExplicitYearIntentOrder groups matching-year first, unknown second, known-wrong last (stable within groups)', () => {
  const match = makeSignalResult({ url: 'https://a.com', age: '2026-01-01', ageKind: 'published' });
  const unknown = makeSignalResult({ url: 'https://b.com', age: null });
  const wrong = makeSignalResult({ url: 'https://c.com', age: '2024-01-01', ageKind: 'published' });
  const ordered = applyExplicitYearIntentOrder([wrong, unknown, match], 'survey 2026');
  assert.deepEqual(
    ordered.map((r) => r.url),
    [match.url, unknown.url, wrong.url],
  );
});

test('applyExplicitYearIntentOrder is a no-op without an explicit year in the query', () => {
  const items = [
    makeSignalResult({ url: 'https://a.com' }),
    makeSignalResult({ url: 'https://b.com' }),
  ];
  assert.deepEqual(applyExplicitYearIntentOrder(items, 'best frameworks'), items);
});

test('authorityWeightedScore: authoritative source outranks keyword-dense blog when cosine is close', () => {
  // Authoritative with slightly lower cosine beats self-promotional blog with
  // slightly higher cosine.
  const authoritative = authorityWeightedScore(0.9, 0.9);
  const selfPromo = authorityWeightedScore(0.95, 0.2);
  assert.ok(authoritative > selfPromo, `${authoritative} should beat ${selfPromo}`);
  assert.equal(authorityWeightedScore(0.8, 0), 0.4, 'authority 0 halves cosine');
  assert.equal(authorityWeightedScore(0.8, 1), 0.8, 'authority 1 keeps cosine');
});

test('authorityWeightedScore: relevance guard — a highly irrelevant high-authority source never outranks a highly relevant low-tier one', () => {
  // A near-perfect authority (0.9) with weak relevance (cosine 0.2) must stay
  // below a highly relevant result (cosine 0.95) even from a low-tier source
  // (authority 0.2). Authority is a tiebreak among close relevance, not a
  // license to promote irrelevant content.
  const irrelevantHighAuthority = authorityWeightedScore(0.2, 0.9);
  const relevantLowTier = authorityWeightedScore(0.95, 0.2);
  assert.ok(
    relevantLowTier > irrelevantHighAuthority,
    `${relevantLowTier} (relevant, low-tier) should beat ${irrelevantHighAuthority} (irrelevant, high-authority)`,
  );
});
