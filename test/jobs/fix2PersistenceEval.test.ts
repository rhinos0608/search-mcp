import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateQualityGates } from '../../src/jobs/evaluation/gates.js';

const base = {
  checkpoint: 'D' as const,
  corpora: [],
  metrics: [],
  runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
};

test('inactive retention is not applicable without turning finding into a pass', () => {
  const report = evaluateQualityGates({
    ...base,
    extras: {
      profilePersistenceEvidence: {
        inactiveProfileAttestation: true,
        noProductionStoreWiring: true,
        noWriteAction: true,
        requestScopedOnly: true,
        zeroPersistence: true,
        reusableHandle: false,
      },
    },
  });
  const retention = report.findings.find((finding) => finding.gateId === 'D.retention_encryption');
  assert.ok(retention);
  assert.equal(retention.passed, false);
  assert.equal(report.gateApplicability[retention.gateId], 'not_applicable');
});

test('missing inactive-profile attestation keeps retention applicable', () => {
  const report = evaluateQualityGates({
    ...base,
    extras: {
      profilePersistenceEvidence: {
        noProductionStoreWiring: true,
        noWriteAction: true,
        requestScopedOnly: true,
        zeroPersistence: true,
        reusableHandle: false,
      },
    },
  });
  assert.equal(report.gateApplicability['D.retention_encryption'], 'applicable');
});

test('quality gates reject metrics whose corpus is not supplied', () => {
  const report = evaluateQualityGates({
    ...base,
    metrics: [
      {
        corpusId: 'unknown-corpus',
        suiteId: 'generic',
        suiteVersion: '1.0.0',
        manifestHash: 'hash',
        split: 'test',
        queryCount: 1,
        byCategory: {},
        perQuery: [
          {
            queryId: 'query-1',
            category: 'general',
            split: 'test',
            unlabeledCount: 0,
            labeledRelevantCount: 1,
            precisionAt10: 1,
            recallAt20: 1,
            ndcgAt10: 1,
            fixedBudgetRecall: 1,
          },
        ],
        macro: { precisionAt10: 1, recallAt20: 1, ndcgAt10: 1, fixedBudgetRecall: 1 },
      },
    ],
  });
  const finding = report.findings.find((item) => item.gateId === 'EVAL_METRICS');
  assert.ok(finding);
  assert.equal(finding.passed, false);
});

import { EVALUATION_CONTRACT_VERSION, type FrozenCorpus } from '../../src/jobs/evaluation/types.js';

const matchingCorpus: FrozenCorpus = {
  manifest: {
    schemaVersion: EVALUATION_CONTRACT_VERSION,
    corpusId: 'corpus',
    suiteId: 'generic',
    suiteVersion: '1.0.0',
    status: 'frozen',
    documents: [],
    queries: [{ queryId: 'q1', intentFingerprint: 'x' as never }],
    labels: [{ labelId: 'l1', contentHash: 'x' as never }],
    splits: { train: [], dev: [], test: ['q1'] },
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
    manifestHash: 'hash' as never,
  },
  documents: [],
  queries: [
    {
      queryId: 'q1',
      suiteId: 'generic',
      intentFingerprint: 'x' as never,
      intent: {},
      identityClusterId: 'cluster-1',
      asOf: '2024-01-01T00:00:00+00:00',
      split: 'test',
      category: 'general',
      kPrecision: 10,
      kRecall: 20,
      kNdcg: 10,
      fixedBudget: 20,
    },
  ],
  labels: [
    {
      kind: 'binary',
      queryId: 'q1',
      documentId: 'd1',
      relevant: true,
      annotator: 'test',
      labeledAt: '2024-01-01T00:00:00+00:00',
    },
  ],
};

test('quality gates reject non-finite suite metrics', () => {
  const report = evaluateQualityGates({
    ...base,
    corpora: [matchingCorpus],
    metrics: [
      {
        corpusId: 'corpus',
        suiteId: 'generic',
        suiteVersion: '1.0.0',
        manifestHash: 'hash' as never,
        split: 'test',
        queryCount: 1,
        byCategory: {},
        perQuery: [
          {
            queryId: 'q1',
            category: 'general',
            split: 'test',
            unlabeledCount: 0,
            labeledRelevantCount: 1,
            precisionAt10: 1,
            recallAt20: 1,
            ndcgAt10: 1,
            fixedBudgetRecall: 1,
          },
        ],
        macro: { precisionAt10: Number.NaN, recallAt20: 0, ndcgAt10: 0, fixedBudgetRecall: 0 },
      },
    ],
  });
  const finding = report.findings.find((item) => item.gateId === 'EVAL_METRICS');
  assert.ok(finding);
  assert.equal(finding.passed, false);
});

test('quality gates accept finite suite metrics matching corpus', () => {
  const report = evaluateQualityGates({
    ...base,
    corpora: [matchingCorpus],
    metrics: [
      {
        corpusId: 'corpus',
        suiteId: 'generic',
        suiteVersion: '1.0.0',
        manifestHash: 'hash' as never,
        split: 'test',
        queryCount: 1,
        byCategory: {},
        perQuery: [
          {
            queryId: 'q1',
            category: 'general',
            split: 'test',
            unlabeledCount: 0,
            labeledRelevantCount: 1,
            precisionAt10: 1,
            recallAt20: 1,
            ndcgAt10: 1,
            fixedBudgetRecall: 1,
          },
        ],
        macro: { precisionAt10: 1, recallAt20: 1, ndcgAt10: 1, fixedBudgetRecall: 1 },
      },
    ],
  });
  const finding = report.findings.find((item) => item.gateId === 'EVAL_METRICS');
  assert.ok(finding);
  assert.equal(finding.passed, true);
});
