import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateQualityGates } from '../../src/jobs/evaluation/gates.js';
import type { CheckpointEvidence, FrozenCorpus } from '../../src/jobs/evaluation/types.js';
import { EVALUATION_CONTRACT_VERSION } from '../../src/jobs/evaluation/types.js';

function baseCorpus(overrides: Partial<FrozenCorpus['manifest']> = {}): FrozenCorpus {
  return {
    manifest: {
      schemaVersion: EVALUATION_CONTRACT_VERSION,
      corpusId: 'test-corpus',
      suiteId: 'generic',
      suiteVersion: '1.0.0',
      status: 'frozen',
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
      manifestHash: 'x',
      ...overrides,
    },
    documents: [],
    queries: [],
    labels: [],
  };
}

function frozenDoc(docId: string, immutable = true): FrozenCorpus['documents'][number] {
  return {
    documentId: docId,
    identityClusterId: 'cluster-a',
    sourceListingIds: ['listing-1'],
    observationIds: ['obs-1'],
    contentHash: 'a'.repeat(64),
    capturedAt: '2024-01-01T00:00:00+00:00',
    asOf: '2024-01-01T00:00:00+00:00',
    fixturePath: 'documents/a.json',
    immutable,
  };
}

test('RED: A.immutable_observations fails when a frozen doc lacks immutable marker', () => {
  const corpus = baseCorpus();
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [
      {
        ...corpus,
        documents: [frozenDoc('d1', false)],
      },
    ],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
  });
  const finding = report.findings.find((f) => f.gateId === 'A.immutable_observations');
  assert.ok(finding, 'gate must exist');
  assert.equal(finding.passed, false, 'mutable frozen doc must fail the gate');
});

test('RED: A.generic_core fails when packs carry locale defaults as authority', () => {
  const corpus = baseCorpus();
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [corpus],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: {
      localeDefaults: [{ packId: 'au-nsw-sydney', requiredAuthority: true }],
    },
  });
  const finding = report.findings.find((f) => f.gateId === 'A.generic_core');
  assert.ok(finding, 'gate must exist');
  assert.equal(finding.passed, false, 'required locale authority must fail generic core');
});

test('telemetry aggregate scalars pass (errorCount is not a leak)', () => {
  const corpus = baseCorpus();
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [{ ...corpus, documents: [frozenDoc('d1')] }],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: {
      ...cleanExtras(),
      telemetryFixtures: [{ name: 'run-1', payload: { errorCount: 3, counts: 5 } }],
    },
  });
  const finding = report.findings.find((f) => f.gateId === 'A.telemetry_privacy');
  assert.ok(finding);
  assert.equal(finding.passed, true, 'aggregate counts carry no raw material');
});

test('telemetry empty-suspect values pass (errorMessage null/empty)', () => {
  const corpus = baseCorpus();
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [{ ...corpus, documents: [frozenDoc('d1')] }],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: {
      ...cleanExtras(),
      telemetryFixtures: [{ name: 'run-1', payload: { errorMessage: null, rawQuery: '' } }],
    },
  });
  const finding = report.findings.find((f) => f.gateId === 'A.telemetry_privacy');
  assert.ok(finding);
  assert.equal(finding.passed, true, 'empty suspect values carry no raw material');
});

test('RED: A.telemetry_privacy fails when telemetry fixture leaks raw query', () => {
  const corpus = baseCorpus();
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [corpus],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: {
      telemetryFixtures: [{ name: 'run-1', payload: { rawQuery: 'secret query' } }],
    },
  });
  const finding = report.findings.find((f) => f.gateId === 'A.telemetry_privacy');
  assert.ok(finding, 'gate must exist');
  assert.equal(finding.passed, false, 'raw query in telemetry must fail privacy gate');
});

function cleanExtras(): CheckpointEvidence {
  return {
    localeDefaults: [],
    telemetryFixtures: [{ name: 'run-1', payload: { counts: 3 } }],
    policyEdges: [
      { edgeId: 'e1', decidedBy: 'policy-registry', adapterDefined: false, state: 'permitted' },
      { edgeId: 'e2', decidedBy: 'policy-registry', adapterDefined: false, state: 'blocked' },
    ],
    manualImportRuns: [
      {
        contentKind: 'url_only',
        fetchPermitted: false,
        status: 'content_required',
        fetched: false,
      },
    ],
    multiSourcePostings: [{ sourceListingIds: ['listing-1', 'listing-2'] }],
  };
}

test('A.independent_policy fails when evidence missing', () => {
  const corpus = baseCorpus();
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [{ ...corpus, documents: [frozenDoc('d1')] }],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: { ...cleanExtras(), policyEdges: [] },
  });
  const finding = report.findings.find((f) => f.gateId === 'A.independent_policy');
  assert.ok(finding);
  assert.equal(finding.passed, false, 'absent policy evidence must fail required P0 gate');
});

test('A.independent_policy fails when edge is adapter-defined', () => {
  const corpus = baseCorpus();
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [{ ...corpus, documents: [frozenDoc('d1')] }],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: {
      ...cleanExtras(),
      policyEdges: [
        { edgeId: 'e1', decidedBy: 'jobspy-adapter', adapterDefined: true, state: 'permitted' },
      ],
    },
  });
  const finding = report.findings.find((f) => f.gateId === 'A.independent_policy');
  assert.ok(finding);
  assert.equal(finding.passed, false, 'adapter-defined edge must fail independence gate');
});

test('A.manual_import fails when evidence missing', () => {
  const corpus = baseCorpus();
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [{ ...corpus, documents: [frozenDoc('d1')] }],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: { ...cleanExtras(), manualImportRuns: [] },
  });
  const finding = report.findings.find((f) => f.gateId === 'A.manual_import');
  assert.ok(finding);
  assert.equal(finding.passed, false, 'absent manual-import evidence must fail required P1 gate');
});

test('A.manual_import fails when run fetched instead of content_required', () => {
  const corpus = baseCorpus();
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [{ ...corpus, documents: [frozenDoc('d1')] }],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: {
      ...cleanExtras(),
      manualImportRuns: [
        { contentKind: 'url_only', fetchPermitted: true, status: 'imported', fetched: true },
      ],
    },
  });
  const finding = report.findings.find((f) => f.gateId === 'A.manual_import');
  assert.ok(finding);
  assert.equal(finding.passed, false, 'fetched manual run must fail content_required gate');
});

test('A.multi_source_records fails when evidence missing or single-source', () => {
  const corpus = baseCorpus();
  for (const postings of [[], [{ sourceListingIds: ['listing-1'] }]]) {
    const report = evaluateQualityGates({
      checkpoint: 'A',
      corpora: [{ ...corpus, documents: [frozenDoc('d1')] }],
      metrics: [],
      runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
      extras: { ...cleanExtras(), multiSourcePostings: postings },
    });
    const finding = report.findings.find((f) => f.gateId === 'A.multi_source_records');
    assert.ok(finding);
    assert.equal(
      finding.passed,
      false,
      'absent/single-source evidence must fail multi-source gate',
    );
  }
});

test('A.multi_source_records passes with duplicate-id set of 2 collapsed to 1 fails, distinct 2 passes', () => {
  const corpus = baseCorpus();
  const dupes = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [{ ...corpus, documents: [frozenDoc('d1')] }],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: { ...cleanExtras(), multiSourcePostings: [{ sourceListingIds: ['a', 'a'] }] },
  });
  assert.equal(
    dupes.findings.find((f) => f.gateId === 'A.multi_source_records')?.passed,
    false,
    'duplicate ids are one source, must fail',
  );
  const good = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [{ ...corpus, documents: [frozenDoc('d1')] }],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: { ...cleanExtras() },
  });
  assert.equal(good.findings.find((f) => f.gateId === 'A.multi_source_records')?.passed, true);
});

test('A.telemetry_privacy scans whole fixture: root-level rawQuery fails', () => {
  const corpus = baseCorpus();
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [{ ...corpus, documents: [frozenDoc('d1')] }],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: {
      ...cleanExtras(),
      telemetryFixtures: [{ name: 'run-1', rawQuery: 'secret query' }],
    },
  });
  const finding = report.findings.find((f) => f.gateId === 'A.telemetry_privacy');
  assert.ok(finding);
  assert.equal(finding.passed, false, 'root-level rawQuery outside payload must fail');
});

test('A.telemetry_privacy fails when fixtures absent', () => {
  const corpus = baseCorpus();
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [{ ...corpus, documents: [frozenDoc('d1')] }],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: { ...cleanExtras(), telemetryFixtures: [] },
  });
  const finding = report.findings.find((f) => f.gateId === 'A.telemetry_privacy');
  assert.ok(finding);
  assert.equal(finding.passed, false, 'absent telemetry must fail required P0 gate');
});

test('A.immutable_observations fails when no documents at all', () => {
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [baseCorpus()],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: { ...cleanExtras() },
  });
  const finding = report.findings.find((f) => f.gateId === 'A.immutable_observations');
  assert.ok(finding);
  assert.equal(finding.passed, false, 'empty doc set must fail required P0 gate');
});

test('A gates pass on clean evidence', () => {
  const corpus = baseCorpus();
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [
      {
        ...corpus,
        documents: [frozenDoc('d1')],
      },
    ],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
    extras: { ...cleanExtras() },
  });
  for (const gateId of [
    'A.immutable_observations',
    'A.generic_core',
    'A.telemetry_privacy',
    'A.independent_policy',
    'A.manual_import',
    'A.multi_source_records',
  ]) {
    const finding = report.findings.find((f) => f.gateId === gateId);
    assert.ok(finding, `${gateId} must exist`);
    assert.equal(finding.passed, true, `${gateId} must pass on clean evidence`);
  }
});

test('D success rate stays applicable when inactive profile persistence is proven', () => {
  const report = evaluateQualityGates({
    checkpoint: 'D',
    corpora: [],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 0.9 },
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
  assert.equal(report.gateApplicability['D.success_rate'], 'applicable');
  assert.equal(report.findings.find((f) => f.gateId === 'D.success_rate')?.passed, false);
});

test('metrics gate rejects empty suite evidence', () => {
  const report = evaluateQualityGates({
    checkpoint: 'A',
    corpora: [],
    metrics: [],
    runIntegrity: { integrityFailures: 0, policyFailures: 0, successRate: 1 },
  });
  assert.equal(report.findings.find((f) => f.gateId === 'EVAL_METRICS')?.passed, false);
});
