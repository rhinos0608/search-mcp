import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  ACQUISITION_CONTRACT_VERSION,
  AcquisitionSliceResultSchema,
} from '../../src/jobs/acquisition/contracts.js';
import {
  ACQUISITION_COORDINATOR_VERSION,
  AcquisitionRunResultSchema,
  runAcquisition,
  type AcquisitionRunBudget,
} from '../../src/jobs/acquisition/coordinator.js';
import { SourcePolicyRegistry } from '../../src/jobs/acquisition/policy/registry.js';
import { AdapterCapabilityRegistry } from '../../src/jobs/acquisition/adapterRegistry.js';
import {
  INDEXED_PROVIDER_DEFINITIONS,
  indexedProviderCapabilities,
} from '../../src/jobs/acquisition/providers/ports.js';
import type { IndexedProviderPort } from '../../src/jobs/acquisition/providers/ports.js';
import { JOBSPY_BOARDS } from '../../src/jobs/acquisition/adapters/jobspy.js';
import { acquiredContentHash } from '../../src/jobs/acquisition/adapterSupport.js';
import { isToolError } from '../../src/errors.js';
import { runIndexedProvider } from '../../src/jobs/acquisition/providers/indexed.js';
import { resolveExecutionPolicyEdge } from '../../src/jobs/acquisition/policy/edgeCoordinator.js';
import type { SourcePolicy } from '../../src/jobs/acquisition/policy/sourcePolicy.js';

function makeSlice(
  overrides: Record<string, unknown> = {},
): import('../../src/jobs/acquisition/contracts.js').AcquisitionSlice {
  const base: Record<string, unknown> = {
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    runId: 'run-1',
    sliceId: 'slice-1',
    ordinal: 0,
    queryVariantId: 'qv-1',
    query: 'software engineer',
    reason: 'test',
    adapterIds: ['indexed-provider:brave'],
    localePackRefs: [],
    domainPackRefs: [],
    budget: {
      logicalRequests: 2,
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

function policy(sourceId: string, state: string = 'permitted'): SourcePolicy {
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

function makeRegistries(ports: readonly IndexedProviderPort[]) {
  const policies: SourcePolicy[] = [];
  for (const p of ports) policies.push(policy(p.providerId, 'permitted'));
  for (const b of JOBSPY_BOARDS) policies.push(policy(b, 'permitted'));
  policies.push(policy('manual', 'permitted'));
  policies.push(policy('publisher:acme', 'permitted'));
  const reg = new SourcePolicyRegistry(policies);
  const caps = new AdapterCapabilityRegistry([
    ...indexedProviderCapabilities(ports as unknown as IndexedProviderPort[]),
    {
      schemaVersion: '1.0.0',
      adapterId: 'jobspy',
      adapterVersion: '1.7.0',
      edges: [{ operation: 'automatedSearch', route: 'direct', targetKind: 'board' }],
    } as unknown as never,
    {
      schemaVersion: '1.0.0',
      adapterId: 'manual',
      adapterVersion: '1.0.0',
      edges: [
        { operation: 'manualImport', route: 'user_supplied', targetKind: 'adapter' },
        { operation: 'userSuppliedContent', route: 'user_supplied', targetKind: 'adapter' },
      ],
    } as unknown as never,
  ]);
  return { reg, caps };
}

function mockPort(
  providerId = 'search-provider:brave',
  searchFn: IndexedProviderPort['search'] = async () => [],
): IndexedProviderPort {
  const def = INDEXED_PROVIDER_DEFINITIONS.find((d) => d.providerId === providerId)!;
  return {
    backend: def.backend as never,
    adapterId: def.adapterId,
    providerId: def.providerId,
    governance: def.governance,
    maxDurationMs: def.maxDurationMs,
    search: searchFn,
  };
}

const capturedAt = '2026-01-02T00:00:00Z';
const budget: AcquisitionRunBudget = {
  logicalRequests: 10,
  reservedAttempts: 20,
  candidates: 10,
  bytes: 200000,
  milliseconds: 70000,
};

test('empty plan → completed zero slices', async () => {
  const ports: IndexedProviderPort[] = [];
  const { reg, caps } = makeRegistries(ports);
  const result = await runAcquisition(
    { runId: 'run-1', capturedAt, budget, plan: [] },
    {
      policyRegistry: reg,
      capabilityRegistry: caps,
      ports,
      scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
    },
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.slices.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.deepEqual(result.budgetConsumed, {
    logicalRequests: 0,
    reservedAttempts: 0,
    candidates: 0,
    bytes: 0,
    milliseconds: 0,
  });
  AcquisitionRunResultSchema.parse(result);
  assert.equal(ACQUISITION_COORDINATOR_VERSION, '1.0.0');
});

test('single indexed slice edge exact and byte-intact', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'T',
      url: 'https://example.test/a',
      description: 'snippet',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const ports = [port];
  const { reg, caps } = makeRegistries(ports);
  const slice = makeSlice({ sliceId: 'slice-1', runId: 'run-1', adapterIds: [port.adapterId] });
  const expectedEdgeId = acquiredContentHash(
    JSON.stringify([
      'acquisition-edge',
      'run-1',
      'slice-1',
      port.adapterId,
      'automatedSearch',
      'execution',
    ]),
  );
  const result = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget,
      plan: [{ kind: 'indexed', slice, providerId: port.providerId, safeSearch: 'moderate' }],
    },
    {
      policyRegistry: reg,
      capabilityRegistry: caps,
      ports,
      scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
    },
  );
  assert.equal(result.slices.length, 1);
  const sr = result.slices[0]!;
  assert.equal(sr.policyEdges[0]!.edgeId, expectedEdgeId);
  assert.equal(sr.policyEdges[0]!.actor.id, port.providerId);
  assert.equal(sr.policyEdges[0]!.operation, 'automatedSearch');
  assert.equal(sr.policyEdges[0]!.route, 'indexed');
  assert.equal(sr.policyEdges[0]!.target.sourceId, port.providerId);
  AcquisitionSliceResultSchema.parse(sr);
  AcquisitionRunResultSchema.parse(result);
  // byte-intact structural deep-equal against adapter's own sliceResult (allow frozen copies)
  const edge = resolveExecutionPolicyEdge(
    reg as never,
    {
      edgeId: expectedEdgeId,
      actor: { kind: 'provider', namespace: 'search-provider', id: port.providerId },
      operation: 'automatedSearch',
      route: 'indexed',
      target: { kind: 'discovery_provider', sourceId: port.providerId },
    } as never,
    { decidedAt: capturedAt },
  );
  const adapterResult = await runIndexedProvider(
    { slice, executionEdge: edge, safeSearch: 'moderate', capturedAt },
    { capabilityRegistry: caps, port, monotonicNow: () => 0 },
  );
  // Coordinator must be byte-intact: deep structural equality with adapter result (frozen copy allowed)
  assert.deepEqual(
    JSON.parse(JSON.stringify(sr)),
    JSON.parse(JSON.stringify(adapterResult.sliceResult)),
  );
});

test('1 indexed + 2 jobspy boards → 3 results plan order', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'T',
      url: 'https://example.test/a',
      description: 's',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const ports = [port];
  const { reg, caps } = makeRegistries(ports);
  const slice1 = makeSlice({
    sliceId: 's1',
    runId: 'run-1',
    adapterIds: [port.adapterId],
    budget: {
      logicalRequests: 1,
      reservedAttempts: 5,
      candidates: 2,
      bytes: 10000,
      milliseconds: 70000,
    },
  });
  const slice2 = makeSlice({
    sliceId: 's2',
    runId: 'run-1',
    adapterIds: ['jobspy'],
    query: 'engineer',
    budget: {
      logicalRequests: 1,
      reservedAttempts: 5,
      candidates: 2,
      bytes: 10000,
      milliseconds: 10000,
    },
  });
  const slice3 = makeSlice({
    sliceId: 's3',
    runId: 'run-1',
    adapterIds: ['jobspy'],
    query: 'engineer',
    budget: {
      logicalRequests: 1,
      reservedAttempts: 5,
      candidates: 2,
      bytes: 10000,
      milliseconds: 10000,
    },
  });
  const result = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget,
      plan: [
        { kind: 'indexed', slice: slice1, providerId: port.providerId, safeSearch: 'moderate' },
        { kind: 'jobspy', slice: slice2, board: 'linkedin' },
        { kind: 'jobspy', slice: slice3, board: 'indeed' },
      ],
    },
    {
      policyRegistry: reg,
      capabilityRegistry: caps,
      ports,
      scrapeJobs: async (params: unknown) => {
        const p = params as Record<string, unknown>;
        const board = (p.site_name as string[])[0]!;
        return {
          jobs: [
            {
              id: `id-${board}`,
              site: board,
              job_url: `https://example.test/${board}`,
              title: 'Job',
              company: 'Co',
              location: 'NYC',
              description: 'desc',
            },
          ],
          totalScraped: 1,
          newCount: 1,
        } as unknown as never;
      },
    },
  );
  assert.equal(result.slices.length, 3);
  assert.equal(result.slices[0]!.sliceId, 's1');
  assert.equal(result.slices[1]!.sliceId, 's2');
  assert.equal(result.slices[2]!.sliceId, 's3');
  AcquisitionRunResultSchema.parse(result);
});

test('budget fits slice1 only → slices 2-3 skipped budget_exhausted', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'T',
      url: 'https://example.test/a',
      description: 's',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const ports = [port];
  const { reg, caps } = makeRegistries(ports);
  let calls = 0;
  const scrape = async () => {
    calls++;
    return {
      jobs: [
        {
          id: '1',
          site: 'linkedin',
          job_url: 'https://example.test/b',
          title: 'J',
          company: 'C',
          location: 'L',
          description: 'd',
        },
      ],
      totalScraped: 1,
      newCount: 1,
    } as unknown as never;
  };
  const slice1 = makeSlice({
    sliceId: 's1',
    runId: 'run-1',
    adapterIds: [port.adapterId],
    budget: {
      logicalRequests: 1,
      reservedAttempts: 5,
      candidates: 1,
      bytes: 1000,
      milliseconds: 70000,
    },
  });
  const slice2 = makeSlice({
    sliceId: 's2',
    runId: 'run-1',
    adapterIds: ['jobspy'],
    budget: {
      logicalRequests: 1,
      reservedAttempts: 5,
      candidates: 1,
      bytes: 1000,
      milliseconds: 1000,
    },
  });
  const slice3 = makeSlice({
    sliceId: 's3',
    runId: 'run-1',
    adapterIds: ['jobspy'],
    budget: {
      logicalRequests: 1,
      reservedAttempts: 5,
      candidates: 1,
      bytes: 1000,
      milliseconds: 1000,
    },
  });
  const smallBudget: AcquisitionRunBudget = {
    logicalRequests: 1,
    reservedAttempts: 5,
    candidates: 1,
    bytes: 1000,
    milliseconds: 70000,
  };
  const result = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget: smallBudget,
      plan: [
        { kind: 'indexed', slice: slice1, providerId: port.providerId, safeSearch: 'moderate' },
        { kind: 'jobspy', slice: slice2, board: 'linkedin' },
        { kind: 'jobspy', slice: slice3, board: 'indeed' },
      ],
    },
    { policyRegistry: reg, capabilityRegistry: caps, ports, scrapeJobs: scrape },
  );
  assert.equal(result.slices.length, 1);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every((s) => s.reason === 'budget_exhausted'));
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(calls, 0);
  void scrape;
});

test('oversized slice skipped smaller later still runs', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'T',
      url: 'https://example.test/a',
      description: 's',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const ports = [port];
  const { reg, caps } = makeRegistries(ports);
  const bigSlice = makeSlice({
    sliceId: 's1',
    runId: 'run-1',
    adapterIds: [port.adapterId],
    budget: {
      logicalRequests: 100,
      reservedAttempts: 100,
      candidates: 100,
      bytes: 100000,
      milliseconds: 1000,
    },
  });
  const smallSlice = makeSlice({
    sliceId: 's2',
    runId: 'run-1',
    adapterIds: [port.adapterId],
    budget: {
      logicalRequests: 1,
      reservedAttempts: 1,
      candidates: 1,
      bytes: 1000,
      milliseconds: 1000,
    },
  });
  const midBudget: AcquisitionRunBudget = {
    logicalRequests: 5,
    reservedAttempts: 5,
    candidates: 5,
    bytes: 10000,
    milliseconds: 70000,
  };
  const result = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget: midBudget,
      plan: [
        { kind: 'indexed', slice: bigSlice, providerId: port.providerId, safeSearch: 'moderate' },
        { kind: 'indexed', slice: smallSlice, providerId: port.providerId, safeSearch: 'moderate' },
      ],
    },
    {
      policyRegistry: reg,
      capabilityRegistry: caps,
      ports,
      scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
    },
  );
  assert.equal(result.slices.length, 1);
  assert.equal(result.slices[0]!.sliceId, 's2');
  assert.equal(result.skipped[0]!.sliceId, 's1');
});

test('failure isolation: scrapeJobs rejects → failed coverage remaining slices run', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'T',
      url: 'https://example.test/a',
      description: 's',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const ports = [port];
  const { reg, caps } = makeRegistries(ports);
  const s1 = makeSlice({ sliceId: 's1', runId: 'run-1', adapterIds: ['jobspy'] });
  const s2 = makeSlice({ sliceId: 's2', runId: 'run-1', adapterIds: [port.adapterId] });
  const result = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget,
      plan: [
        { kind: 'jobspy', slice: s1, board: 'linkedin' },
        { kind: 'indexed', slice: s2, providerId: port.providerId, safeSearch: 'moderate' },
      ],
    },
    {
      policyRegistry: reg,
      capabilityRegistry: caps,
      ports,
      scrapeJobs: async () => {
        throw new Error('boom');
      },
      // deterministic clock: fabricated failure coverage durationMs is exactly 0,
      // so remaining.milliseconds stays 70000 and the second slice is not skipped
      monotonicNow: () => 0,
    },
  );
  assert.equal(result.slices.length, 2);

  assert.equal(result.slices[0]!.coverage[0]!.state, 'failed');
  assert.equal(result.slices[0]!.coverage[0]!.errorCode, 'ERROR');
  assert.equal(result.slices[0]!.coverage[0]!.durationMs, 0);
  assert.equal(result.slices[1]!.candidates.length, 1);
  assert.equal(result.slices[1]!.coverage[0]!.durationMs, 0);
  assert.equal(result.status, 'completed');
  assert.equal(result.skipped.length, 0);
  assert.deepEqual(result.budgetConsumed, {
    logicalRequests: 2,
    reservedAttempts: 4,
    candidates: 1,
    bytes: 1,
    milliseconds: 0,
  });
});

test('deadline advancement → deadline_exceeded skips', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'T',
      url: 'https://example.test/a',
      description: 's',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const ports = [port];
  const { reg, caps } = makeRegistries(ports);
  const tinyBudget: AcquisitionRunBudget = {
    logicalRequests: 10,
    reservedAttempts: 20,
    candidates: 10,
    bytes: 200000,
    milliseconds: 80000,
  };
  let idx = 0;
  const clock = () => (idx++ < 5 ? 0 : 90000);
  const result2 = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget: tinyBudget,
      plan: [
        {
          kind: 'indexed',
          slice: makeSlice({
            sliceId: 's1',
            runId: 'run-1',
            adapterIds: [port.adapterId],
            budget: {
              logicalRequests: 5,
              reservedAttempts: 5,
              candidates: 5,
              bytes: 100000,
              milliseconds: 70000,
            },
          }),
          providerId: port.providerId,
          safeSearch: 'moderate',
        },
        {
          kind: 'indexed',
          slice: makeSlice({
            sliceId: 's2',
            runId: 'run-1',
            adapterIds: [port.adapterId],
            budget: {
              logicalRequests: 5,
              reservedAttempts: 5,
              candidates: 5,
              bytes: 100000,
              milliseconds: 70000,
            },
          }),
          providerId: port.providerId,
          safeSearch: 'moderate',
        },
      ],
    },
    {
      policyRegistry: reg,
      capabilityRegistry: caps,
      ports,
      scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
      monotonicNow: clock,
    },
  );
  assert.equal(result2.status, 'deadline_exceeded');
  assert.equal(result2.skipped.length, 1);
  assert.equal(result2.skipped[0]!.sliceId, 's2');
  assert.equal(result2.skipped[0]!.reason, 'deadline_exceeded');
  assert.equal(result2.slices.length, 1);
  assert.equal(result2.slices[0]!.sliceId, 's1');
});

test('pre-aborted signal → aborted zero calls', async () => {
  const countingPort = mockPort('search-provider:brave', async () => [
    {
      title: 'T',
      url: 'https://example.test/a',
      description: 's',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const { reg: reg2, caps: caps2 } = makeRegistries([countingPort]);
  let calls = 0;
  const countingSearch = async () => {
    calls++;
    return [];
  };
  const portWithCount = {
    ...countingPort,
    search: countingSearch,
  } as unknown as IndexedProviderPort;
  const controller = new AbortController();
  controller.abort();
  const result2 = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget,
      plan: [
        {
          kind: 'indexed',
          slice: makeSlice({ sliceId: 's1', runId: 'run-1', adapterIds: [countingPort.adapterId] }),
          providerId: countingPort.providerId,
          safeSearch: 'moderate',
        },
      ],
      abortSignal: controller.signal,
    },
    {
      policyRegistry: reg2,
      capabilityRegistry: caps2,
      ports: [portWithCount],
      scrapeJobs: async () => {
        calls++;
        return { jobs: [], totalScraped: 0, newCount: 0 } as unknown as never;
      },
    },
  );
  assert.equal(result2.status, 'aborted');
  assert.equal(result2.slices.length, 0);
  assert.equal(result2.skipped[0]!.reason, 'aborted');
  assert.equal(calls, 0);
});

test('destination_fetch_required re-resolution fetch_pending and fetch_not_permitted', async () => {
  const ports: IndexedProviderPort[] = [];
  void ports;
  const permittedReg = new SourcePolicyRegistry([policy('publisher:acme', 'permitted')]);
  const blockedReg = new SourcePolicyRegistry([
    {
      sourceId: 'publisher:acme',
      revision: 'rev-1',
      modes: {
        automatedSearch: 'permitted',
        automatedFetch: 'blocked',
        userSuppliedContent: 'permitted',
        manualImport: 'permitted',
        employerApi: 'not_supported',
      },
      evidenceRefs: [],
      reviewedAt: '2026-01-01T00:00:00Z',
    } as unknown as import('../../src/jobs/acquisition/policy/sourcePolicy.js').SourcePolicy,
  ]);
  const caps = new AdapterCapabilityRegistry([
    {
      schemaVersion: '1.0.0',
      adapterId: 'manual',
      adapterVersion: '1.0.0',
      edges: [
        { operation: 'manualImport', route: 'user_supplied', targetKind: 'adapter' },
        { operation: 'userSuppliedContent', route: 'user_supplied', targetKind: 'adapter' },
        { operation: 'automatedFetch', route: 'direct', targetKind: 'publisher' },
      ],
    } as unknown as never,
  ]);
  const manualSlice = makeSlice({ sliceId: 's1', runId: 'run-1', adapterIds: ['manual'] });
  const pubTarget = { kind: 'publisher' as const, sourceId: 'publisher:acme' };
  const { resolveExecutionPolicyEdge: resolve } =
    await import('../../src/jobs/acquisition/policy/edgeCoordinator.js');
  const edgeIdExec = acquiredContentHash(
    JSON.stringify(['acquisition-edge', 'run-1', 's1', 'manual', 'automatedFetch', 'execution']),
  );
  const priorEdge = resolve(
    permittedReg as never,
    {
      edgeId: edgeIdExec,
      actor: { kind: 'user', namespace: 'ns', id: 'u1' },
      operation: 'automatedFetch',
      route: 'direct',
      target: { ...pubTarget, normalizedHost: 'publisher.acme' },
    } as never,
    { decidedAt: capturedAt },
  );
  const manualPlan = {
    kind: 'manual' as const,
    slice: manualSlice,
    submittedBy: { namespace: 'ns', id: 'u1' },
    content: { kind: 'url_only' as const, destinationUrl: 'https://publisher.acme/job/1' },
    publisherTarget: pubTarget,
    destinationFetchEdge: priorEdge,
  };
  const resultPermitted = await runAcquisition(
    { runId: 'run-1', capturedAt, budget, plan: [manualPlan] },
    {
      policyRegistry: permittedReg,
      capabilityRegistry: caps,
      ports,
      scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
      monotonicNow: () => 0,
    },
  );
  assert.equal(resultPermitted.destinationFetchReviews.length, 1);
  assert.equal(resultPermitted.destinationFetchReviews[0]!.disposition, 'fetch_pending');
  assert.equal(resultPermitted.destinationFetchReviews[0]!.recheckState, 'permitted');

  const resultBlocked = await runAcquisition(
    { runId: 'run-1', capturedAt, budget, plan: [manualPlan] },
    {
      policyRegistry: blockedReg,
      capabilityRegistry: caps,
      ports,
      scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
      monotonicNow: () => 0,
    },
  );
  assert.equal(resultBlocked.destinationFetchReviews.length, 1);
  assert.equal(resultBlocked.destinationFetchReviews[0]!.disposition, 'fetch_not_permitted');
  assert.ok(resultBlocked.warnings.includes('destination_fetch_not_permitted'));
});

test('url_only without fetch edge → content_required no review', async () => {
  const ports: IndexedProviderPort[] = [];
  void ports;
  const reg = new SourcePolicyRegistry([
    policy('manual', 'permitted'),
    policy('publisher:acme', 'permitted'),
  ]);
  const caps = new AdapterCapabilityRegistry([
    {
      schemaVersion: '1.0.0',
      adapterId: 'manual',
      adapterVersion: '1.0.0',
      edges: [
        { operation: 'manualImport', route: 'user_supplied', targetKind: 'adapter' },
        { operation: 'userSuppliedContent', route: 'user_supplied', targetKind: 'adapter' },
      ],
    } as unknown as never,
  ]);
  const slice = makeSlice({ sliceId: 's1', runId: 'run-1', adapterIds: ['manual'] });
  const result = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget,
      plan: [
        {
          kind: 'manual',
          slice,
          submittedBy: { namespace: 'ns', id: 'u1' },
          content: { kind: 'url_only', destinationUrl: 'https://example.test/job/1' },
        },
      ],
    },
    {
      policyRegistry: reg,
      capabilityRegistry: caps,
      ports,
      scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
    },
  );
  assert.equal(result.slices.length, 1);
  assert.equal(result.destinationFetchReviews.length, 0);
  assert.ok(!result.warnings.includes('destination_fetch_not_permitted'));
});

test('same canonicalUrl indexed + jobspy → duplicate retains adapter_acquired', async () => {
  const url = 'https://example.test/job/1';
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'T',
      url,
      description: 'snippet',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const ports = [port];
  const { reg, caps } = makeRegistries(ports);
  const s1 = makeSlice({
    sliceId: 's1',
    runId: 'run-1',
    adapterIds: [port.adapterId],
    budget: {
      logicalRequests: 1,
      reservedAttempts: 5,
      candidates: 2,
      bytes: 10000,
      milliseconds: 70000,
    },
  });
  const s2 = makeSlice({
    sliceId: 's2',
    runId: 'run-1',
    adapterIds: ['jobspy'],
    budget: {
      logicalRequests: 1,
      reservedAttempts: 5,
      candidates: 2,
      bytes: 10000,
      milliseconds: 10000,
    },
  });
  const result = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget,
      plan: [
        { kind: 'indexed', slice: s1, providerId: port.providerId, safeSearch: 'moderate' },
        { kind: 'jobspy', slice: s2, board: 'linkedin' },
      ],
    },
    {
      policyRegistry: reg,
      capabilityRegistry: caps,
      ports,
      scrapeJobs: async () =>
        ({
          jobs: [
            {
              id: '1',
              site: 'linkedin',
              job_url: url,
              title: 'J',
              company: 'C',
              location: 'L',
              description: 'd',
            },
          ],
          totalScraped: 1,
          newCount: 1,
        }) as unknown as never,
    },
  );
  assert.ok(result.duplicates.length >= 1);
  const dup = result.duplicates.find((d) => d.canonicalUrl === 'https://example.test/job/1');
  assert.ok(dup);
  const retainedCand = result.slices
    .flatMap((s) => s.candidates)
    .find((c) => c.candidateId === dup!.retainedCandidateId);
  assert.ok(retainedCand);
  assert.equal(retainedCand!.state, 'adapter_acquired');
  assert.equal(result.slices[0]!.candidates.length, 1);
  assert.equal(result.slices[1]!.candidates.length, 1);
});

test('determinism same input → byte-equal', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'T',
      url: 'https://example.test/a',
      description: 's',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const ports = [port];
  const { reg, caps } = makeRegistries(ports);
  const slice = makeSlice({ sliceId: 's1', runId: 'run-1', adapterIds: [port.adapterId] });
  const plan = [
    {
      kind: 'indexed' as const,
      slice,
      providerId: port.providerId,
      safeSearch: 'moderate' as const,
    },
  ];
  const opts = { runId: 'run-1', capturedAt, budget, plan };
  const deps = {
    policyRegistry: reg,
    capabilityRegistry: caps,
    ports,
    scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
    monotonicNow: () => 12345,
  };
  const r1 = await runAcquisition(opts, deps);
  const r2 = await runAcquisition(opts, deps);
  assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

test('runId mismatch → VALIDATION_ERROR before any resolution', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'T',
      url: 'https://example.test/a',
      description: 's',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  const ports = [port];
  const { reg, caps } = makeRegistries(ports);
  let calls = 0;
  const countingPort = {
    ...port,
    search: async () => {
      calls++;
      return [];
    },
  } as unknown as IndexedProviderPort;
  const slice = makeSlice({ sliceId: 's1', runId: 'run-2', adapterIds: [port.adapterId] });
  await assert.rejects(
    () =>
      runAcquisition(
        {
          runId: 'run-1',
          capturedAt,
          budget,
          plan: [{ kind: 'indexed', slice, providerId: port.providerId, safeSearch: 'moderate' }],
        },
        {
          policyRegistry: reg,
          capabilityRegistry: caps,
          ports: [countingPort],
          scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
        },
      ),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
  assert.equal(calls, 0);
});

test('missing port → VALIDATION_ERROR zero calls', async () => {
  const ports: IndexedProviderPort[] = [];
  const { reg, caps } = makeRegistries(ports);
  let calls = 0;
  const slice = makeSlice({
    sliceId: 's1',
    runId: 'run-1',
    adapterIds: ['indexed-provider:brave'],
  });
  await assert.rejects(
    () =>
      runAcquisition(
        {
          runId: 'run-1',
          capturedAt,
          budget,
          plan: [
            { kind: 'indexed', slice, providerId: 'search-provider:brave', safeSearch: 'moderate' },
          ],
        },
        {
          policyRegistry: reg,
          capabilityRegistry: caps,
          ports,
          scrapeJobs: async () => {
            calls++;
            return { jobs: [], totalScraped: 0, newCount: 0 } as unknown as never;
          },
        },
      ),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
  assert.equal(calls, 0);
});

test('overrun clamp → budget_overrun warning subsequent skip', async () => {
  // duration overrun via injected clock: slice budget ms fits remaining, but coverage durationMs exceeds remaining.
  const totalBudget: AcquisitionRunBudget = {
    logicalRequests: 10,
    reservedAttempts: 20,
    candidates: 10,
    bytes: 500000,
    milliseconds: 7000,
  };
  const js1 = makeSlice({
    sliceId: 's1',
    runId: 'run-1',
    adapterIds: ['jobspy'],
    budget: {
      logicalRequests: 1,
      reservedAttempts: 1,
      candidates: 5,
      bytes: 10000,
      milliseconds: 6000,
    },
  });
  const js2 = makeSlice({
    sliceId: 's2',
    runId: 'run-1',
    adapterIds: ['jobspy'],
    budget: {
      logicalRequests: 1,
      reservedAttempts: 1,
      candidates: 5,
      bytes: 10000,
      milliseconds: 1000,
    },
  });
  // monotonicNow sequence: runStart=0, elapsedBeforeSlice1=0, sliceStart s1=0, jobspy start=100, jobspy end=8100 (duration 8000) exceeds remaining ~7000, second slice timestamps follow
  let clockCalls = 0;
  const seq = [0, 0, 0, 100, 8100, 8100, 8100];
  const monotonicNow = () => {
    const v = seq[Math.min(clockCalls, seq.length - 1)]!;
    clockCalls++;
    return v;
  };
  const result2 = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget: totalBudget,
      plan: [
        { kind: 'jobspy', slice: js1, board: 'linkedin' },
        { kind: 'jobspy', slice: js2, board: 'indeed' },
      ],
    },
    {
      policyRegistry: new SourcePolicyRegistry([
        policy('linkedin', 'permitted'),
        policy('indeed', 'permitted'),
      ]),
      capabilityRegistry: new AdapterCapabilityRegistry([
        {
          schemaVersion: '1.0.0',
          adapterId: 'jobspy',
          adapterVersion: '1.7.0',
          edges: [{ operation: 'automatedSearch', route: 'direct', targetKind: 'board' }],
        } as unknown as never,
      ]),
      ports: [],
      scrapeJobs: async () =>
        ({
          jobs: [
            {
              id: '1',
              site: 'linkedin',
              job_url: 'https://example.test/a',
              title: 'T',
              company: 'C',
              location: 'L',
              description: 'd',
            },
          ],
          totalScraped: 1,
          newCount: 1,
        }) as unknown as never,
      monotonicNow,
    },
  );
  assert.ok(result2.warnings.includes('budget_overrun'));
  assert.equal(result2.budgetConsumed.milliseconds, 7000);
  assert.equal(result2.slices.length, 1);
  assert.equal(result2.slices[0]!.sliceId, 's1');
  assert.equal(result2.skipped.length, 1);
  assert.equal(result2.skipped[0]!.sliceId, 's2');
});

test('blocked registry edge → policy_blocked zero counters no calls', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      title: 'T',
      url: 'https://example.test/a',
      description: 's',
      position: 1,
      domain: 'example.test',
      source: 'brave',
      age: null,
      ageKind: 'unknown',
      extraSnippet: null,
      deepLinks: null,
      contentKind: 'snippet',
      generatedSummary: null,
    } as unknown as never,
  ]);
  let calls = 0;
  const countingPort = {
    ...port,
    search: async () => {
      calls++;
      return [];
    },
  } as unknown as IndexedProviderPort;
  const blockedReg = new SourcePolicyRegistry([policy(port.providerId, 'blocked')]);
  const caps = new AdapterCapabilityRegistry(
    indexedProviderCapabilities([port] as unknown as IndexedProviderPort[]),
  );
  const slice = makeSlice({ sliceId: 's1', runId: 'run-1', adapterIds: [port.adapterId] });
  const result = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget,
      plan: [{ kind: 'indexed', slice, providerId: port.providerId, safeSearch: 'moderate' }],
    },
    {
      policyRegistry: blockedReg,
      capabilityRegistry: caps,
      ports: [countingPort],
      scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
    },
  );
  assert.equal(result.slices[0]!.coverage[0]!.state, 'policy_blocked');
  assert.equal(result.slices[0]!.coverage[0]!.logicalRequestsUsed, 0);
  assert.equal(calls, 0);
});

test('duplicates-heavy plan same canonicalUrl does not throw and schema passes', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      url: 'https://example.test/same',
      title: 'T',
      description: 'd',
      position: 1,
    } as unknown as never,
  ]);
  const { reg, caps } = makeRegistries([port]);
  const plan: never[] = [];
  for (let i = 0; i < 11; i++) {
    const sl = makeSlice({
      sliceId: `sd${i}`,
      runId: 'run-1',
      adapterIds: [port.adapterId],
      queryVariantId: `qv-${i}`,
      ordinal: i,
      budget: {
        logicalRequests: 1,
        reservedAttempts: 1,
        candidates: 5,
        bytes: 1_000_000,
        milliseconds: 10000,
      },
    });
    plan.push({
      kind: 'indexed',
      slice: sl,
      providerId: port.providerId,
      safeSearch: 'moderate',
    } as never);
  }
  const dupBudget: AcquisitionRunBudget = {
    logicalRequests: 100,
    reservedAttempts: 100,
    candidates: 100,
    bytes: 10_000_000,
    milliseconds: 100000,
  };
  const result = await runAcquisition(
    { runId: 'run-1', capturedAt, budget: dupBudget, plan },
    {
      policyRegistry: reg,
      capabilityRegistry: caps,
      ports: [port],
      scrapeJobs: (async () =>
        ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never) as never,
    },
  );
  // should not throw; duplicates bound (50000 = 100 slices x 1000 candidates) allows many slices same url without schema failure
  AcquisitionRunResultSchema.parse(result);
  assert.equal(result.slices.length, 11);
});

test('fabricated durationMs floored and clamped via injected float clock', async () => {
  const port = mockPort('search-provider:brave', async () => [
    {
      url: 'https://example.test/a',
      title: 'T',
      description: 'd',
      position: 1,
    } as unknown as never,
  ]);
  const sl = makeSlice({
    sliceId: 'sf',
    runId: 'run-1',
    adapterIds: [port.adapterId],
    budget: {
      logicalRequests: 1,
      reservedAttempts: 1,
      candidates: 5,
      bytes: 10000,
      milliseconds: 10000,
    },
  });
  let calls = 0;
  const monotonicNow = () => {
    calls++;
    if (calls === 1) return 0; // runStart
    if (calls === 2) return 0.7; // elapsed before slice
    if (calls === 3) return 10.9; // sliceStart
    return 25.3; // now for failure fabricated duration (25.3 -10.9 =14.4 floor 14)
  };
  const throwingCaps = {
    supports: () => {
      throw new Error('cap boom');
    },
  } as unknown as never;
  const result = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget,
      plan: [
        {
          kind: 'indexed',
          slice: sl,
          providerId: port.providerId,
          safeSearch: 'moderate',
        } as never,
      ],
    },
    {
      policyRegistry: new SourcePolicyRegistry([policy(port.providerId, 'permitted')]),
      capabilityRegistry: throwingCaps,
      ports: [port],
      scrapeJobs: (async () =>
        ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never) as never,
      monotonicNow,
    },
  );
  assert.equal(result.slices[0]!.coverage[0]!.durationMs, 14);
  assert.equal(Number.isInteger(result.slices[0]!.coverage[0]!.durationMs), true);
});

test('duplicate sliceId pre-run validation zero resolutions/calls', async () => {
  const sA = makeSlice({ sliceId: 'dup', runId: 'run-1', adapterIds: ['ex'] });
  const sB = makeSlice({ sliceId: 'dup', runId: 'run-1', adapterIds: ['ex'] });
  let searchCalls = 0;
  const port = {
    adapterId: 'ex',
    providerId: 'prov-a',
    providerPolicyId: 'prov-a',
    backend: 'exa',
    maxDurationMs: 100,
    governance: {
      providerId: 'prov-a',
      kind: 'indexed_provider',
      sourcePolicyId: 'prov-a',
      requiresExplicitApproval: false,
      supportsStrictSafeSearch: true,
      maxAttempts: 1,
    },
    search: async () => {
      searchCalls++;
      return [{ url: 'https://example.test/a', title: 'T', description: 'd', position: 1 }];
    },
  } as never;
  const registry = new SourcePolicyRegistry([policy('prov-a', 'permitted')]);
  try {
    await runAcquisition(
      {
        runId: 'run-1',
        capturedAt,
        budget,
        plan: [
          { kind: 'indexed', slice: sA, providerId: 'prov-a' } as never,
          { kind: 'indexed', slice: sB, providerId: 'prov-a' } as never,
        ],
      },
      {
        policyRegistry: registry,
        capabilityRegistry: new AdapterCapabilityRegistry([
          {
            schemaVersion: '1.0.0',
            adapterId: 'ex',
            adapterVersion: '1.0.0',
            edges: [
              { operation: 'automatedSearch', route: 'indexed', targetKind: 'discovery_provider' },
            ],
          } as unknown as never,
        ]),
        ports: [port],
        scrapeJobs: (async () =>
          ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never) as never,
      },
    );
    assert.fail('should have thrown');
  } catch (err: unknown) {
    assert.equal(isToolError(err), true);
    assert.equal((err as never)['code'], 'VALIDATION_ERROR');
    assert.equal(searchCalls, 0);
  }
});

test('every result passes exported AcquisitionRunResultSchema', async () => {
  const port = mockPort('search-provider:brave', async () => []);
  const { reg, caps } = makeRegistries([port]);
  const slice = makeSlice({ sliceId: 's1', runId: 'run-1', adapterIds: [port.adapterId] });
  const result = await runAcquisition(
    {
      runId: 'run-1',
      capturedAt,
      budget,
      plan: [{ kind: 'indexed', slice, providerId: port.providerId, safeSearch: 'moderate' }],
    },
    {
      policyRegistry: reg,
      capabilityRegistry: caps,
      ports: [port],
      scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
    },
  );
  AcquisitionRunResultSchema.parse(result);
  const parsed = AcquisitionRunResultSchema.safeParse(result);
  assert.equal(parsed.success, true);
});

test('coordinator static imports allowlist', () => {
  const p = path.resolve('src/jobs/acquisition/coordinator.ts');
  const src = fs.readFileSync(p, 'utf8');
  const staticImportRe = /import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g;
  const specifiers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = staticImportRe.exec(src)) !== null) specifiers.push(m[1]!);
  const allow = new Set([
    'zod/v4',
    './contracts.js',
    './adapterSupport.js',
    './policy/edgeCoordinator.js',
    './providers/indexed.js',
    './adapters/jobspy.js',
    './adapters/manualImport.js',
    '../../errors.js',
    '../domain/ids.js',
    './policy/registry.js',
    './adapterRegistry.js',
    './providers/ports.js',
  ]);
  for (const s of specifiers) assert.ok(allow.has(s), `unexpected specifier ${s}`);
  assert.ok(specifiers.includes('zod/v4'));
  assert.ok(specifiers.includes('./contracts.js'));
  assert.equal(/\bimport\s*\(/.test(src), false, 'no dynamic import');
  assert.equal(/\bPromise\s*\.\s*all\s*\(/.test(src), false, 'no Promise.all');
  assert.equal(/\bPromise\s*\.\s*allSettled\s*\(/.test(src), false, 'no Promise.allSettled');
  assert.equal(/\bfetch\s*\(/.test(src), false, 'no fetch');
  assert.equal(/\bconsole\./.test(src), false, 'no console');
  // eslint-disable-next-line no-restricted-syntax
  assert.equal(src.includes('randomUUID'), false, 'no random');
  assert.equal(src.includes('Math.random'), false, 'no random');
});
