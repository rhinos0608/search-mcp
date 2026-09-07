import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  SEMANTIC_JOBS_SHADOW_VERSION,
  SemanticJobsShadowResultSchema,
  runSemanticJobsShadow,
  type SemanticJobsShadowPlanItem,
} from '../../src/jobs/compat/semanticJobsShadow.js';
import {
  ACQUISITION_CONTRACT_VERSION,
  type AcquisitionSlice,
} from '../../src/jobs/acquisition/contracts.js';
import { JOBSPY_CAPABILITY } from '../../src/jobs/acquisition/adapters/jobspy.js';
import type { JobSpyBoard } from '../../src/jobs/acquisition/adapters/jobspy.js';
import type { FlatJobRecord, JobSpyAcquisitionParams } from '../../src/utils/jobspyClient.js';
import { isToolError } from '../../src/errors.js';
import { AdapterCapabilityRegistry } from '../../src/jobs/acquisition/adapterRegistry.js';
import { SourcePolicyRegistry } from '../../src/jobs/acquisition/policy/registry.js';
import type { SourcePolicy } from '../../src/jobs/acquisition/policy/sourcePolicy.js';

const CAPTURED_AT = '2026-01-02T00:00:00Z';
const QUERY = 'Sydney rocket scientist';
const URL_A = 'https://jobs.example.com/secret-a';
const URL_B = 'https://jobs.example.com/secret-b';
const URL_G = 'https://jobs.example.com/secret-g';

const RUN_BUDGET = {
  logicalRequests: 10,
  reservedAttempts: 20,
  candidates: 50,
  bytes: 1_000_000,
  milliseconds: 70_000,
};

const SLICE_BUDGET = {
  logicalRequests: 2,
  reservedAttempts: 2,
  candidates: 10,
  bytes: 200_000,
  milliseconds: 60_000,
};

function makeSlice(sliceId: string): AcquisitionSlice {
  const base = {
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    runId: 'run-1',
    sliceId,
    ordinal: 0,
    queryVariantId: 'qv-1',
    query: QUERY,
    reason: 'shadow comparison',
    adapterIds: ['jobspy'],
    localePackRefs: [],
    domainPackRefs: [],
    budget: { ...SLICE_BUDGET },
  };
  return base as unknown as AcquisitionSlice;
}

interface PlanOverrides {
  boards?: readonly JobSpyBoard[];
  sliceBudget?: typeof SLICE_BUDGET;
  query?: string;
  filters?: SemanticJobsShadowPlanItem['filters'];
}

function makePlan(overrides: PlanOverrides = {}) {
  const boards = overrides.boards ?? (['linkedin', 'indeed'] as const);
  const query = overrides.query ?? QUERY;
  return boards.map((board, i) => ({
    kind: 'jobspy' as const,
    slice: {
      ...makeSlice(`slice-${i}`),
      query,
      ...(overrides.sliceBudget ? { budget: { ...overrides.sliceBudget } } : {}),
    },
    board,
    filters: overrides.filters ?? { resultsWanted: 5, hoursOld: 48 },
  }));
}

function policy(sourceId: string, state = 'permitted'): SourcePolicy {
  return {
    sourceId,
    revision: 'rev-1',
    modes: {
      automatedSearch: state as never,
      automatedFetch: state as never,
      userSuppliedContent: state as never,
      manualImport: state as never,
      employerApi: 'not_supported' as never,
    },
    evidenceRefs: [],
    reviewedAt: '2026-01-01T00:00:00Z',
  } as unknown as SourcePolicy;
}

function makeRegistries(
  permittedBoards: readonly string[] = JOBSPY_BOARD_LIST,
  blockedBoards: readonly string[] = [],
) {
  const reg = new SourcePolicyRegistry([
    ...permittedBoards.map((b) => policy(b)),
    ...blockedBoards.map((b) => policy(b, 'blocked')),
  ]);
  const caps = new AdapterCapabilityRegistry([JOBSPY_CAPABILITY]);
  return { reg, caps };
}

const JOBSPY_BOARD_LIST = ['linkedin', 'indeed', 'zip_recruiter', 'glassdoor'] as const;

interface DepsHarness {
  scrapeCalls: string[];
  legacyCalls: JobSpyAcquisitionParams[];
}

interface HarnessOverrides {
  legacyRecords?: FlatJobRecord[];
  legacyThrows?: Error;
  coordinatorJobs?: Record<string, FlatJobRecord[]>;
  permittedBoards?: readonly string[];
  blockedBoards?: readonly string[];
  monotonicNow?: () => number;
  abortSignal?: AbortSignal;
}

function makeDeps(overrides: HarnessOverrides = {}): {
  deps: Parameters<typeof runSemanticJobsShadow>[1];
  harness: DepsHarness;
} {
  const scrapeCalls: string[] = [];
  const legacyCalls: JobSpyAcquisitionParams[] = [];
  const { reg, caps } = makeRegistries(overrides.permittedBoards, overrides.blockedBoards);
  const deps = {
    policyRegistry: reg,
    capabilityRegistry: caps,
    scrapeJobs: async (params: Record<string, unknown>) => {
      const site = (params.site_name as string[])[0] ?? '';
      scrapeCalls.push(site);
      const jobs = overrides.coordinatorJobs?.[site] ?? [];
      return { jobs, totalScraped: jobs.length, newCount: jobs.length };
    },
    searchJobSpy: async (params: JobSpyAcquisitionParams) => {
      legacyCalls.push(params);
      if (overrides.legacyThrows) throw overrides.legacyThrows;
      return overrides.legacyRecords ?? [];
    },
    ...(overrides.monotonicNow ? { monotonicNow: overrides.monotonicNow } : {}),
  };
  return { deps, harness: { scrapeCalls, legacyCalls } };
}

function flatRecord(overrides: Partial<FlatJobRecord> & { site: string }): FlatJobRecord {
  return {
    id: 'rec-1',
    job_url: URL_A,
    title: 'Secret Title',
    company: 'Secret Co',
    description: 'Secret description',
    ...overrides,
  } as FlatJobRecord;
}

function defaultRequest(plan: ReturnType<typeof makePlan>, abortSignal?: AbortSignal) {
  return {
    runId: 'run-1',
    capturedAt: CAPTURED_AT,
    budget: { ...RUN_BUDGET },
    plan,
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  };
}

test('1. one legacy multi-site call for four-board plan', async () => {
  const plan = makePlan({ boards: JOBSPY_BOARD_LIST });
  const { deps, harness } = makeDeps();
  const result = await runSemanticJobsShadow(defaultRequest(plan), deps);
  assert.equal(harness.legacyCalls.length, 1);
  assert.deepEqual(harness.legacyCalls[0]?.sites, [...JOBSPY_BOARD_LIST]);
  assert.equal(harness.legacyCalls[0]?.query, QUERY);
  assert.equal(harness.legacyCalls[0]?.resultsWanted, 5);
  assert.equal(harness.legacyCalls[0]?.hoursOld, 48);
  assert.equal(result.legacy.callCount, 1);
  assert.equal(result.legacy.status, 'completed');
  assert.equal(result.status, 'completed');
  SemanticJobsShadowResultSchema.parse(result);
});

test('2. same URLs on both paths → shared=1, jaccardMillis=1000', async () => {
  const plan = makePlan({ boards: ['linkedin'] });
  const { deps } = makeDeps({
    legacyRecords: [flatRecord({ site: 'linkedin', job_url: URL_A })],
    coordinatorJobs: { linkedin: [flatRecord({ site: 'linkedin', job_url: URL_A })] },
  });
  const result = await runSemanticJobsShadow(defaultRequest(plan), deps);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.comparison, {
    status: 'computed',
    key: 'canonical_url_sha256',
    shared: 1,
    legacyOnly: 0,
    coordinatorOnly: 0,
    union: 1,
    jaccardMillis: 1000,
  });
  assert.equal(result.legacy.keyedCount, 1);
  assert.equal(result.coordinator.candidateCount, 1);
});

test('3. disjoint sets → correct aggregate counts', async () => {
  const plan = makePlan({ boards: ['linkedin'] });
  const { deps } = makeDeps({
    legacyRecords: [flatRecord({ site: 'linkedin', job_url: URL_A })],
    coordinatorJobs: { linkedin: [flatRecord({ site: 'linkedin', job_url: URL_B })] },
  });
  const result = await runSemanticJobsShadow(defaultRequest(plan), deps);
  assert.deepEqual(result.comparison, {
    status: 'computed',
    key: 'canonical_url_sha256',
    shared: 0,
    legacyOnly: 1,
    coordinatorOnly: 1,
    union: 2,
    jaccardMillis: 0,
  });
});

test('4. empty and empty → union zero, jaccardMillis null', async () => {
  const plan = makePlan({ boards: ['linkedin'] });
  const { deps } = makeDeps({});
  const result = await runSemanticJobsShadow(defaultRequest(plan), deps);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.comparison, {
    status: 'computed',
    key: 'canonical_url_sha256',
    shared: 0,
    legacyOnly: 0,
    coordinatorOnly: 0,
    union: 0,
    jaccardMillis: null,
  });
});

test('5. blocked coordinator board: zero scrape for it, legacy still searched', async () => {
  const plan = makePlan({ boards: ['linkedin', 'indeed'] });
  const { deps, harness } = makeDeps({
    permittedBoards: ['linkedin'],
    blockedBoards: ['indeed'],
    legacyRecords: [flatRecord({ site: 'indeed', job_url: URL_B })],
  });
  const result = await runSemanticJobsShadow(defaultRequest(plan), deps);
  // zero coordinator scrape calls for the blocked board
  assert.deepEqual(harness.scrapeCalls, ['linkedin']);
  // legacy still searched both plan boards
  assert.deepEqual(harness.legacyCalls[0]?.sites, ['linkedin', 'indeed']);
  const blockedRow = result.boards.find((b) => b.board === 'indeed');
  assert.equal(blockedRow?.coordinatorCoverageState, 'policy_blocked');
  assert.equal(blockedRow?.coordinatorCandidateCount, 0);
  // coordinator completed (blocked slice executed with zero calls) → comparison computed
  assert.equal(result.coordinator.status, 'completed');
  assert.equal(result.comparison.status, 'computed');

  // sub-case: coordinator incomplete → comparison not computed
  const plan2 = makePlan({ boards: ['linkedin', 'indeed'] });
  const { deps: deps2, harness: harness2 } = makeDeps({
    monotonicNow: (() => {
      let tick = 0;
      return () => {
        tick += 1;
        return tick * 1000;
      };
    })(),
  });
  const result2 = await runSemanticJobsShadow(
    {
      runId: 'run-1',
      capturedAt: CAPTURED_AT,
      budget: { ...RUN_BUDGET, milliseconds: 1 },
      plan: plan2,
    },
    deps2,
  );
  assert.deepEqual(harness2.scrapeCalls, []);
  assert.equal(result2.coordinator.status, 'deadline_exceeded');
  assert.deepEqual(result2.comparison, {
    status: 'not_computed',
    reason: 'coordinator_incomplete',
  });
  assert.equal(result2.status, 'partial');
});

test('6. plan/filter validation mismatch causes zero calls', async () => {
  const { deps, harness } = makeDeps();
  const cases: unknown[] = [
    // differing filters across slices
    [
      {
        kind: 'jobspy',
        slice: makeSlice('slice-0'),
        board: 'linkedin',
        filters: { resultsWanted: 5, hoursOld: 48, location: 'Sydney' },
      },
      {
        kind: 'jobspy',
        slice: makeSlice('slice-1'),
        board: 'indeed',
        filters: { resultsWanted: 5, hoursOld: 48, location: 'Melbourne' },
      },
    ],
    // duplicate boards
    makePlan({ boards: ['linkedin', 'linkedin'] }),
    // duplicate slice IDs
    [
      {
        kind: 'jobspy',
        slice: makeSlice('slice-0'),
        board: 'linkedin',
        filters: { resultsWanted: 5, hoursOld: 48 },
      },
      {
        kind: 'jobspy',
        slice: makeSlice('slice-0'),
        board: 'indeed',
        filters: { resultsWanted: 5, hoursOld: 48 },
      },
    ],
    // slice runId mismatch
    [
      {
        kind: 'jobspy',
        slice: { ...makeSlice('slice-0'), runId: 'run-other' },
        board: 'linkedin',
        filters: { resultsWanted: 5, hoursOld: 48 },
      },
    ],
    // differing query across slices
    [
      {
        kind: 'jobspy',
        slice: makeSlice('slice-0'),
        board: 'linkedin',
        filters: { resultsWanted: 5, hoursOld: 48 },
      },
      {
        kind: 'jobspy',
        slice: { ...makeSlice('slice-1'), query: 'other query' },
        board: 'indeed',
        filters: { resultsWanted: 5, hoursOld: 48 },
      },
    ],
    // adapterIds not exactly ['jobspy']
    [
      {
        kind: 'jobspy',
        slice: { ...makeSlice('slice-0'), adapterIds: ['jobspy', 'other'] },
        board: 'linkedin',
        filters: { resultsWanted: 5, hoursOld: 48 },
      },
    ],
    // missing required resultsWanted
    [{ kind: 'jobspy', slice: makeSlice('slice-0'), board: 'linkedin', filters: { hoursOld: 48 } }],
    // hoursOld below range
    [
      {
        kind: 'jobspy',
        slice: makeSlice('slice-0'),
        board: 'linkedin',
        filters: { resultsWanted: 5, hoursOld: 0 },
      },
    ],
    // plan length 10
    Array.from({ length: 10 }, (_, i) => ({
      kind: 'jobspy',
      slice: makeSlice(`slice-${i}`),
      board: JOBSPY_BOARD_LIST[i % JOBSPY_BOARD_LIST.length],
      filters: { resultsWanted: 5, hoursOld: 48 },
    })),
  ];
  for (const plan of cases) {
    await assert.rejects(
      () => runSemanticJobsShadow(defaultRequest(plan as never), deps),
      (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
    );
  }
  assert.equal(harness.legacyCalls.length, 0);
  assert.equal(harness.scrapeCalls.length, 0);
});

test('7. legacy throw still permits coordinator run and returns partial', async () => {
  const plan = makePlan({ boards: ['linkedin'] });
  const { deps, harness } = makeDeps({
    legacyThrows: new Error('upstream boom'),
    coordinatorJobs: { linkedin: [flatRecord({ site: 'linkedin', job_url: URL_B })] },
  });
  const result = await runSemanticJobsShadow(defaultRequest(plan), deps);
  assert.equal(harness.scrapeCalls.length, 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.legacy.status, 'failed');
  assert.equal(result.legacy.callCount, 1);
  assert.equal(result.legacy.recordCount, 0);
  assert.equal(result.legacy.errorCode, 'ERROR');
  assert.equal(result.coordinator.status, 'completed');
  assert.deepEqual(result.comparison, { status: 'not_computed', reason: 'legacy_failed' });
});

test('8. coordinator throw preserves legacy counts and returns partial', async () => {
  const plan = makePlan({ boards: ['linkedin'] });
  const { deps } = makeDeps({
    legacyRecords: [flatRecord({ site: 'linkedin', job_url: URL_A })],
    monotonicNow: (() => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls >= 2) throw new Error('clock failure');
        return 0;
      };
    })(),
  });
  const result = await runSemanticJobsShadow(defaultRequest(plan), deps);
  assert.equal(result.status, 'partial');
  assert.equal(result.legacy.status, 'completed');
  assert.equal(result.legacy.recordCount, 1);
  assert.equal(result.legacy.keyedCount, 1);
  assert.equal(result.coordinator.status, 'failed');
  assert.equal(result.coordinator.errorCode, 'ERROR');
  assert.deepEqual(result.comparison, { status: 'not_computed', reason: 'coordinator_failed' });
});

test('9. pre-abort gives zero calls', async () => {
  const plan = makePlan({ boards: ['linkedin', 'indeed'] });
  const controller = new AbortController();
  controller.abort();
  const { deps, harness } = makeDeps();
  const result = await runSemanticJobsShadow(defaultRequest(plan, controller.signal), deps);
  assert.equal(harness.legacyCalls.length, 0);
  assert.equal(harness.scrapeCalls.length, 0);
  assert.equal(result.status, 'aborted');
  assert.equal(result.legacy.status, 'aborted');
  assert.equal(result.legacy.callCount, 0);
  assert.equal(result.coordinator.status, 'not_run');
  assert.deepEqual(result.comparison, { status: 'not_computed', reason: 'aborted' });
  assert.deepEqual(
    result.boards.map((b) => b.legacyRecordCount),
    [0, 0],
  );
});

test('10. raw query, URL, host, title, company, and hashes absent from result', async () => {
  const plan = makePlan({ boards: ['linkedin'] });
  const { deps } = makeDeps({
    legacyRecords: [flatRecord({ site: 'linkedin', job_url: URL_A })],
    coordinatorJobs: { linkedin: [flatRecord({ site: 'linkedin', job_url: URL_A })] },
  });
  const result = await runSemanticJobsShadow(defaultRequest(plan), deps);
  const serialized = JSON.stringify(result);
  for (const secret of [
    QUERY,
    URL_A,
    URL_B,
    'jobs.example.com',
    'Secret Title',
    'Secret Co',
    'sha256:',
    'canonicalUrl',
    'provenance',
    'job_url',
  ]) {
    assert.equal(serialized.includes(secret), false, `leaked: ${secret}`);
  }
});

test('11. unplanned-board and unkeyed records counted but excluded', async () => {
  const plan = makePlan({ boards: ['linkedin'] });
  const { deps } = makeDeps({
    legacyRecords: [
      flatRecord({ site: 'linkedin', job_url: URL_A }),
      flatRecord({ site: 'google', job_url: URL_G, id: 'rec-g' }),
      flatRecord({ site: 'linkedin', job_url: 'not a url', id: 'rec-bad' }),
      flatRecord({
        site: 'linkedin',
        job_url: 'https://user:pass@jobs.example.com/cred',
        id: 'rec-cred',
      }),
    ],
    coordinatorJobs: { linkedin: [flatRecord({ site: 'linkedin', job_url: URL_A })] },
  });
  const result = await runSemanticJobsShadow(defaultRequest(plan), deps);
  assert.equal(result.legacy.recordCount, 4);
  assert.equal(result.legacy.keyedCount, 1);
  assert.equal(result.legacy.unkeyedCount, 2);
  assert.equal(result.legacy.unplannedBoardCount, 1);
  const row = result.boards.find((b) => b.board === 'linkedin');
  assert.equal(row?.legacyRecordCount, 3);
  assert.deepEqual(result.comparison, {
    status: 'computed',
    key: 'canonical_url_sha256',
    shared: 1,
    legacyOnly: 0,
    coordinatorOnly: 0,
    union: 1,
    jaccardMillis: 1000,
  });
});

test('12. two runs with same mocks and clock deep-equal', async () => {
  const runOnce = async () => {
    const plan = makePlan({ boards: ['linkedin', 'indeed'] });
    let tick = 0;
    const { deps } = makeDeps({
      legacyRecords: [flatRecord({ site: 'linkedin', job_url: URL_A })],
      coordinatorJobs: {
        linkedin: [flatRecord({ site: 'linkedin', job_url: URL_A, id: 'c-1' })],
        indeed: [flatRecord({ site: 'indeed', job_url: URL_B, id: 'c-2' })],
      },
      monotonicNow: () => {
        tick += 1;
        return tick;
      },
    });
    return runSemanticJobsShadow(defaultRequest(plan), deps);
  };
  const a = await runOnce();
  const b = await runOnce();
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('13. static imports allowlist excludes forbidden modules', () => {
  const p = path.resolve('src/jobs/compat/semanticJobsShadow.ts');
  const src = fs.readFileSync(p, 'utf8');
  const staticImportRe = /import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g;
  const specifiers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = staticImportRe.exec(src)) !== null) specifiers.push(m[1]!);
  const allow = new Set([
    'zod/v4',
    '../acquisition/coordinator.js',
    '../acquisition/adapters/jobspy.js',
    '../acquisition/adapterSupport.js',
    '../acquisition/contracts.js',
    '../domain/ids.js',
    '../../errors.js',
    '../acquisition/policy/registry.js',
    '../acquisition/adapterRegistry.js',
    '../../utils/jobspyClient.js',
  ]);
  for (const s of specifiers) {
    assert.ok(allow.has(s), `unexpected specifier ${s}`);
    for (const banned of [
      'semanticJobs',
      'jobPipeline',
      'jobGraphDb',
      'embedding',
      'crawl',
      'logger',
      'query_log',
      'persistence',
      'graph',
    ]) {
      assert.equal(s.includes(banned), false, `forbidden module in import: ${s}`);
    }
  }
  assert.equal(/\bimport\s*\(/.test(src), false, 'no dynamic import');
  assert.equal(/\bPromise\s*\.\s*all\s*\(/.test(src), false, 'no Promise.all');
  assert.equal(/\bPromise\s*\.\s*allSettled\s*\(/.test(src), false, 'no Promise.allSettled');
  assert.equal(/\bfetch\s*\(/.test(src), false, 'no fetch');
  assert.equal(/\bconsole\./.test(src), false, 'no console');
  assert.equal(src.includes('randomUUID'), false, 'no random');
  assert.equal(src.includes('Math.random'), false, 'no random');
  assert.equal(src.includes('logger'), false, 'no logger reference');
  assert.equal(src.includes('Date.now'), false, 'no ambient clock');
  assert.equal(SEMANTIC_JOBS_SHADOW_VERSION, '1.0.0');
});

test('14. semanticJobs tool, server, registry, and acquisition barrel untouched by shadow', () => {
  const untouched = [
    'src/tools/semanticJobs.ts',
    'src/server.ts',
    'src/index.ts',
    'src/tools/registry.ts',
    'src/jobs/acquisition/index.ts',
  ];
  for (const rel of untouched) {
    const src = fs.readFileSync(path.resolve(rel), 'utf8');
    assert.equal(src.includes('semanticJobsShadow'), false, `${rel} references shadow module`);
    assert.equal(src.includes('semantic-jobs-shadow'), false, `${rel} references shadow tool`);
  }
  // shadow module is not exported through any barrel
  const barrel = fs.readFileSync(path.resolve('src/jobs/acquisition/index.ts'), 'utf8');
  assert.equal(barrel.includes('compat/semanticJobsShadow'), false, 'no barrel export');
});

test('15. invalid job_url falls back to valid job_url_direct for comparison keying', async () => {
  const plan = makePlan({ boards: ['linkedin'] });
  const { deps } = makeDeps({
    legacyRecords: [flatRecord({ site: 'linkedin', job_url: 'not a url', job_url_direct: URL_A })],
    coordinatorJobs: { linkedin: [flatRecord({ site: 'linkedin', job_url: URL_A })] },
  });
  const result = await runSemanticJobsShadow(defaultRequest(plan), deps);
  assert.equal(result.status, 'completed');
  // W3-E selection keyed the legacy record via job_url_direct, not counted unkeyed
  assert.equal(result.legacy.recordCount, 1);
  assert.equal(result.legacy.keyedCount, 1);
  assert.equal(result.legacy.unkeyedCount, 0);
  assert.deepEqual(result.comparison, {
    status: 'computed',
    key: 'canonical_url_sha256',
    shared: 1,
    legacyOnly: 0,
    coordinatorOnly: 0,
    union: 1,
    jaccardMillis: 1000,
  });
});

test('16. all optional common filters forwarded verbatim to single legacy call', async () => {
  const filters = {
    resultsWanted: 5,
    hoursOld: 48,
    location: 'Sydney',
    isRemote: true,
    jobType: 'fulltime',
    country: 'Australia',
    enforceAnnualSalary: true,
  } as const;
  const plan = makePlan({ boards: JOBSPY_BOARD_LIST, filters });
  const { deps, harness } = makeDeps();
  const result = await runSemanticJobsShadow(defaultRequest(plan), deps);
  assert.equal(result.status, 'completed');
  assert.equal(result.legacy.callCount, 1);
  assert.equal(harness.legacyCalls.length, 1);
  assert.deepEqual(harness.legacyCalls[0], {
    query: QUERY,
    sites: [...JOBSPY_BOARD_LIST],
    resultsWanted: 5,
    hoursOld: 48,
    location: 'Sydney',
    isRemote: true,
    jobType: 'fulltime',
    country: 'Australia',
    enforceAnnualSalary: true,
  });
});
