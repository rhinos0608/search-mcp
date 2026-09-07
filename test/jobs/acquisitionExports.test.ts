import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SourcePolicyRegistry,
  SOURCE_POLICY_VERSION,
  decideSourcePolicy,
  isPolicyPermitted,
  runIfPermitted,
  PolicyEdgeRequestSchema,
  ResolvePolicyEdgeOptionsSchema,
  resolveExecutionPolicyEdge,
  resolveInformationalPolicyEdge,
  executeIfPolicyPermitted,
  caveatsForInformationalEdges,
  type PolicyEdgeRequest,
  ADAPTER_CAPABILITY_CONTRACT_VERSION,
  AdapterCapabilitySchema,
  AdapterEdgeCapabilitySchema,
  AdapterCapabilityRegistry,
  AcquisitionPolicyEdgeSchema,
  AcquisitionSliceSchema,
  ACQUISITION_CONTRACT_VERSION,
  INDEXED_PROVIDER_ADAPTER_VERSION,
  runIndexedProvider,
  INDEXED_PROVIDER_DEFINITIONS,
  createDefaultIndexedProviderPorts,
  indexedProviderCapabilities,
  JOBSPY_ADAPTER_ID,
  JOBSPY_ADAPTER_VERSION,
  JOBSPY_BOARDS,
  DEFAULT_JOBSPY_BOARDS,
  JOBSPY_CAPABILITY,
  runJobSpyBoard,
  MANUAL_IMPORT_ADAPTER_ID,
  MANUAL_IMPORT_ADAPTER_VERSION,
  ManualImportRequestSchema,
  ManualImportResultSchema,
  runManualImport,
  type IndexedProviderRequest,
  type JobSpyBoardRequest,
  type ManualImportRequest,
  ACQUISITION_COORDINATOR_VERSION,
  runAcquisition,
  AcquisitionRunBudgetSchema,
  AcquisitionRunOptionsSchema,
  AcquisitionRunStatusSchema,
  AcquisitionSkippedSliceSchema,
  AcquisitionDestinationFetchReviewSchema,
  AcquisitionDuplicateGroupSchema,
  AcquisitionRunResultSchema,
  IndexedSlicePlanItemSchema,
  JobSpySlicePlanItemSchema,
  ManualSlicePlanItemSchema,
  AcquisitionSlicePlanItemSchema,
  type AcquisitionSlicePlanItem,
  type AcquisitionRunResult,
  DESTINATION_FETCH_ENRICHMENT_VERSION,
  DESTINATION_FETCH_ADAPTER_ID,
  DESTINATION_FETCH_CAPABILITY,
  DestinationFetchEnrichmentOptionsSchema,
  DestinationFetchEnrichmentResultSchema,
  enrichDestinationFetches,
} from '../../src/jobs/acquisition/index.js';
import { enrichDestinationFetches as enrichDestinationFetchesFromModule } from '../../src/jobs/acquisition/destinationFetch.js';
import { runAcquisition as runAcquisitionFromCoordinator } from '../../src/jobs/acquisition/coordinator.js';

test('barrel re-exports legacy SourcePolicyRegistry and source-policy APIs', () => {
  assert.ok(SourcePolicyRegistry);
  assert.equal(typeof SOURCE_POLICY_VERSION, 'string');
  assert.equal(typeof decideSourcePolicy, 'function');
  assert.equal(typeof isPolicyPermitted, 'function');
  assert.equal(typeof runIfPermitted, 'function');
  const reg = new SourcePolicyRegistry([]);
  assert.ok(reg instanceof SourcePolicyRegistry);
});

test('W3-B schemas and edge resolvers via barrel', () => {
  const req: PolicyEdgeRequest = {
    edgeId: 'edge-1' as PolicyEdgeRequest['edgeId'],
    actor: { kind: 'provider', namespace: 'provider', id: 'exa' },
    operation: 'automatedSearch',
    route: 'indexed',
    target: { kind: 'discovery_provider', sourceId: 'exa' },
  };
  assert.doesNotThrow(() => PolicyEdgeRequestSchema.parse(req));
  assert.doesNotThrow(() =>
    ResolvePolicyEdgeOptionsSchema.parse({ decidedAt: '2026-01-02T00:00:00Z' }),
  );
  const reg = new SourcePolicyRegistry([
    {
      sourceId: 'exa',
      revision: 'rev-1',
      modes: {
        automatedSearch: 'permitted',
        automatedFetch: 'blocked',
        userSuppliedContent: 'permitted',
        manualImport: 'permitted',
        employerApi: 'not_supported',
      },
      evidenceRefs: ['ev-1'],
      reviewedAt: '2026-01-01T00:00:00Z',
      notes: 'note',
    },
  ]);
  const exec = resolveExecutionPolicyEdge(reg, req, { decidedAt: '2026-01-02T00:00:00Z' });
  assert.equal(exec.effect, 'authorized_operation');
  AcquisitionPolicyEdgeSchema.parse(exec);
  const infoReq: PolicyEdgeRequest = {
    edgeId: 'edge-2' as PolicyEdgeRequest['edgeId'],
    actor: { kind: 'adapter', namespace: 'adapter', id: 'jobspy' },
    operation: 'automatedSearch',
    route: 'direct',
    target: { kind: 'publisher', sourceId: 'acme' },
  };
  const info = resolveInformationalPolicyEdge(reg, infoReq, {
    decidedAt: '2026-01-02T00:00:00Z',
  });
  assert.equal(info.effect, 'informational_capability');
  assert.equal(typeof executeIfPolicyPermitted, 'function');
  assert.equal(typeof caveatsForInformationalEdges, 'function');
  const caveats = caveatsForInformationalEdges([info]);
  assert.ok(Array.isArray(caveats));
});

test('W3-C capability exports via barrel', () => {
  assert.equal(ADAPTER_CAPABILITY_CONTRACT_VERSION, '1.0.0');
  const edge = {
    operation: 'automatedSearch' as const,
    route: 'direct' as const,
    targetKind: 'board' as const,
  };
  assert.equal(AdapterEdgeCapabilitySchema.safeParse(edge).success, true);
  const cap = {
    schemaVersion: '1.0.0' as const,
    adapterId: 'seek',
    adapterVersion: '1.0.0',
    edges: [edge],
  };
  const parsed = AdapterCapabilitySchema.parse(cap);
  assert.ok(Object.isFrozen(parsed));
  const registry = new AdapterCapabilityRegistry([cap]);
  assert.equal(registry.supports('seek', edge), true);
  assert.deepEqual(
    registry.list().map((c) => c.adapterId),
    ['seek'],
  );
  assert.equal(ACQUISITION_CONTRACT_VERSION, '1.0.0');
});

test('W3-D/E/F barrel smoke: indexed definitions, capabilities, rakes, manual schemas', () => {
  // indexed adapter version and request slice shape cheap construction
  assert.equal(INDEXED_PROVIDER_ADAPTER_VERSION, '1.0.0');
  assert.equal(typeof runIndexedProvider, 'function');
  const slice = AcquisitionSliceSchema.parse({
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
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 10,
      bytes: 100000,
      milliseconds: 70000,
    },
  });
  const indexedReq: IndexedProviderRequest = {
    slice,
    executionEdge: AcquisitionPolicyEdgeSchema.parse({
      edgeId: 'edge-idx-1',
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      actor: { kind: 'provider', namespace: 'search-provider', id: 'search-provider:brave' },
      operation: 'automatedSearch',
      route: 'indexed',
      target: { kind: 'discovery_provider', sourceId: 'search-provider:brave' },
      state: 'permitted',
      effect: 'authorized_operation',
      revision: 'rev-1',
      evidenceRefs: [],
      reviewedAt: new Date().toISOString(),
    }),
    safeSearch: 'moderate',
    capturedAt: new Date().toISOString(),
  };
  assert.equal(indexedReq.safeSearch, 'moderate');

  // provider definition table check: 7 entries, governance bounded_cache etc
  assert.equal(INDEXED_PROVIDER_DEFINITIONS.length, 7);
  const brave = INDEXED_PROVIDER_DEFINITIONS.find((d) => d.backend === 'brave');
  assert.ok(brave);
  assert.equal(brave!.providerId, 'search-provider:brave');
  assert.equal(brave!.governance.resultRetention, 'bounded_cache');
  assert.equal(brave!.maxDurationMs, 70000);

  // capability construction via ports (use table definitions to build mock ports)
  const mockPorts = INDEXED_PROVIDER_DEFINITIONS.slice(0, 2).map((def) => ({
    backend: def.backend,
    adapterId: def.adapterId,
    providerId: def.providerId,
    governance: def.governance,
    maxDurationMs: def.maxDurationMs,
    search: async () => [] as never,
  })) as unknown as ReturnType<typeof createDefaultIndexedProviderPorts>;
  const caps = indexedProviderCapabilities(mockPorts);
  assert.equal(caps.length, 2);
  assert.deepEqual(caps[0]!.edges[0], {
    operation: 'automatedSearch',
    route: 'indexed',
    targetKind: 'discovery_provider',
  });

  // JobSpy capability triple automatedSearch/direct/board
  assert.equal(JOBSPY_ADAPTER_ID, 'jobspy');
  assert.equal(JOBSPY_ADAPTER_VERSION, '1.7.0');
  assert.deepEqual([...JOBSPY_BOARDS].slice(0, 4), [
    'linkedin',
    'indeed',
    'zip_recruiter',
    'glassdoor',
  ]);
  assert.deepEqual(
    [...DEFAULT_JOBSPY_BOARDS],
    ['linkedin', 'indeed', 'glassdoor', 'zip_recruiter'],
  );
  assert.equal(JOBSPY_CAPABILITY.edges.length, 1);
  assert.deepEqual(JOBSPY_CAPABILITY.edges[0], {
    operation: 'automatedSearch',
    route: 'direct',
    targetKind: 'board',
  });
  assert.equal(typeof runJobSpyBoard, 'function');
  const jobSpyReq: JobSpyBoardRequest = {
    slice,
    board: 'linkedin',
    executionEdge: AcquisitionPolicyEdgeSchema.parse({
      edgeId: 'edge-jobspy-1',
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      actor: { kind: 'adapter', namespace: 'adapter', id: JOBSPY_ADAPTER_ID },
      operation: 'automatedSearch',
      route: 'direct',
      target: { kind: 'board', sourceId: 'linkedin' },
      state: 'permitted',
      effect: 'authorized_operation',
      revision: 'rev-1',
      evidenceRefs: [],
      reviewedAt: new Date().toISOString(),
    }),
    capturedAt: new Date().toISOString(),
  };
  assert.equal(jobSpyReq.board, 'linkedin');

  // manual request/result schema parse of representative imported outcome
  assert.equal(MANUAL_IMPORT_ADAPTER_ID, 'manual');
  assert.equal(MANUAL_IMPORT_ADAPTER_VERSION, '1.0.0');
  assert.equal(typeof runManualImport, 'function');
  const manualReq: ManualImportRequest = {
    slice,
    capturedAt: new Date().toISOString(),
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'Hello world' },
    manualImportEdge: AcquisitionPolicyEdgeSchema.parse({
      edgeId: 'manual-import',
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      actor: { kind: 'user', namespace: 'user', id: 'alice' },
      operation: 'manualImport',
      route: 'user_supplied',
      target: { kind: 'publisher', sourceId: 'acme' },
      state: 'permitted',
      effect: 'authorized_operation',
      revision: 'r1',
      evidenceRefs: [],
      reviewedAt: '2026-01-01T00:00:00Z',
    }),
    userSuppliedContentEdge: AcquisitionPolicyEdgeSchema.parse({
      edgeId: 'manual-content',
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      actor: { kind: 'user', namespace: 'user', id: 'alice' },
      operation: 'userSuppliedContent',
      route: 'user_supplied',
      target: { kind: 'publisher', sourceId: 'acme' },
      state: 'permitted',
      effect: 'authorized_operation',
      revision: 'r1',
      evidenceRefs: [],
      reviewedAt: '2026-01-01T00:00:00Z',
    }),
  };
  assert.doesNotThrow(() => ManualImportRequestSchema.parse(manualReq));
  const imported = runManualImport(manualReq);
  assert.equal(imported.status, 'imported');
  assert.doesNotThrow(() => ManualImportResultSchema.parse(imported));
});

test('W3-H destinationFetch enrichment exports via barrel', () => {
  assert.equal(DESTINATION_FETCH_ENRICHMENT_VERSION, '1.0.0');
  assert.equal(DESTINATION_FETCH_ADAPTER_ID, 'destination-fetch');
  // capability triple structure
  assert.equal(DESTINATION_FETCH_CAPABILITY.schemaVersion, ADAPTER_CAPABILITY_CONTRACT_VERSION);
  assert.equal(DESTINATION_FETCH_CAPABILITY.adapterId, DESTINATION_FETCH_ADAPTER_ID);
  assert.equal(DESTINATION_FETCH_CAPABILITY.adapterVersion, DESTINATION_FETCH_ENRICHMENT_VERSION);
  assert.equal(DESTINATION_FETCH_CAPABILITY.edges.length, 3);
  assert.deepEqual(
    DESTINATION_FETCH_CAPABILITY.edges.map((e) => e.targetKind),
    ['publisher', 'board', 'ats_tenant'],
  );
  assert.ok(
    DESTINATION_FETCH_CAPABILITY.edges.every(
      (e) => e.operation === 'automatedFetch' && e.route === 'direct',
    ),
  );

  // barrel re-export must be destinationFetch.js's own export, not a wrapper/duplicate
  assert.equal(enrichDestinationFetches, enrichDestinationFetchesFromModule);
  assert.equal(typeof enrichDestinationFetches, 'function');

  // representative options schema parse
  const budget = AcquisitionRunBudgetSchema.parse({
    logicalRequests: 5,
    reservedAttempts: 5,
    candidates: 10,
    bytes: 100000,
    milliseconds: 70000,
  });
  const run: AcquisitionRunResult = AcquisitionRunResultSchema.parse({
    status: 'completed',
    slices: [],
    skipped: [],
    destinationFetchReviews: [],
    duplicates: [],
    warnings: [],
    budgetConsumed: {
      logicalRequests: 0,
      reservedAttempts: 0,
      candidates: 0,
      bytes: 0,
      milliseconds: 0,
    },
  });
  const options = DestinationFetchEnrichmentOptionsSchema.parse({ run, budget });
  assert.equal(options.run.status, 'completed');
  assert.equal(options.budget.logicalRequests, 5);

  // representative result schema parse
  const result = DestinationFetchEnrichmentResultSchema.parse({
    schemaVersion: DESTINATION_FETCH_ENRICHMENT_VERSION,
    status: 'completed',
    run,
    attempts: [],
    budgetConsumed: {
      logicalRequests: 1,
      reservedAttempts: 1,
      candidates: 0,
      bytes: 256,
      milliseconds: 42,
    },
  });
  assert.equal(result.status, 'completed');
});

test('W3-G coordinator envelope schemas via barrel', () => {
  assert.equal(ACQUISITION_COORDINATOR_VERSION, '1.0.0');
  assert.equal(typeof runAcquisition, 'function');
  // barrel re-export must be the coordinator's own export, not a wrapper/duplicate
  assert.equal(runAcquisition, runAcquisitionFromCoordinator);

  const budget = AcquisitionRunBudgetSchema.parse({
    logicalRequests: 5,
    reservedAttempts: 5,
    candidates: 10,
    bytes: 100000,
    milliseconds: 70000,
  });
  assert.equal(budget.logicalRequests, 5);

  const slice = AcquisitionSliceSchema.parse({
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
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 10,
      bytes: 100000,
      milliseconds: 70000,
    },
  });

  // Representative plan parse: one item per slice-plan variant.
  const indexedItem = IndexedSlicePlanItemSchema.parse({
    kind: 'indexed',
    slice,
    providerId: 'search-provider:brave',
    safeSearch: 'moderate',
  });
  assert.equal(indexedItem.providerId, 'search-provider:brave');
  const jobspyItem = JobSpySlicePlanItemSchema.parse({ kind: 'jobspy', slice, board: 'linkedin' });
  assert.equal(jobspyItem.board, 'linkedin');
  const manualItem = ManualSlicePlanItemSchema.parse({
    kind: 'manual',
    slice,
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'Hello world' },
  });
  assert.equal(manualItem.submittedBy.id, 'alice');

  const planInput = [indexedItem, jobspyItem, manualItem];
  assert.doesNotThrow(() => AcquisitionSlicePlanItemSchema.parse(indexedItem));
  assert.doesNotThrow(() => AcquisitionSlicePlanItemSchema.parse(jobspyItem));
  assert.doesNotThrow(() => AcquisitionSlicePlanItemSchema.parse(manualItem));
  const plan: AcquisitionSlicePlanItem[] = planInput;
  assert.deepEqual(
    plan.map((item) => item.kind),
    ['indexed', 'jobspy', 'manual'],
  );
  assert.doesNotThrow(() => IndexedSlicePlanItemSchema.parse(plan[0]));
  assert.doesNotThrow(() => JobSpySlicePlanItemSchema.parse(plan[1]));
  assert.doesNotThrow(() => ManualSlicePlanItemSchema.parse(plan[2]));

  const opts = AcquisitionRunOptionsSchema.parse({
    runId: 'run-1',
    capturedAt: new Date().toISOString(),
    budget,
    plan,
  });
  assert.equal(opts.runId, 'run-1');

  assert.doesNotThrow(() => AcquisitionRunStatusSchema.parse('completed'));
  const skipped = AcquisitionSkippedSliceSchema.parse({
    sliceId: 'slice-2',
    reason: 'budget_exhausted',
  });
  assert.equal(skipped.reason, 'budget_exhausted');
  const review = AcquisitionDestinationFetchReviewSchema.parse({
    sliceId: 'slice-3',
    priorFetchEdgeRef: 'edge-prior',
    recheckEdgeRef: 'edge-recheck',
    recheckState: 'permitted',
    disposition: 'fetch_pending',
  });
  assert.equal(review.disposition, 'fetch_pending');
  const dupes = AcquisitionDuplicateGroupSchema.parse({
    canonicalUrl: 'https://example.com/job/1',
    retainedCandidateId: 'cand-1',
    superseded: [{ candidateId: 'cand-2', sliceId: 'slice-1' }],
  });
  assert.equal(dupes.retainedCandidateId, 'cand-1');

  // Representative run-result envelope with empty collections.
  const result: AcquisitionRunResult = AcquisitionRunResultSchema.parse({
    status: 'completed',
    slices: [],
    skipped: [],
    destinationFetchReviews: [],
    duplicates: [],
    warnings: [],
    budgetConsumed: {
      logicalRequests: 0,
      reservedAttempts: 0,
      candidates: 0,
      bytes: 0,
      milliseconds: 0,
    },
  });
  assert.equal(result.status, 'completed');
});
