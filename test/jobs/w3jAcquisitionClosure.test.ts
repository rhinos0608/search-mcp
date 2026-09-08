/**
 * W3-J offline acquisition closure evidence.
 *
 * Single table-driven offline cross-package closure suite over the closed
 * W3-A..I modules: injected policy/capability registries, indexed ports,
 * JobSpy functions, and safe fetch. No network, no keys, no environment
 * reads, no disk, no timers, no persistence, no golden corpus. Deterministic
 * injected clocks in every timing-sensitive case.
 *
 * Cross-package invariants only; exhaustive per-package suites live in the
 * W3-A..I test files and are not duplicated here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACQUISITION_CONTRACT_VERSION,
  AcquisitionCandidateSchema,
  type AcquisitionSlice,
} from '../../src/jobs/acquisition/contracts.js';
import { AcquisitionEdgeIdSchema } from '../../src/jobs/acquisition/ids.js';
import {
  AcquisitionRunResultSchema,
  runAcquisition,
  type AcquisitionRunBudget,
  type AcquisitionRunResult,
} from '../../src/jobs/acquisition/coordinator.js';
import { SourcePolicyRegistry } from '../../src/jobs/acquisition/policy/registry.js';
import { AdapterCapabilityRegistry } from '../../src/jobs/acquisition/adapterRegistry.js';
import {
  INDEXED_PROVIDER_DEFINITIONS,
  type IndexedProviderPort,
} from '../../src/jobs/acquisition/providers/ports.js';
import { JOBSPY_CAPABILITY, type JobSpyBoard } from '../../src/jobs/acquisition/adapters/jobspy.js';
import {
  DESTINATION_FETCH_ADAPTER_ID,
  DESTINATION_FETCH_CAPABILITY,
  enrichDestinationFetches,
  type DestinationFetchCandidateAttempt,
  type DestinationFetchEnrichmentResult,
} from '../../src/jobs/acquisition/destinationFetch.js';
// W3-H additive barrel exports: case 14 proves export identity and schema.
import {
  DestinationFetchEnrichmentResultSchema as BarrelDestinationFetchEnrichmentResultSchema,
  enrichDestinationFetches as barrelEnrichDestinationFetches,
} from '../../src/jobs/acquisition/index.js';
import {
  executeIfPolicyPermitted,
  resolveExecutionPolicyEdge,
  resolveInformationalPolicyEdge,
} from '../../src/jobs/acquisition/policy/edgeCoordinator.js';
import { acquiredContentHash } from '../../src/jobs/acquisition/adapterSupport.js';
import type { SourcePolicy } from '../../src/jobs/acquisition/policy/sourcePolicy.js';
import type { SafeFetchOptions, SafeFetchResult } from '../../src/httpGuards.js';
import type { FlatJobRecord } from '../../src/jobs/acquisition/adapters/jobspy.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_ID = 'search-provider:brave';
const PROVIDER_ADAPTER_ID = 'indexed-provider:brave';
/** SEEK publisher identity per docs/jobs/indexed-discovery-amendment.md (`board:seek`). */
const SEEK_SOURCE_ID = 'board:seek';
const SEEK_HOST = 'seek.example';
const SEEK_URL = 'https://seek.example/job/1';
const CAPTURED_AT = '2026-01-02T00:00:00Z';
const NOW_ISO = '2026-01-03T00:00:00.000Z';
const SNIPPET = '<html><body>senior engineer role</body></html>';

const BUDGET: AcquisitionRunBudget = {
  logicalRequests: 20,
  reservedAttempts: 20,
  candidates: 20,
  bytes: 1_000_000,
  milliseconds: 70_000,
};

// ---------------------------------------------------------------------------
// Policy fixtures
// ---------------------------------------------------------------------------

function policy(
  sourceId: string,
  overrides: Partial<SourcePolicy['modes']> = {},
  revision = 'rev-1',
): SourcePolicy {
  return {
    sourceId,
    revision,
    modes: {
      automatedSearch: 'permitted',
      automatedFetch: 'permitted',
      userSuppliedContent: 'permitted',
      manualImport: 'permitted',
      employerApi: 'not_supported',
      ...overrides,
    },
    evidenceRefs: [],
    reviewedAt: '2026-01-01T00:00:00Z',
  } as unknown as SourcePolicy;
}

/** Frozen default direct SEEK policy (docs/jobs/indexed-discovery-amendment.md "SEEK rule"). */
function seekPolicy(): SourcePolicy {
  return policy(
    SEEK_SOURCE_ID,
    { automatedSearch: 'blocked', automatedFetch: 'blocked' },
    'seek-default-1',
  );
}

function providerFullyPermittedPolicy(): SourcePolicy {
  return policy(PROVIDER_ID);
}

function makeRegistries(
  seek: SourcePolicy = seekPolicy(),
  provider: SourcePolicy = providerFullyPermittedPolicy(),
  extra: readonly SourcePolicy[] = [],
): SourcePolicyRegistry {
  return new SourcePolicyRegistry([provider, seek, ...extra]);
}

function makeCaps(): AdapterCapabilityRegistry {
  return new AdapterCapabilityRegistry([
    {
      schemaVersion: '1.0.0',
      adapterId: PROVIDER_ADAPTER_ID,
      adapterVersion: '1.0.0',
      edges: [{ operation: 'automatedSearch', route: 'indexed', targetKind: 'discovery_provider' }],
    },
    JOBSPY_CAPABILITY,
    {
      schemaVersion: '1.0.0',
      adapterId: 'manual',
      adapterVersion: '1.0.0',
      edges: [
        { operation: 'manualImport', route: 'user_supplied', targetKind: 'adapter' },
        { operation: 'userSuppliedContent', route: 'user_supplied', targetKind: 'adapter' },
        { operation: 'automatedFetch', route: 'direct', targetKind: 'publisher' },
        { operation: 'automatedFetch', route: 'direct', targetKind: 'board' },
      ],
    },
    DESTINATION_FETCH_CAPABILITY,
  ]);
}

// ---------------------------------------------------------------------------
// Indexed-discovery (W3-D/W3-G) fixtures
// ---------------------------------------------------------------------------

function makeSlice(overrides: Record<string, unknown> = {}): AcquisitionSlice {
  const base: Record<string, unknown> = {
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    runId: 'run-1',
    sliceId: 'slice-1',
    ordinal: 0,
    queryVariantId: 'qv-1',
    query: 'software engineer',
    reason: 'closure evidence',
    adapterIds: [PROVIDER_ADAPTER_ID],
    localePackRefs: [],
    domainPackRefs: [],
    budget: {
      logicalRequests: 2,
      reservedAttempts: 5,
      candidates: 10,
      bytes: 100_000,
      milliseconds: 70_000,
    },
  };
  return { ...base, ...overrides } as unknown as AcquisitionSlice;
}

function mockBravePort(url: string): IndexedProviderPort {
  const def = INDEXED_PROVIDER_DEFINITIONS.find((d) => d.providerId === PROVIDER_ID)!;
  return {
    backend: def.backend as never,
    adapterId: def.adapterId,
    providerId: def.providerId,
    governance: def.governance,
    maxDurationMs: def.maxDurationMs,
    search: async () =>
      [
        {
          title: 'Senior Engineer',
          url,
          description: SNIPPET,
          position: 1,
          domain: SEEK_HOST,
          source: 'brave',
          age: null,
          ageKind: 'unknown',
          extraSnippet: null,
          deepLinks: null,
          contentKind: 'snippet',
          generatedSummary: null,
        },
      ] as never,
  };
}

function informationalEdge(
  reg: SourcePolicyRegistry,
  sliceId: string,
  operation: 'automatedSearch' | 'automatedFetch',
  sourceId = SEEK_SOURCE_ID,
  decidedAt = CAPTURED_AT,
) {
  const edgeId = acquiredContentHash(
    JSON.stringify(['acquisition-edge', 'run-1', sliceId, sourceId, operation, 'informational']),
  );
  return resolveInformationalPolicyEdge(
    reg,
    {
      edgeId: AcquisitionEdgeIdSchema.parse(edgeId),
      actor: { kind: 'adapter', namespace: 'adapter', id: PROVIDER_ADAPTER_ID },
      operation,
      route: 'direct',
      target: { kind: 'board', sourceId },
    },
    { decidedAt },
  );
}

interface SeekRunOptions {
  reg: SourcePolicyRegistry;
  /** Attach informational publisher edges (default true). False → publisher-less candidates. */
  informational?: boolean;
  sliceIds?: readonly string[];
  url?: string;
}

/** Build a schema-valid run: one brave indexed slice per sliceId against one SEEK URL. */
async function buildSeekRun(opts: SeekRunOptions): Promise<AcquisitionRunResult> {
  const informational = opts.informational ?? true;
  const url = opts.url ?? SEEK_URL;
  const sliceIds = opts.sliceIds ?? ['slice-1'];
  const plan = sliceIds.map((sliceId, i) => {
    const slice = makeSlice({
      sliceId,
      ordinal: i,
      adapterIds: [PROVIDER_ADAPTER_ID],
    });
    return {
      kind: 'indexed' as const,
      slice,
      providerId: PROVIDER_ID,
      safeSearch: 'moderate' as const,
      ...(informational
        ? {
            informationalEdges: [
              informationalEdge(opts.reg, sliceId, 'automatedSearch'),
              informationalEdge(opts.reg, sliceId, 'automatedFetch'),
            ] as unknown as never[],
          }
        : {}),
    };
  });
  const run = await runAcquisition(
    { runId: 'run-1', capturedAt: CAPTURED_AT, budget: { ...BUDGET }, plan: plan as never },
    {
      policyRegistry: opts.reg,
      capabilityRegistry: makeCaps(),
      ports: sliceIds.map(() => mockBravePort(url)),
      scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as never,
      // deterministic injected clock: zero elapsed durations everywhere
      monotonicNow: () => 0,
    },
  );
  return AcquisitionRunResultSchema.parse(run);
}

// ---------------------------------------------------------------------------
// W3-H fixtures
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init?: RequestInit | undefined;
  options?: SafeFetchOptions | undefined;
}

function okFetch(overrides: Partial<SafeFetchResult> = {}, body = SNIPPET) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init?: RequestInit, options?: SafeFetchOptions) => {
    calls.push({ url, init, options });
    return {
      finalUrl: url,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/html' }),
      body: new TextEncoder().encode(body),
      redirectCount: 0,
      ...overrides,
    };
  };
  return { fn, calls };
}

interface HDepsOptions {
  now?: () => Date;
  monotonicNow?: () => number;
}

function hDeps(
  reg: SourcePolicyRegistry,
  safeFetch: (
    url: string,
    init?: RequestInit,
    options?: SafeFetchOptions,
  ) => Promise<SafeFetchResult>,
  opts: HDepsOptions = {},
) {
  return {
    policyRegistry: reg,
    capabilityRegistry: makeCaps(),
    safeFetch,
    now: opts.now ?? (() => new Date(NOW_ISO)),
    // deterministic injected monotonic clock: fixed, never Date.now
    monotonicNow: opts.monotonicNow ?? (() => 1000),
  };
}

function candidateAttempts(
  result: DestinationFetchEnrichmentResult,
): DestinationFetchCandidateAttempt[] {
  return result.attempts.filter(
    (a): a is DestinationFetchCandidateAttempt => a.kind === 'candidate',
  );
}

// ---------------------------------------------------------------------------
// W3-E/W3-G JobSpy fixtures
// ---------------------------------------------------------------------------

const SHARED_JOB_URL = 'https://jobs.example.com/a';

function flatRecord(overrides: Partial<FlatJobRecord> & { site: string }): FlatJobRecord {
  return {
    id: 'rec-1',
    job_url: SHARED_JOB_URL,
    title: 'Senior Engineer',
    company: 'Example Co',
    description: 'Example description',
    ...overrides,
  } as FlatJobRecord;
}

function makeJobspySlice(sliceId: string, ordinal: number, budget: Record<string, unknown> = {}) {
  return makeSlice({
    sliceId,
    ordinal,
    adapterIds: ['jobspy'],
    ...budget,
  });
}

interface JobSpyHarness {
  scrapeCalls: string[];
}

interface JobSpyPlanOptions {
  boards: readonly JobSpyBoard[];
  /** slice budgets per plan index (override after default merge). */
  sliceBudgets?: readonly (Record<string, unknown> | undefined)[];
  runBudget?: AcquisitionRunBudget;
}

function makeJobspyPlan(opts: JobSpyPlanOptions) {
  return opts.boards.map((board, i) => ({
    kind: 'jobspy' as const,
    slice: makeJobspySlice(`slice-${String(i)}`, i, opts.sliceBudgets?.[i] ?? {}),
    board,
    filters: { resultsWanted: 5, hoursOld: 48 },
  }));
}

function makeJobspyDeps(overrides: {
  records?: Record<string, FlatJobRecord[]>;
  throwBoards?: ReadonlySet<string>;
}) {
  const scrapeCalls: string[] = [];
  const scrapeJobs = async (params: Record<string, unknown>) => {
    const site = (params.site_name as string[])[0] ?? '';
    scrapeCalls.push(site);
    if (overrides.throwBoards?.has(site)) throw new Error('injected scrape failure');
    const jobs = overrides.records?.[site] ?? [];
    return { jobs, totalScraped: jobs.length, newCount: jobs.length } as never;
  };
  const harness: JobSpyHarness = { scrapeCalls };
  return { scrapeJobs, harness };
}

// ---------------------------------------------------------------------------
// Table-driven aggregate cases
// ---------------------------------------------------------------------------

interface ClosureCase {
  readonly id: number;
  readonly name: string;
  readonly run: () => Promise<void> | void;
}

export const CASES: readonly ClosureCase[] = [
  {
    id: 1,
    name: 'provider permission remains separate from publisher search/fetch',
    run: async () => {
      // provider source is fully permitted — even automatedFetch on the provider —
      // while the publisher board:seek is blocked. W3-H must target the publisher,
      // never the provider, and must make zero fetches.
      const reg = makeRegistries();
      assert.equal(reg.decide(PROVIDER_ID, 'automatedFetch').state, 'permitted');
      assert.equal(reg.decide(SEEK_SOURCE_ID, 'automatedFetch').state, 'blocked');
      const run = await buildSeekRun({ reg });
      const { fn, calls } = okFetch();
      const result = await enrichDestinationFetches({ run, budget: BUDGET }, hDeps(reg, fn));
      assert.equal(calls.length, 0);
      assert.deepEqual(
        candidateAttempts(result).map((a) => a.status),
        ['not_permitted'],
      );
      const cand = result.run.slices[0]!.candidates[0]!;
      assert.equal(cand.state, 'indexed_only');
      // provider edge is authorizing for discovery only; publisher edges are informational
      const slice = result.run.slices[0]!;
      const authorizing = slice.policyEdges.filter((e) => e.effect === 'authorized_operation');
      assert.equal(authorizing.length, 2);
      assert.ok(authorizing.some((e) => e.actor.kind === 'provider'));
      for (const edge of slice.policyEdges) {
        if (edge.effect === 'informational_capability') {
          assert.equal(edge.target.sourceId, SEEK_SOURCE_ID);
        }
        if (edge.actor.kind === 'adapter' && edge.actor.id === DESTINATION_FETCH_ADAPTER_ID) {
          // the destination-fetch adapter never resolves an edge against the provider
          assert.equal(edge.target.sourceId, SEEK_SOURCE_ID);
          assert.equal(edge.state, 'blocked');
        }
      }
      assert.equal(result.status, 'partial');
    },
  },
  {
    id: 2,
    name: 'exact blocked SEEK direct search/fetch causes zero direct calls',
    run: async () => {
      const reg = makeRegistries();
      // inner table: both frozen SEEK default modes are blocked and never execute
      for (const operation of ['automatedSearch', 'automatedFetch'] as const) {
        const edgeId = acquiredContentHash(
          JSON.stringify([
            'acquisition-edge',
            'run-1',
            'slice-1',
            SEEK_SOURCE_ID,
            operation,
            'closure-probe',
          ]),
        );
        const edge = resolveExecutionPolicyEdge(
          reg,
          {
            edgeId: AcquisitionEdgeIdSchema.parse(edgeId),
            actor: { kind: 'adapter', namespace: 'adapter', id: 'closure-probe' },
            operation,
            route: 'direct',
            target: { kind: 'board', sourceId: SEEK_SOURCE_ID },
          },
          { decidedAt: CAPTURED_AT },
        );
        assert.equal(edge.state, 'blocked');
        let probes = 0;
        const exec = await executeIfPolicyPermitted(edge, async () => {
          probes += 1;
          return 'called';
        });
        assert.equal(exec.status, 'not_executed');
        if (exec.status === 'not_executed') {
          assert.equal(exec.reason, 'policy_not_permitted');
        }
        assert.equal(probes, 0);
      }
      // the same exact blocked registry also produces zero destination fetches in W3-H
      const run = await buildSeekRun({ reg });
      const { fn, calls } = okFetch();
      const result = await enrichDestinationFetches({ run, budget: BUDGET }, hDeps(reg, fn));
      assert.equal(calls.length, 0);
      assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
    },
  },
  {
    id: 3,
    name: 'permitted indexed SEEK candidate survives as caveated indexed_only',
    run: async () => {
      // permitted brave indexed discovery + frozen default blocked SEEK edges
      const reg = makeRegistries();
      const run = await buildSeekRun({ reg });
      const cand = run.slices[0]!.candidates[0]!;
      assert.equal(cand.state, 'indexed_only');
      for (const caveat of [
        'provider_index_only',
        'publisher_not_fetched',
        'stale_index_possible',
        'direct_search_blocked',
        'destination_fetch_blocked',
      ]) {
        assert.ok(cand.caveats.includes(caveat as never), `caveat ${caveat}`);
      }
      const { fn, calls } = okFetch();
      const result = await enrichDestinationFetches({ run, budget: BUDGET }, hDeps(reg, fn));
      assert.equal(calls.length, 0);
      const after = result.run.slices[0]!.candidates[0]!;
      assert.equal(after.state, 'indexed_only');
      assert.deepEqual(after.caveats, cand.caveats);
      assert.equal(
        result.run.slices[0]!.evidence.some((e) => e.kind === 'destination_content'),
        false,
      );
      AcquisitionRunResultSchema.parse(result.run);
    },
  },
  {
    id: 4,
    name: 'indexed-only candidate has zero observation envelopes',
    run: async () => {
      const reg = makeRegistries();
      const run = await buildSeekRun({ reg });
      const slice = run.slices[0]!;
      assert.equal(slice.observations.length, 0);
      const cand = slice.candidates[0]!;
      assert.equal('observationEnvelopeRef' in cand, false);
      for (const ev of slice.evidence) {
        assert.equal(ev.kind === 'destination_content' || ev.kind === 'adapter_listing', false);
      }
      const { fn, calls } = okFetch();
      const result = await enrichDestinationFetches({ run, budget: BUDGET }, hDeps(reg, fn));
      assert.equal(calls.length, 0);
      assert.equal(result.run.slices[0]!.observations.length, 0);
      assert.equal('observationEnvelopeRef' in result.run.slices[0]!.candidates[0]!, false);
    },
  },
  {
    id: 5,
    name: 'informational edge never authorizes execution',
    run: async () => {
      // a permitted informational automatedFetch edge exists on the candidate, but
      // call-time execution policy is blocked: zero fetches.
      const permittedReg = makeRegistries(policy(SEEK_SOURCE_ID, {}, 'seek-permitted-1'));
      const run = await buildSeekRun({ reg: permittedReg });
      const slice = run.slices[0]!;
      const infoEdge = slice.policyEdges.find(
        (e) => e.effect === 'informational_capability' && e.state === 'permitted',
      );
      assert.ok(infoEdge, 'fixture needs a permitted informational edge');
      // direct proof: executeIfPolicyPermitted refuses informational edges outright
      let probes = 0;
      const refused = await executeIfPolicyPermitted(infoEdge, async () => {
        probes += 1;
        return 'called';
      });
      assert.equal(refused.status, 'not_executed');
      if (refused.status === 'not_executed') assert.equal(refused.reason, 'informational_only');
      assert.equal(probes, 0);
      // candidate carries the informational ref; W3-H still resolves fresh execution policy
      const cand = slice.candidates[0]!;
      slice.candidates[0] = AcquisitionCandidateSchema.parse({
        ...cand,
        policyEdgeRefs: [...cand.policyEdgeRefs, infoEdge.edgeId],
      });
      AcquisitionRunResultSchema.parse(run);
      const blockedReg = makeRegistries();
      const { fn, calls } = okFetch();
      const result = await enrichDestinationFetches({ run, budget: BUDGET }, hDeps(blockedReg, fn));
      assert.equal(calls.length, 0);
      assert.deepEqual(
        candidateAttempts(result).map((a) => a.status),
        ['not_permitted'],
      );
      assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
    },
  },
  {
    id: 6,
    name: 'unknown source policy fails closed',
    run: async () => {
      // registry has the provider but no board:seek policy at all
      const reg = new SourcePolicyRegistry([providerFullyPermittedPolicy()]);
      assert.equal(reg.decide(SEEK_SOURCE_ID, 'automatedFetch').state, 'not_supported');
      const run = await buildSeekRun({ reg });
      const { fn, calls } = okFetch();
      const result = await enrichDestinationFetches({ run, budget: BUDGET }, hDeps(reg, fn));
      assert.equal(calls.length, 0);
      assert.deepEqual(
        candidateAttempts(result).map((a) => a.status),
        ['not_permitted'],
      );
      assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
      // fresh edge records the fail-closed sentinel: policy missing note + decision time
      const freshEdge = result.run.slices[0]!.policyEdges.find(
        (e) => e.actor.kind === 'adapter' && e.actor.id === DESTINATION_FETCH_ADAPTER_ID,
      );
      assert.ok(freshEdge);
      assert.equal(freshEdge.state, 'not_supported');
      assert.equal(freshEdge.notes, 'policy missing; fail closed');
      assert.equal(freshEdge.reviewedAt, NOW_ISO);
      const cov = result.run.slices[0]!.coverage.find(
        (c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID,
      );
      assert.ok(cov);
      assert.equal(cov.state, 'not_supported');
      assert.equal(cov.resultState, 'unknown');
      assert.equal(cov.logicalRequestsUsed, 0);
    },
  },
  {
    id: 7,
    name: 'W3-G budget skipping, failure isolation, and annotation-only dedup remain valid',
    run: async () => {
      // s0 indeed succeeds (URL A); s1 linkedin scrape throws (isolated failure);
      // s2 glassdoor succeeds with the same URL A (duplicate annotation);
      // s3 zip_recruiter slice budget exceeds remaining run budget (skip).
      const runBudget: AcquisitionRunBudget = {
        logicalRequests: 6,
        reservedAttempts: 20,
        candidates: 20,
        bytes: 500_000,
        milliseconds: 70_000,
      };
      const plan = makeJobspyPlan({
        boards: ['indeed', 'linkedin', 'glassdoor', 'zip_recruiter'],
        sliceBudgets: [
          undefined,
          undefined,
          undefined,
          {
            budget: {
              logicalRequests: 4,
              reservedAttempts: 2,
              candidates: 5,
              bytes: 100_000,
              milliseconds: 60_000,
            },
          },
        ],
        runBudget,
      });
      const { scrapeJobs, harness } = makeJobspyDeps({
        records: {
          indeed: [flatRecord({ site: 'indeed', id: 'i1', job_url: SHARED_JOB_URL })],
          glassdoor: [flatRecord({ site: 'glassdoor', id: 'g1', job_url: SHARED_JOB_URL })],
        },
        throwBoards: new Set(['linkedin']),
      });
      const run = await runAcquisition(
        { runId: 'run-1', capturedAt: CAPTURED_AT, budget: runBudget, plan: plan as never },
        {
          policyRegistry: makeRegistries(seekPolicy(), policy('linkedin'), [
            policy('indeed'),
            policy('glassdoor'),
            policy('zip_recruiter'),
          ]),
          capabilityRegistry: new AdapterCapabilityRegistry([JOBSPY_CAPABILITY]),
          ports: [],
          scrapeJobs,
          monotonicNow: () => 0,
        },
      );
      const result = AcquisitionRunResultSchema.parse(run);
      assert.equal(result.status, 'budget_exhausted');
      assert.ok(result.warnings.includes('budget_exhausted'));
      // budget skip: slice-3 skipped, never scraped
      assert.deepEqual(
        result.skipped.map((s) => s.sliceId),
        ['slice-3'],
      );
      assert.equal(result.skipped[0]!.reason, 'budget_exhausted');
      assert.equal(harness.scrapeCalls.includes('zip_recruiter'), false);
      // failure isolation: linkedin fabricated-failed; other slices unaffected
      const linkedin = result.slices.find((s) => s.sliceId === 'slice-1')!;
      // the failed board is isolated to its own slice: failed coverage with a
      // sanitized error code, no raw error text, remaining slices unaffected
      assert.equal(linkedin.coverage[0]!.state, 'failed');
      assert.equal(linkedin.coverage[0]!.errorCode, 'ERROR');
      assert.equal(result.warnings.includes('slice_execution_error'), false);
      assert.equal(JSON.stringify(result).includes('injected scrape failure'), false);
      const indeed = result.slices.find((s) => s.sliceId === 'slice-0')!;
      const glassdoor = result.slices.find((s) => s.sliceId === 'slice-2')!;
      assert.equal(indeed.coverage[0]!.state, 'succeeded');
      assert.equal(glassdoor.coverage[0]!.state, 'succeeded');
      // annotation-only dedup: both candidates retained, group annotates superseded
      assert.equal(indeed.candidates.length, 1);
      assert.equal(glassdoor.candidates.length, 1);
      assert.equal(result.duplicates.length, 1);
      const group = result.duplicates[0]!;
      assert.equal(group.canonicalUrl, SHARED_JOB_URL);
      assert.equal(group.retainedCandidateId, indeed.candidates[0]!.candidateId);
      assert.deepEqual(group.superseded, [
        { candidateId: glassdoor.candidates[0]!.candidateId, sliceId: 'slice-2' },
      ]);
      // consumed budget stays within the declared budget
      assert.ok(result.budgetConsumed.logicalRequests <= runBudget.logicalRequests);
      assert.ok(result.budgetConsumed.milliseconds <= runBudget.milliseconds);
    },
  },
  {
    id: 8,
    name: 'W3-F destination_fetch_required remains review-only in W3-G (and H)',
    run: async () => {
      // prior permitted fetch edge (import-time), recheck against the frozen blocked
      // SEEK default → review-only record with zero fetch network activity.
      const permittedReg = makeRegistries(policy(SEEK_SOURCE_ID, {}, 'seek-permitted-1'));
      const priorEdgeId = acquiredContentHash(
        JSON.stringify([
          'acquisition-edge',
          'run-1',
          'slice-1',
          'manual',
          'automatedFetch',
          'execution',
        ]),
      );
      const priorEdge = resolveExecutionPolicyEdge(
        permittedReg,
        {
          edgeId: AcquisitionEdgeIdSchema.parse(priorEdgeId),
          actor: { kind: 'user', namespace: 'user', id: 'u1' },
          operation: 'automatedFetch',
          route: 'direct',
          target: { kind: 'board', sourceId: SEEK_SOURCE_ID, normalizedHost: SEEK_HOST },
        },
        { decidedAt: CAPTURED_AT },
      );
      assert.equal(priorEdge.state, 'permitted');
      const manualPlan = [
        {
          kind: 'manual' as const,
          slice: makeJobspySlice('slice-1', 0, { adapterIds: ['manual'] }),
          submittedBy: { namespace: 'user', id: 'u1' },
          content: { kind: 'url_only' as const, destinationUrl: SEEK_URL },
          publisherTarget: { kind: 'board' as const, sourceId: SEEK_SOURCE_ID },
          destinationFetchEdge: priorEdge,
        },
      ];
      const { scrapeJobs, harness } = makeJobspyDeps({});
      const run = await runAcquisition(
        {
          runId: 'run-1',
          capturedAt: CAPTURED_AT,
          budget: { ...BUDGET },
          plan: manualPlan as never,
        },
        {
          policyRegistry: makeRegistries(), // frozen default: automatedFetch blocked → recheck fails
          capabilityRegistry: makeCaps(),
          ports: [],
          scrapeJobs,
          monotonicNow: () => 0,
        },
      );
      const result = AcquisitionRunResultSchema.parse(run);
      assert.equal(harness.scrapeCalls.length, 0);
      assert.equal(result.destinationFetchReviews.length, 1);
      const review = result.destinationFetchReviews[0]!;
      assert.equal(review.disposition, 'fetch_not_permitted');
      assert.equal(review.recheckState, 'blocked');
      assert.equal(review.priorFetchEdgeRef, priorEdgeId);
      assert.ok(result.warnings.includes('destination_fetch_not_permitted'));
      assert.equal(result.slices[0]!.candidates.length, 0);
      assert.equal(
        result.slices.flatMap((s) => s.evidence).some((e) => e.kind === 'destination_content'),
        false,
      );
      // W3-H turns the review into an unsupported v1 handoff: still zero HTTP
      const { fn, calls } = okFetch();
      const enriched = await enrichDestinationFetches(
        { run: result, budget: BUDGET },
        hDeps(makeRegistries(), fn),
      );
      assert.equal(calls.length, 0);
      assert.equal(enriched.attempts.length, 1);
      const attempt = enriched.attempts[0]!;
      assert.equal(attempt.kind, 'manual_handoff');
      if (attempt.kind === 'manual_handoff') {
        assert.equal(attempt.status, 'unsupported_v1_manual_handoff');
        assert.equal(attempt.priorFetchEdgeRef, priorEdgeId);
      }
      assert.equal(enriched.run.destinationFetchReviews.length, 1);
    },
  },
  {
    id: 9,
    name: 'W3-H blocked destination edge causes zero safeFetch',
    run: async () => {
      const reg = makeRegistries();
      const run = await buildSeekRun({ reg });
      const { fn, calls } = okFetch();
      const result = await enrichDestinationFetches({ run, budget: BUDGET }, hDeps(reg, fn));
      assert.equal(calls.length, 0);
      assert.deepEqual(
        candidateAttempts(result).map((a) => a.status),
        ['not_permitted'],
      );
      const cov = result.run.slices[0]!.coverage.find(
        (c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID,
      );
      assert.ok(cov);
      assert.equal(cov.state, 'policy_blocked');
      assert.equal(cov.resultState, 'unknown');
      assert.equal(cov.logicalRequestsUsed, 0);
      assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
    },
  },
  {
    id: 10,
    name: 'W3-H permitted destination call carries no credentials and creates valid destination evidence',
    run: async () => {
      const reg = makeRegistries(policy(SEEK_SOURCE_ID, {}, 'seek-permitted-1'));
      const run = await buildSeekRun({ reg });
      const { fn, calls } = okFetch();
      const result = await enrichDestinationFetches({ run, budget: BUDGET }, hDeps(reg, fn));
      assert.equal(result.status, 'completed');
      assert.equal(calls.length, 1);
      const call = calls[0]!;
      // credentials-free: plain canonical URL, GET, accept header only
      assert.equal(call.url, SEEK_URL);
      assert.equal(call.url.includes('@'), false);
      assert.equal(call.init?.method, 'GET');
      const headers = call.init?.headers as Record<string, string>;
      assert.deepEqual(Object.keys(headers), ['accept']);
      assert.equal('authorization' in headers, false);
      assert.equal('cookie' in headers, false);
      const opts = call.options ?? {};
      assert.equal(opts.maxRedirects, 5);
      assert.equal(opts.timeoutMs, 10_000);
      assert.equal(opts.maxBytes, 262_144);
      assert.equal('networkPolicy' in opts, false);
      // valid destination evidence: upgraded candidate + linked evidence/envelope
      const cand = result.run.slices[0]!.candidates[0]!;
      assert.equal(cand.state, 'destination_fetched');
      if (cand.state !== 'destination_fetched') return;
      assert.ok(cand.destinationEvidenceRef);
      assert.ok(cand.observationEnvelopeRef);
      assert.equal(cand.fetchEdgeRef, cand.policyEdgeRefs[cand.policyEdgeRefs.length - 1]);
      assert.deepEqual(cand.caveats, ['stale_index_possible']);
      const slice = result.run.slices[0]!;
      const evidence = slice.evidence.find((e) => e.evidenceId === cand.destinationEvidenceRef);
      assert.ok(evidence);
      assert.equal(evidence.kind, 'destination_content');
      if (evidence.kind === 'destination_content') {
        assert.equal(evidence.targetCanonicalUrl, SEEK_URL);
        assert.equal(evidence.boundedText, SNIPPET);
        assert.equal(evidence.capturedAt, NOW_ISO);
      }
      const envelope = slice.observations.find((o) => o.envelopeId === cand.observationEnvelopeRef);
      assert.ok(envelope);
      assert.equal(envelope.acquisition.captureKind, 'destination_fetch');
      if (envelope.acquisition.captureKind === 'destination_fetch') {
        assert.equal(envelope.acquisition.publisherSourceId, SEEK_SOURCE_ID);
        assert.deepEqual(envelope.acquisition.discoveryCandidateIds, [cand.candidateId]);
        assert.equal(envelope.acquisition.fetchEdgeRef, cand.fetchEdgeRef);
      }
      assert.equal(envelope.listing.adapterId, DESTINATION_FETCH_ADAPTER_ID);
      assert.equal(envelope.observation.extractionVersion, 'none');
      assert.equal(envelope.observation.immutable, true);
    },
  },
  {
    id: 11,
    name: 'W3-H refuses publisher-less and manual URL candidates',
    run: async () => {
      // (a) publisher-less indexed candidate: zero policy/network calls
      {
        const reg = makeRegistries();
        const run = await buildSeekRun({ reg, informational: false });
        assert.equal(run.slices[0]!.candidates[0]!.provenance.publisher, undefined);
        const { fn, calls } = okFetch();
        const result = await enrichDestinationFetches({ run, budget: BUDGET }, hDeps(reg, fn));
        assert.equal(calls.length, 0);
        assert.deepEqual(
          candidateAttempts(result).map((a) => a.status),
          ['publisher_identity_missing'],
        );
        assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
      }
      // (b) manual inline content with a destination URL stays manual_content: skipped
      // silently by W3-H, zero fetch, state preserved
      {
        const manualPlan = [
          {
            kind: 'manual' as const,
            slice: makeJobspySlice('slice-1', 0, { adapterIds: ['manual'] }),
            submittedBy: { namespace: 'user', id: 'u1' },
            content: {
              kind: 'inline_text' as const,
              text: 'Senior Engineer role pasted by the user',
              destinationUrl: SEEK_URL,
            },
            publisherTarget: { kind: 'board' as const, sourceId: SEEK_SOURCE_ID },
          },
        ];
        const { scrapeJobs } = makeJobspyDeps({});
        const run = await runAcquisition(
          {
            runId: 'run-1',
            capturedAt: CAPTURED_AT,
            budget: { ...BUDGET },
            plan: manualPlan as never,
          },
          {
            policyRegistry: makeRegistries(),
            capabilityRegistry: makeCaps(),
            ports: [],
            scrapeJobs,
            monotonicNow: () => 0,
          },
        );
        const parsed = AcquisitionRunResultSchema.parse(run);
        const cand = parsed.slices[0]!.candidates[0]!;
        assert.equal(cand.state, 'manual_content');
        const { fn, calls } = okFetch();
        const result = await enrichDestinationFetches(
          { run: parsed, budget: BUDGET },
          hDeps(makeRegistries(), fn),
        );
        assert.equal(calls.length, 0);
        assert.deepEqual(candidateAttempts(result), []);
        assert.equal(result.run.slices[0]!.candidates[0]!.state, 'manual_content');
        assert.equal(
          result.run.slices[0]!.coverage.some((c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID),
          false,
        );
      }
    },
  },
  {
    id: 12,
    name: 'H abort and work budgets remain bounded',
    run: async () => {
      // H abort: first fetch aborts the controller and throws; no further candidates run
      {
        const reg = makeRegistries(policy(SEEK_SOURCE_ID, {}, 'seek-permitted-1'));
        const run = await buildSeekRun({ reg, sliceIds: ['slice-1', 'slice-2'] });
        assert.equal(run.slices.length, 2);
        const controller = new AbortController();
        const calls: FetchCall[] = [];
        const fn = async (url: string, init?: RequestInit, options?: SafeFetchOptions) => {
          calls.push({ url, init, options });
          controller.abort();
          throw new Error('injected abort');
        };
        const result = await enrichDestinationFetches(
          { run, budget: BUDGET, abortSignal: controller.signal },
          hDeps(reg, fn),
        );
        assert.equal(calls.length, 1);
        assert.equal(result.status, 'aborted');
        assert.equal(candidateAttempts(result).length, 1);
      }
      // H work budget: candidates budget 1 bounds processing across slices
      {
        const reg = makeRegistries(policy(SEEK_SOURCE_ID, {}, 'seek-permitted-1'));
        const run = await buildSeekRun({ reg, sliceIds: ['slice-1', 'slice-2'] });
        const { fn, calls } = okFetch();
        const result = await enrichDestinationFetches(
          { run, budget: { ...BUDGET, candidates: 1 } },
          hDeps(reg, fn),
        );
        assert.equal(calls.length, 1);
        assert.deepEqual(
          candidateAttempts(result).map((a) => a.status),
          ['upgraded', 'capacity_exhausted'],
        );
        assert.equal(result.status, 'budget_exhausted');
        assert.ok(result.budgetConsumed.candidates <= 2);
      }
    },
  },
  {
    id: 13,
    name: 'full H outputs pass exported schemas',
    run: async () => {
      // H: full successful enrichment parses through the additive barrel export
      {
        const reg = makeRegistries(policy(SEEK_SOURCE_ID, {}, 'seek-permitted-1'));
        const run = await buildSeekRun({ reg });
        const { fn } = okFetch();
        const result = await enrichDestinationFetches({ run, budget: BUDGET }, hDeps(reg, fn));
        assert.equal(result.status, 'completed');
        assert.equal(barrelEnrichDestinationFetches, enrichDestinationFetches);
        const parsed = BarrelDestinationFetchEnrichmentResultSchema.parse(result);
        assert.equal(parsed.schemaVersion, '1.0.0');
        assert.equal(parsed.run.slices[0]!.candidates[0]!.state, 'destination_fetched');
      }
    },
  },
];

for (const c of CASES) {
  test(`W3-J ${String(c.id)}. ${c.name}`, async () => {
    await c.run();
  });
}
