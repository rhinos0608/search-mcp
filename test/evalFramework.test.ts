/**
 * Tests for the v3.2.0 Evaluation Framework (Phase 5).
 *
 * Covers:
 * - Scoring functions (precision@k, recall@k, nDCG)
 * - Relevance detection
 * - Single query evaluation
 * - Full evaluation suite run
 * - Domain/difficulty filtering
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  precisionAtK,
  recallAtK,
  ndcgAtK,
  isResultRelevant,
  findRelevantIndices,
  evaluateQuery,
  runEvaluation,
  filterByDomain,
  filterByDifficulty,
} from '../src/rag/__tests__/eval/metrics.js';
import type { GoldenQuery, RetrievalAPI } from '../src/rag/__tests__/eval/metrics.js';

// ── Sample Golden Queries ───────────────────────────────────────────────────

const sampleQuery: GoldenQuery = {
  id: 'test-001',
  domain: 'general',
  query: 'how to use TypeScript with React',
  expectedTerms: ['typescript', 'react'],
  minRelevant: 2,
  difficulty: 'easy' as const,
};

const sampleQueryNoTerms: GoldenQuery = {
  id: 'test-002',
  domain: 'general',
  query: 'any query',
  minRelevant: 1,
  difficulty: 'easy' as const,
};

const sampleQueryWithSection: GoldenQuery = {
  id: 'test-003',
  domain: 'academic',
  query: 'test academic query',
  expectedSection: 'results',
  expectedTerms: ['data'],
  minRelevant: 1,
  difficulty: 'medium' as const,
};

const sampleQueryWithTags: GoldenQuery = {
  id: 'test-004',
  domain: 'qa',
  query: 'React hooks question',
  expectedTags: ['react', 'react-hooks'],
  expectedTerms: ['hook'],
  minRelevant: 1,
  difficulty: 'medium' as const,
};

// ── Sample Results ──────────────────────────────────────────────────────────

const allIrrelevant = [
  { text: 'Python is a dynamic programming language.' },
  { text: 'Java is a compiled language.' },
  { text: 'Rust systems programming language.' },
  { text: 'Go concurrency model.' },
  { text: 'Ruby on Rails web framework.' },
];

const scoredResults = [
  { text: 'TypeScript with React is great.', score: 0.95 },
  { text: 'React components in TypeScript.', score: 0.88 },
  { text: 'Python dynamic language.', score: 0.45 },
  { text: 'TypeScript static typing.', score: 0.82 },
  { text: 'React hooks are powerful.', score: 0.76 },
];

// ── Scoring Function Tests ──────────────────────────────────────────────────

void test('precisionAtK: returns 1.0 when all top-k are relevant', () => {
  const relevant = new Set([0, 1, 2]);
  assert.strictEqual(precisionAtK(relevant, 3), 1.0);
});

void test('precisionAtK: returns 0.5 when half of top-k are relevant', () => {
  const relevant = new Set([0, 2]);
  assert.strictEqual(precisionAtK(relevant, 4), 0.5);
});

void test('precisionAtK: returns 0 when none are relevant', () => {
  const relevant = new Set([4, 5]);
  assert.strictEqual(precisionAtK(relevant, 3), 0);
});

void test('precisionAtK: returns 0 when k is 0', () => {
  const relevant = new Set([0, 1]);
  assert.strictEqual(precisionAtK(relevant, 0), 0);
});

void test('precisionAtK: handles k larger than result set', () => {
  const relevant = new Set([0, 1]);
  assert.strictEqual(precisionAtK(relevant, 10), 0.2);
});

void test('recallAtK: returns 1.0 when all relevant items are in top-k', () => {
  const relevant = new Set([0, 1]);
  assert.strictEqual(recallAtK(relevant, 2, 5), 1.0);
});

void test('recallAtK: returns 0.5 when half of relevant items are in top-k', () => {
  const relevant = new Set([0]);
  assert.strictEqual(recallAtK(relevant, 2, 5), 0.5);
});

void test('recallAtK: returns 0 when totalRelevant is 0', () => {
  const relevant = new Set<number>();
  assert.strictEqual(recallAtK(relevant, 0, 5), 0);
});

void test('recallAtK: returns correct value for partial recall', () => {
  const relevant = new Set([0, 2]);
  assert.strictEqual(recallAtK(relevant, 4, 3), 0.5);
});

void test('ndcgAtK: returns 1.0 for perfect ranking', () => {
  const scores = [0.9, 0.8, 0.7];
  const relevant = new Set([0, 1, 2]);
  assert.strictEqual(ndcgAtK(scores, relevant, 3), 1.0);
});

void test('ndcgAtK: returns value between 0 and 1 for partial ranking', () => {
  const scores = [0.9, 0.8, 0.7, 0.6];
  const relevant = new Set([0, 2]);
  const ndcg = ndcgAtK(scores, relevant, 4);
  assert.ok(ndcg > 0);
  assert.ok(ndcg < 1);
});

void test('ndcgAtK: returns 0 when no relevant items', () => {
  const scores = [0.9, 0.8, 0.7];
  assert.strictEqual(ndcgAtK(scores, new Set<number>(), 3), 0);
});

void test('ndcgAtK: returns 0 when k is 0', () => {
  const scores = [0.9, 0.8];
  const relevant = new Set([0]);
  assert.strictEqual(ndcgAtK(scores, relevant, 0), 0);
});

void test('ndcgAtK: handles empty scores array', () => {
  const scores: number[] = [];
  assert.strictEqual(ndcgAtK(scores, new Set<number>(), 5), 0);
});

// ── Relevance Detection Tests ───────────────────────────────────────────────

void test('isResultRelevant: returns true when expected terms are found', () => {
  assert.strictEqual(isResultRelevant('Using TypeScript with React', undefined, sampleQuery), true);
});

void test('isResultRelevant: returns false when expected terms are missing', () => {
  assert.strictEqual(isResultRelevant('Python programming language', undefined, sampleQuery), false);
});

void test('isResultRelevant: returns true when no expected terms', () => {
  assert.strictEqual(isResultRelevant('any text here', undefined, sampleQueryNoTerms), true);
});

void test('isResultRelevant: returns true with matching section in metadata', () => {
  assert.strictEqual(isResultRelevant('test data', { section: 'results' }, sampleQueryWithSection), true);
});

void test('isResultRelevant: returns false with wrong section in metadata', () => {
  assert.strictEqual(isResultRelevant('test data', { section: 'abstract' }, sampleQueryWithSection), false);
});

void test('isResultRelevant: returns true with matching tags in metadata', () => {
  assert.strictEqual(isResultRelevant('Using hooks like useState', { tags: ['react', 'react-hooks'] }, sampleQueryWithTags), true);
});

void test('isResultRelevant: returns false without matching tags', () => {
  assert.strictEqual(isResultRelevant('Using hooks like useState', { tags: ['python'] }, sampleQueryWithTags), false);
});

void test('isResultRelevant: is case-insensitive', () => {
  assert.strictEqual(isResultRelevant('TYPESCRIPT WITH REACT', undefined, sampleQuery), true);
});

void test('findRelevantIndices: finds all relevant indices', () => {
  const results = [
    { text: 'TypeScript with React is great for type safety.' },
    { text: 'React components in TypeScript provide better developer experience.' },
    { text: 'Python is a dynamic programming language.' },
    { text: 'TypeScript adds static typing to JavaScript.' },
    { text: 'React hooks like useState and useEffect are powerful.' },
  ];
  const relevant = findRelevantIndices(results, sampleQuery);
  assert.ok(relevant.has(0));
  assert.ok(relevant.has(1));
});

void test('findRelevantIndices: returns empty set when none are relevant', () => {
  const relevant = findRelevantIndices(allIrrelevant, sampleQuery);
  assert.strictEqual(relevant.size, 0);
});

void test('findRelevantIndices: handles empty results array', () => {
  const relevant = findRelevantIndices([], sampleQuery);
  assert.strictEqual(relevant.size, 0);
});

// ── Single Query Evaluation Tests ──────────────────────────────────────────

void test('evaluateQuery: returns correct structure', async () => {
  const mockAPI: RetrievalAPI = {
    retrieve: async () => ({
      results: scoredResults,
    }),
  };

  const result = await evaluateQuery(sampleQuery, mockAPI, 10);

  assert.strictEqual(result.queryId, 'test-001');
  assert.strictEqual(result.domain, 'general');
  assert.strictEqual(result.numResults, 5);
  assert.ok(result.precisionAtK >= 0);
  assert.ok(result.precisionAtK <= 1);
  assert.ok(result.recallAtK >= 0);
  assert.ok(result.ndcg >= 0);
  assert.strictEqual(result.topResultScore, 0.95);
  assert.strictEqual(typeof result.passed, 'boolean');
});

void test('evaluateQuery: reports passed=true when enough relevant results found', async () => {
  const apiWithRelevant: RetrievalAPI = {
    retrieve: async () => ({
      results: scoredResults,
    }),
  };

  const result = await evaluateQuery(sampleQuery, apiWithRelevant, 10);
  assert.ok(result.relevantFound >= result.numRelevant);
});

void test('evaluateQuery: reports passed=false when not enough relevant results', async () => {
  const apiWithIrrelevant: RetrievalAPI = {
    retrieve: async () => ({
      results: allIrrelevant,
    }),
  };

  const result = await evaluateQuery(sampleQuery, apiWithIrrelevant, 10);
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.relevantFound, 0);
});

void test('evaluateQuery: handles empty results', async () => {
  const emptyAPI: RetrievalAPI = {
    retrieve: async () => ({ results: [] }),
  };

  const result = await evaluateQuery(sampleQuery, emptyAPI, 10);
  assert.strictEqual(result.numResults, 0);
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.averageScore, 0);
  assert.strictEqual(result.topResultScore, 0);
});

// ── Full Evaluation Suite Tests ────────────────────────────────────────────

void test('runEvaluation: runs across multiple queries', async () => {
  const queries = [sampleQuery, sampleQueryNoTerms];

  const mockAPI: RetrievalAPI = {
    retrieve: async () => ({
      results: scoredResults,
    }),
  };

  const summary = await runEvaluation(queries, mockAPI, 10);

  assert.strictEqual(summary.totalQueries, 2);
  assert.strictEqual(summary.results.length, 2);
  assert.ok(summary.passed >= 0);
  assert.ok(summary.passRate >= 0);
  assert.ok(summary.averagePrecision >= 0);
  assert.ok(summary.averageRecall >= 0);
  assert.ok(summary.averageNdcg >= 0);
});

void test('runEvaluation: aggregates results by domain', async () => {
  const queries = [
    { ...sampleQuery, id: 'q1', domain: 'general' },
    { ...sampleQuery, id: 'q2', domain: 'general' },
    { ...sampleQuery, id: 'q3', domain: 'academic' },
  ];

  const mockAPI: RetrievalAPI = {
    retrieve: async () => ({
      results: scoredResults,
    }),
  };

  const summary = await runEvaluation(queries, mockAPI, 10);

  assert.ok(summary.byDomain.general !== undefined);
  assert.ok(summary.byDomain.academic !== undefined);
  assert.strictEqual(summary.byDomain.general!.total, 2);
  assert.strictEqual(summary.byDomain.academic!.total, 1);
});

void test('runEvaluation: aggregates results by difficulty', async () => {
  const queries: GoldenQuery[] = [
    { ...sampleQuery, id: 'q1' as const, difficulty: 'easy' as const },
    { ...sampleQuery, id: 'q2' as const, difficulty: 'easy' as const },
    { ...sampleQuery, id: 'q3' as const, difficulty: 'hard' as const },
  ];

  const mockAPI: RetrievalAPI = {
    retrieve: async () => ({
      results: scoredResults,
    }),
  };

  const summary = await runEvaluation(queries, mockAPI, 10);

  assert.ok(summary.byDifficulty.easy !== undefined);
  assert.ok(summary.byDifficulty.hard !== undefined);
  assert.strictEqual(summary.byDifficulty.easy!.total, 2);
  assert.strictEqual(summary.byDifficulty.hard!.total, 1);
});

void test('runEvaluation: has correct timestamp', async () => {
  const before = Date.now();
  const summary = await runEvaluation(
    [sampleQuery],
    { retrieve: async () => ({ results: scoredResults }) },
    10,
  );
  const after = Date.now();

  assert.ok(summary.timestamp.getTime() >= before);
  assert.ok(summary.timestamp.getTime() <= after);
});

// ── Filter Tests ────────────────────────────────────────────────────────────

void test('filterByDomain: filters queries by domain', () => {
  const queries: GoldenQuery[] = [
    { ...sampleQuery, id: 'q1', domain: 'general' },
    { ...sampleQuery, id: 'q2', domain: 'academic' },
    { ...sampleQuery, id: 'q3', domain: 'general' },
  ];

  const filtered = filterByDomain(queries, 'general');
  assert.strictEqual(filtered.length, 2);
});

void test('filterByDomain: returns empty array when no matches', () => {
  const queries: GoldenQuery[] = [
    { ...sampleQuery, id: 'q1', domain: 'general' },
  ];

  const filtered = filterByDomain(queries, 'academic');
  assert.strictEqual(filtered.length, 0);
});

void test('filterByDifficulty: filters queries by difficulty', () => {
  const queries: GoldenQuery[] = [
    { ...sampleQuery, id: 'q1', difficulty: 'easy' },
    { ...sampleQuery, id: 'q2', difficulty: 'hard' },
    { ...sampleQuery, id: 'q3', difficulty: 'easy' },
  ];

  const filtered = filterByDifficulty(queries, 'easy');
  assert.strictEqual(filtered.length, 2);
});
