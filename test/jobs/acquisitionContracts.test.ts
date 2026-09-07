import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACQUISITION_CONTRACT_VERSION,
  AcquiredObservationEnvelopeSchema,
  AcquisitionCandidateSchema,
  AcquisitionCoverageSchema,
  AcquisitionPolicyEdgeSchema,
  AcquisitionSliceResultSchema,
  AcquisitionSliceResultV1Schema,
  DiscoveryEvidenceSchema,
  DiscoveryProvenanceSchema,
  ProviderGovernanceSchema,
  type AcquisitionSliceResult,
  type AcquisitionSliceResultV1,
  isPermittedAcquisitionEdge,
} from '../../src/jobs/acquisition/index.js';

const gov = {
  schemaVersion: '1.0.0',
  providerId: 'exa',
  sourcePolicyId: 'policy',
  mode: 'automatedSearch',
  queryHandling: 'raw',
  resultRetention: 'ephemeral',
  sendsQueryOffDevice: true,
  supportsUrlAttributedSummary: true,
  supportsStrictSafeSearch: true,
  maxResultsPerRequest: 10,
  maxAttempts: 2,
  evidenceRefs: ['gov-evidence'],
} as const;

const indexedProv = {
  kind: 'indexed_discovery' as const,
  schemaVersion: '1.0.0' as const,
  discoverers: [
    {
      providerId: 'exa',
      providerResultId: 'result-1',
      rank: 1,
      queryVariantId: 'qv',
      upstreamEngines: ['exa'],
    },
  ],
  contentDonor: {
    kind: 'provider' as const,
    providerId: 'exa',
    representation: 'indexed_snippet' as const,
  },
  destination: {
    rawUrl: 'https://jobs.example.test/a',
    canonicalUrl: 'https://jobs.example.test/a',
    normalizedHost: 'jobs.example.test',
  },
  capturedAt: '2026-01-01T00:00:00Z',
};
const directProv = {
  kind: 'direct_adapter' as const,
  schemaVersion: '1.0.0' as const,
  discoverer: {
    adapterId: 'jobspy',
    adapterResultId: 'r1',
    rank: 1,
    queryVariantId: 'qv',
    operation: 'automatedSearch' as const,
  },
  contentDonor: {
    kind: 'adapter' as const,
    adapterId: 'jobspy',
    representation: 'adapter_listing' as const,
  },
  publisher: { kind: 'board' as const, sourceId: 'seek' },
  capturedAt: '2026-01-01T00:00:00Z',
};
const manualProv = {
  kind: 'manual_content' as const,
  schemaVersion: '1.0.0' as const,
  contentDonor: {
    kind: 'user' as const,
    namespace: 'user',
    id: 'alice',
    representation: 'user_supplied_content' as const,
  },
  publisher: { kind: 'publisher' as const, sourceId: 'acme' },
  capturedAt: '2026-01-01T00:00:00Z',
};
const manualProvNoPub = {
  kind: 'manual_content' as const,
  schemaVersion: '1.0.0' as const,
  contentDonor: {
    kind: 'user' as const,
    namespace: 'user',
    id: 'alice',
    representation: 'user_supplied_content' as const,
  },
  capturedAt: '2026-01-01T00:00:00Z',
};
const evIndexed = {
  evidenceId: 'ev-1',
  kind: 'indexed_snippet' as const,
  providerAttributed: true as const,
  providerId: 'exa',
  targetCanonicalUrl: 'https://jobs.example.test/a',
  boundedText: 'Senior engineer',
  contentHash: 'hash-1',
  capturedAt: '2026-01-01T00:00:00Z',
};
const evDestination = {
  evidenceId: 'ev-destination',
  kind: 'destination_content' as const,
  targetCanonicalUrl: 'https://jobs.example.test/a',
  boundedText: 'Full posting',
  contentHash: 'hash-destination',
  capturedAt: '2026-01-01T00:00:00Z',
  observationId: 'observation-1',
  sourceListingId: 'listing-1',
};
const evAdapter = {
  evidenceId: 'ev-adapter',
  kind: 'adapter_listing' as const,
  boundedText: 'Adapter posting',
  contentHash: 'hash-adapter',
  capturedAt: '2026-01-01T00:00:00Z',
  adapterId: 'jobspy',
  publisherSourceId: 'seek',
  sourceListingId: 'listing-1',
  observationId: 'observation-1',
};
const evManual = {
  evidenceId: 'ev-manual',
  kind: 'user_supplied_content' as const,
  boundedText: 'Manual posting',
  contentHash: 'hash-manual',
  capturedAt: '2026-01-01T00:00:00Z',
  submittedBy: { namespace: 'user', id: 'alice' },
  sourceListingId: 'listing-1',
  observationId: 'observation-1',
};
function baseCandidate(provenance: unknown, extras: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0' as const,
    candidateId: 'candidate-1',
    runId: 'run-1',
    sliceId: 'slice-1',
    adapterId: 'seek',
    provenance,
    evidenceRefs: ['ev-1'],
    policyEdgeRefs: ['edge-1'],
    caveats: [] as string[],
    state: 'indexed_only' as const,
    ...extras,
  };
}
const edgeProvider = AcquisitionPolicyEdgeSchema.parse({
  edgeId: 'edge-1',
  schemaVersion: '1.0.0',
  actor: { kind: 'provider', namespace: 'provider', id: 'exa' },
  operation: 'automatedSearch',
  route: 'indexed',
  target: { kind: 'discovery_provider', sourceId: 'exa' },
  state: 'permitted',
  effect: 'authorized_operation',
  revision: 'r1',
  evidenceRefs: [],
  reviewedAt: '2026-01-01T00:00:00Z',
});
const fetchEdge = {
  ...edgeProvider,
  edgeId: 'fetch-edge',
  operation: 'automatedFetch' as const,
  route: 'direct' as const,
  target: {
    kind: 'publisher' as const,
    sourceId: 'publisher',
    normalizedHost: 'jobs.example.test',
  },
};
const adapterEdge = AcquisitionPolicyEdgeSchema.parse({
  edgeId: 'adapter-edge',
  schemaVersion: '1.0.0',
  actor: { kind: 'adapter', namespace: 'adapter', id: 'jobspy' },
  operation: 'automatedSearch',
  route: 'direct',
  target: { kind: 'board', sourceId: 'seek' },
  state: 'permitted',
  effect: 'authorized_operation',
  revision: 'r1',
  evidenceRefs: [],
  reviewedAt: '2026-01-01T00:00:00Z',
});
const manualImportEdge = AcquisitionPolicyEdgeSchema.parse({
  edgeId: 'manual-import',
  schemaVersion: '1.0.0',
  actor: { kind: 'user', namespace: 'user', id: 'alice' },
  operation: 'manualImport',
  route: 'user_supplied',
  target: { kind: 'publisher', sourceId: 'acme' },
  state: 'permitted',
  effect: 'authorized_operation',
  revision: 'r1',
  evidenceRefs: [],
  reviewedAt: '2026-01-01T00:00:00Z',
});
const manualContentEdge = AcquisitionPolicyEdgeSchema.parse({
  edgeId: 'manual-content-edge',
  schemaVersion: '1.0.0',
  actor: { kind: 'user', namespace: 'user', id: 'alice' },
  operation: 'userSuppliedContent',
  route: 'user_supplied',
  target: { kind: 'publisher', sourceId: 'acme' },
  state: 'permitted',
  effect: 'authorized_operation',
  revision: 'r1',
  evidenceRefs: [],
  reviewedAt: '2026-01-01T00:00:00Z',
});
const envelopeDest = {
  schemaVersion: '1.0.0' as const,
  envelopeId: 'envelope-1',
  listing: {
    sourceListingId: 'listing-1',
    adapterId: 'seek',
    externalId: 'external-1',
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
    currentObservationId: 'observation-1',
  },
  observation: {
    observationId: 'observation-1',
    sourceListingId: 'listing-1',
    fetchedAt: '2026-01-01T00:00:00Z',
    contentHash: 'hash-destination',
    evidenceRefs: ['ev-destination'],
    extractionVersion: 'v1',
    adapterVersion: 'v1',
    fetchOutcome: 'success' as const,
    sourceConfidence: {},
    immutable: true as const,
  },
  acquisition: {
    captureKind: 'destination_fetch' as const,
    publisherSourceId: 'publisher',
    discoveryCandidateIds: ['candidate-1'],
    policyEdgeRefs: ['fetch-edge'],
    evidenceRefs: ['ev-destination'],
    fetchEdgeRef: 'fetch-edge',
  },
};
const envelopeAdapter = {
  schemaVersion: '1.0.0' as const,
  envelopeId: 'envelope-1',
  listing: {
    sourceListingId: 'listing-1',
    adapterId: 'jobspy',
    externalId: 'external-1',
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
    currentObservationId: 'observation-1',
  },
  observation: {
    observationId: 'observation-1',
    sourceListingId: 'listing-1',
    fetchedAt: '2026-01-01T00:00:00Z',
    contentHash: 'hash-adapter',
    evidenceRefs: ['ev-adapter'],
    extractionVersion: 'v1',
    adapterVersion: 'v1',
    fetchOutcome: 'success' as const,
    sourceConfidence: {},
    immutable: true as const,
  },
  acquisition: {
    captureKind: 'adapter_listing' as const,
    publisherSourceId: 'seek',
    discoveryCandidateIds: ['candidate-1'],
    policyEdgeRefs: ['adapter-edge'],
    evidenceRefs: ['ev-adapter'],
    adapterId: 'jobspy',
    acquisitionEdgeRef: 'adapter-edge',
  },
};
const envelopeManual = {
  schemaVersion: '1.0.0' as const,
  envelopeId: 'envelope-1',
  listing: {
    sourceListingId: 'listing-1',
    adapterId: 'seek',
    externalId: 'external-1',
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
    currentObservationId: 'observation-1',
  },
  observation: {
    observationId: 'observation-1',
    sourceListingId: 'listing-1',
    fetchedAt: '2026-01-01T00:00:00Z',
    contentHash: 'hash-manual',
    evidenceRefs: ['ev-manual'],
    extractionVersion: 'v1',
    adapterVersion: 'v1',
    fetchOutcome: 'success' as const,
    sourceConfidence: {},
    immutable: true as const,
  },
  acquisition: {
    captureKind: 'manual_content' as const,
    publisherSourceId: 'acme',
    discoveryCandidateIds: ['candidate-1'],
    policyEdgeRefs: ['manual-import', 'manual-content-edge'],
    evidenceRefs: ['ev-manual'],
    submittedBy: { namespace: 'user', id: 'alice' },
    manualImportEdgeRef: 'manual-import',
    userSuppliedContentEdgeRef: 'manual-content-edge',
  },
};

test('governance exact handling', () => {
  assert.equal(ProviderGovernanceSchema.safeParse(gov).success, true);
});
test('governance rejects policy query state', () => {
  assert.equal(
    ProviderGovernanceSchema.safeParse({ ...gov, queryHandling: 'permitted' } as unknown as object)
      .success,
    false,
  );
});
test('edge requires actor identity', () => {
  assert.equal(
    AcquisitionPolicyEdgeSchema.safeParse({
      ...edgeProvider,
      actor: 'provider' as unknown as object,
    }).success,
    false,
  );
});
test('informational edge not authorized', () => {
  assert.equal(
    isPermittedAcquisitionEdge({ ...edgeProvider, effect: 'informational_capability' as const }),
    false,
  );
});
test('indexed provenance parses', () => {
  assert.equal(DiscoveryProvenanceSchema.safeParse(indexedProv).success, true);
});
test('direct provenance parses', () => {
  assert.equal(DiscoveryProvenanceSchema.safeParse(directProv).success, true);
});
test('manual provenance parses', () => {
  assert.equal(DiscoveryProvenanceSchema.safeParse(manualProv).success, true);
});
test('indexed needs destination', () => {
  assert.equal(
    DiscoveryProvenanceSchema.safeParse({
      ...indexedProv,
      destination: undefined,
    } as unknown as object).success,
    false,
  );
});
test('manual partial destination rejects', () => {
  assert.equal(
    DiscoveryProvenanceSchema.safeParse({
      ...manualProv,
      destination: { canonicalUrl: 'https://x.test/a' } as unknown as object,
    }).success,
    false,
  );
});
test('candidate inline evidence rejected', () => {
  assert.equal(
    AcquisitionCandidateSchema.safeParse({
      ...baseCandidate(indexedProv),
      evidence: [evIndexed],
    } as unknown as object).success,
    false,
  );
});

test('indexed only passes', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider],
  });
  assert.equal(r.success, true);
});
test('fetch eligible passes', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(indexedProv, {
        state: 'fetch_eligible',
        fetchEdgeRef: 'fetch-edge',
        policyEdgeRefs: ['edge-1', 'fetch-edge'],
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, fetchEdge],
  });
  assert.equal(r.success, true);
});
test('destination_fetched linkage passes', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(indexedProv, {
          state: 'destination_fetched',
          fetchEdgeRef: 'fetch-edge',
          destinationEvidenceRef: 'ev-destination',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-1', 'ev-destination'],
          policyEdgeRefs: ['edge-1', 'fetch-edge'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed, evDestination],
    observations: [envelopeDest],
    policyEdges: [edgeProvider, fetchEdge],
  });
  assert.equal(r.success, true);
});
test('indexed accepts absent publisher', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate({ ...indexedProv, publisher: undefined })],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider],
  });
  assert.equal(r.success, true);
});
test('blocked informational publisher edge with caveat passes', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(indexedProv, {
          policyEdgeRefs: ['edge-1', 'edge-2'],
          caveats: ['direct_search_blocked'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [
      edgeProvider,
      {
        ...edgeProvider,
        edgeId: 'edge-2',
        effect: 'informational_capability' as const,
        state: 'blocked' as const,
        route: 'direct' as const,
        target: { kind: 'publisher', sourceId: 'unknown' },
      },
    ],
  });
  assert.equal(r.success, true);
});
test('jobspy adapter passes', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(directProv, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'jobspy',
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [envelopeAdapter],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, true);
});
test('generic direct adapter URL-less passes', () => {
  const prov = {
    ...directProv,
    discoverer: { ...directProv.discoverer, adapterId: 'greenhouse' },
    contentDonor: {
      kind: 'adapter' as const,
      adapterId: 'greenhouse',
      representation: 'adapter_listing' as const,
    },
    publisher: { kind: 'board' as const, sourceId: 'greenhouse-board' },
  };
  const ev = { ...evAdapter, adapterId: 'greenhouse', publisherSourceId: 'greenhouse-board' };
  const edge = {
    ...adapterEdge,
    actor: { kind: 'adapter' as const, namespace: 'adapter', id: 'greenhouse' },
    target: { kind: 'board' as const, sourceId: 'greenhouse-board' },
  };
  const env = {
    ...envelopeAdapter,
    acquisition: {
      ...envelopeAdapter.acquisition,
      publisherSourceId: 'greenhouse-board',
      adapterId: 'greenhouse',
    },
    listing: { ...envelopeAdapter.listing, adapterId: 'greenhouse' },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(prov, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'greenhouse',
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [ev],
    observations: [env],
    policyEdges: [edge],
  });
  assert.equal(r.success, true);
});
test('manual no URL passes', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(manualProv, {
          state: 'manual_content',
          manualImportEdgeRef: 'manual-import',
          userSuppliedContentEdgeRef: 'manual-content-edge',
          manualEvidenceRef: 'ev-manual',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-manual'],
          policyEdgeRefs: ['manual-import', 'manual-content-edge'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evManual],
    observations: [envelopeManual],
    policyEdges: [manualImportEdge, manualContentEdge],
  });
  assert.equal(r.success, true);
});
test('manual without publisher via adapter target passes', () => {
  const imp = { ...manualImportEdge, target: { kind: 'adapter' as const, sourceId: 'seek' } };
  const cont = { ...manualContentEdge, target: { kind: 'adapter' as const, sourceId: 'seek' } };
  const env = {
    ...envelopeManual,
    acquisition: {
      ...envelopeManual.acquisition,
      publisherSourceId: 'seek',
      policyEdgeRefs: ['manual-import', 'manual-content-edge'],
    },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(manualProvNoPub, {
          state: 'manual_content',
          manualImportEdgeRef: 'manual-import',
          userSuppliedContentEdgeRef: 'manual-content-edge',
          manualEvidenceRef: 'ev-manual',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-manual'],
          policyEdgeRefs: ['manual-import', 'manual-content-edge'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evManual],
    observations: [env],
    policyEdges: [imp, cont],
  });
  assert.equal(r.success, true);
});
test('indexed rejects adapter provenance', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(directProv)],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});
test('adapter rejects indexed provenance', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(indexedProv, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [envelopeAdapter],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});
test('manual rejects indexed provenance', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(indexedProv, {
          state: 'manual_content',
          manualImportEdgeRef: 'manual-import',
          userSuppliedContentEdgeRef: 'manual-content-edge',
          manualEvidenceRef: 'ev-manual',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-manual'],
          policyEdgeRefs: ['manual-import', 'manual-content-edge'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evManual],
    observations: [envelopeManual],
    policyEdges: [manualImportEdge, manualContentEdge],
  });
  assert.equal(r.success, false);
});
test('indexed missing provider edge rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [],
  });
  assert.equal(r.success, false);
});
test('provider evidence URL mismatch rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [],
    warnings: [],
    evidence: [{ ...evIndexed, targetCanonicalUrl: 'https://jobs.example.test/other' }],
    observations: [],
    policyEdges: [edgeProvider],
  });
  assert.equal(r.success, false);
});
test('fetch eligible rejects informational edge', () => {
  const bad = { ...fetchEdge, effect: 'informational_capability' as const };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(indexedProv, {
        state: 'fetch_eligible',
        fetchEdgeRef: 'fetch-edge',
        policyEdgeRefs: ['edge-1', 'fetch-edge'],
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, bad],
  });
  assert.equal(r.success, false);
});
test('fetch eligible rejects blocked edge', () => {
  const bad = { ...fetchEdge, state: 'blocked' as const };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(indexedProv, {
        state: 'fetch_eligible',
        fetchEdgeRef: 'fetch-edge',
        policyEdgeRefs: ['edge-1', 'fetch-edge'],
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, bad],
  });
  assert.equal(r.success, false);
});
test('fetch wrong operation rejects', () => {
  const bad = { ...fetchEdge, operation: 'automatedSearch' as const };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(indexedProv, {
        state: 'fetch_eligible',
        fetchEdgeRef: 'fetch-edge',
        policyEdgeRefs: ['edge-1', 'fetch-edge'],
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, bad],
  });
  assert.equal(r.success, false);
});
test('jobspy rejects provider edge', () => {
  const fake = {
    ...edgeProvider,
    edgeId: 'adapter-edge',
    target: { kind: 'board' as const, sourceId: 'seek' },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(directProv, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'jobspy',
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [envelopeAdapter],
    policyEdges: [fake],
  });
  assert.equal(r.success, false);
});
test('jobspy wrong adapter actor rejects', () => {
  const bad = {
    ...adapterEdge,
    actor: { kind: 'adapter' as const, namespace: 'adapter', id: 'other' },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(directProv, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'jobspy',
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [envelopeAdapter],
    policyEdges: [bad],
  });
  assert.equal(r.success, false);
});
test('jobspy wrong target rejects', () => {
  const bad = { ...adapterEdge, target: { kind: 'board' as const, sourceId: 'other' } };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(directProv, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'jobspy',
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [envelopeAdapter],
    policyEdges: [bad],
  });
  assert.equal(r.success, false);
});
test('jobspy wrong operation rejects', () => {
  const bad = { ...adapterEdge, operation: 'employerApi' as const };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(directProv, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'jobspy',
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [envelopeAdapter],
    policyEdges: [bad],
  });
  assert.equal(r.success, false);
});
test('jobspy publisher mismatch rejects', () => {
  const prov = { ...directProv, publisher: { kind: 'board' as const, sourceId: 'other' } };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(prov, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'jobspy',
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [envelopeAdapter],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});
test('manual missing edge rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(manualProv, {
          state: 'manual_content',
          manualImportEdgeRef: 'manual-import',
          userSuppliedContentEdgeRef: 'manual-content-edge',
          manualEvidenceRef: 'ev-manual',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-manual'],
          policyEdgeRefs: ['manual-import'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evManual],
    observations: [envelopeManual],
    policyEdges: [manualImportEdge, manualContentEdge],
  });
  assert.equal(r.success, false);
});
test('manual mismatched donor rejects', () => {
  const prov = {
    ...manualProv,
    contentDonor: {
      kind: 'user' as const,
      namespace: 'user',
      id: 'bob',
      representation: 'user_supplied_content' as const,
    },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(prov, {
          state: 'manual_content',
          manualImportEdgeRef: 'manual-import',
          userSuppliedContentEdgeRef: 'manual-content-edge',
          manualEvidenceRef: 'ev-manual',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-manual'],
          policyEdgeRefs: ['manual-import', 'manual-content-edge'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evManual],
    observations: [envelopeManual],
    policyEdges: [manualImportEdge, manualContentEdge],
  });
  assert.equal(r.success, false);
});
test('manual informational edge rejects', () => {
  const bad = { ...manualContentEdge, effect: 'informational_capability' as const };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(manualProv, {
          state: 'manual_content',
          manualImportEdgeRef: 'manual-import',
          userSuppliedContentEdgeRef: 'manual-content-edge',
          manualEvidenceRef: 'ev-manual',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-manual'],
          policyEdgeRefs: ['manual-import', 'manual-content-edge'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evManual],
    observations: [envelopeManual],
    policyEdges: [manualImportEdge, bad],
  });
  assert.equal(r.success, false);
});
test('manual rejects destination evidence', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(manualProv, {
          state: 'manual_content',
          manualImportEdgeRef: 'manual-import',
          userSuppliedContentEdgeRef: 'manual-content-edge',
          manualEvidenceRef: 'ev-manual',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-manual', 'ev-destination'],
          policyEdgeRefs: ['manual-import', 'manual-content-edge'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evManual, evDestination],
    observations: [envelopeManual],
    policyEdges: [manualImportEdge, manualContentEdge],
  });
  assert.equal(r.success, false);
});
test('adapter rejects provider envelope', () => {
  const badEnv = {
    ...envelopeAdapter,
    acquisition: {
      ...envelopeAdapter.acquisition,
      captureKind: 'destination_fetch' as const,
      fetchEdgeRef: 'adapter-edge',
    },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(directProv, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'jobspy',
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [badEnv as unknown as object],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});
test('indexed-only linked to observation rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [],
    warnings: [],
    evidence: [evIndexed, evDestination],
    observations: [
      {
        ...envelopeDest,
        acquisition: { ...envelopeDest.acquisition, discoveryCandidateIds: ['candidate-1'] },
      },
    ],
    policyEdges: [edgeProvider, fetchEdge],
  });
  assert.equal(r.success, false);
});
test('acquired mismatched listing rejects', () => {
  const badEv = { ...evAdapter, sourceListingId: 'other' };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(directProv, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'jobspy',
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [badEv],
    observations: [envelopeAdapter],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});
test('acquired hash mismatch rejects', () => {
  const badEv = { ...evAdapter, contentHash: 'other' };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(directProv, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'jobspy',
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [badEv],
    observations: [envelopeAdapter],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});
test('manual submitter mismatch rejects', () => {
  const badEv = { ...evManual, submittedBy: { namespace: 'user', id: 'bob' } };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(manualProv, {
          state: 'manual_content',
          manualImportEdgeRef: 'manual-import',
          userSuppliedContentEdgeRef: 'manual-content-edge',
          manualEvidenceRef: 'ev-manual',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-manual'],
          policyEdgeRefs: ['manual-import', 'manual-content-edge'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [badEv],
    observations: [envelopeManual],
    policyEdges: [manualImportEdge, manualContentEdge],
  });
  assert.equal(r.success, false);
});
test('unknown refs reject', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [{ ...baseCandidate(indexedProv, { evidenceRefs: ['missing'] }) }],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider],
  });
  assert.equal(r.success, false);
});
test('wrong capture kind rejects', () => {
  // valid manual envelope but candidate expects adapter -> linkage fails via capture state mismatch
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(directProv, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'jobspy',
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter, evManual],
    observations: [envelopeManual],
    policyEdges: [adapterEdge, manualImportEdge, manualContentEdge],
  });
  assert.equal(r.success, false);
});
test('V1 schema assignable', () => {
  const parsed = AcquisitionSliceResultV1Schema.parse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider],
  });
  const v1: AcquisitionSliceResultV1 = parsed;
  const v: AcquisitionSliceResult = v1;
  assert.equal(v.schemaVersion, '1.0.0');
  assert.equal(AcquisitionSliceResultV1Schema === AcquisitionSliceResultSchema, true);
});
test('coverage counters', () => {
  assert.equal(
    AcquisitionCoverageSchema.safeParse({
      schemaVersion: '1.0.0',
      adapterId: 'seek',
      state: 'succeeded',
      resultState: 'results',
      candidatesProduced: 1,
      logicalRequestsUsed: 1,
      attemptsReserved: 1,
      bytesUsed: 10,
      durationMs: 5,
      policyEdgeRefs: [],
    }).success,
    true,
  );
});
test('all caveats bounded', () => {
  assert.equal(
    DiscoveryEvidenceSchema.safeParse({ ...evIndexed, kind: 'provider_metadata' }).success,
    true,
  );
});
test('duplicate candidate IDs rejected', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv), baseCandidate(indexedProv)],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider],
  });
  assert.equal(r.success, false);
});

// --- Closure tests: exact bounds, duplicates, shared envelope, policy_blocked counters ---
test('candidate evidenceRefs max 32 passes', () => {
  const refs = Array.from({ length: 32 }, (_, i) => `ev-${i}`);
  const evid = refs.map((id) => ({ ...evIndexed, evidenceId: id }));
  // need 32 evidence entries, but we can reuse same evidence kind with distinct ids targeting same URL
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv, { evidenceRefs: refs })],
    coverage: [],
    warnings: [],
    evidence: evid,
    observations: [],
    policyEdges: [edgeProvider],
  });
  assert.equal(r.success, true);
});
test('candidate evidenceRefs 33 rejects', () => {
  const refs = Array.from({ length: 33 }, (_, i) => `ev-${i}`);
  const evid = refs.map((id) => ({ ...evIndexed, evidenceId: id }));
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv, { evidenceRefs: refs })],
    coverage: [],
    warnings: [],
    evidence: evid,
    observations: [],
    policyEdges: [edgeProvider],
  });
  assert.equal(r.success, false);
});
test('candidate evidenceRefs duplicate rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv, { evidenceRefs: ['ev-1', 'ev-1'] })],
    coverage: [],
    warnings: [],
    evidence: [evIndexed, { ...evIndexed, evidenceId: 'ev-1' }],
    observations: [],
    policyEdges: [edgeProvider],
  });
  assert.equal(r.success, false);
});
test('candidate policyEdgeRefs duplicate rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv, { policyEdgeRefs: ['edge-1', 'edge-1'] })],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider],
  });
  assert.equal(r.success, false);
});
test('envelope discoveryCandidateIds empty rejects', () => {
  const bad = {
    ...envelopeAdapter,
    acquisition: { ...envelopeAdapter.acquisition, discoveryCandidateIds: [] as string[] },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(directProv, {
        state: 'adapter_acquired',
        acquisitionEdgeRef: 'adapter-edge',
        adapterEvidenceRef: 'ev-adapter',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-adapter'],
        policyEdgeRefs: ['adapter-edge'],
        adapterId: 'jobspy',
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [bad as unknown as object],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});
test('envelope discoveryCandidateIds 33 rejects', () => {
  const ids = Array.from({ length: 33 }, (_, i) => `candidate-${i}`);
  const bad = {
    ...envelopeAdapter,
    acquisition: { ...envelopeAdapter.acquisition, discoveryCandidateIds: ids },
  };
  // need candidates matching ids but we test envelope validation via safeParse rejecting envelope itself
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(directProv, {
        state: 'adapter_acquired',
        acquisitionEdgeRef: 'adapter-edge',
        adapterEvidenceRef: 'ev-adapter',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-adapter'],
        policyEdgeRefs: ['adapter-edge'],
        adapterId: 'jobspy',
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [bad as unknown as object],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});
test('envelope evidenceRefs 32 acquired refs consistent passes', () => {
  const ids = Array.from({ length: 32 }, (_, i) => `ev-${i}`);
  const evidence = ids.map((id) => ({
    ...evAdapter,
    evidenceId: id,
    contentHash: envelopeAdapter.observation.contentHash,
    sourceListingId: envelopeAdapter.listing.sourceListingId,
    observationId: envelopeAdapter.observation.observationId,
  }));
  const envelope = {
    ...envelopeAdapter,
    observation: { ...envelopeAdapter.observation, evidenceRefs: [...ids] },
    acquisition: { ...envelopeAdapter.acquisition, evidenceRefs: [...ids] },
  };
  const candidate = baseCandidate(directProv, {
    state: 'adapter_acquired',
    acquisitionEdgeRef: 'adapter-edge',
    adapterEvidenceRef: ids[0],
    observationEnvelopeRef: 'envelope-1',
    evidenceRefs: [...ids],
    policyEdgeRefs: ['adapter-edge'],
    adapterId: 'jobspy',
  });
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [candidate],
    coverage: [],
    warnings: [],
    evidence,
    observations: [envelope],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, true);
});

test('envelope evidenceRefs 33 rejects', () => {
  const ids = Array.from({ length: 33 }, (_, i) => `ev-${i}`);
  const evidence = ids.map((id) => ({
    ...evAdapter,
    evidenceId: id,
    contentHash: envelopeAdapter.observation.contentHash,
    sourceListingId: envelopeAdapter.listing.sourceListingId,
    observationId: envelopeAdapter.observation.observationId,
  }));
  const envelope = {
    ...envelopeAdapter,
    observation: { ...envelopeAdapter.observation, evidenceRefs: [...ids] },
    acquisition: { ...envelopeAdapter.acquisition, evidenceRefs: [...ids] },
  };
  const candidate = baseCandidate(directProv, {
    state: 'adapter_acquired',
    acquisitionEdgeRef: 'adapter-edge',
    adapterEvidenceRef: ids[0],
    observationEnvelopeRef: 'envelope-1',
    evidenceRefs: [...ids],
    policyEdgeRefs: ['adapter-edge'],
    adapterId: 'jobspy',
  });
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [candidate],
    coverage: [],
    warnings: [],
    evidence,
    observations: [envelope],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});
test('shared envelope compatible candidates allowed', () => {
  const c1 = baseCandidate(directProv, {
    candidateId: 'candidate-1',
    state: 'adapter_acquired',
    acquisitionEdgeRef: 'adapter-edge',
    adapterEvidenceRef: 'ev-adapter',
    observationEnvelopeRef: 'envelope-1',
    evidenceRefs: ['ev-adapter'],
    policyEdgeRefs: ['adapter-edge'],
    adapterId: 'jobspy',
  });
  const c2 = baseCandidate(directProv, {
    candidateId: 'candidate-2',
    state: 'adapter_acquired',
    acquisitionEdgeRef: 'adapter-edge',
    adapterEvidenceRef: 'ev-adapter',
    observationEnvelopeRef: 'envelope-1',
    evidenceRefs: ['ev-adapter'],
    policyEdgeRefs: ['adapter-edge'],
    adapterId: 'jobspy',
  });
  const sharedEnv = {
    ...envelopeAdapter,
    acquisition: {
      ...envelopeAdapter.acquisition,
      discoveryCandidateIds: ['candidate-1', 'candidate-2'],
    },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [c1, c2],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [sharedEnv as unknown as object],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, true);
});
test('shared envelope divergence fetchEdge mismatch rejects', () => {
  const c1 = baseCandidate(indexedProv, {
    candidateId: 'candidate-1',
    state: 'destination_fetched',
    fetchEdgeRef: 'fetch-edge',
    destinationEvidenceRef: 'ev-destination',
    observationEnvelopeRef: 'envelope-1',
    evidenceRefs: ['ev-1', 'ev-destination'],
    policyEdgeRefs: ['edge-1', 'fetch-edge'],
  });
  const otherFetch = {
    ...fetchEdge,
    edgeId: 'fetch-edge-2',
    target: {
      kind: 'publisher' as const,
      sourceId: 'publisher',
      normalizedHost: 'jobs.example.test',
    },
  };
  const c2 = baseCandidate(indexedProv, {
    candidateId: 'candidate-2',
    state: 'destination_fetched',
    fetchEdgeRef: 'fetch-edge-2',
    destinationEvidenceRef: 'ev-destination',
    observationEnvelopeRef: 'envelope-1',
    evidenceRefs: ['ev-1', 'ev-destination'],
    policyEdgeRefs: ['edge-1', 'fetch-edge-2'],
  });
  const sharedEnv = {
    ...envelopeDest,
    acquisition: {
      ...envelopeDest.acquisition,
      discoveryCandidateIds: ['candidate-1', 'candidate-2'],
    },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [c1, c2],
    coverage: [],
    warnings: [],
    evidence: [evIndexed, evDestination],
    observations: [sharedEnv as unknown as object],
    policyEdges: [edgeProvider, fetchEdge, otherFetch],
  });
  assert.equal(r.success, false);
});
test('policy_blocked requires unknown resultState', () => {
  const r = AcquisitionCoverageSchema.safeParse({
    schemaVersion: '1.0.0',
    adapterId: 'seek',
    state: 'policy_blocked',
    resultState: 'results',
    candidatesProduced: 0,
    logicalRequestsUsed: 0,
    attemptsReserved: 0,
    bytesUsed: 0,
    durationMs: 5,
    policyEdgeRefs: ['edge-1'],
  });
  assert.equal(r.success, false);
});
test('policy_blocked zero candidates fails when candidatesProduced >0', () => {
  const r = AcquisitionCoverageSchema.safeParse({
    schemaVersion: '1.0.0',
    adapterId: 'seek',
    state: 'policy_blocked',
    resultState: 'unknown',
    candidatesProduced: 1,
    logicalRequestsUsed: 0,
    attemptsReserved: 0,
    bytesUsed: 0,
    durationMs: 5,
    policyEdgeRefs: ['edge-1'],
  });
  assert.equal(r.success, false);
});
test('policy_blocked zero requests fails when logicalRequestsUsed >0', () => {
  const r = AcquisitionCoverageSchema.safeParse({
    schemaVersion: '1.0.0',
    adapterId: 'seek',
    state: 'policy_blocked',
    resultState: 'unknown',
    candidatesProduced: 0,
    logicalRequestsUsed: 1,
    attemptsReserved: 0,
    bytesUsed: 0,
    durationMs: 5,
    policyEdgeRefs: ['edge-1'],
  });
  assert.equal(r.success, false);
});
test('policy_blocked zero reservations fails when attemptsReserved >0', () => {
  const r = AcquisitionCoverageSchema.safeParse({
    schemaVersion: '1.0.0',
    adapterId: 'seek',
    state: 'policy_blocked',
    resultState: 'unknown',
    candidatesProduced: 0,
    logicalRequestsUsed: 0,
    attemptsReserved: 1,
    bytesUsed: 0,
    durationMs: 5,
    policyEdgeRefs: ['edge-1'],
  });
  assert.equal(r.success, false);
});
test('policy_blocked zero bytes fails when bytesUsed >0', () => {
  const r = AcquisitionCoverageSchema.safeParse({
    schemaVersion: '1.0.0',
    adapterId: 'seek',
    state: 'policy_blocked',
    resultState: 'unknown',
    candidatesProduced: 0,
    logicalRequestsUsed: 0,
    attemptsReserved: 0,
    bytesUsed: 10,
    durationMs: 5,
    policyEdgeRefs: ['edge-1'],
  });
  assert.equal(r.success, false);
});
test('policy_blocked requires at least one policy edge ref', () => {
  const r = AcquisitionCoverageSchema.safeParse({
    schemaVersion: '1.0.0',
    adapterId: 'seek',
    state: 'policy_blocked',
    resultState: 'unknown',
    candidatesProduced: 0,
    logicalRequestsUsed: 0,
    attemptsReserved: 0,
    bytesUsed: 0,
    durationMs: 5,
    policyEdgeRefs: [],
  });
  assert.equal(r.success, false);
});

test('version exported', () => {
  assert.equal(ACQUISITION_CONTRACT_VERSION, '1.0.0');
});

// --- P1 repro and positive coverage ---
const indexedWithPublisher = {
  ...indexedProv,
  publisher: { kind: 'publisher' as const, sourceId: 'acme' },
};
const fetchEdgePublisherAcme = {
  ...fetchEdge,
  target: { kind: 'publisher' as const, sourceId: 'acme', normalizedHost: 'jobs.example.test' },
};
const fetchEdgeWrongPublisher = {
  ...fetchEdge,
  target: { kind: 'publisher' as const, sourceId: 'wrong', normalizedHost: 'other.test' },
};
const fetchEdgeHostOnly = {
  ...fetchEdge,
  target: { kind: 'ats_tenant' as const, sourceId: 'other', normalizedHost: 'jobs.example.test' },
};
const fetchEdgeAdapterTarget = {
  ...fetchEdge,
  target: { kind: 'adapter' as const, sourceId: 'seek' },
};
const fetchEdgeDiscoveryTarget = {
  ...fetchEdge,
  target: { kind: 'discovery_provider' as const, sourceId: 'exa' },
};

test('fetch edge wrong publisher and host rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(indexedWithPublisher, {
        state: 'fetch_eligible',
        fetchEdgeRef: 'fetch-edge',
        policyEdgeRefs: ['edge-1', 'fetch-edge'],
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, fetchEdgeWrongPublisher],
  });
  assert.equal(r.success, false);
});

test('fetch edge wrong host when publisher absent rejects', () => {
  const bad = {
    ...fetchEdge,
    target: { kind: 'publisher' as const, sourceId: 'publisher', normalizedHost: 'evil.test' },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(indexedProv, {
        state: 'fetch_eligible',
        fetchEdgeRef: 'fetch-edge',
        policyEdgeRefs: ['edge-1', 'fetch-edge'],
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, bad],
  });
  assert.equal(r.success, false);
});

test('fetch edge adapter target rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(indexedProv, {
        state: 'fetch_eligible',
        fetchEdgeRef: 'fetch-edge',
        policyEdgeRefs: ['edge-1', 'fetch-edge'],
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, fetchEdgeAdapterTarget],
  });
  assert.equal(r.success, false);
});

test('fetch edge discovery target rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(indexedProv, {
        state: 'fetch_eligible',
        fetchEdgeRef: 'fetch-edge',
        policyEdgeRefs: ['edge-1', 'fetch-edge'],
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, fetchEdgeDiscoveryTarget],
  });
  assert.equal(r.success, false);
});

test('fetch edge publisher match passes', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(indexedWithPublisher, {
        state: 'fetch_eligible',
        fetchEdgeRef: 'fetch-edge',
        policyEdgeRefs: ['edge-1', 'fetch-edge'],
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, fetchEdgePublisherAcme],
  });
  assert.equal(r.success, true);
});

test('fetch edge host match passes when publisher absent', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(indexedProv, {
        state: 'fetch_eligible',
        fetchEdgeRef: 'fetch-edge',
        policyEdgeRefs: ['edge-1', 'fetch-edge'],
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, fetchEdgeHostOnly],
  });
  assert.equal(r.success, true);
});

test('direct adapter publisher kind passes with ats_tenant', () => {
  const prov = {
    ...directProv,
    discoverer: { ...directProv.discoverer, adapterId: 'greenhouse' },
    contentDonor: {
      kind: 'adapter' as const,
      adapterId: 'greenhouse',
      representation: 'adapter_listing' as const,
    },
    publisher: { kind: 'ats_tenant' as const, sourceId: 'greenhouse-ats' },
  };
  const ev = { ...evAdapter, adapterId: 'greenhouse', publisherSourceId: 'greenhouse-ats' };
  const edge = {
    ...adapterEdge,
    actor: { kind: 'adapter' as const, namespace: 'adapter', id: 'greenhouse' },
    target: { kind: 'ats_tenant' as const, sourceId: 'greenhouse-ats' },
  };
  const env = {
    ...envelopeAdapter,
    acquisition: {
      ...envelopeAdapter.acquisition,
      publisherSourceId: 'greenhouse-ats',
      adapterId: 'greenhouse',
    },
    listing: { ...envelopeAdapter.listing, adapterId: 'greenhouse' },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(prov, {
        state: 'adapter_acquired',
        acquisitionEdgeRef: 'adapter-edge',
        adapterEvidenceRef: 'ev-adapter',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-adapter'],
        policyEdgeRefs: ['adapter-edge'],
        adapterId: 'greenhouse',
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [ev],
    observations: [env],
    policyEdges: [edge],
  });
  assert.equal(r.success, true);
});

test('direct adapter custom namespace passes', () => {
  const prov = { ...directProv, publisher: { kind: 'publisher' as const, sourceId: 'acme' } };
  const ev = { ...evAdapter, adapterId: 'custom-adapter', publisherSourceId: 'acme' };
  const edge = {
    ...adapterEdge,
    actor: { kind: 'adapter' as const, namespace: 'custom-ns', id: 'custom-adapter' },
    target: { kind: 'publisher' as const, sourceId: 'acme' },
  };
  const env = {
    ...envelopeAdapter,
    acquisition: {
      ...envelopeAdapter.acquisition,
      publisherSourceId: 'acme',
      adapterId: 'custom-adapter',
    },
    listing: { ...envelopeAdapter.listing, adapterId: 'custom-adapter' },
  };
  const prov2 = {
    ...prov,
    discoverer: { ...prov.discoverer, adapterId: 'custom-adapter' },
    contentDonor: {
      kind: 'adapter' as const,
      adapterId: 'custom-adapter',
      representation: 'adapter_listing' as const,
    },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(prov2, {
        state: 'adapter_acquired',
        acquisitionEdgeRef: 'adapter-edge',
        adapterEvidenceRef: 'ev-adapter',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-adapter'],
        policyEdgeRefs: ['adapter-edge'],
        adapterId: 'custom-adapter',
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [ev],
    observations: [env],
    policyEdges: [edge],
  });
  assert.equal(r.success, true);
});

test('direct adapter employerApi passes', () => {
  const prov = {
    ...directProv,
    discoverer: { ...directProv.discoverer, operation: 'employerApi' as const },
  };
  const edge = { ...adapterEdge, operation: 'employerApi' as const };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(prov, {
        state: 'adapter_acquired',
        acquisitionEdgeRef: 'adapter-edge',
        adapterEvidenceRef: 'ev-adapter',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-adapter'],
        policyEdgeRefs: ['adapter-edge'],
        adapterId: 'jobspy',
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [envelopeAdapter],
    policyEdges: [edge],
  });
  assert.equal(r.success, true);
});

test('direct adapter target kind mismatch rejects', () => {
  const prov = { ...directProv, publisher: { kind: 'publisher' as const, sourceId: 'acme' } };
  const edge = { ...adapterEdge, target: { kind: 'board' as const, sourceId: 'acme' } };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(prov, {
        state: 'adapter_acquired',
        acquisitionEdgeRef: 'adapter-edge',
        adapterEvidenceRef: 'ev-adapter',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-adapter'],
        policyEdgeRefs: ['adapter-edge'],
        adapterId: 'jobspy',
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [{ ...evAdapter, publisherSourceId: 'acme' }],
    observations: [
      {
        ...envelopeAdapter,
        acquisition: { ...envelopeAdapter.acquisition, publisherSourceId: 'acme' },
      } as unknown as object,
    ],
    policyEdges: [edge],
  });
  assert.equal(r.success, false);
});

test('manual target kind mismatch rejects', () => {
  const badImp = { ...manualImportEdge, target: { kind: 'adapter' as const, sourceId: 'acme' } };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(manualProv, {
        state: 'manual_content',
        manualImportEdgeRef: 'manual-import',
        userSuppliedContentEdgeRef: 'manual-content-edge',
        manualEvidenceRef: 'ev-manual',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-manual'],
        policyEdgeRefs: ['manual-import', 'manual-content-edge'],
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evManual],
    observations: [envelopeManual],
    policyEdges: [badImp, manualContentEdge],
  });
  assert.equal(r.success, false);
});

test('observation unknown evidence ref rejects', () => {
  const badEnv = {
    ...envelopeAdapter,
    observation: { ...envelopeAdapter.observation, evidenceRefs: ['missing'] },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(directProv, {
        state: 'adapter_acquired',
        acquisitionEdgeRef: 'adapter-edge',
        adapterEvidenceRef: 'ev-adapter',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-adapter'],
        policyEdgeRefs: ['adapter-edge'],
        adapterId: 'jobspy',
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [badEnv as unknown as object],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});

test('observation provider evidence for adapter rejects', () => {
  const badEnv = {
    ...envelopeAdapter,
    observation: { ...envelopeAdapter.observation, evidenceRefs: ['ev-1'] },
    acquisition: { ...envelopeAdapter.acquisition, evidenceRefs: ['ev-1'] },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(directProv, {
        state: 'adapter_acquired',
        acquisitionEdgeRef: 'adapter-edge',
        adapterEvidenceRef: 'ev-adapter',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-adapter'],
        policyEdgeRefs: ['adapter-edge'],
        adapterId: 'jobspy',
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter, evIndexed],
    observations: [badEnv as unknown as object],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});

test('envelope publisherSourceId mismatch rejects', () => {
  const badEnv = {
    ...envelopeAdapter,
    acquisition: { ...envelopeAdapter.acquisition, publisherSourceId: 'other' },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(directProv, {
        state: 'adapter_acquired',
        acquisitionEdgeRef: 'adapter-edge',
        adapterEvidenceRef: 'ev-adapter',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-adapter'],
        policyEdgeRefs: ['adapter-edge'],
        adapterId: 'jobspy',
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [badEnv as unknown as object],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});

test('listing adapterId mismatch rejects', () => {
  const badEnv = {
    ...envelopeAdapter,
    listing: { ...envelopeAdapter.listing, adapterId: 'other' },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(directProv, {
        state: 'adapter_acquired',
        acquisitionEdgeRef: 'adapter-edge',
        adapterEvidenceRef: 'ev-adapter',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-adapter'],
        policyEdgeRefs: ['adapter-edge'],
        adapterId: 'jobspy',
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [badEnv as unknown as object],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});

test('indexed_only with destination evidence rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv, { evidenceRefs: ['ev-1', 'ev-destination'] })],
    coverage: [],
    warnings: [],
    evidence: [evIndexed, evDestination],
    observations: [],
    policyEdges: [edgeProvider],
  });
  assert.equal(r.success, false);
});

test('destination_fetched with adapter evidence rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(indexedProv, {
          state: 'destination_fetched',
          fetchEdgeRef: 'fetch-edge',
          destinationEvidenceRef: 'ev-destination',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-1', 'ev-destination', 'ev-adapter'],
          policyEdgeRefs: ['edge-1', 'fetch-edge'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed, evDestination, evAdapter],
    observations: [envelopeDest],
    policyEdges: [edgeProvider, fetchEdge],
  });
  assert.equal(r.success, false);
});

test('adapter_acquired with provider evidence rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(directProv, {
        state: 'adapter_acquired',
        acquisitionEdgeRef: 'adapter-edge',
        adapterEvidenceRef: 'ev-adapter',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-adapter', 'ev-1'],
        policyEdgeRefs: ['adapter-edge'],
        adapterId: 'jobspy',
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter, evIndexed],
    observations: [envelopeAdapter],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});

test('manual_content with provider evidence rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(manualProv, {
        state: 'manual_content',
        manualImportEdgeRef: 'manual-import',
        userSuppliedContentEdgeRef: 'manual-content-edge',
        manualEvidenceRef: 'ev-manual',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-manual', 'ev-1'],
        policyEdgeRefs: ['manual-import', 'manual-content-edge'],
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evManual, evIndexed],
    observations: [envelopeManual],
    policyEdges: [manualImportEdge, manualContentEdge],
  });
  assert.equal(r.success, false);
});

test('envelope evidence not in observation rejects', () => {
  const badEnv = {
    ...envelopeAdapter,
    observation: { ...envelopeAdapter.observation, evidenceRefs: [] },
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      baseCandidate(directProv, {
        state: 'adapter_acquired',
        acquisitionEdgeRef: 'adapter-edge',
        adapterEvidenceRef: 'ev-adapter',
        observationEnvelopeRef: 'envelope-1',
        evidenceRefs: ['ev-adapter'],
        policyEdgeRefs: ['adapter-edge'],
        adapterId: 'jobspy',
      }),
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [badEnv as unknown as object],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});

test('nested envelope hostile >32 evidenceRefs short-circuits before indexed getter traversal', () => {
  const hostile = Array.from({ length: 33 }, (_, i) => `ev-${i}`) as string[];
  let accessed = false;
  Object.defineProperty(hostile, '0', {
    configurable: true,
    enumerable: true,
    get() {
      accessed = true;
      throw new Error('trap');
    },
  });
  const hostileObservation = {
    ...envelopeAdapter.observation,
    evidenceRefs: hostile as unknown as string[],
  };
  const hostileEnvelope = { ...envelopeAdapter, observation: hostileObservation };
  const res = AcquiredObservationEnvelopeSchema.safeParse(hostileEnvelope as unknown as object);
  assert.equal(res.success, false);
  assert.equal(accessed, false);
});

test('nested envelope hostile parse throws without trap', () => {
  const hostile = Array.from({ length: 33 }, (_, i) => `ev-${i}`) as string[];
  let accessed = false;
  Object.defineProperty(hostile, '0', {
    configurable: true,
    enumerable: true,
    get() {
      accessed = true;
      throw new Error('trap');
    },
  });
  const hostileObservation = {
    ...envelopeAdapter.observation,
    evidenceRefs: hostile as unknown as string[],
  };
  const hostileEnvelope = { ...envelopeAdapter, observation: hostileObservation };
  assert.throws(() =>
    AcquiredObservationEnvelopeSchema.parse(hostileEnvelope as unknown as object),
  );
  assert.equal(accessed, false);
});

test('destination_fetched missing envelope rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(indexedProv, {
          state: 'destination_fetched',
          fetchEdgeRef: 'fetch-edge',
          destinationEvidenceRef: 'ev-destination',
          observationEnvelopeRef: 'missing',
          evidenceRefs: ['ev-1', 'ev-destination'],
          policyEdgeRefs: ['edge-1', 'fetch-edge'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evIndexed, evDestination],
    observations: [],
    policyEdges: [edgeProvider, fetchEdge],
  });
  assert.equal(r.success, false);
});

test('adapter_acquired missing envelope rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(directProv, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'missing',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'jobspy',
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evAdapter],
    observations: [],
    policyEdges: [adapterEdge],
  });
  assert.equal(r.success, false);
});

test('manual_content missing envelope rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(manualProv, {
          state: 'manual_content',
          manualImportEdgeRef: 'manual-import',
          userSuppliedContentEdgeRef: 'manual-content-edge',
          manualEvidenceRef: 'ev-manual',
          observationEnvelopeRef: 'missing',
          evidenceRefs: ['ev-manual'],
          policyEdgeRefs: ['manual-import', 'manual-content-edge'],
        }),
      },
    ],
    coverage: [],
    warnings: [],
    evidence: [evManual],
    observations: [],
    policyEdges: [manualImportEdge, manualContentEdge],
  });
  assert.equal(r.success, false);
});

test('missing envelope does not throw', () => {
  let threw = false;
  try {
    AcquisitionSliceResultSchema.safeParse({
      schemaVersion: '1.0.0',
      runId: 'run-1',
      sliceId: 'slice-1',
      candidates: [
        {
          ...baseCandidate(directProv, {
            state: 'adapter_acquired',
            acquisitionEdgeRef: 'adapter-edge',
            adapterEvidenceRef: 'ev-adapter',
            observationEnvelopeRef: 'missing',
            evidenceRefs: ['ev-adapter'],
            policyEdgeRefs: ['adapter-edge'],
            adapterId: 'jobspy',
          }),
        },
      ],
      coverage: [],
      warnings: [],
      evidence: [evAdapter],
      observations: [],
      policyEdges: [adapterEdge],
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
});

function hostileLenOne(): string[] {
  const a = Array.from({ length: 1 }, (_, i) => `ev-${i}`) as string[];
  Object.defineProperty(a, '0', {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error('trap len1');
    },
  });
  return a;
}

test('nested envelope hostile length-1 evidenceRefs safeParse never throws', () => {
  const hostile = hostileLenOne();
  const hostileObservation = {
    ...envelopeAdapter.observation,
    evidenceRefs: hostile as unknown as string[],
  };
  const hostileEnvelope = { ...envelopeAdapter, observation: hostileObservation };
  let threw = false;
  let res: ReturnType<typeof AcquiredObservationEnvelopeSchema.safeParse> | undefined;
  try {
    res = AcquiredObservationEnvelopeSchema.safeParse(hostileEnvelope as unknown as object);
  } catch (e) {
    threw = true;
    assert.equal((e as Error).message.includes('trap'), false);
  }
  assert.equal(threw, false);
  assert.equal(res?.success, false);
  if (res && !res.success) assert.equal(JSON.stringify(res.error.issues).includes('trap'), false);
});

test('nested envelope hostile length-1 parse throws ZodError not attacker', () => {
  const hostile = hostileLenOne();
  const hostileObservation = {
    ...envelopeAdapter.observation,
    evidenceRefs: hostile as unknown as string[],
  };
  const hostileEnvelope = { ...envelopeAdapter, observation: hostileObservation };
  assert.throws(
    () => AcquiredObservationEnvelopeSchema.parse(hostileEnvelope as unknown as object),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.constructor.name, 'ZodError');
      assert.equal((e as Error).message.includes('trap'), false);
      return true;
    },
  );
});

test('slice with nested hostile length-1 envelope safeParse never throws', () => {
  const hostile = hostileLenOne();
  const hostileObservation = {
    ...envelopeAdapter.observation,
    evidenceRefs: hostile as unknown as string[],
  };
  const hostileEnvelope = { ...envelopeAdapter, observation: hostileObservation };
  let threw = false;
  let res: ReturnType<typeof AcquisitionSliceResultSchema.safeParse> | undefined;
  try {
    res = AcquisitionSliceResultSchema.safeParse({
      schemaVersion: '1.0.0',
      runId: 'run-1',
      sliceId: 'slice-1',
      candidates: [
        baseCandidate(directProv, {
          state: 'adapter_acquired',
          acquisitionEdgeRef: 'adapter-edge',
          adapterEvidenceRef: 'ev-adapter',
          observationEnvelopeRef: 'envelope-1',
          evidenceRefs: ['ev-adapter'],
          policyEdgeRefs: ['adapter-edge'],
          adapterId: 'jobspy',
        }),
      ],
      coverage: [],
      warnings: [],
      evidence: [evAdapter],
      observations: [hostileEnvelope as unknown as object],
      policyEdges: [adapterEdge],
    });
  } catch (e) {
    threw = true;
    assert.equal((e as Error).message.includes('trap'), false);
  }
  assert.equal(threw, false);
  assert.equal(res?.success, false);
});

// --- W3-A policy_blocked coverage refinement ---
function coverageBlockedAuth(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0' as const,
    adapterId: 'seek',
    state: 'policy_blocked' as const,
    resultState: 'unknown' as const,
    candidatesProduced: 0,
    logicalRequestsUsed: 0,
    attemptsReserved: 0,
    bytesUsed: 0,
    durationMs: 5,
    policyEdgeRefs: ['blocked-auth'],
    ...overrides,
  };
}
const blockedAuthEdge = {
  ...edgeProvider,
  edgeId: 'blocked-auth',
  state: 'blocked' as const,
  effect: 'authorized_operation' as const,
  route: 'direct' as const,
  target: { kind: 'board' as const, sourceId: 'seek' },
};
const blockedInfoEdge = {
  ...edgeProvider,
  edgeId: 'blocked-info',
  state: 'blocked' as const,
  effect: 'informational_capability' as const,
  route: 'direct' as const,
  target: { kind: 'publisher' as const, sourceId: 'unknown' },
};
test('policy_blocked coverage permitted authorized only rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [coverageBlockedAuth({ policyEdgeRefs: ['edge-1'] })],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider],
  });
  assert.equal(r.success, false);
});

test('policy_blocked coverage blocked informational only rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [coverageBlockedAuth({ policyEdgeRefs: ['blocked-info'] })],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, blockedInfoEdge],
  });
  assert.equal(r.success, false);
});

test('policy_blocked coverage blocked authorized accepts', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [coverageBlockedAuth()],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, blockedAuthEdge],
  });
  assert.equal(r.success, true);
});

test('policy_blocked coverage blocked authorized plus permitted and blocked informational accepts', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [
      coverageBlockedAuth({
        policyEdgeRefs: ['blocked-auth', 'edge-1', 'blocked-info'],
      }),
    ],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, blockedAuthEdge, blockedInfoEdge],
  });
  assert.equal(r.success, true);
});

test('policy_blocked coverage requires_configuration rejects', () => {
  const e = {
    ...edgeProvider,
    edgeId: 'req-config',
    state: 'requires_configuration' as const,
    effect: 'authorized_operation' as const,
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [coverageBlockedAuth({ policyEdgeRefs: ['req-config'] })],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, e],
  });
  assert.equal(r.success, false);
});

test('policy_blocked coverage requires_review rejects', () => {
  const e = {
    ...edgeProvider,
    edgeId: 'req-review',
    state: 'requires_review' as const,
    effect: 'authorized_operation' as const,
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [coverageBlockedAuth({ policyEdgeRefs: ['req-review'] })],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, e],
  });
  assert.equal(r.success, false);
});

test('policy_blocked coverage not_supported rejects', () => {
  const e = {
    ...edgeProvider,
    edgeId: 'not-sup',
    state: 'not_supported' as const,
    effect: 'authorized_operation' as const,
  };
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [coverageBlockedAuth({ policyEdgeRefs: ['not-sup'] })],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, e],
  });
  assert.equal(r.success, false);
});

test('indexed candidate survives alongside blocked informational publisher and unrelated direct blocked coverage', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [
      {
        ...baseCandidate(indexedProv, {
          policyEdgeRefs: ['edge-1', 'blocked-info'],
          caveats: ['direct_search_blocked'],
        }),
      },
    ],
    coverage: [coverageBlockedAuth({ adapterId: 'greenhouse', policyEdgeRefs: ['blocked-auth'] })],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, blockedInfoEdge, blockedAuthEdge],
  });
  assert.equal(r.success, true);
});

test('W3-A policy_blocked coverage unresolved policy ref rejects', () => {
  const r = AcquisitionSliceResultSchema.safeParse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    candidates: [baseCandidate(indexedProv)],
    coverage: [coverageBlockedAuth({ policyEdgeRefs: ['blocked-auth', 'missing'] })],
    warnings: [],
    evidence: [evIndexed],
    observations: [],
    policyEdges: [edgeProvider, blockedAuthEdge],
  });
  assert.equal(r.success, false);
});
