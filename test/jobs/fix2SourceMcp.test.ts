import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACQUISITION_CONTRACT_VERSION,
  type AcquisitionPolicyEdge,
  type AcquisitionSlice,
} from '../../src/jobs/acquisition/contracts.js';
import {
  JOBSPY_ADAPTER_ID,
  JOBSPY_CAPABILITY,
  runJobSpyBoard,
} from '../../src/jobs/acquisition/adapters/jobspy.js';
import { AdapterCapabilityRegistry } from '../../src/jobs/acquisition/adapterRegistry.js';
import { SourcePolicyRegistry } from '../../src/jobs/acquisition/policy/registry.js';

const capturedAt = '2026-01-01T00:00:00.000Z';
const slice = {
  schemaVersion: ACQUISITION_CONTRACT_VERSION,
  runId: 'run-fix2',
  sliceId: 'slice-fix2',
  ordinal: 0,
  queryVariantId: 'qv-1',
  query: 'engineer',
  reason: 'fix2',
  adapterIds: [JOBSPY_ADAPTER_ID],
  localePackRefs: [],
  domainPackRefs: [],
  budget: {
    logicalRequests: 1,
    reservedAttempts: 1,
    candidates: 1,
    bytes: 1000,
    milliseconds: 1000,
  },
} as unknown as AcquisitionSlice;

function edge(state: 'permitted' | 'blocked', revision = 'rev-1'): AcquisitionPolicyEdge {
  return {
    edgeId: `edge-${state}` as never,
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    actor: { kind: 'adapter', namespace: 'adapter', id: JOBSPY_ADAPTER_ID },
    operation: 'automatedSearch',
    route: 'direct',
    target: { kind: 'board', sourceId: 'linkedin' },
    state,
    effect: 'authorized_operation',
    revision,
    evidenceRefs: [],
    reviewedAt: capturedAt,
  };
}

function policyRegistry(): SourcePolicyRegistry {
  return new SourcePolicyRegistry([
    {
      sourceId: 'linkedin',
      revision: 'rev-1',
      modes: {
        automatedSearch: 'permitted',
        automatedFetch: 'not_supported',
        userSuppliedContent: 'permitted',
        manualImport: 'permitted',
        employerApi: 'not_supported',
      },
      evidenceRefs: [],
      reviewedAt: capturedAt,
    },
  ]);
}

function deps(scrapeJobs: () => Promise<never>, withPolicy = true): Record<string, unknown> {
  return {
    capabilityRegistry: new AdapterCapabilityRegistry([JOBSPY_CAPABILITY]),
    ...(withPolicy ? { policyRegistry: policyRegistry() } : {}),
    scrapeJobs,
  };
}

test('fix2 missing JobSpy policy registry fails closed before scrape', async () => {
  let calls = 0;
  const result = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge('permitted'), capturedAt },
    deps(async () => {
      calls++;
      throw new Error('must not call');
    }, false) as never,
  );
  assert.equal(calls, 0);
  assert.equal(result.coverage[0]?.state, 'not_supported');
});

test('fix2 execution edge metadata mismatch fails closed before scrape', async () => {
  let calls = 0;
  const result = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge('permitted', 'stale-revision'), capturedAt },
    deps(async () => {
      calls++;
      throw new Error('must not call');
    }) as never,
  );
  assert.equal(calls, 0);
  assert.equal(result.coverage[0]?.state, 'not_supported');
});

import { projectJobsCandidate } from '../../src/tools/jobs/searchBuilder.js';
import type { JobsSearchCandidate } from '../../src/jobs/orchestration/searchContracts.js';

test('fix2 MCP candidate mapping exposes bounded source provenance', () => {
  const rawCandidate: JobsSearchCandidate = {
    candidateId: 'cand-1',
    rank: 1,
    title: 'Senior Engineer',
    organisation: 'GovNSW',
    utility: 0.95,
    coverage: 0.8,
    confidence: 0.9,
    eligibility: 'eligible',
    eligibilityGates: [],
    evidenceState: 'indexed_only',
    flags: [],
    caveats: [],
    evidenceRefs: [],
    provenance: Array.from({ length: 8 }, () => 'indexed' as const),
    sourceListingIds: Array.from({ length: 20 }, (_, i) => `listing-${i}`),
    observationIds: Array.from({ length: 20 }, (_, i) => `obs-${i}`),
    profileApplied: false,
    identityDecisionRevision: '1',
    retrievalMetadata: {
      rrfRank: 1,
      rrfScore: 0.5,
      scoredChannelCount: 1,
      textBm25Score: 1,
    },
    groupScores: {
      relevance: 1,
      candidateFit: 1,
      preferenceFit: 1,
      marketState: 1,
      evidenceQuality: 1,
      personalAdaptation: 1,
    },
  };
  const projected = projectJobsCandidate(rawCandidate);
  assert.equal(projected.provenance.length, 8);
  assert.equal(projected.sourceListingIds.length, 16);
  assert.equal(projected.observationIds.length, 16);
  assert.equal(projected.evidenceState, 'indexed_only');
});
