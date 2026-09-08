import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  JOBSPY_ADAPTER_ID,
  JOBSPY_ADAPTER_VERSION,
  JOBSPY_BOARDS,
  DEFAULT_JOBSPY_BOARDS,
  JOBSPY_CAPABILITY,
  runJobSpyBoard,
  type JobSpyBoardRequest,
  type JobSpyScrapeResult,
} from '../../src/jobs/acquisition/adapters/jobspy.js';
import { AdapterCapabilityRegistry } from '../../src/jobs/acquisition/adapterRegistry.js';
import { SourcePolicyRegistry } from '../../src/jobs/acquisition/policy/registry.js';
import { ADAPTER_CAPABILITY_CONTRACT_VERSION } from '../../src/jobs/acquisition/adapterCapability.js';
import {
  ACQUISITION_CONTRACT_VERSION,
  AcquisitionSliceResultSchema,
} from '../../src/jobs/acquisition/contracts.js';
import {
  deterministicAcquisitionId,
  acquiredContentHash,
} from '../../src/jobs/acquisition/adapterSupport.js';

// helpers
function makeSlice(overrides: Partial<Record<string, unknown>> = {}) {
  const base: Record<string, unknown> = {
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    runId: 'run-1',
    sliceId: 'slice-1',
    ordinal: 0,
    queryVariantId: 'qv-1',
    query: 'software engineer',
    reason: 'test',
    adapterIds: [JOBSPY_ADAPTER_ID],
    localePackRefs: [],
    domainPackRefs: [],
    budget: {
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 10,
      bytes: 100000,
      milliseconds: 70000,
    },
  };
  return {
    ...base,
    ...overrides,
  } as unknown as import('../../src/jobs/acquisition/contracts.js').AcquisitionSlice;
}

function makeEdge(
  board: string,
  state: string,
  effect = 'authorized_operation',
): import('../../src/jobs/acquisition/contracts.js').AcquisitionPolicyEdge {
  return {
    edgeId: `edge-${board}-${state}` as never,
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    actor: { kind: 'adapter', namespace: 'adapter', id: JOBSPY_ADAPTER_ID },
    operation: 'automatedSearch',
    route: 'direct',
    target: { kind: 'board', sourceId: board },
    state: state as never,
    effect: effect as never,
    revision: 'rev-1',
    evidenceRefs: [],
    reviewedAt: new Date().toISOString(),
  };
}

function registryWithCapability(): AdapterCapabilityRegistry {
  return new AdapterCapabilityRegistry([JOBSPY_CAPABILITY]);
}
function emptyRegistry(): AdapterCapabilityRegistry {
  return new AdapterCapabilityRegistry([]);
}

function makeDeps(
  registry: AdapterCapabilityRegistry,
  fn: (params: Record<string, unknown>) => Promise<JobSpyScrapeResult>,
) {
  return {
    capabilityRegistry: registry,
    policyRegistry: new SourcePolicyRegistry(
      JOBSPY_BOARDS.map((sourceId) => ({
        sourceId,
        revision: 'rev-1',
        modes: {
          automatedSearch: 'permitted' as const,
          automatedFetch: 'not_supported' as const,
          userSuppliedContent: 'permitted' as const,
          manualImport: 'permitted' as const,
          employerApi: 'not_supported' as const,
        },
        evidenceRefs: [],
        reviewedAt: '2026-01-01T00:00:00.000Z',
      })),
    ),
    scrapeJobs: fn,
  };
}

function flatRecord(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'rec-123',
    site: 'linkedin',
    job_url: 'https://example.com/jobs/123',
    title: 'Software Engineer',
    company: 'Acme',
    location: 'SF',
    description: 'Build stuff',
    ...overrides,
  };
}

// ----- constants -----
test('JOBSPY_ADAPTER_ID and VERSION frozen', () => {
  assert.equal(JOBSPY_ADAPTER_ID, 'jobspy');
  assert.equal(JOBSPY_ADAPTER_VERSION, '1.7.0');
});

test('JOBSPY_BOARDS exact ordered list', () => {
  assert.deepEqual(
    [...JOBSPY_BOARDS],
    [
      'linkedin',
      'indeed',
      'zip_recruiter',
      'glassdoor',
      'google',
      'google_careers',
      'bayt',
      'naukri',
      'bdjobs',
    ],
  );
});

test('DEFAULT_JOBSPY_BOARDS exact', () => {
  assert.deepEqual([...DEFAULT_JOBSPY_BOARDS], []);
});

test('JOBSPY_CAPABILITY exact triple automatedSearch/direct/board', () => {
  assert.equal(JOBSPY_CAPABILITY.schemaVersion, ADAPTER_CAPABILITY_CONTRACT_VERSION);
  assert.equal(JOBSPY_CAPABILITY.adapterId, JOBSPY_ADAPTER_ID);
  assert.equal(JOBSPY_CAPABILITY.adapterVersion, JOBSPY_ADAPTER_VERSION);
  assert.equal(JOBSPY_CAPABILITY.edges.length, 1);
  assert.deepEqual(JOBSPY_CAPABILITY.edges[0], {
    operation: 'automatedSearch',
    route: 'direct',
    targetKind: 'board',
  });
});

// ----- capability missing -> zero calls -----
test('missing capability makes zero scrape calls and not_supported coverage', async () => {
  let calls = 0;
  const deps = makeDeps(emptyRegistry(), async () => {
    calls++;
    return { jobs: [], totalScraped: 0, newCount: 0 };
  });
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(calls, 0);
  assert.equal(res.coverage.length, 1);
  assert.equal(res.coverage[0]!.state, 'not_supported');
  assert.equal(res.candidates.length, 0);
  AcquisitionSliceResultSchema.parse(res);
});

// ----- non-permitted states zero calls -----
for (const state of [
  'blocked',
  'requires_configuration',
  'requires_review',
  'not_supported',
] as const) {
  test(`non-permitted state ${state} makes zero scrape calls`, async () => {
    let calls = 0;
    const deps = makeDeps(registryWithCapability(), async () => {
      calls++;
      return { jobs: [], totalScraped: 0, newCount: 0 };
    });
    const slice = makeSlice();
    const edge = makeEdge('linkedin', state);
    const res = await runJobSpyBoard(
      { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
      deps,
    );
    assert.equal(calls, 0, `state ${state} should make zero calls`);
    AcquisitionSliceResultSchema.parse(res);
    if (state === 'blocked') assert.equal(res.coverage[0]!.state, 'policy_blocked');
    else if (state === 'requires_configuration' || state === 'requires_review')
      assert.equal(res.coverage[0]!.state, 'disabled');
    else assert.equal(res.coverage[0]!.state, 'not_supported');
    assert.equal(res.coverage[0]!.policyEdgeRefs[0], edge.edgeId);
    assert.equal(res.policyEdges[0]!.edgeId, edge.edgeId);
  });
}

test('blocked SEEK edge not permitted still zero calls (policy_blocked)', async () => {
  // simulate blocked linkedin board edge even though board seek not in jobspy boards, we test linkedin blocked
  let calls = 0;
  const deps = makeDeps(registryWithCapability(), async () => {
    calls++;
    return { jobs: [], totalScraped: 0, newCount: 0 };
  });
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'blocked');
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(calls, 0);
  assert.equal(res.coverage[0]!.state, 'policy_blocked');
});

// ----- one board per invocation -----
test('one call contains exactly one board', async () => {
  const captured: Record<string, unknown>[] = [];
  const deps = makeDeps(registryWithCapability(), async (p) => {
    captured.push(p);
    return { jobs: [flatRecord() as never], totalScraped: 1, newCount: 1 };
  });
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]!['site_name'], ['linkedin']);
});

test('unsupported board rejects before call', async () => {
  let calls = 0;
  const deps = makeDeps(registryWithCapability(), async () => {
    calls++;
    return { jobs: [], totalScraped: 0, newCount: 0 };
  });
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  await assert.rejects(() =>
    runJobSpyBoard(
      {
        slice,
        board: 'seek' as unknown as never,
        executionEdge: edge,
        capturedAt: new Date().toISOString(),
      } as unknown as JobSpyBoardRequest,
      deps,
    ),
  );
  assert.equal(calls, 0);
});

test('execution edge mismatch rejects before call', async () => {
  let calls = 0;
  const deps = makeDeps(registryWithCapability(), async () => {
    calls++;
    return { jobs: [], totalScraped: 0, newCount: 0 };
  });
  const slice = makeSlice();
  // edge targets indeed but request board linkedin
  const edge = makeEdge('indeed', 'permitted');
  await assert.rejects(() =>
    runJobSpyBoard(
      { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
      deps,
    ),
  );
  assert.equal(calls, 0);
});

test('call excludes forbidden keys and uses bounded safe filters', async () => {
  const captured: Record<string, unknown>[] = [];
  const deps = makeDeps(registryWithCapability(), async (p) => {
    captured.push(p);
    return { jobs: [], totalScraped: 0, newCount: 0 };
  });
  const slice = makeSlice({
    budget: {
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 5,
      bytes: 100000,
      milliseconds: 70000,
    },
  } as never);
  const edge = makeEdge('indeed', 'permitted');
  await runJobSpyBoard(
    {
      slice,
      board: 'indeed',
      executionEdge: edge,
      capturedAt: new Date().toISOString(),
      filters: {
        location: ' Berlin ',
        isRemote: true,
        jobType: 'fulltime',
        resultsWanted: 100,
        country: 'usa',
        hoursOld: 24,
        enforceAnnualSalary: true,
      },
    },
    deps,
  );
  assert.equal(captured.length, 1);
  const p = captured[0]!;
  assert.deepEqual(p['site_name'], ['indeed']);
  assert.equal(p['search_term'], 'software engineer');
  assert.equal(p['location'], ' Berlin ');
  assert.equal(p['is_remote'], true);
  // results_wanted = min(100,50,5)=5
  assert.equal(p['results_wanted'], 5);
  assert.equal(p['description_format'], 'markdown');
  assert.equal(p['linkedin_fetch_description'], false);
  assert.equal(p['indeed_fetch_description'], false);
  assert.equal(p['job_type'], 'fulltime');
  assert.equal(p['country_indeed'], 'usa');
  assert.equal(p['hours_old'], 24);
  assert.equal(p['enforce_annual_salary'], true);
  // forbidden never present
  for (const k of [
    'profile',
    'state_file',
    'skip_dedup',
    'proxies',
    'credentials',
    'use_creds',
    'username',
    'password',
    'linkedin_username',
  ]) {
    assert.equal(k in p, false, `forbidden key ${k} should not be present`);
  }
});

test('results_wanted defaults and caps: requested 20, min with slice budget', async () => {
  const captured: Record<string, unknown>[] = [];
  const mk = async (sliceCandidates: number, reqWanted: number | undefined, expected: number) => {
    captured.length = 0;
    const deps = makeDeps(registryWithCapability(), async (p) => {
      captured.push(p);
      return { jobs: [], totalScraped: 0, newCount: 0 };
    });
    const slice = makeSlice({
      budget: {
        logicalRequests: 5,
        reservedAttempts: 5,
        candidates: sliceCandidates,
        bytes: 100000,
        milliseconds: 70000,
      },
    } as never);
    const edge = makeEdge('glassdoor', 'permitted');
    await runJobSpyBoard(
      {
        slice,
        board: 'glassdoor',
        executionEdge: edge,
        capturedAt: new Date().toISOString(),
        filters: reqWanted !== undefined ? { resultsWanted: reqWanted } : {},
      },
      deps,
    );
    assert.equal(captured[0]!['results_wanted'], expected);
  };
  await mk(10, undefined, 10); // default 20 but slice 10 =>10
  await mk(100, 5, 5);
  await mk(10, 50, 10); // min(50,50,10)=10
  await mk(100, 100, 50); // min(100,50,100)=50
});

test('markdown descriptions and both fetch flags false always', async () => {
  const captured: Record<string, unknown>[] = [];
  const deps = makeDeps(registryWithCapability(), async (p) => {
    captured.push(p);
    return { jobs: [], totalScraped: 0, newCount: 0 };
  });
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(captured[0]!['description_format'], 'markdown');
  assert.equal(captured[0]!['linkedin_fetch_description'], false);
  assert.equal(captured[0]!['indeed_fetch_description'], false);
});

// ----- mapping valid record -----
test('valid record produces schema-valid candidate/evidence/envelope with direct_adapter provenance', async () => {
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({
        id: 'id-1',
        site: 'linkedin',
        job_url: 'https://example.com/j/1',
        title: 'T',
        company: 'C',
        location: 'L',
        description: 'D',
      }) as never,
    ],
    totalScraped: 1,
    newCount: 1,
  }));
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const capturedAt = new Date().toISOString();
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt },
    deps,
  );
  AcquisitionSliceResultSchema.parse(res);
  assert.equal(res.candidates.length, 1);
  const c = res.candidates[0] as Record<string, unknown>;
  assert.equal(c['state'], 'adapter_acquired');
  const prov = c['provenance'] as Record<string, unknown>;
  assert.equal(prov['kind'], 'direct_adapter');
  assert.deepEqual(prov['publisher'] as Record<string, unknown>, {
    kind: 'board',
    sourceId: 'linkedin',
  });
  assert.deepEqual(prov['contentDonor'] as Record<string, unknown>, {
    kind: 'adapter',
    adapterId: 'jobspy',
    representation: 'adapter_listing',
  });
  // publisher only from edge, not inferred
  assert.equal(res.evidence.length, 1);
  assert.equal((res.evidence[0] as Record<string, unknown>)['kind'], 'adapter_listing');
  assert.equal(res.observations.length, 1);
  assert.equal(
    (res.observations[0] as Record<string, unknown> & { acquisition: Record<string, unknown> })[
      'acquisition'
    ]['captureKind'],
    'adapter_listing',
  );
  assert.equal(
    (res.observations[0] as Record<string, unknown> & { observation: Record<string, unknown> })[
      'observation'
    ]['adapterVersion'],
    '1.7.0',
  );
  assert.equal(
    (res.observations[0] as Record<string, unknown> & { observation: Record<string, unknown> })[
      'observation'
    ]['extractionVersion'],
    'none',
  );
  // IDs deterministic
  assert.ok((c['candidateId'] as string).startsWith('candidate:'));
  // sourceConfidence
  assert.deepEqual(
    (res.observations[0] as Record<string, unknown> & { observation: Record<string, unknown> })[
      'observation'
    ]['sourceConfidence'],
    { adapter_record: 1 },
  );
});

test('record site mismatch cannot spoof publisher', async () => {
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [flatRecord({ site: 'indeed', id: 'x', job_url: 'https://example.com/x' }) as never],
    totalScraped: 1,
    newCount: 1,
  }));
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  // mismatched site discarded -> empty but not error, malformed warning and partial/no_results
  assert.equal(res.candidates.length, 0);
  assert.equal(res.warnings.includes('jobspy_malformed_record_discarded'), true);
  assert.equal(res.coverage[0]!.state, 'partial');
});

test('credential-bearing URL rejected: requires stable ID or credential-free URL', async () => {
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({
        id: '',
        site: 'linkedin',
        job_url: 'https://user:pass@example.com/a',
        title: 'T',
        description: 'D',
      }) as never,
    ],
    totalScraped: 1,
    newCount: 1,
  }));
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(res.candidates.length, 0);
  assert.equal(res.coverage[0]!.state, 'partial');
});

test('stable ID accepted when URL credential-bearing', async () => {
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({
        id: 'stable-id',
        site: 'linkedin',
        job_url: 'https://user:pass@example.com/a',
        title: 'T',
      }) as never,
    ],
    totalScraped: 1,
    newCount: 1,
  }));
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(res.candidates.length, 1);
});

test('evidence bounded to 32768 and only title/company/location/description', async () => {
  const longDesc = 'a'.repeat(40000);
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({
        title: 'T',
        company: 'C',
        location: 'L',
        description: longDesc,
        site: 'linkedin',
        job_url: 'https://example.com/j',
      }) as never,
    ],
    totalScraped: 1,
    newCount: 1,
  }));
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(res.candidates.length, 1);
  const ev = res.evidence[0] as Record<string, unknown>;
  assert.ok((ev['boundedText'] as string).length <= 32768);
  assert.equal((ev['boundedText'] as string).includes('T'), true);
  // ensure emails not included even if present in raw record
  const deps2 = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({
        site: 'linkedin',
        job_url: 'https://example.com/j',
        title: 'T',
        description: 'D',
        emails: 'secret@example.com',
      }) as never,
    ],
    totalScraped: 1,
    newCount: 1,
  }));
  const res2 = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps2,
  );
  assert.equal(
    ((res2.evidence[0] as Record<string, unknown>)['boundedText'] as string).includes(
      'secret@example.com',
    ),
    false,
  );
});

test('deterministic listing ID and content change changes observation/evidence IDs', async () => {
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const capturedAt = new Date().toISOString();
  const rec = flatRecord({
    id: 'id-xyz',
    site: 'linkedin',
    job_url: 'https://example.com/j',
    title: 'T',
    description: 'D1',
  });
  const deps1 = makeDeps(registryWithCapability(), async () => ({
    jobs: [rec as never],
    totalScraped: 1,
    newCount: 1,
  }));
  const res1 = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt },
    deps1,
  );
  const res2 = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt },
    deps1,
  );
  assert.equal(res1.candidates[0]!.candidateId, res2.candidates[0]!.candidateId);
  assert.equal(
    (res1.evidence[0] as Record<string, unknown>)['evidenceId'],
    (res2.evidence[0] as Record<string, unknown>)['evidenceId'],
  );
  // change description
  const rec2 = flatRecord({
    id: 'id-xyz',
    site: 'linkedin',
    job_url: 'https://example.com/j',
    title: 'T',
    description: 'D2',
  });
  const deps2 = makeDeps(registryWithCapability(), async () => ({
    jobs: [rec2 as never],
    totalScraped: 1,
    newCount: 1,
  }));
  const res3 = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt },
    deps2,
  );
  // listingId same (adapter+board+id), observation differs
  assert.equal(
    (res1.observations[0] as Record<string, unknown> & { listing: Record<string, unknown> })[
      'listing'
    ]['sourceListingId'],
    (res3.observations[0] as Record<string, unknown> & { listing: Record<string, unknown> })[
      'listing'
    ]['sourceListingId'],
  );
  assert.notEqual(
    (res1.evidence[0] as Record<string, unknown>)['evidenceId'],
    (res3.evidence[0] as Record<string, unknown>)['evidenceId'],
  );
  assert.notEqual(
    (res1.observations[0] as Record<string, unknown> & { observation: Record<string, unknown> })[
      'observation'
    ]['observationId'],
    (res3.observations[0] as Record<string, unknown> & { observation: Record<string, unknown> })[
      'observation'
    ]['observationId'],
  );
});

test('candidate and byte budgets enforced; attemptReserved 1; one coverage record', async () => {
  // candidate budget 1
  const slice = makeSlice({
    budget: {
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 1,
      bytes: 100000,
      milliseconds: 70000,
    },
  } as never);
  const edge = makeEdge('linkedin', 'permitted');
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({
        id: 'a',
        site: 'linkedin',
        job_url: 'https://example.com/a',
        title: 'T1',
      }) as never,
      flatRecord({
        id: 'b',
        site: 'linkedin',
        job_url: 'https://example.com/b',
        title: 'T2',
      }) as never,
    ],
    totalScraped: 2,
    newCount: 2,
  }));
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(res.coverage.length, 1);
  assert.equal(res.coverage[0]!.attemptsReserved, 1);
  assert.equal(res.coverage[0]!.logicalRequestsUsed, 1);
  assert.equal(res.candidates.length, 1);
  // byte budget very small -> should truncate
  const slice2 = makeSlice({
    budget: {
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 10,
      bytes: 10,
      milliseconds: 70000,
    },
  } as never);
  const deps2 = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({
        id: 'a',
        site: 'linkedin',
        job_url: 'https://example.com/a',
        title: 'T',
        description: 'hello world',
      }) as never,
    ],
    totalScraped: 1,
    newCount: 1,
  }));
  const res2 = await runJobSpyBoard(
    { slice: slice2, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps2,
  );
  // bytes budget exceeded -> zero candidates? Our implementation breaks before adding, so zero with partial? But boundedText for that record is >10 bytes, so it will be rejected due to budget -> zero candidates but not malformed
  // ensure bytesUsed <= budget
  assert.ok(res2.coverage[0]!.bytesUsed <= 10);
});

test('dependency rejection -> failed coverage', async () => {
  const deps = makeDeps(registryWithCapability(), async () => {
    throw new Error('network fail');
  });
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(res.coverage[0]!.state, 'failed');
  assert.equal(res.candidates.length, 0);
  AcquisitionSliceResultSchema.parse(res);
});

test('empty jobs -> succeeded/no_results with ambiguity warning', async () => {
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [],
    totalScraped: 0,
    newCount: 0,
  }));
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(res.coverage[0]!.state, 'succeeded');
  assert.equal(res.coverage[0]!.resultState, 'no_results');
  assert.ok(res.warnings.some((w) => w.includes('ambiguous')));
  AcquisitionSliceResultSchema.parse(res);
});

test('malformed/mismatch -> partial with fixed warning', async () => {
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({
        id: 'good',
        site: 'linkedin',
        job_url: 'https://example.com/g',
        title: 'T',
      }) as never,
      flatRecord({ id: '', site: 'linkedin', job_url: 'not-a-url', title: 'T' }) as never,
    ],
    totalScraped: 2,
    newCount: 2,
  }));
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(res.candidates.length, 1);
  assert.equal(res.coverage[0]!.state, 'partial');
  assert.ok(res.warnings.includes('jobspy_malformed_record_discarded'));
  AcquisitionSliceResultSchema.parse(res);
});

test('no fanout: exactly one scrape call per invocation', async () => {
  let calls = 0;
  const deps = makeDeps(registryWithCapability(), async () => {
    calls++;
    return { jobs: [], totalScraped: 0, newCount: 0 };
  });
  const slice = makeSlice();
  const edge = makeEdge('google', 'permitted');
  await runJobSpyBoard(
    { slice, board: 'google', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(calls, 1);
});

test('uses shared deterministic IDs and hash', async () => {
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const rec = flatRecord({ id: 'my-id', site: 'linkedin', job_url: 'https://example.com/j' });
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [rec as never],
    totalScraped: 1,
    newCount: 1,
  }));
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  const stableKey = 'my-id';
  const listingId = deterministicAcquisitionId('listing', [
    JOBSPY_ADAPTER_ID,
    'linkedin',
    stableKey,
  ]);
  assert.equal(
    (res.observations[0] as Record<string, unknown> & { listing: Record<string, unknown> })[
      'listing'
    ]['sourceListingId'],
    listingId,
  );
  const bounded = `Title: ${rec['title']}\n\nCompany: ${rec['company']}\n\nLocation: ${rec['location']}\n\nDescription:\n${rec['description']}`;
  const hash = acquiredContentHash(bounded);
  assert.equal((res.evidence[0] as Record<string, unknown>)['contentHash'], hash);
});

test('source metadata exact: adapterId jobspy, adapterVersion 1.7.0, extractionVersion none, fetchOutcome success, payloadRef absent, sourceConfidence adapter_record 1', async () => {
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [flatRecord() as never],
    totalScraped: 1,
    newCount: 1,
  }));
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  const obs = (
    res.observations[0] as Record<string, unknown> & { observation: Record<string, unknown> }
  )['observation'];
  assert.equal(obs['adapterVersion'], '1.7.0');
  assert.equal(obs['extractionVersion'], 'none');
  assert.equal(obs['fetchOutcome'], 'success');
  assert.equal(obs['payloadRef'], undefined);
  assert.deepEqual(obs['sourceConfidence'], { adapter_record: 1 });
  const listing = (
    res.observations[0] as Record<string, unknown> & { listing: Record<string, unknown> }
  )['listing'];
  assert.equal(listing['adapterId'], 'jobspy');
});

test('forbidden scope: source does not contain Promise.allSettled, profile/state/proxy/fetchJobDetails', () => {
  const src = fs.readFileSync(path.resolve('src/jobs/acquisition/adapters/jobspy.ts'), 'utf8');
  assert.equal(src.includes('Promise.allSettled'), false, 'should not contain Promise.allSettled');
  assert.equal(src.includes('fetchJobDetails'), false);
  assert.equal(src.includes('fetchLinkedInJob'), false);
  // check forbidden params not referenced as keys in source (should not pass them)
  // but source may mention them in comments; check that scrape call site does not include those keys
  assert.equal(
    /\bprofile\b/.test(src) && src.includes("'profile'"),
    false,
    'should not pass profile',
  );
  // simpler: ensure src does not contain string 'state_file'
  assert.equal(src.includes('state_file'), false);
  assert.equal(src.includes('skip_dedup'), false);
  assert.equal(src.includes('proxies'), false);
});

test('complete output passes AcquisitionSliceResultSchema for succeeded case', async () => {
  const slice = makeSlice();
  const edge = makeEdge('bayt', 'permitted');
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({ site: 'bayt', job_url: 'https://example.com/b', title: 'Engineer' }) as never,
    ],
    totalScraped: 1,
    newCount: 1,
  }));
  const res = await runJobSpyBoard(
    { slice, board: 'bayt', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.doesNotThrow(() => AcquisitionSliceResultSchema.parse(res));
});

test('durationMs bounded and coverage single record', async () => {
  const slice = makeSlice();
  const edge = makeEdge('naukri', 'permitted');
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [],
    totalScraped: 0,
    newCount: 0,
  }));
  const start = Date.now();
  const res = await runJobSpyBoard(
    { slice, board: 'naukri', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(res.coverage.length, 1);
  assert.ok(res.coverage[0]!.durationMs >= 0);
  assert.ok(res.coverage[0]!.durationMs < 86400000);
  assert.ok(Date.now() - start < 5000);
});

test('duplicate stable records yield partial + fixed warning and no crash', async () => {
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const dup = flatRecord({
    id: 'dup-id',
    site: 'linkedin',
    job_url: 'https://example.com/j/dup',
    title: 'T',
    company: 'C',
    location: 'L',
    description: 'D',
  });
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [dup as never, { ...dup } as never],
    totalScraped: 2,
    newCount: 2,
  }));
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(res.candidates.length, 1, 'dedup should leave one candidate');
  assert.equal(res.coverage[0]!.state, 'partial');
  assert.ok(res.warnings.includes('jobspy_malformed_record_discarded'));
  assert.doesNotThrow(() => AcquisitionSliceResultSchema.parse(res));
});

test('NaN resultsWanted does not pass NaN and caps via budget', async () => {
  const captured: Record<string, unknown>[] = [];
  const deps = makeDeps(registryWithCapability(), async (p) => {
    captured.push(p as Record<string, unknown>);
    return { jobs: [], totalScraped: 0, newCount: 0 };
  });
  const slice = makeSlice() as unknown as Record<string, unknown> & {
    budget: { candidates: number };
  };
  // slice budget 10 => NaN should fallback to default and cap to 10, not NaN
  (slice.budget as unknown as Record<string, unknown>)['candidates'] = 10;
  const edge = makeEdge('linkedin', 'permitted');
  await runJobSpyBoard(
    {
      slice: slice as unknown as import('../../src/jobs/acquisition/contracts.js').AcquisitionSlice,
      board: 'linkedin',
      executionEdge: edge,
      capturedAt: new Date().toISOString(),
      filters: { resultsWanted: NaN },
    },
    deps,
  );
  const rw = captured[0]!['results_wanted'];
  assert.ok(
    typeof rw === 'number' && Number.isFinite(rw as number),
    'results_wanted must be finite',
  );
  assert.notEqual(String(rw), 'NaN');
  assert.ok((rw as number) <= 10, 'should be capped by budget');
});

test('oversized location and country are capped at 512 chars', async () => {
  const captured: Record<string, unknown>[] = [];
  const deps = makeDeps(registryWithCapability(), async (p) => {
    captured.push(p as Record<string, unknown>);
    return { jobs: [], totalScraped: 0, newCount: 0 };
  });
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  const longLoc = 'a'.repeat(600);
  const longCountry = 'b'.repeat(600);
  await runJobSpyBoard(
    {
      slice,
      board: 'linkedin',
      executionEdge: edge,
      capturedAt: new Date().toISOString(),
      filters: { location: longLoc, country: longCountry },
    },
    deps,
  );
  assert.equal(captured.length, 1);
  const loc = captured[0]!['location'] as string;
  const country = captured[0]!['country_indeed'] as string;
  assert.ok(typeof loc === 'string' && loc.length <= 512, 'location capped to 512');
  assert.ok(typeof country === 'string' && country.length <= 512, 'country capped to 512');
  assert.notEqual(longLoc, loc);
  assert.notEqual(longCountry, country);
});

test('hoursOld upper bound is clamped before params', async () => {
  const captured: Record<string, unknown>[] = [];
  const deps = makeDeps(registryWithCapability(), async (p) => {
    captured.push(p as Record<string, unknown>);
    return { jobs: [], totalScraped: 0, newCount: 0 };
  });
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  await runJobSpyBoard(
    {
      slice,
      board: 'linkedin',
      executionEdge: edge,
      capturedAt: new Date().toISOString(),
      filters: { hoursOld: 100000 },
    },
    deps,
  );
  assert.equal(captured.length, 1);
  const h = captured[0]!['hours_old'] as number;
  assert.ok(typeof h === 'number' && Number.isFinite(h));
  assert.ok(h <= 720, 'hours_old should be clamped to 720');
  assert.notEqual(h, 100000);
});

test('probe removal still enforces zero-call non-permitted and exactly-one-call permitted', async () => {
  // non-permitted -> zero
  let calls = 0;
  const depsBlocked = makeDeps(registryWithCapability(), async () => {
    calls++;
    return { jobs: [], totalScraped: 0, newCount: 0 };
  });
  await runJobSpyBoard(
    {
      slice: makeSlice(),
      board: 'linkedin',
      executionEdge: makeEdge('linkedin', 'blocked'),
      capturedAt: new Date().toISOString(),
    },
    depsBlocked,
  );
  assert.equal(calls, 0, 'blocked edge should make zero calls');
  // permitted -> exactly one
  calls = 0;
  const depsPermitted = makeDeps(registryWithCapability(), async () => {
    calls++;
    return { jobs: [], totalScraped: 0, newCount: 0 };
  });
  await runJobSpyBoard(
    {
      slice: makeSlice(),
      board: 'linkedin',
      executionEdge: makeEdge('linkedin', 'permitted'),
      capturedAt: new Date().toISOString(),
    },
    depsPermitted,
  );
  assert.equal(calls, 1, 'permitted edge should make exactly one call');
  // source must not contain a dummy probe pattern separate from the real wrap
  const src = fs.readFileSync(path.resolve('src/jobs/acquisition/adapters/jobspy.ts'), 'utf8');
  const probeDummyMatches = (
    src.match(
      /executeIfPolicyPermitted\s*\(\s*executionEdge\s*,\s*async\s*\(\)\s*=>\s*null\s*\)/,
    ) || []
  ).length;
  assert.equal(probeDummyMatches, 0, 'dummy probe gate must be removed');
  assert.ok(src.includes('executeIfPolicyPermitted'));
});

test('giant externalId >256 treated as absent and falls through to URL or malformed without throw', async () => {
  const giant = 'x'.repeat(300);
  const slice = makeSlice();
  const edge = makeEdge('linkedin', 'permitted');
  // giant id + valid url -> succeeds via URL
  const depsOk = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({ id: giant, site: 'linkedin', job_url: 'https://example.com/j/giant' }) as never,
    ],
    totalScraped: 1,
    newCount: 1,
  }));
  const resOk = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    depsOk,
  );
  assert.equal(
    resOk.candidates.length,
    1,
    'giant id with valid url should still produce candidate via URL',
  );
  assert.doesNotThrow(() => AcquisitionSliceResultSchema.parse(resOk));
  // giant id + no url -> malformed discarded, no throw, partial/no_results
  const depsBad = makeDeps(registryWithCapability(), async () => ({
    jobs: [flatRecord({ id: giant, site: 'linkedin', job_url: '' }) as never],
    totalScraped: 1,
    newCount: 1,
  }));
  const resBad = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    depsBad,
  );
  assert.equal(resBad.candidates.length, 0);
  assert.equal(resBad.coverage[0]!.state, 'partial');
  assert.ok(resBad.warnings.includes('jobspy_malformed_record_discarded'));
  assert.doesNotThrow(() => AcquisitionSliceResultSchema.parse(resBad));
});

test('byte-budget truncation maps to partial with budget warning and results', async () => {
  const slice = makeSlice({
    budget: {
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 10,
      bytes: 80,
      milliseconds: 70000,
    },
  } as never);
  const edge = makeEdge('linkedin', 'permitted');
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({
        id: 'a',
        site: 'linkedin',
        job_url: 'https://example.com/a',
        title: 'T',
        description: 'hello world hello world',
      }) as never,
      flatRecord({
        id: 'b',
        site: 'linkedin',
        job_url: 'https://example.com/b',
        title: 'T',
        description: 'hello world hello world',
      }) as never,
    ],
    totalScraped: 2,
    newCount: 2,
  }));
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(res.candidates.length, 1, 'second record should be truncated by byte budget');
  assert.equal(res.coverage[0]!.state, 'partial');
  assert.equal(res.coverage[0]!.resultState, 'results');
  assert.ok(res.warnings.includes('jobspy_budget_truncated'));
  assert.ok(res.coverage[0]!.bytesUsed <= 80);
  AcquisitionSliceResultSchema.parse(res);
});

test('byte-budget truncation with zero candidates maps to partial no_results', async () => {
  const slice = makeSlice({
    budget: {
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 10,
      bytes: 10,
      milliseconds: 70000,
    },
  } as never);
  const edge = makeEdge('linkedin', 'permitted');
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({
        id: 'a',
        site: 'linkedin',
        job_url: 'https://example.com/a',
        title: 'T',
        description: 'hello world',
      }) as never,
    ],
    totalScraped: 1,
    newCount: 1,
  }));
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(res.candidates.length, 0);
  assert.equal(res.coverage[0]!.state, 'partial');
  assert.equal(res.coverage[0]!.resultState, 'no_results');
  assert.ok(res.warnings.includes('jobspy_budget_truncated'));
  AcquisitionSliceResultSchema.parse(res);
});

test('candidate-budget truncation maps to partial with budget warning and results', async () => {
  const slice = makeSlice({
    budget: {
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 1,
      bytes: 100000,
      milliseconds: 70000,
    },
  } as never);
  const edge = makeEdge('linkedin', 'permitted');
  const deps = makeDeps(registryWithCapability(), async () => ({
    jobs: [
      flatRecord({ id: 'a', site: 'linkedin', job_url: 'https://example.com/a' }) as never,
      flatRecord({ id: 'b', site: 'linkedin', job_url: 'https://example.com/b' }) as never,
      flatRecord({ id: 'c', site: 'linkedin', job_url: 'https://example.com/c' }) as never,
    ],
    totalScraped: 3,
    newCount: 3,
  }));
  const res = await runJobSpyBoard(
    { slice, board: 'linkedin', executionEdge: edge, capturedAt: new Date().toISOString() },
    deps,
  );
  assert.equal(res.candidates.length, 1);
  assert.equal(res.coverage[0]!.state, 'partial');
  assert.equal(res.coverage[0]!.resultState, 'results');
  assert.ok(res.warnings.includes('jobspy_budget_truncated'));
  AcquisitionSliceResultSchema.parse(res);
});
