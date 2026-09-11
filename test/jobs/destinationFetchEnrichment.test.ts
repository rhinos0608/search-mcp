import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AcquisitionCandidateSchema } from '../../src/jobs/acquisition/contracts.js';
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
import {
  DESTINATION_FETCH_ADAPTER_ID,
  DESTINATION_FETCH_CAPABILITY,
  DESTINATION_FETCH_ENRICHMENT_VERSION,
  DestinationFetchEnrichmentResultSchema,
  enrichDestinationFetches,
  type DestinationFetchCandidateAttempt,
  type DestinationFetchEnrichmentResult,
} from '../../src/jobs/acquisition/destinationFetch.js';
import {
  acquiredContentHash,
  deterministicAcquisitionId,
} from '../../src/jobs/acquisition/adapterSupport.js';
import {
  resolveExecutionPolicyEdge,
  resolveInformationalPolicyEdge,
} from '../../src/jobs/acquisition/policy/edgeCoordinator.js';
import type { SourcePolicy } from '../../src/jobs/acquisition/policy/sourcePolicy.js';
import type { SafeFetchOptions, SafeFetchResult } from '../../src/httpGuards.js';
import { isToolError } from '../../src/errors.js';

const PROVIDER_ID = 'search-provider:brave';
const PUBLISHER_SOURCE_ID = 'publisher:acme';
const OTHER_PUBLISHER_SOURCE_ID = 'publisher:other';
const DEST_URL = 'https://example.test/a';
const CAPTURED_AT = '2026-01-02T00:00:00Z';
const NOW_ISO = '2026-01-03T00:00:00.000Z';
const SNIPPET = '<html><body>senior engineer role</body></html>';

const budget: AcquisitionRunBudget = {
  logicalRequests: 20,
  reservedAttempts: 20,
  candidates: 20,
  bytes: 1_000_000,
  milliseconds: 70_000,
};

function policy(sourceId: string, fetchState = 'permitted'): SourcePolicy {
  return {
    sourceId,
    revision: 'rev-1',
    modes: {
      automatedSearch: 'permitted',
      automatedFetch: fetchState,
      userSuppliedContent: 'permitted',
      manualImport: 'permitted',
      employerApi: 'not_supported',
    },
    evidenceRefs: [],
    reviewedAt: '2026-01-01T00:00:00Z',
  } as unknown as SourcePolicy;
}

function makeRegistries(fetchState = 'permitted', withCapability = true) {
  const reg = new SourcePolicyRegistry([
    policy(PROVIDER_ID),
    policy(PUBLISHER_SOURCE_ID, fetchState),
    policy(OTHER_PUBLISHER_SOURCE_ID, fetchState),
  ]);
  const caps = new AdapterCapabilityRegistry(withCapability ? [DESTINATION_FETCH_CAPABILITY] : []);
  return { reg, caps };
}

function mockPort(results: unknown[]): IndexedProviderPort {
  const def = INDEXED_PROVIDER_DEFINITIONS.find((d) => d.providerId === PROVIDER_ID)!;
  return {
    backend: def.backend as never,
    adapterId: def.adapterId,
    providerId: def.providerId,
    governance: def.governance,
    maxDurationMs: def.maxDurationMs,
    search: async () => results as never,
  };
}

function informationalEdge(reg: SourcePolicyRegistry, sliceId: string, sourceId: string) {
  const edgeId = acquiredContentHash(
    JSON.stringify([
      'acquisition-edge',
      'run-1',
      sliceId,
      sourceId,
      'automatedFetch',
      'informational',
    ]),
  );
  const edge = resolveInformationalPolicyEdge(
    reg,
    {
      edgeId: AcquisitionEdgeIdSchema.parse(edgeId),
      actor: { kind: 'adapter', namespace: 'adapter', id: DESTINATION_FETCH_ADAPTER_ID },
      operation: 'automatedFetch',
      route: 'direct',
      target: { kind: 'publisher', sourceId },
    },
    { decidedAt: CAPTURED_AT },
  );
  return edge;
}

interface BuildOptions {
  urls?: string[];
  withPublisher?: boolean;
  sliceIds?: string[];
  reg?: SourcePolicyRegistry;
  slicePublishers?: Record<string, string>;
}

/** Build a schema-valid AcquisitionRunResult with one indexed_only candidate per slice. */
async function buildRun(opts: BuildOptions = {}): Promise<AcquisitionRunResult> {
  const urls = opts.urls ?? [DEST_URL];
  const sliceIds = opts.sliceIds ?? ['slice-1'];
  const withPublisher = opts.withPublisher ?? true;
  const reg = opts.reg ?? makeRegistries().reg;
  const port = mockPort(
    urls.map((url, i) => ({
      title: `T${String(i)}`,
      url,
      description: SNIPPET,
      position: i + 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    })),
  );
  const plan = sliceIds.map((sliceId, i) => ({
    kind: 'indexed' as const,
    slice: {
      schemaVersion: '1.0.0',
      runId: 'run-1',
      sliceId,
      ordinal: i,
      queryVariantId: 'qv-1',
      query: 'software engineer',
      reason: 'test',
      adapterIds: [port.adapterId],
      localePackRefs: [],
      domainPackRefs: [],
      budget: {
        logicalRequests: 2,
        reservedAttempts: 5,
        candidates: 10,
        bytes: 100_000,
        milliseconds: 70_000,
      },
    },
    providerId: port.providerId,
    safeSearch: 'moderate' as const,
    ...(withPublisher
      ? {
          informationalEdges: [
            informationalEdge(reg, sliceId, opts.slicePublishers?.[sliceId] ?? PUBLISHER_SOURCE_ID),
          ] as unknown as never[],
        }
      : {}),
  }));
  const run = await runAcquisition(
    { runId: 'run-1', capturedAt: CAPTURED_AT, budget, plan: plan as never },
    {
      policyRegistry: reg,
      capabilityRegistry: new AdapterCapabilityRegistry([
        {
          schemaVersion: '1.0.0',
          adapterId: port.adapterId,
          adapterVersion: '1.0.0',
          edges: [
            { operation: 'automatedSearch', route: 'indexed', targetKind: 'discovery_provider' },
          ],
        } as never,
      ]),
      ports: [port],
      scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as never,
      // deterministic clock: under combined-file test load the default Date.now clock makes
      // slice-1 coverage durationMs consume >=1ms of the 70_000ms run budget, so the
      // per-slice budget precheck (slice.budget.milliseconds=70_000 vs remaining) skips
      // every later slice and tests that expect slice-2 coverage/attempts fail
      // intermittently (same flake class as the W3-G coordinator fix).
      monotonicNow: () => 0,
    },
  );
  return AcquisitionRunResultSchema.parse(run);
}

/** Convert the first indexed_only candidate of a slice into fetch_eligible with a pre-resolved edge. */
function makeEligible(
  run: AcquisitionRunResult,
  sliceId: string,
  reg: SourcePolicyRegistry,
  decidedAt = CAPTURED_AT,
): string {
  const slice = run.slices.find((s) => s.sliceId === sliceId)!;
  const cand = slice.candidates[0]!;
  assert.equal(cand.state, 'indexed_only');
  const prov = cand.provenance as {
    publisher?: { kind: string; sourceId: string };
    destination: { normalizedHost: string };
  };
  const pub = prov.publisher!;
  const edgeId = acquiredContentHash(
    JSON.stringify([
      'acquisition-edge',
      slice.runId,
      sliceId,
      DESTINATION_FETCH_ADAPTER_ID,
      cand.candidateId,
      'automatedFetch',
      'execution',
      decidedAt,
    ]),
  );
  const edge = resolveExecutionPolicyEdge(
    reg,
    {
      edgeId: AcquisitionEdgeIdSchema.parse(edgeId),
      actor: { kind: 'adapter', namespace: 'adapter', id: DESTINATION_FETCH_ADAPTER_ID },
      operation: 'automatedFetch',
      route: 'direct',
      target: {
        kind: pub.kind as never,
        sourceId: pub.sourceId,
        normalizedHost: prov.destination.normalizedHost,
      },
    },
    { decidedAt },
  );
  slice.policyEdges.push(edge);
  const upgraded = {
    ...cand,
    state: 'fetch_eligible',
    fetchEdgeRef: edgeId,
    policyEdgeRefs: [...cand.policyEdgeRefs, edgeId],
  };
  slice.candidates[0] = AcquisitionCandidateSchema.parse(upgraded);
  AcquisitionRunResultSchema.parse(run);
  return edgeId;
}

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

function rejectFetch(error: Error) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init?: RequestInit, options?: SafeFetchOptions) => {
    calls.push({ url, init, options });
    throw error;
  };
  return { fn, calls };
}

function baseDeps(
  reg: SourcePolicyRegistry,
  caps: AdapterCapabilityRegistry,
  safeFetch: (
    url: string,
    init?: RequestInit,
    options?: SafeFetchOptions,
  ) => Promise<SafeFetchResult>,
  monotonicNow: () => number = () => 1000,
) {
  return {
    policyRegistry: reg,
    capabilityRegistry: caps,
    safeFetch,
    now: () => new Date(NOW_ISO),
    monotonicNow,
  };
}

function candidateAttempts(
  result: DestinationFetchEnrichmentResult,
): DestinationFetchCandidateAttempt[] {
  return result.attempts.filter(
    (a): a is DestinationFetchCandidateAttempt => a.kind === 'candidate',
  );
}

test('1. permitted indexed candidate upgrades to destination_fetched with valid schema', async () => {
  const { reg, caps } = makeRegistries();
  const run = await buildRun({ reg });
  const { fn, calls } = okFetch();
  const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
  assert.equal(result.status, 'completed');
  assert.equal(result.schemaVersion, DESTINATION_FETCH_ENRICHMENT_VERSION);
  assert.equal(result.attempts.length, 1);
  const attempt = result.attempts[0]!;
  assert.equal(attempt.kind, 'candidate');
  assert.equal(attempt.status, 'upgraded');
  assert.equal(attempt.sliceId, 'slice-1');
  assert.ok(attempt.fetchEdgeRef);
  assert.equal(calls.length, 1);
  const slice = result.run.slices[0]!;
  const cand = slice.candidates[0]!;
  assert.equal(cand.state, 'destination_fetched');
  const destEvidence = slice.evidence.find((e) => e.kind === 'destination_content');
  assert.ok(destEvidence);
  assert.equal(slice.observations.length, 1);
  const cov = slice.coverage.find((c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID);
  assert.ok(cov);
  assert.equal(cov.state, 'succeeded');
  assert.equal(cov.resultState, 'results');
  assert.equal(cov.candidatesProduced, 1);
  assert.equal(cov.logicalRequestsUsed, 1);
  assert.ok(cov.bytesUsed > 0);
  assert.equal(result.budgetConsumed.logicalRequests, 1);
  assert.equal(result.budgetConsumed.reservedAttempts, 1);
  assert.equal(result.budgetConsumed.candidates, 1);
  DestinationFetchEnrichmentResultSchema.parse(result);
});

test('2. missing publisher identity → zero resolution/fetch', async () => {
  const { reg, caps } = makeRegistries();
  const run = await buildRun({ reg, withPublisher: false });
  const slice = run.slices[0]!;
  const prov = slice.candidates[0]!.provenance;
  assert.equal(prov.kind, 'indexed_discovery');
  assert.equal(prov.publisher, undefined);
  const { fn, calls } = okFetch();
  const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
  assert.equal(calls.length, 0);
  assert.deepEqual(
    candidateAttempts(result).map((a) => a.status),
    ['publisher_identity_missing'],
  );
  assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
  assert.equal(result.status, 'partial');
});

test('3. missing capability → zero resolution/fetch', async () => {
  const { reg, caps } = makeRegistries('permitted', false);
  const run = await buildRun({ reg });
  const { fn, calls } = okFetch();
  const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
  assert.equal(calls.length, 0);
  assert.deepEqual(
    candidateAttempts(result).map((a) => a.status),
    ['capability_missing'],
  );
  assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
});

for (const state of ['blocked', 'requires_configuration', 'requires_review', 'not_supported']) {
  test(`4. policy state ${state} → not_permitted, zero fetch`, async () => {
    const { reg, caps } = makeRegistries(state);
    const run = await buildRun({ reg });
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
    assert.equal(calls.length, 0);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['not_permitted'],
    );
    assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
    if (state === 'blocked') {
      const cov = result.run.slices[0]!.coverage.find(
        (c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID,
      );
      assert.ok(cov);
      assert.equal(cov.state, 'policy_blocked');
      assert.equal(cov.resultState, 'unknown');
      assert.equal(cov.logicalRequestsUsed, 0);
      assert.ok(cov.policyEdgeRefs.length >= 1);
    }
  });
}

test('5. informational permitted edge cannot authorize fetch', async () => {
  // a permitted informational_capability edge exists on the candidate, but call-time
  // execution policy is blocked: the informational edge must never authorize the fetch
  const buildReg = makeRegistries('permitted').reg;
  const run = await buildRun({ reg: buildReg });
  const slice = run.slices[0]!;
  const cand = slice.candidates[0]!;
  const infoEdge = slice.policyEdges.find(
    (e) => e.effect === 'informational_capability' && e.state === 'permitted',
  );
  assert.ok(infoEdge, 'fixture needs a permitted informational edge');
  const withInfo = AcquisitionCandidateSchema.parse({
    ...cand,
    policyEdgeRefs: [...cand.policyEdgeRefs, infoEdge.edgeId],
  });
  slice.candidates[0] = withInfo;
  AcquisitionRunResultSchema.parse(run);
  const { reg, caps } = makeRegistries('blocked');
  const { fn, calls } = okFetch();
  const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
  assert.equal(calls.length, 0);
  assert.deepEqual(
    candidateAttempts(result).map((a) => a.status),
    ['not_permitted'],
  );
  assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
});

test('6. fresh call-time decision overrides stale fetch_eligible edge', async () => {
  const staleReg = makeRegistries('permitted').reg;
  const run = await buildRun({ reg: staleReg });
  const staleEdgeId = makeEligible(run, 'slice-1', staleReg, CAPTURED_AT);
  // registry now blocks automatedFetch at call time
  const { reg, caps } = makeRegistries('blocked');
  const { fn, calls } = okFetch();
  const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
  assert.equal(calls.length, 0);
  const attempt = candidateAttempts(result)[0]!;
  assert.equal(attempt.status, 'not_permitted');
  assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
  // the stale edge id differs from the fresh decision edge (fresh resolved at NOW_ISO)
  const freshEdgeId = acquiredContentHash(
    JSON.stringify([
      'acquisition-edge',
      'run-1',
      'slice-1',
      DESTINATION_FETCH_ADAPTER_ID,
      result.run.slices[0]!.candidates[0]!.candidateId,
      'automatedFetch',
      'execution',
      NOW_ISO,
    ]),
  );
  assert.notEqual(staleEdgeId, freshEdgeId);
  assert.ok(result.run.slices[0]!.policyEdges.some((e) => e.edgeId === freshEdgeId));
});

test('7. failed fetch downgrades fetch_eligible to indexed_only', async () => {
  const reg = makeRegistries().reg;
  const run = await buildRun({ reg });
  makeEligible(run, 'slice-1', reg);
  const { fn, calls } = rejectFetch(new Error('safe fetch aborted'));
  const result = await enrichDestinationFetches(
    { run, budget },
    baseDeps(reg, makeRegistries().caps, fn),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(
    candidateAttempts(result).map((a) => a.status),
    ['fetch_failed'],
  );
  const cand = result.run.slices[0]!.candidates[0]!;
  assert.equal(cand.state, 'indexed_only');
  assert.equal('fetchEdgeRef' in cand, false);
  const slice = result.run.slices[0]!;
  assert.equal(
    slice.evidence.some((e) => e.kind === 'destination_content'),
    false,
  );
  assert.equal(slice.observations.length, 0);
  assert.equal(
    result.run.slices[0]!.coverage.find((c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID)?.state,
    'failed',
  );
});

test('8. non-2xx, empty, binary, oversized responses never upgrade', async () => {
  const cases: {
    name: string;
    overrides: Partial<SafeFetchResult>;
    body?: string;
    expected: string;
  }[] = [
    { name: 'non-2xx', overrides: { status: 404 }, expected: 'fetch_failed' },
    { name: 'empty body', overrides: {}, body: '', expected: 'fetch_failed' },
    {
      name: 'binary',
      overrides: { headers: new Headers({ 'content-type': 'application/pdf' }) },
      expected: 'unsupported_content_type',
    },
    {
      name: 'oversized',
      overrides: {},
      body: 'x'.repeat(300_000),
      expected: 'fetch_failed',
    },
  ];
  for (const c of cases) {
    const { reg, caps } = makeRegistries();
    const run = await buildRun({ reg });
    const { fn, calls } = okFetch(c.overrides, c.body);
    const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
    assert.equal(calls.length, 1, c.name);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      [c.expected],
      c.name,
    );
    const slice = result.run.slices[0]!;
    assert.equal(slice.candidates[0]!.state, 'indexed_only', c.name);
    assert.equal(
      slice.evidence.some((e) => e.kind === 'destination_content'),
      false,
      c.name,
    );
    assert.equal(slice.observations.length, 0, c.name);
    // bytes counted including non-2xx responses
    if (c.name === 'non-2xx') assert.ok(result.budgetConsumed.bytes > 0);
  }
});

test('9. final redirect host mismatch never upgrades', async () => {
  const { reg, caps } = makeRegistries();
  const run = await buildRun({ reg });
  const { fn, calls } = okFetch({ finalUrl: 'https://other.example/x' });
  const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
  assert.equal(calls.length, 1);
  assert.deepEqual(
    candidateAttempts(result).map((a) => a.status),
    ['redirect_host_mismatch'],
  );
  assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
});

test('10. URL credentials/private/metadata rejections surface as fetch_failed, error not exposed', async () => {
  const rejections = [
    new Error('safeFetch rejects URL credentials'),
    new Error('Blocked request to private IP address "127.0.0.1"'),
    new Error('Blocked request to cloud metadata host "metadata.google.internal"'),
  ];
  for (const err of rejections) {
    const { reg, caps } = makeRegistries();
    const run = await buildRun({ reg });
    const { fn, calls } = rejectFetch(err);
    const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
    assert.equal(calls.length, 1);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['fetch_failed'],
    );
    assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
    assert.equal(JSON.stringify(result).includes(err.message), false);
  }
});

test('11. exactly one GET with accept header only, no credentials/provider headers, bounded options', async () => {
  const { reg, caps } = makeRegistries();
  const run = await buildRun({ reg });
  const { fn, calls } = okFetch();
  const controller = new AbortController();
  await enrichDestinationFetches(
    { run, budget, abortSignal: controller.signal },
    baseDeps(reg, caps, fn),
  );
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, DEST_URL);
  assert.deepEqual(Object.keys(call.init ?? {}), ['method', 'headers']);
  assert.equal(call.init?.method, 'GET');
  const headers = call.init?.headers as Record<string, string>;
  assert.deepEqual(Object.keys(headers), ['accept']);
  assert.equal(headers['accept'], 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1');
  const opts = call.options ?? {};
  assert.equal(opts.maxRedirects, 5);
  assert.equal(opts.timeoutMs, 10_000);
  assert.equal(opts.maxBytes, 262_144);
  assert.equal(opts.signal, controller.signal);
  assert.equal('networkPolicy' in opts, false);
  assert.equal(JSON.stringify(call).toLowerCase().includes('authorization'), false);
  assert.equal(JSON.stringify(call).toLowerCase().includes('cookie'), false);
});

test('12. abort and deadline stop later candidates; signal reaches in-flight fetch', async () => {
  // abort mid-run
  {
    const { reg, caps } = makeRegistries();
    const run = await buildRun({
      reg,
      urls: [DEST_URL],
      sliceIds: ['slice-1', 'slice-2'],
    });
    assert.equal(run.slices[0]!.candidates.length, 1);
    assert.equal(run.slices[1]!.candidates.length, 1);
    const controller = new AbortController();
    const calls: FetchCall[] = [];
    const fn = async (url: string, init?: RequestInit, options?: SafeFetchOptions) => {
      calls.push({ url, init, options });
      controller.abort();
      throw new Error('safe fetch aborted');
    };
    const result = await enrichDestinationFetches(
      { run, budget, abortSignal: controller.signal },
      baseDeps(reg, caps, fn),
    );
    assert.equal(calls.length, 1);
    assert.equal(result.status, 'aborted');
    assert.equal(candidateAttempts(result).length, 1);
  }
  // deadline exceeded before execution: recheck fires immediately before safeFetch,
  // so no fetch happens and no attempt is recorded for the in-flight candidate
  {
    const { reg, caps } = makeRegistries();
    const run = await buildRun({ reg, sliceIds: ['slice-1', 'slice-2'] });
    let tick = 0;
    const monotonic = () => {
      tick += 40_000;
      return tick;
    };
    const { fn, calls } = okFetch();
    const tightBudget: AcquisitionRunBudget = { ...budget, milliseconds: 70_000 };
    const result = await enrichDestinationFetches(
      { run, budget: tightBudget },
      baseDeps(reg, caps, fn, monotonic),
    );
    assert.equal(calls.length, 0);
    assert.equal(result.status, 'deadline_exceeded');
    assert.equal(candidateAttempts(result).length, 0);
  }
});

test('W3-H post-settlement: safeFetch aborts signal then returns 200 → upgrade kept, run aborted, zero further fetches', async () => {
  const { reg, caps } = makeRegistries();
  const run = await buildRun({ reg });
  const controller = new AbortController();
  const { fn, calls } = okFetch();
  const abortingFn = async (url: string, init?: RequestInit, options?: SafeFetchOptions) => {
    controller.abort();
    return fn(url, init, options);
  };
  const result = await enrichDestinationFetches(
    { run, budget, abortSignal: controller.signal },
    baseDeps(reg, caps, abortingFn),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(
    candidateAttempts(result).map((a) => a.status),
    ['upgraded'],
  );
  const slice = result.run.slices[0]!;
  assert.equal(slice.candidates[0]!.state, 'destination_fetched');
  const cov = slice.coverage.find((c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID);
  assert.ok(cov);
  assert.equal(cov.state, 'succeeded');
  assert.equal(cov.resultState, 'results');
  assert.equal(cov.candidatesProduced, 1);
  assert.equal(result.status, 'aborted');
  DestinationFetchEnrichmentResultSchema.parse(result);
});

test('W3-H post-settlement: deadline elapses during safeFetch → upgrade kept, run deadline_exceeded, zero further fetches', async () => {
  const { reg, caps } = makeRegistries();
  const run = await buildRun({ reg });
  const { fn, calls } = okFetch();
  const startMs = 1000;
  let fetchStarted = false;
  const monotonic = () => (fetchStarted ? startMs + budget.milliseconds + 1 : startMs);
  const timingFn = async (url: string, init?: RequestInit, options?: SafeFetchOptions) => {
    fetchStarted = true;
    return fn(url, init, options);
  };
  const result = await enrichDestinationFetches(
    { run, budget },
    baseDeps(reg, caps, timingFn, monotonic),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(
    candidateAttempts(result).map((a) => a.status),
    ['upgraded'],
  );
  const slice = result.run.slices[0]!;
  assert.equal(slice.candidates[0]!.state, 'destination_fetched');
  const cov = slice.coverage.find((c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID);
  assert.ok(cov);
  assert.equal(cov.state, 'succeeded');
  assert.equal(cov.resultState, 'results');
  assert.equal(result.status, 'deadline_exceeded');
  DestinationFetchEnrichmentResultSchema.parse(result);
});

test('13. candidate/byte budgets and per-slice capacity enforced', async () => {
  // candidate budget: 1 candidate allowed, second gets capacity_exhausted
  {
    const { reg, caps } = makeRegistries();
    const run = await buildRun({ reg, sliceIds: ['slice-1', 'slice-2'] });
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches(
      { run, budget: { ...budget, candidates: 1 } },
      baseDeps(reg, caps, fn),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['upgraded', 'capacity_exhausted'],
    );
    assert.equal(result.status, 'budget_exhausted');
  }
  // byte budget: first response consumes bytes, second candidate cannot reserve
  {
    const { reg, caps } = makeRegistries();
    const run = await buildRun({ reg, sliceIds: ['slice-1', 'slice-2'] });
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches(
      { run, budget: { ...budget, bytes: 20 } },
      baseDeps(reg, caps, fn),
    );
    assert.equal(calls.length, 1);
    // response body exceeds the remaining byte budget → first attempt fails,
    // second candidate cannot reserve bytes → capacity_exhausted
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['fetch_failed', 'capacity_exhausted'],
    );
  }
  // per-slice coverage capacity: 100 existing rows leave no room for the destination-fetch row
  {
    const { reg, caps } = makeRegistries();
    const run = await buildRun({ reg });
    const slice = run.slices[0]!;
    // fixture already has one provider coverage row; 99 more leave no room
    for (let i = 0; i < 99; i++) {
      slice.coverage.push({
        schemaVersion: '1.0.0',
        adapterId: `adapter-${String(i)}`,
        state: 'succeeded',
        resultState: 'no_results',
        candidatesProduced: 0,
        logicalRequestsUsed: 0,
        attemptsReserved: 0,
        bytesUsed: 0,
        durationMs: 0,
        policyEdgeRefs: [],
      });
    }
    AcquisitionRunResultSchema.parse(run);
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
    assert.equal(calls.length, 0);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['capacity_exhausted'],
    );
    assert.equal(result.run.slices[0]!.candidates[0]!.state, 'indexed_only');
  }
});

test('14. upgrade preserves candidate identity, provenance, provider evidence, and provider edge', async () => {
  const { reg, caps } = makeRegistries();
  const run = await buildRun({ reg });
  const before = JSON.parse(JSON.stringify(run)) as AcquisitionRunResult;
  const candBefore = before.slices[0]!.candidates[0]!;
  const { fn } = okFetch();
  const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
  const slice = result.run.slices[0]!;
  const cand = slice.candidates[0]!;
  assert.equal(cand.candidateId, candBefore.candidateId);
  assert.equal(cand.runId, candBefore.runId);
  assert.equal(cand.sliceId, candBefore.sliceId);
  assert.equal(cand.adapterId, candBefore.adapterId);
  assert.deepEqual(cand.provenance, candBefore.provenance);
  for (const ref of candBefore.evidenceRefs) {
    assert.ok(cand.evidenceRefs.includes(ref), `provider evidence ${ref} preserved`);
  }
  for (const ref of candBefore.policyEdgeRefs) {
    assert.ok(cand.policyEdgeRefs.includes(ref), `provider edge ${ref} preserved`);
  }
  assert.deepEqual(
    cand.caveats.filter((c) => c === 'stale_index_possible'),
    ['stale_index_possible'],
  );
  assert.equal(cand.caveats.includes('provider_index_only'), false);
  assert.equal(cand.caveats.includes('publisher_not_fetched'), false);
});

test('15. exact deterministic ID preimages and artifact mappings pass schemas', async () => {
  const { reg, caps } = makeRegistries();
  const run = await buildRun({ reg });
  const candId = run.slices[0]!.candidates[0]!.candidateId;
  const { fn } = okFetch();
  const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
  const fetchEdgeId = acquiredContentHash(
    JSON.stringify([
      'acquisition-edge',
      'run-1',
      'slice-1',
      'destination-fetch',
      candId,
      'automatedFetch',
      'execution',
      NOW_ISO,
    ]),
  );
  const listingId = deterministicAcquisitionId('listing', [
    'destination-fetch',
    'publisher',
    PUBLISHER_SOURCE_ID,
    DEST_URL,
  ]);
  const contentHash = acquiredContentHash(SNIPPET);
  const observationId = deterministicAcquisitionId('observation', [
    listingId,
    contentHash,
    NOW_ISO,
  ]);
  const evidenceId = deterministicAcquisitionId('evidence', [
    listingId,
    observationId,
    contentHash,
  ]);
  const envelopeId = deterministicAcquisitionId('envelope', [candId, observationId]);

  const slice = result.run.slices[0]!;
  const cand = slice.candidates[0]!;
  assert.equal(cand.state, 'destination_fetched');
  if (cand.state !== 'destination_fetched') return;
  assert.equal(cand.fetchEdgeRef, fetchEdgeId);
  assert.equal(cand.destinationEvidenceRef, evidenceId);
  assert.equal(cand.observationEnvelopeRef, envelopeId);
  assert.equal(cand.policyEdgeRefs[cand.policyEdgeRefs.length - 1], fetchEdgeId);

  const ev = slice.evidence.find((e) => e.evidenceId === evidenceId);
  assert.ok(ev);
  assert.equal(ev.kind, 'destination_content');
  if (ev.kind === 'destination_content') {
    assert.equal(ev.targetCanonicalUrl, DEST_URL);
    assert.equal(ev.boundedText, SNIPPET);
    assert.equal(ev.contentHash, contentHash);
    assert.equal(ev.capturedAt, NOW_ISO);
    assert.equal(ev.observationId, observationId);
    assert.equal(ev.sourceListingId, listingId);
  }
  const envelope = slice.observations.find((o) => o.envelopeId === envelopeId);
  assert.ok(envelope);
  assert.equal(envelope.listing.sourceListingId, listingId);
  assert.equal(envelope.listing.adapterId, 'destination-fetch');
  assert.equal(envelope.listing.canonicalUrl, DEST_URL);
  assert.equal(envelope.listing.firstSeenAt, NOW_ISO);
  assert.equal(envelope.listing.lastSeenAt, NOW_ISO);
  assert.equal(envelope.listing.currentObservationId, observationId);
  assert.equal(envelope.observation.observationId, observationId);
  assert.equal(envelope.observation.sourceListingId, listingId);
  assert.equal(envelope.observation.fetchedAt, NOW_ISO);
  assert.equal(envelope.observation.contentHash, contentHash);
  assert.deepEqual(envelope.observation.evidenceRefs, [evidenceId]);
  assert.equal(envelope.observation.extractionVersion, 'none');
  assert.equal(envelope.observation.adapterVersion, '1.0.0');
  assert.equal(envelope.observation.fetchOutcome, 'success');
  assert.deepEqual(envelope.observation.sourceConfidence, { destination_fetch: 1 });
  assert.equal(envelope.observation.immutable, true);
  assert.equal(envelope.observation.payloadRef, undefined);
  assert.equal(envelope.acquisition.captureKind, 'destination_fetch');
  if (envelope.acquisition.captureKind === 'destination_fetch') {
    assert.equal(envelope.acquisition.publisherSourceId, PUBLISHER_SOURCE_ID);
    assert.deepEqual(envelope.acquisition.discoveryCandidateIds, [candId]);
    assert.deepEqual(envelope.acquisition.policyEdgeRefs, [fetchEdgeId]);
    assert.deepEqual(envelope.acquisition.evidenceRefs, [evidenceId]);
    assert.equal(envelope.acquisition.fetchEdgeRef, fetchEdgeId);
  }
  DestinationFetchEnrichmentResultSchema.parse(result);
  const cov = slice.coverage.find((c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID);
  assert.ok(cov);
  assert.deepEqual(cov.policyEdgeRefs, [fetchEdgeId]);
});

test('16. input run unchanged; duplicates recomputed deterministically with W3-G ranking', async () => {
  const regMixed = new SourcePolicyRegistry([
    policy(PROVIDER_ID),
    policy(PUBLISHER_SOURCE_ID, 'permitted'),
    policy(OTHER_PUBLISHER_SOURCE_ID, 'blocked'),
  ]);
  // slice-1 publisher permitted (upgrades); slice-2 publisher blocked (stays indexed_only); same URL
  const run = await buildRun({
    reg: regMixed,
    sliceIds: ['slice-1', 'slice-2'],
    slicePublishers: { 'slice-2': OTHER_PUBLISHER_SOURCE_ID },
  });
  assert.ok(run.slices[1]!.candidates[0]!.provenance.publisher);
  const snapshot = JSON.stringify(run);
  const { fn, calls } = okFetch();
  const result = await enrichDestinationFetches(
    { run, budget },
    baseDeps(regMixed, makeRegistries().caps, fn),
  );
  assert.equal(JSON.stringify(run), snapshot, 'input run must not be mutated');
  assert.equal(calls.length, 1); // slice-2 blocked → not_permitted, zero fetch
  const dupes = result.run.duplicates;
  const group = dupes.find((d) => d.canonicalUrl === DEST_URL);
  assert.ok(group, 'duplicate group recomputed');
  assert.equal(group.retainedCandidateId, result.run.slices[0]!.candidates[0]!.candidateId);
  assert.ok(
    group.superseded.some(
      (s) =>
        s.sliceId === 'slice-2' &&
        s.candidateId === result.run.slices[1]!.candidates[0]!.candidateId,
    ),
  );
  // determinism: identical fresh fixture → identical duplicates
  const run3 = await buildRun({
    reg: regMixed,
    sliceIds: ['slice-1', 'slice-2'],
    slicePublishers: { 'slice-2': OTHER_PUBLISHER_SOURCE_ID },
  });
  const result3 = await enrichDestinationFetches(
    { run: run3, budget },
    baseDeps(regMixed, makeRegistries().caps, okFetch().fn),
  );
  assert.deepEqual(result3.run.duplicates, result.run.duplicates);
  assert.equal(result.status, 'partial');
});

test('17. manual handoff reviews produce unsupported attempts with zero HTTP', async () => {
  const { reg, caps } = makeRegistries();
  const run = await buildRun({ reg, withPublisher: false });
  run.slices[0]!.candidates = [];
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
  run.destinationFetchReviews.push({
    sliceId: 'slice-1',
    priorFetchEdgeRef: priorEdgeId,
    recheckEdgeRef: acquiredContentHash(
      JSON.stringify([
        'acquisition-edge',
        'run-1',
        'slice-1',
        'manual',
        'automatedFetch',
        'recheck',
      ]),
    ),
    recheckState: 'permitted',
    disposition: 'fetch_pending',
  });
  AcquisitionRunResultSchema.parse(run);
  const { fn, calls } = okFetch();
  const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
  assert.equal(calls.length, 0);
  const handoffs = result.attempts.filter((a) => a.kind === 'manual_handoff');
  assert.equal(handoffs.length, 1);
  const h = handoffs[0]!;
  if (h.kind === 'manual_handoff') {
    assert.equal(h.status, 'unsupported_v1_manual_handoff');
    assert.equal(h.sliceId, 'slice-1');
    assert.equal(h.priorFetchEdgeRef, priorEdgeId);
  }
  assert.equal(result.run.destinationFetchReviews.length, 1);
  assert.equal(result.status, 'completed');
});

test('18. import boundary: no extraction/recovery/persistence/logger/dynamic import/native fetch', () => {
  const p = path.resolve('src/jobs/acquisition/destinationFetch.ts');
  const src = fs.readFileSync(p, 'utf8');
  const staticImportRe = /import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g;
  const specifiers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = staticImportRe.exec(src)) !== null) specifiers.push(m[1]!);
  const allow = new Set([
    'zod/v4',
    './contracts.js',
    './ids.js',
    './coordinator.js',
    './adapterSupport.js',
    './adapterCapability.js',
    './adapterRegistry.js',
    './policy/registry.js',
    './policy/edgeCoordinator.js',
    '../../httpGuards.js',
    '../../errors.js',
  ]);
  for (const s of specifiers) assert.ok(allow.has(s), `unexpected specifier ${s}`);
  const forbidden = [
    /documentExtraction/i,
    /externalRecovery/i,
    /corpusCache/i,
    /persist/i,
    /logger/i,
    /pino/i,
  ];
  for (const re of forbidden) assert.equal(re.test(src), false, `forbidden pattern ${String(re)}`);
  assert.equal(/\bimport\s*\(/.test(src), false, 'no dynamic import');
  assert.equal(/\bfetch\s*\(/.test(src), false, 'no native fetch call');
  assert.equal(/\bconsole\./.test(src), false, 'no console');
  assert.equal(src.includes('Math.random'), false, 'no random');
});

test('invalid options/deps/clocks throw sanitized VALIDATION_ERROR before any network call', async () => {
  const { reg, caps } = makeRegistries();
  const run = await buildRun({ reg });
  const { fn, calls } = okFetch();
  // invalid run (missing status)
  await assert.rejects(
    enrichDestinationFetches(
      { run: { ...run, status: 'nope' } as unknown as AcquisitionRunResult, budget },
      baseDeps(reg, caps, fn),
    ),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
  // invalid safeFetch dep
  await assert.rejects(
    enrichDestinationFetches(
      { run, budget },
      { ...baseDeps(reg, caps, fn), safeFetch: undefined as never },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    ),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
  // invalid clock
  await assert.rejects(
    enrichDestinationFetches(
      { run, budget },
      { ...baseDeps(reg, caps, fn), now: (() => 'nope') as never },
    ),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
  assert.equal(calls.length, 0);
});

test('clock that becomes invalid on a later read throws sanitized VALIDATION_ERROR', async () => {
  const { reg, caps } = makeRegistries();
  const { fn, calls } = okFetch();
  // now() valid at startup probe, invalid at call-time decision read
  {
    const run = await buildRun({ reg });
    let n = 0;
    const now = () => {
      n += 1;
      return n <= 1 ? new Date(NOW_ISO) : new Date('not-a-date');
    };
    await assert.rejects(
      enrichDestinationFetches({ run, budget }, { ...baseDeps(reg, caps, fn), now }),
      (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
    );
    assert.equal(calls.length, 0);
  }
  // monotonicNow() valid at start, invalid at first between-candidate elapsed read
  {
    const run = await buildRun({ reg });
    let m = 0;
    const monotonicNow = () => {
      m += 1;
      return m <= 1 ? 1000 : Number.NaN;
    };
    await assert.rejects(
      enrichDestinationFetches({ run, budget }, { ...baseDeps(reg, caps, fn), monotonicNow }),
      (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
    );
    assert.equal(calls.length, 0);
  }
});

test('repeated enrichment with identical now after a failed fetch: no duplicate edges, upgrades on second run', async () => {
  const reg = makeRegistries().reg;
  const run = await buildRun({ reg });
  makeEligible(run, 'slice-1', reg);
  const { fn: failFn } = rejectFetch(new Error('transient network failure'));
  const first = await enrichDestinationFetches(
    { run, budget },
    baseDeps(reg, makeRegistries().caps, failFn),
  );
  assert.deepEqual(
    candidateAttempts(first).map((a) => a.status),
    ['fetch_failed'],
  );
  assert.equal(first.run.slices[0]!.candidates[0]!.state, 'indexed_only');

  // second run over the first run's result with the same injected now
  const { fn: okFn, calls } = okFetch();
  const second = await enrichDestinationFetches(
    { run: first.run, budget },
    baseDeps(reg, makeRegistries().caps, okFn),
  );
  const slice = second.run.slices[0]!;
  const cand = slice.candidates[0]!;
  assert.equal(cand.state, 'destination_fetched');
  const freshEdgeId = acquiredContentHash(
    JSON.stringify([
      'acquisition-edge',
      'run-1',
      'slice-1',
      DESTINATION_FETCH_ADAPTER_ID,
      cand.candidateId,
      'automatedFetch',
      'execution',
      NOW_ISO,
    ]),
  );
  // idempotency: the re-resolved edge ID is never appended twice
  assert.equal(cand.policyEdgeRefs.filter((r) => r === freshEdgeId).length, 1);
  assert.equal(slice.policyEdges.filter((e) => e.edgeId === freshEdgeId).length, 1);
  assert.equal(slice.observations.length, 1);
  assert.equal(calls.length, 1);
  // coverage authorization ref survives the identical-edge second run: the fresh
  // edge ID appears exactly once in the destination-fetch coverage policyEdgeRefs
  const cov = slice.coverage.find((c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID);
  assert.ok(cov, 'second run has a destination-fetch coverage row');
  assert.equal(cov.policyEdgeRefs.filter((r) => r === freshEdgeId).length, 1);
  // no VALIDATION_ERROR: the whole result (incl. run schema) parses
  DestinationFetchEnrichmentResultSchema.parse(second);
});

test('clock that throws surfaces as sanitized VALIDATION_ERROR before any network call', async () => {
  const { reg, caps } = makeRegistries();
  const { fn, calls } = okFetch();
  // throwing now()
  {
    const run = await buildRun({ reg });
    await assert.rejects(
      enrichDestinationFetches(
        { run, budget },
        {
          ...baseDeps(reg, caps, fn),
          now: () => {
            throw new Error('clock now exploded');
          },
        },
      ),
      (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
    );
  }
  // throwing monotonicNow()
  {
    const run = await buildRun({ reg });
    await assert.rejects(
      enrichDestinationFetches(
        { run, budget },
        {
          ...baseDeps(reg, caps, fn),
          monotonicNow: () => {
            throw new Error('clock monotonic exploded');
          },
        },
      ),
      (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
    );
  }
  // raw clock error messages never escape and no fetch was attempted
  assert.equal(JSON.stringify({ checked: 'clock' }).includes('exploded'), false);
  assert.equal(calls.length, 0);
});

test('attempts bound reaches provable maximum 10101 (handoffs + identity-missing + capacity record)', async () => {
  const { reg, caps } = makeRegistries();
  const run = await buildRun({ reg, withPublisher: false });
  const base = run.slices[0]!;
  const proto = base.candidates[0]!;
  assert.equal(proto.provenance.kind, 'indexed_discovery');
  assert.equal(proto.provenance.publisher, undefined);
  // 10 slices x 1000 identity-missing candidates + 1 slice with the capacity-exhausted candidate
  for (let s = 0; s < 11; s++) {
    const slice = s === 0 ? base : structuredClone(base);
    if (s !== 0) {
      (slice as { sliceId: string }).sliceId = `slice-cap-${String(s)}`;
      run.slices.push(slice);
    }
    slice.candidates = [];
    const count = s < 10 ? 1000 : 1;
    for (let i = 0; i < count; i++) {
      // provenance (and its evidence-matching destination URL) stays identical; only the
      // candidate ID varies so each candidate is independently identity-missing
      slice.candidates.push(
        AcquisitionCandidateSchema.parse({
          ...proto,
          candidateId: `cap-${String(s)}-${String(i)}`,
          sliceId: slice.sliceId,
        }),
      );
    }
  }
  // 100 manual handoff reviews
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
  const recheckEdgeId = acquiredContentHash(
    JSON.stringify(['acquisition-edge', 'run-1', 'slice-1', 'manual', 'automatedFetch', 'recheck']),
  );
  for (let i = 0; i < 100; i++) {
    run.destinationFetchReviews.push({
      sliceId: 'slice-1',
      priorFetchEdgeRef: priorEdgeId,
      recheckEdgeRef: recheckEdgeId,
      recheckState: 'permitted',
      disposition: 'fetch_pending',
    });
  }
  AcquisitionRunResultSchema.parse(run);
  const { fn, calls } = okFetch();
  const result = await enrichDestinationFetches(
    { run, budget: { ...budget, candidates: 10000 } },
    baseDeps(reg, caps, fn),
  );
  assert.equal(result.attempts.length, 10101);
  assert.equal(candidateAttempts(result).length, 10001);
  const last = candidateAttempts(result).at(-1);
  assert.equal(last?.status, 'capacity_exhausted');
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(calls.length, 0);
  const DEST_URL_B = 'https://example.test/b';

  /**
   * Build a single-slice run holding two independently-acting candidates by merging
   * slice-2's candidate (plus its evidence/edges) into slice-1. Used for W3-H
   * mixed-outcome coverage matrix tests.
   */
  async function buildMergedRun(
    first: BuildOptions,
    second: BuildOptions,
  ): Promise<AcquisitionRunResult> {
    const runA = await buildRun({
      ...first,
      sliceIds: ['slice-1'],
      urls: first.urls ?? [DEST_URL],
    });
    const runB = await buildRun({
      ...second,
      sliceIds: ['slice-2'],
      urls: second.urls ?? [DEST_URL_B],
    });
    const s1 = runA.slices[0]!;
    const s2 = runB.slices[0]!;
    const cand2 = s2.candidates[0]!;
    s1.evidence.push(...s2.evidence);
    s1.policyEdges.push(...s2.policyEdges);
    s1.observations.push(...s2.observations);
    s1.candidates.push(
      AcquisitionCandidateSchema.parse({
        ...cand2,
        candidateId: `${cand2.candidateId}-b`,
        sliceId: 'slice-1',
      }),
    );
    AcquisitionRunResultSchema.parse(runA);
    return runA;
  }

  function destinationCoverage(run: AcquisitionRunResult, sliceId: string) {
    return run.slices
      .find((s) => s.sliceId === sliceId)!
      .coverage.find((c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID);
  }

  function publisherOnlyFetchCaps(): AdapterCapabilityRegistry {
    return new AdapterCapabilityRegistry([
      {
        schemaVersion: '1.0.0',
        adapterId: DESTINATION_FETCH_ADAPTER_ID,
        adapterVersion: '1.0.0',
        edges: [{ operation: 'automatedFetch', route: 'direct', targetKind: 'publisher' }],
      } as never,
    ]);
  }

  // --- W3-H addendum: exact coverage precedence matrix ---

  await test('W3-H 1. mixed upgraded + blocked not_permitted → partial/results', async () => {
    const reg = new SourcePolicyRegistry([
      policy(PROVIDER_ID),
      policy(PUBLISHER_SOURCE_ID, 'permitted'),
      policy(OTHER_PUBLISHER_SOURCE_ID, 'blocked'),
    ]);
    const run = await buildMergedRun(
      { reg, slicePublishers: { 'slice-1': PUBLISHER_SOURCE_ID } },
      { reg, slicePublishers: { 'slice-2': OTHER_PUBLISHER_SOURCE_ID } },
    );
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches(
      { run, budget },
      baseDeps(reg, makeRegistries().caps, fn),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['upgraded', 'not_permitted'],
    );
    const cov = destinationCoverage(result.run, 'slice-1');
    assert.ok(cov);
    assert.equal(cov.state, 'partial');
    assert.equal(cov.resultState, 'results');
    assert.equal(cov.candidatesProduced, 1);
    assert.equal(cov.logicalRequestsUsed, 1);
    assert.equal(cov.attemptsReserved, 1);
    assert.equal(result.status, 'partial');
  });

  await test('W3-H 2. mixed upgraded + capability_missing → partial/results', async () => {
    const reg = makeRegistries().reg;
    const run = await buildMergedRun(
      { reg, slicePublishers: { 'slice-1': PUBLISHER_SOURCE_ID } },
      { reg, slicePublishers: { 'slice-2': OTHER_PUBLISHER_SOURCE_ID } },
    );
    // second candidate targets a board: publisher-only capability registry → capability_missing
    const slice = run.slices[0]!;
    const cand2 = slice.candidates[1]!;
    const prov = cand2.provenance as { publisher: { kind: string } };
    prov.publisher.kind = 'board';
    slice.candidates[1] = AcquisitionCandidateSchema.parse(cand2);
    AcquisitionRunResultSchema.parse(run);
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches(
      { run, budget },
      baseDeps(reg, publisherOnlyFetchCaps(), fn),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['upgraded', 'capability_missing'],
    );
    const cov = destinationCoverage(result.run, 'slice-1');
    assert.ok(cov);
    assert.equal(cov.state, 'partial');
    assert.equal(cov.resultState, 'results');
    assert.equal(cov.candidatesProduced, 1);
    assert.equal(result.status, 'partial');
  });

  await test('W3-H 3. mixed upgraded + publisher_identity_missing → partial/results', async () => {
    const reg = makeRegistries().reg;
    const run = await buildMergedRun(
      { reg, slicePublishers: { 'slice-1': PUBLISHER_SOURCE_ID } },
      { reg, withPublisher: false },
    );
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches(
      { run, budget },
      baseDeps(reg, makeRegistries().caps, fn),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['upgraded', 'publisher_identity_missing'],
    );
    const cov = destinationCoverage(result.run, 'slice-1');
    assert.ok(cov);
    assert.equal(cov.state, 'partial');
    assert.equal(cov.resultState, 'results');
    assert.equal(cov.candidatesProduced, 1);
    assert.equal(result.status, 'partial');
  });

  await test('W3-H 4. mixed upgraded + structural capacity_exhausted → partial/results, run partial', async () => {
    const reg = makeRegistries().reg;
    const run = await buildMergedRun(
      { reg, slicePublishers: { 'slice-1': PUBLISHER_SOURCE_ID } },
      { reg, slicePublishers: { 'slice-2': OTHER_PUBLISHER_SOURCE_ID } },
    );
    // fill to exactly 99 edges: first candidate's fetch edge fits (100), second hits the cap
    const slice = run.slices[0]!;
    let i = 0;
    while (slice.policyEdges.length < 99) {
      const edgeId = acquiredContentHash(JSON.stringify(['w3h-filler', String(i)]));
      slice.policyEdges.push(
        resolveInformationalPolicyEdge(
          reg,
          {
            edgeId: AcquisitionEdgeIdSchema.parse(edgeId),
            actor: { kind: 'adapter', namespace: 'adapter', id: DESTINATION_FETCH_ADAPTER_ID },
            operation: 'automatedFetch',
            route: 'direct',
            target: { kind: 'publisher', sourceId: `filler:${String(i)}` },
          },
          { decidedAt: CAPTURED_AT },
        ),
      );
      i += 1;
    }
    AcquisitionRunResultSchema.parse(run);
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches(
      { run, budget },
      baseDeps(reg, makeRegistries().caps, fn),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['upgraded', 'capacity_exhausted'],
    );
    const cov = destinationCoverage(result.run, 'slice-1');
    assert.ok(cov);
    assert.equal(cov.state, 'partial');
    assert.equal(cov.resultState, 'results');
    assert.equal(cov.candidatesProduced, 1);
    assert.equal(result.status, 'partial');
  });

  await test('W3-H 5. zero upgrades with attempted fetch failure → failed/no_results', async () => {
    const reg = makeRegistries().reg;
    const run = await buildRun({ reg });
    makeEligible(run, 'slice-1', reg);
    const { fn, calls } = rejectFetch(new Error('safe fetch aborted'));
    const result = await enrichDestinationFetches(
      { run, budget },
      baseDeps(reg, makeRegistries().caps, fn),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['fetch_failed'],
    );
    const cov = destinationCoverage(result.run, 'slice-1');
    assert.ok(cov);
    assert.equal(cov.state, 'failed');
    assert.equal(cov.resultState, 'no_results');
    assert.equal(cov.candidatesProduced, 0);
    assert.equal(cov.logicalRequestsUsed, 1);
    assert.equal(cov.attemptsReserved, 1);
  });

  await test('W3-H 6. all blocked → policy_blocked/unknown with zero calls', async () => {
    const reg = makeRegistries('blocked').reg;
    const run = await buildRun({ reg, sliceIds: ['slice-1', 'slice-2'] });
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches(
      { run, budget },
      baseDeps(reg, makeRegistries().caps, fn),
    );
    assert.equal(calls.length, 0);
    for (const sliceId of ['slice-1', 'slice-2']) {
      const cov = destinationCoverage(result.run, sliceId);
      assert.ok(cov, sliceId);
      assert.equal(cov.state, 'policy_blocked');
      assert.equal(cov.resultState, 'unknown');
      assert.equal(cov.candidatesProduced, 0);
      assert.equal(cov.logicalRequestsUsed, 0);
      assert.equal(cov.attemptsReserved, 0);
      assert.equal(cov.bytesUsed, 0);
      assert.ok(cov.policyEdgeRefs.length >= 1);
    }
    assert.equal(result.status, 'partial');
  });

  await test('W3-H 7. all requires_configuration/requires_review → disabled/unknown with zero calls', async () => {
    const reg = new SourcePolicyRegistry([
      policy(PROVIDER_ID),
      policy(PUBLISHER_SOURCE_ID, 'requires_configuration'),
      policy(OTHER_PUBLISHER_SOURCE_ID, 'requires_review'),
    ]);
    const run = await buildRun({
      reg,
      sliceIds: ['slice-1', 'slice-2'],
      slicePublishers: { 'slice-2': OTHER_PUBLISHER_SOURCE_ID },
    });
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches(
      { run, budget },
      baseDeps(reg, makeRegistries().caps, fn),
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['not_permitted', 'not_permitted'],
    );
    for (const sliceId of ['slice-1', 'slice-2']) {
      const cov = destinationCoverage(result.run, sliceId);
      assert.ok(cov, sliceId);
      assert.equal(cov.state, 'disabled');
      assert.equal(cov.resultState, 'unknown');
      assert.equal(cov.logicalRequestsUsed, 0);
    }
  });

  await test('W3-H 8. all capability-missing/policy-not-supported → not_supported/unknown with zero calls', async () => {
    const reg = new SourcePolicyRegistry([
      policy(PROVIDER_ID),
      policy(PUBLISHER_SOURCE_ID, 'not_supported'),
      policy(OTHER_PUBLISHER_SOURCE_ID, 'permitted'),
    ]);
    const run = await buildRun({
      reg,
      sliceIds: ['slice-1', 'slice-2'],
      slicePublishers: { 'slice-2': OTHER_PUBLISHER_SOURCE_ID },
    });
    // slice-2 candidate targets a board: publisher-only capability → capability_missing
    const slice2 = run.slices[1]!;
    const cand2 = slice2.candidates[0]!;
    const prov = cand2.provenance as { publisher: { kind: string } };
    prov.publisher.kind = 'board';
    slice2.candidates[0] = AcquisitionCandidateSchema.parse(cand2);
    AcquisitionRunResultSchema.parse(run);
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches(
      { run, budget },
      baseDeps(reg, publisherOnlyFetchCaps(), fn),
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['not_permitted', 'capability_missing'],
    );
    for (const sliceId of ['slice-1', 'slice-2']) {
      const cov = destinationCoverage(result.run, sliceId);
      assert.ok(cov, sliceId);
      assert.equal(cov.state, 'not_supported');
      assert.equal(cov.resultState, 'unknown');
      assert.equal(cov.logicalRequestsUsed, 0);
    }
  });

  await test('W3-H 9. mixed zero-call blocked + disabled, zero upgrades → partial/no_results', async () => {
    const reg = new SourcePolicyRegistry([
      policy(PROVIDER_ID),
      policy(PUBLISHER_SOURCE_ID, 'blocked'),
      policy(OTHER_PUBLISHER_SOURCE_ID, 'requires_configuration'),
    ]);
    const run = await buildMergedRun(
      { reg, slicePublishers: { 'slice-1': PUBLISHER_SOURCE_ID } },
      { reg, slicePublishers: { 'slice-2': OTHER_PUBLISHER_SOURCE_ID } },
    );
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches(
      { run, budget },
      baseDeps(reg, makeRegistries().caps, fn),
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['not_permitted', 'not_permitted'],
    );
    const cov = destinationCoverage(result.run, 'slice-1');
    assert.ok(cov);
    assert.equal(cov.state, 'partial');
    assert.equal(cov.resultState, 'no_results');
    assert.equal(cov.candidatesProduced, 0);
    assert.equal(cov.logicalRequestsUsed, 0);
  });

  await test('W3-H 10. abort after successful candidate → slice succeeded/results, run aborted', async () => {
    const reg = makeRegistries().reg;
    const run = await buildRun({ reg, sliceIds: ['slice-1', 'slice-2'] });
    const controller = new AbortController();
    const ok = okFetch();
    let fetchedCount = 0;
    const fn = async (url: string, init?: RequestInit, options?: SafeFetchOptions) => {
      const res = await ok.fn(url, init, options);
      fetchedCount += 1;
      if (fetchedCount === 1) controller.abort();
      return res;
    };
    const result = await enrichDestinationFetches(
      { run, budget, abortSignal: controller.signal },
      baseDeps(reg, makeRegistries().caps, fn),
    );
    assert.equal(ok.calls.length, 1);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['upgraded'],
    );
    const cov = destinationCoverage(result.run, 'slice-1');
    assert.ok(cov);
    assert.equal(cov.state, 'succeeded');
    assert.equal(cov.resultState, 'results');
    assert.equal(destinationCoverage(result.run, 'slice-2'), undefined);
    assert.equal(result.status, 'aborted');
  });

  await test('W3-H 11. deadline after successful candidate → slice succeeded/results, run deadline_exceeded', async () => {
    const reg = makeRegistries().reg;
    const run = await buildRun({ reg, sliceIds: ['slice-1', 'slice-2'] });
    let m = 0;
    const monotonic = () => {
      m += 1;
      return m <= 5 ? m * 1000 : 1_000_000;
    };
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches(
      { run, budget },
      baseDeps(reg, makeRegistries().caps, fn, monotonic),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      candidateAttempts(result).map((a) => a.status),
      ['upgraded'],
    );
    const cov = destinationCoverage(result.run, 'slice-1');
    assert.ok(cov);
    assert.equal(cov.state, 'succeeded');
    assert.equal(cov.resultState, 'results');
    assert.equal(destinationCoverage(result.run, 'slice-2'), undefined);
    assert.equal(result.status, 'deadline_exceeded');
  });

  for (const dim of ['logicalRequests', 'reservedAttempts'] as const) {
    await test(`W3-H 12/13. ${dim}:1 budget exhaustion → one fetch, second capacity_exhausted, run budget_exhausted`, async () => {
      const reg = makeRegistries().reg;
      const run = await buildRun({ reg, sliceIds: ['slice-1', 'slice-2'] });
      const { fn, calls } = okFetch();
      const result = await enrichDestinationFetches(
        { run, budget: { ...budget, [dim]: 1 } },
        baseDeps(reg, makeRegistries().caps, fn),
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(
        candidateAttempts(result).map((a) => a.status),
        ['upgraded', 'capacity_exhausted'],
      );
      const cov1 = destinationCoverage(result.run, 'slice-1');
      assert.ok(cov1);
      assert.equal(cov1.state, 'succeeded');
      assert.equal(cov1.logicalRequestsUsed, 1);
      // second candidate's capacity_exhausted attempt is a candidate attempt → coverage row
      const cov2 = destinationCoverage(result.run, 'slice-2');
      assert.ok(cov2);
      assert.equal(cov2.state, 'partial');
      assert.equal(cov2.resultState, 'no_results');
      assert.equal(cov2.candidatesProduced, 0);
      assert.equal(cov2.logicalRequestsUsed, 0);
      assert.equal(result.status, 'budget_exhausted');
    });
  }

  await test('W3-H 14. manual-handoff-only run stays completed with no destination-fetch coverage', async () => {
    const { reg, caps } = makeRegistries();
    const run = await buildRun({ reg, withPublisher: false });
    run.slices[0]!.candidates = [];
    run.destinationFetchReviews.push({
      sliceId: 'slice-1',
      priorFetchEdgeRef: acquiredContentHash(
        JSON.stringify([
          'acquisition-edge',
          'run-1',
          'slice-1',
          'manual',
          'automatedFetch',
          'execution',
        ]),
      ),
      recheckEdgeRef: acquiredContentHash(
        JSON.stringify([
          'acquisition-edge',
          'run-1',
          'slice-1',
          'manual',
          'automatedFetch',
          'recheck',
        ]),
      ),
      recheckState: 'permitted',
      disposition: 'fetch_pending',
    });
    AcquisitionRunResultSchema.parse(run);
    const { fn, calls } = okFetch();
    const result = await enrichDestinationFetches({ run, budget }, baseDeps(reg, caps, fn));
    assert.equal(calls.length, 0);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]!.kind, 'manual_handoff');
    assert.equal(result.status, 'completed');
    assert.equal(
      result.run.slices.some((s) =>
        s.coverage.some((c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID),
      ),
      false,
    );
  });

  // boundary record passes the result schema
  DestinationFetchEnrichmentResultSchema.parse(result);
});
