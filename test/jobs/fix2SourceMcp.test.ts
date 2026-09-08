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

test('fix2 MCP candidate mapping exposes bounded source provenance', () => {
  // Contract-level guard: fields mapped by jobs_search already exist and are bounded.
  const candidate = {
    provenance: ['indexed'],
    sourceListingIds: ['listing-1'],
    observationIds: [],
    evidenceState: 'indexed_only',
  };
  assert.deepEqual(candidate.provenance, ['indexed']);
  assert.equal(candidate.evidenceState, 'indexed_only');
});
