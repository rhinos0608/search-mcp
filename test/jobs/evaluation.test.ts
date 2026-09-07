import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  EvalLabel,
  EvalManifest,
  EvalQuery,
  FrozenCorpus,
  GradedRelevance,
  PairwiseLabel,
} from '../../src/jobs/evaluation/types.js';
import { EVALUATION_CONTRACT_VERSION } from '../../src/jobs/evaluation/types.js';
import { canonicalJson, sha256Hex, computeManifestHash } from '../../src/jobs/evaluation/hashes.js';
import {
  precisionAtK,
  recallAtK,
  ndcgAtK,
  fixedBudgetRecall,
  pairwiseAccuracy,
  evaluateQuery,
  evaluateSuite,
} from '../../src/jobs/evaluation/metrics.js';
import { freezeCorpus, verifyManifest, assertNoLeakage } from '../../src/jobs/evaluation/corpus.js';
import { evaluateQualityGates } from '../../src/jobs/evaluation/gates.js';
import type { RankedItem } from '../../src/jobs/evaluation/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeQuery(overrides: Partial<EvalQuery> & Pick<EvalQuery, 'queryId'>): EvalQuery {
  return {
    suiteId: 'generic',
    intentFingerprint: sha256Hex('intent-' + overrides.queryId),
    intent: {},
    identityClusterId: 'cluster-a',
    asOf: '2024-01-01T00:00:00+00:00',
    split: 'test',
    category: 'general',
    kPrecision: 10,
    kRecall: 20,
    kNdcg: 10,
    fixedBudget: 50,
    ...overrides,
  };
}

function makeManifest(overrides?: Partial<EvalManifest>): EvalManifest {
  return {
    schemaVersion: EVALUATION_CONTRACT_VERSION,
    corpusId: 'test-corpus',
    suiteId: 'generic',
    suiteVersion: '1.0.0',
    status: 'draft',
    documents: [],
    queries: [],
    labels: [],
    splits: { train: [], dev: [], test: [] },
    revisions: {
      gitCommit: 'abc123',
      schemaVersion: '1.0.0',
      policyRevision: '1.0.0',
      rankingVersion: '1.0.0',
      packVersions: [],
      adapterVersions: [],
      fixtureVersion: '1.0.0',
      runtimeRevision: 'node-1.0.0',
    },
    manifestHash: '',
    ...overrides,
  };
}

function makeCorpus(overrides?: Partial<FrozenCorpus>): FrozenCorpus {
  return {
    manifest: makeManifest(),
    documents: [],
    queries: [],
    labels: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Hash tests
// ---------------------------------------------------------------------------

test('canonicalJson sorts keys', () => {
  const result = JSON.parse(canonicalJson({ b: 2, a: 1 }));
  const keys = Object.keys(result);
  assert.deepStrictEqual(keys, ['a', 'b']);
});

test('canonicalJson drops undefined', () => {
  const result = JSON.parse(canonicalJson({ a: 1, b: undefined }));
  assert.deepStrictEqual(result, { a: 1 });
});

test('canonicalJson preserves array order', () => {
  const result = JSON.parse(canonicalJson([3, 1, 2]));
  assert.deepStrictEqual(result, [3, 1, 2]);
});

test('sha256Hex is deterministic', () => {
  const a = sha256Hex('hello');
  const b = sha256Hex('hello');
  assert.strictEqual(a, b);
  assert.strictEqual(a.length, 64);
});

test('computeManifestHash matches manual', () => {
  const m = makeManifest({ manifestHash: '' });
  const computed = computeManifestHash(m);
  assert.strictEqual(computed.length, 64);
  assert.notStrictEqual(computed, '');
});

// ---------------------------------------------------------------------------
// Metric tests
// ---------------------------------------------------------------------------

test('precisionAtK basic', () => {
  const retrieved: RankedItem[] = [
    { documentId: 'd1', rank: 1 },
    { documentId: 'd2', rank: 2 },
    { documentId: 'd3', rank: 3 },
    { documentId: 'd4', rank: 4 },
  ];
  const relevant = new Set(['d1', 'd3']);
  assert.strictEqual(precisionAtK(retrieved, relevant, 4), 0.5);
});

test('precisionAtK empty retrieval', () => {
  assert.strictEqual(precisionAtK([], new Set(['d1']), 10), 0);
});

test('recallAtK basic', () => {
  const retrieved: RankedItem[] = [
    { documentId: 'd1', rank: 1 },
    { documentId: 'd2', rank: 2 },
  ];
  const relevant = new Set(['d1', 'd2', 'd3']);
  assert.strictEqual(recallAtK(retrieved, relevant, 10), 2 / 3);
});

test('recallAtK no relevant docs', () => {
  const retrieved: RankedItem[] = [{ documentId: 'd1', rank: 1 }];
  assert.strictEqual(recallAtK(retrieved, new Set(), 10), 0);
});

test('ndcgAtK ideal list = 1.0', () => {
  const retrieved: RankedItem[] = [
    { documentId: 'd1', rank: 1 },
    { documentId: 'd2', rank: 2 },
  ];
  const grades = new Map<string, GradedRelevance>([
    ['d1', 3],
    ['d2', 2],
  ]);
  assert.strictEqual(ndcgAtK(retrieved, grades, 10), 1.0);
});

test('ndcgAtK reversed list < 1.0', () => {
  const retrieved: RankedItem[] = [
    { documentId: 'd1', rank: 1 },
    { documentId: 'd2', rank: 2 },
  ];
  const grades = new Map<string, GradedRelevance>([
    ['d1', 1],
    ['d2', 3],
  ]);
  const score = ndcgAtK(retrieved, grades, 10);
  assert.ok(score < 1.0);
  assert.ok(score > 0);
});

test('ndcgAtK unlabeled docs excluded', () => {
  const retrieved: RankedItem[] = [
    { documentId: 'd1', rank: 1 },
    { documentId: 'unlabeled', rank: 2 },
  ];
  const grades = new Map<string, GradedRelevance>([['d1', 3]]);
  const score = ndcgAtK(retrieved, grades, 10);
  assert.ok(score > 0);
});

test('fixedBudgetRecall basic', () => {
  const retrieved: RankedItem[] = [
    { documentId: 'd1', rank: 1 },
    { documentId: 'd2', rank: 2 },
    { documentId: 'd3', rank: 3 },
  ];
  const relevant = new Set(['d1', 'd3', 'd4']);
  assert.strictEqual(fixedBudgetRecall(retrieved, relevant, 3), 2 / 3);
});

test('pairwiseAccuracy basic', () => {
  const retrieved: RankedItem[] = [
    { documentId: 'd1', rank: 1 },
    { documentId: 'd2', rank: 2 },
  ];
  const pairs: PairwiseLabel[] = [
    {
      kind: 'pairwise',
      queryId: 'q1',
      preferredDocumentId: 'd1',
      otherDocumentId: 'd2',
      annotator: 'a',
      labeledAt: '2024-01-01T00:00:00+00:00',
      utilityNotEligibility: true,
    },
  ];
  assert.strictEqual(pairwiseAccuracy(retrieved, pairs), 1.0);
});

test('pairwiseAccuracy loss on unranked', () => {
  const retrieved: RankedItem[] = [{ documentId: 'd1', rank: 1 }];
  const pairs: PairwiseLabel[] = [
    {
      kind: 'pairwise',
      queryId: 'q1',
      preferredDocumentId: 'd2',
      otherDocumentId: 'd1',
      annotator: 'a',
      labeledAt: '2024-01-01T00:00:00+00:00',
      utilityNotEligibility: true,
    },
  ];
  assert.strictEqual(pairwiseAccuracy(retrieved, pairs), 0);
});

// ---------------------------------------------------------------------------
// evaluateQuery tests
// ---------------------------------------------------------------------------

test('evaluateQuery handles unlabeled count', () => {
  const query = makeQuery({ queryId: 'q1' });
  const retrieved: RankedItem[] = [
    { documentId: 'd1', rank: 1 },
    { documentId: 'd2', rank: 2 },
    { documentId: 'unlabeled', rank: 3 },
  ];
  const labels: EvalLabel[] = [
    {
      kind: 'binary',
      queryId: 'q1',
      documentId: 'd1',
      relevant: true,
      annotator: 'a',
      labeledAt: '2024-01-01T00:00:00+00:00',
    },
    {
      kind: 'binary',
      queryId: 'q1',
      documentId: 'd2',
      relevant: false,
      annotator: 'a',
      labeledAt: '2024-01-01T00:00:00+00:00',
    },
  ];
  const metrics = evaluateQuery(query, retrieved, labels);
  assert.strictEqual(metrics.unlabeledCount, 1);
  assert.strictEqual(metrics.labeledRelevantCount, 1);
});

// ---------------------------------------------------------------------------
// Freeze / verify tests
// ---------------------------------------------------------------------------

test('verifyManifest passes for valid draft', () => {
  const m = makeManifest();
  m.manifestHash = computeManifestHash(m);
  const corpus = makeCorpus({ manifest: m });
  assert.doesNotThrow(() => verifyManifest(corpus));
});

test('verifyManifest throws on hash mismatch', () => {
  const m = makeManifest({ manifestHash: 'badhash' });
  const corpus = makeCorpus({ manifest: m });
  assert.throws(() => verifyManifest(corpus), /manifestHash mismatch/);
});

test('freezeCorpus sets status and freezes', () => {
  const m = makeManifest();
  m.manifestHash = computeManifestHash(m);
  const corpus = makeCorpus({ manifest: m });
  const frozen = freezeCorpus(corpus, '2024-01-01T00:00:00+00:00');
  assert.strictEqual(frozen.manifest.status, 'frozen');
  assert.ok(frozen.manifest.frozenAt);
  assert.ok(Object.isFrozen(frozen));
});

test('assertNoLeakage passes for disjoint clusters', () => {
  const m = makeManifest({
    splits: {
      train: ['q1'],
      dev: [],
      test: ['q2'],
    },
  });
  m.manifestHash = computeManifestHash(m);
  const corpus = makeCorpus({
    manifest: m,
    queries: [
      makeQuery({ queryId: 'q1', identityClusterId: 'c1', split: 'train' }),
      makeQuery({ queryId: 'q2', identityClusterId: 'c2', split: 'test' }),
    ],
  });
  assert.doesNotThrow(() => assertNoLeakage(corpus));
});

test('assertNoLeakage throws on shared cluster', () => {
  const m = makeManifest({
    splits: {
      train: ['q1'],
      dev: [],
      test: ['q2'],
    },
  });
  m.manifestHash = computeManifestHash(m);
  const corpus = makeCorpus({
    manifest: m,
    queries: [
      makeQuery({ queryId: 'q1', identityClusterId: 'c1', split: 'train' }),
      makeQuery({ queryId: 'q2', identityClusterId: 'c1', split: 'test' }),
    ],
  });
  assert.throws(() => assertNoLeakage(corpus), /EVAL_LEAKAGE/);
});

// ---------------------------------------------------------------------------
// evaluateSuite tests
// ---------------------------------------------------------------------------

test('evaluateSuite returns test-only metrics', () => {
  const m = makeManifest({
    splits: { train: ['q1'], dev: [], test: ['q2'] },
  });
  m.manifestHash = computeManifestHash(m);
  const corpus = makeCorpus({
    manifest: m,
    queries: [
      makeQuery({ queryId: 'q1', split: 'train', identityClusterId: 'c1' }),
      makeQuery({ queryId: 'q2', split: 'test', identityClusterId: 'c2' }),
    ],
    labels: [
      {
        kind: 'binary',
        queryId: 'q2',
        documentId: 'd1',
        relevant: true,
        annotator: 'a',
        labeledAt: '2024-01-01T00:00:00+00:00',
      },
    ],
  });
  const retrieve = (q: EvalQuery): RankedItem[] => {
    if (q.queryId === 'q2') {
      return [{ documentId: 'd1', rank: 1 }];
    }
    return [];
  };
  const metrics = evaluateSuite(corpus, retrieve);
  assert.strictEqual(metrics.split, 'test');
  assert.strictEqual(metrics.queryCount, 1);
  assert.strictEqual(metrics.perQuery.length, 1);
});

// ---------------------------------------------------------------------------
// Quality gates tests
// ---------------------------------------------------------------------------

test('evaluateQualityGates returns all findings', () => {
  const report = evaluateQualityGates({
    checkpoint: 'D',
    corpora: [],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
  });
  assert.strictEqual(report.schemaVersion, EVALUATION_CONTRACT_VERSION);
  assert.ok(report.findings.length > 0);
});

test('D.retention_encryption is not_applicable (passing)', () => {
  const report = evaluateQualityGates({
    checkpoint: 'D',
    corpora: [],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
  });
  const retFinding = report.findings.find((f) => f.gateId === 'D.retention_encryption');
  assert.ok(retFinding);
  assert.ok(retFinding.passed);
});

test('D17.success_rate fails below threshold', () => {
  const report = evaluateQualityGates({
    checkpoint: 'D',
    corpora: [],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 0.9 },
  });
  const srFinding = report.findings.find((f) => f.gateId === 'D17.success_rate');
  assert.ok(srFinding);
  assert.ok(!srFinding.passed);
});

test('evaluateQualityGates checkpoint B lifecycle gate passes', () => {
  const report = evaluateQualityGates({
    checkpoint: 'B',
    corpora: [],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
  });
  const lifecycle = report.findings.find((f) => f.gateId === 'B.lifecycle');
  assert.ok(lifecycle);
  assert.ok(lifecycle.passed);
});
