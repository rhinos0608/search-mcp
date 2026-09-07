import { z } from 'zod/v4';
import {
  AcquisitionCandidateIdSchema,
  AcquisitionEdgeIdSchema,
  AcquisitionRunIdSchema,
  AcquisitionSliceIdSchema,
  DiscoveryEvidenceIdSchema,
} from './ids.js';
import { InstantSchema, SourceListingSchema, SourceObservationSchema } from '../domain/index.js';
/* eslint-disable @typescript-eslint/no-unnecessary-condition -- discriminated unions require safe kind checks */

export const ACQUISITION_CONTRACT_VERSION = '1.0.0' as const;
const text = (max: number) => z.string().trim().min(1).max(max);
const url = z.url().max(8192);
const caveat = z.enum([
  'provider_index_only',
  'publisher_not_fetched',
  'direct_search_blocked',
  'destination_fetch_blocked',
  'direct_access_not_permitted',
  'publisher_policy_unknown',
  'provider_generated_summary',
  'stale_index_possible',
  'content_required',
  'unverified_manual_content',
]);
export const AcquisitionCaveatSchema = caveat;
export type AcquisitionCaveat = z.infer<typeof caveat>;

export const AcquisitionPolicyStateSchema = z.enum([
  'permitted',
  'blocked',
  'requires_configuration',
  'requires_review',
  'not_supported',
]);
export type AcquisitionPolicyState = z.infer<typeof AcquisitionPolicyStateSchema>;
export const AcquisitionActorSchema = z
  .object({
    kind: z.enum(['provider', 'adapter', 'user', 'system']),
    namespace: text(128),
    id: text(256),
  })
  .strict();
export type AcquisitionActor = z.infer<typeof AcquisitionActorSchema>;
export const AcquisitionOperationSchema = z.enum([
  'automatedSearch',
  'automatedFetch',
  'userSuppliedContent',
  'manualImport',
  'employerApi',
]);
export const AcquisitionRouteSchema = z.enum(['direct', 'indexed', 'user_supplied']);
export const PolicyTargetSchema = z
  .object({
    kind: z.enum(['discovery_provider', 'publisher', 'board', 'adapter', 'ats_tenant']),
    sourceId: text(256),
    normalizedHost: text(253).optional(),
  })
  .strict();
export type PolicyTarget = z.infer<typeof PolicyTargetSchema>;
export const PolicyTargetV1Schema = PolicyTargetSchema;
export type PolicyTargetV1 = PolicyTarget;

export const AcquisitionPolicyEdgeSchema = z
  .object({
    edgeId: AcquisitionEdgeIdSchema,
    schemaVersion: z.literal(ACQUISITION_CONTRACT_VERSION),
    actor: AcquisitionActorSchema,
    operation: AcquisitionOperationSchema,
    route: AcquisitionRouteSchema,
    target: PolicyTargetSchema,
    state: AcquisitionPolicyStateSchema,
    effect: z.enum(['authorized_operation', 'informational_capability']),
    revision: text(256),
    evidenceRefs: z.array(text(256)).max(100),
    reviewedAt: InstantSchema,
    notes: text(2048).optional(),
  })
  .strict();
export const AcquisitionPolicyEdgeV1Schema = AcquisitionPolicyEdgeSchema;
export type AcquisitionPolicyEdge = z.infer<typeof AcquisitionPolicyEdgeSchema>;
export type AcquisitionPolicyEdgeV1 = AcquisitionPolicyEdge;

export const ProviderGovernanceSchema = z
  .object({
    schemaVersion: z.literal(ACQUISITION_CONTRACT_VERSION),
    providerId: text(256),
    sourcePolicyId: text(256),
    mode: z.literal('automatedSearch'),
    queryHandling: z.enum(['raw', 'redacted', 'blocked']),
    resultRetention: z.enum(['ephemeral', 'bounded_cache', 'metadata_only']),
    sendsQueryOffDevice: z.boolean(),
    supportsUrlAttributedSummary: z.boolean(),
    supportsStrictSafeSearch: z.boolean(),
    maxResultsPerRequest: z.number().int().positive().max(1000),
    maxAttempts: z.number().int().positive().max(100),
    evidenceRefs: z.array(text(256)).max(100),
  })
  .strict();
export const ProviderGovernanceV1Schema = ProviderGovernanceSchema;
export type ProviderGovernance = z.infer<typeof ProviderGovernanceSchema>;
export type ProviderGovernanceV1 = ProviderGovernance;

const indexedProvenance = z
  .object({
    kind: z.literal('indexed_discovery'),
    schemaVersion: z.literal(ACQUISITION_CONTRACT_VERSION),
    discoverers: z
      .array(
        z
          .object({
            providerId: text(256),
            providerResultId: text(256).optional(),
            rank: z.number().int().nonnegative().max(1_000_000),
            queryVariantId: text(256),
            upstreamEngines: z.array(text(128)).max(32).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    contentDonor: z
      .object({
        kind: z.literal('provider'),
        providerId: text(256),
        representation: z.enum([
          'indexed_snippet',
          'provider_generated_summary',
          'provider_metadata',
        ]),
      })
      .strict(),
    publisher: z
      .object({
        kind: z.enum(['publisher', 'board', 'ats_tenant']),
        sourceId: text(256),
      })
      .strict()
      .optional(),
    destination: z
      .object({
        rawUrl: url,
        canonicalUrl: url,
        normalizedHost: text(253),
      })
      .strict(),
    capturedAt: InstantSchema,
  })
  .strict();

const directAdapterProvenance = z
  .object({
    kind: z.literal('direct_adapter'),
    schemaVersion: z.literal(ACQUISITION_CONTRACT_VERSION),
    discoverer: z
      .object({
        adapterId: text(256),
        adapterResultId: text(256).optional(),
        rank: z.number().int().nonnegative().max(1_000_000),
        queryVariantId: text(256),
        operation: z.enum(['automatedSearch', 'employerApi']),
      })
      .strict(),
    contentDonor: z
      .object({
        kind: z.literal('adapter'),
        adapterId: text(256),
        representation: z.literal('adapter_listing'),
      })
      .strict(),
    publisher: z
      .object({
        kind: z.enum(['publisher', 'board', 'ats_tenant']),
        sourceId: text(256),
      })
      .strict(),
    destination: z
      .object({
        rawUrl: url.optional(),
        canonicalUrl: url,
        normalizedHost: text(253),
      })
      .strict()
      .optional(),
    capturedAt: InstantSchema,
  })
  .strict();

const manualProvenance = z
  .object({
    kind: z.literal('manual_content'),
    schemaVersion: z.literal(ACQUISITION_CONTRACT_VERSION),
    contentDonor: z
      .object({
        kind: z.literal('user'),
        namespace: text(128),
        id: text(256),
        representation: z.literal('user_supplied_content'),
      })
      .strict(),
    publisher: z
      .object({
        kind: z.enum(['publisher', 'board', 'ats_tenant']),
        sourceId: text(256),
      })
      .strict()
      .optional(),
    destination: z
      .object({
        rawUrl: url.optional(),
        canonicalUrl: url,
        normalizedHost: text(253),
      })
      .strict()
      .optional(),
    capturedAt: InstantSchema,
  })
  .strict();

export const AcquisitionProvenanceV1Schema = z.discriminatedUnion('kind', [
  indexedProvenance,
  directAdapterProvenance,
  manualProvenance,
]);
export type AcquisitionProvenanceV1 = z.infer<typeof AcquisitionProvenanceV1Schema>;
export const DiscoveryProvenanceSchema = AcquisitionProvenanceV1Schema;
export const DiscoveryProvenanceV1Schema = AcquisitionProvenanceV1Schema;
export type DiscoveryProvenance = AcquisitionProvenanceV1;
export type DiscoveryProvenanceV1 = AcquisitionProvenanceV1;

const evidenceBase = {
  evidenceId: DiscoveryEvidenceIdSchema,
  kind: z.literal('indexed_snippet'),
  providerAttributed: z.literal(true),
  providerId: text(256),
  targetCanonicalUrl: url,
  boundedText: text(8192).optional(),
  contentHash: text(256),
  capturedAt: InstantSchema,
};
const indexedEvidence = z.object(evidenceBase).strict();
const metadataEvidence = indexedEvidence.extend({ kind: z.literal('provider_metadata') }).strict();
const summaryEvidence = z
  .object({
    evidenceId: DiscoveryEvidenceIdSchema,
    kind: z.literal('provider_generated_summary'),
    providerAttributed: z.literal(true),
    providerId: text(256),
    urlAttributable: z.literal(true),
    targetCanonicalUrl: url,
    generatedBy: text(256),
    boundedText: text(8192),
    contentHash: text(256),
    capturedAt: InstantSchema,
  })
  .strict();
const destinationEvidence = z
  .object({
    evidenceId: DiscoveryEvidenceIdSchema,
    kind: z.literal('destination_content'),
    targetCanonicalUrl: url,
    boundedText: text(32768),
    contentHash: text(256),
    capturedAt: InstantSchema,
    observationId: text(256),
    sourceListingId: text(256),
  })
  .strict();
const adapterEvidence = z
  .object({
    evidenceId: DiscoveryEvidenceIdSchema,
    kind: z.literal('adapter_listing'),
    boundedText: text(32768),
    contentHash: text(256),
    capturedAt: InstantSchema,
    adapterId: text(256),
    publisherSourceId: text(256),
    sourceListingId: text(256),
    observationId: text(256),
    adapterResultId: text(256).optional(),
  })
  .strict();
const userEvidence = z
  .object({
    evidenceId: DiscoveryEvidenceIdSchema,
    kind: z.literal('user_supplied_content'),
    boundedText: text(32768),
    contentHash: text(256),
    capturedAt: InstantSchema,
    submittedBy: z.object({ namespace: text(128), id: text(256) }).strict(),
    sourceListingId: text(256),
    observationId: text(256),
  })
  .strict();
export const DiscoveryEvidenceSchema = z.discriminatedUnion('kind', [
  indexedEvidence,
  metadataEvidence,
  summaryEvidence,
  destinationEvidence,
  adapterEvidence,
  userEvidence,
]);
export const DiscoveryEvidenceV1Schema = DiscoveryEvidenceSchema;
export type DiscoveryEvidence = z.infer<typeof DiscoveryEvidenceSchema>;
export type DiscoveryEvidenceV1 = DiscoveryEvidence;

function uniqueArray<T extends z.ZodType>(item: T, min: number, max: number) {
  return z
    .array(item)
    .min(min)
    .max(max)
    .superRefine((xs: unknown[], ctx) => {
      if (new Set(xs as string[]).size !== xs.length) {
        ctx.addIssue({ code: 'custom', message: 'duplicate entries' });
      }
    });
}
const candidateEvidenceRefsSchema = uniqueArray(DiscoveryEvidenceIdSchema, 1, 32);
const candidatePolicyEdgeRefsSchema = uniqueArray(AcquisitionEdgeIdSchema, 1, 32);
const candidateCaveatsSchema = z
  .array(caveat)
  .max(32)
  .superRefine((xs, ctx) => {
    if (new Set(xs).size !== xs.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate caveats' });
  });

const candidateCommon = {
  schemaVersion: z.literal(ACQUISITION_CONTRACT_VERSION),
  candidateId: AcquisitionCandidateIdSchema,
  runId: AcquisitionRunIdSchema,
  sliceId: AcquisitionSliceIdSchema,
  adapterId: text(256),
  titleHint: text(512).optional(),
  publishedAtHint: InstantSchema.optional(),
  evidenceRefs: candidateEvidenceRefsSchema,
  policyEdgeRefs: candidatePolicyEdgeRefsSchema,
  caveats: candidateCaveatsSchema,
};

const indexedCandidate = z
  .object({ ...candidateCommon, state: z.literal('indexed_only'), provenance: indexedProvenance })
  .strict();
const eligibleCandidate = z
  .object({
    ...candidateCommon,
    state: z.literal('fetch_eligible'),
    provenance: indexedProvenance,
    fetchEdgeRef: AcquisitionEdgeIdSchema,
  })
  .strict();
const fetchedCandidate = z
  .object({
    ...candidateCommon,
    state: z.literal('destination_fetched'),
    provenance: indexedProvenance,
    fetchEdgeRef: AcquisitionEdgeIdSchema,
    destinationEvidenceRef: DiscoveryEvidenceIdSchema,
    observationEnvelopeRef: text(256),
  })
  .strict();
const adapterCandidate = z
  .object({
    ...candidateCommon,
    state: z.literal('adapter_acquired'),
    provenance: directAdapterProvenance,
    acquisitionEdgeRef: AcquisitionEdgeIdSchema,
    adapterEvidenceRef: DiscoveryEvidenceIdSchema,
    observationEnvelopeRef: text(256),
  })
  .strict();
const manualCandidate = z
  .object({
    ...candidateCommon,
    state: z.literal('manual_content'),
    provenance: manualProvenance,
    manualImportEdgeRef: AcquisitionEdgeIdSchema,
    userSuppliedContentEdgeRef: AcquisitionEdgeIdSchema,
    manualEvidenceRef: DiscoveryEvidenceIdSchema,
    observationEnvelopeRef: text(256),
  })
  .strict();
export const AcquisitionCandidateSchema = z.discriminatedUnion('state', [
  indexedCandidate,
  eligibleCandidate,
  fetchedCandidate,
  adapterCandidate,
  manualCandidate,
]);
export const AcquisitionCandidateV1Schema = AcquisitionCandidateSchema;
export type AcquisitionCandidate = z.infer<typeof AcquisitionCandidateSchema>;
export type AcquisitionCandidateV1 = AcquisitionCandidate;

export const AcquisitionCoverageSchema = z
  .object({
    schemaVersion: z.literal(ACQUISITION_CONTRACT_VERSION),
    adapterId: text(256),
    state: z.enum([
      'succeeded',
      'partial',
      'failed',
      'disabled',
      'policy_blocked',
      'not_supported',
    ]),
    resultState: z.enum(['results', 'no_results', 'unknown']),
    candidatesProduced: z.number().int().nonnegative().max(10000),
    logicalRequestsUsed: z.number().int().nonnegative().max(10000),
    attemptsReserved: z.number().int().nonnegative().max(10000),
    bytesUsed: z.number().int().nonnegative().max(100_000_000),
    durationMs: z.number().int().nonnegative().max(86_400_000),
    errorCode: text(256).optional(),
    policyEdgeRefs: z
      .array(AcquisitionEdgeIdSchema)
      .max(32)
      .superRefine((xs, ctx) => {
        if (new Set(xs as string[]).size !== xs.length)
          ctx.addIssue({ code: 'custom', message: 'duplicate policyEdgeRefs' });
      }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.resultState === 'no_results' && v.candidatesProduced !== 0)
      ctx.addIssue({
        code: 'custom',
        path: ['candidatesProduced'],
        message: 'no_results requires zero candidates',
      });
    if (v.state === 'policy_blocked') {
      if (v.resultState !== 'unknown')
        ctx.addIssue({
          code: 'custom',
          path: ['resultState'],
          message: 'policy_blocked requires unknown',
        });
      if (v.candidatesProduced !== 0)
        ctx.addIssue({
          code: 'custom',
          path: ['candidatesProduced'],
          message: 'policy_blocked requires zero candidates',
        });
      if (v.logicalRequestsUsed !== 0)
        ctx.addIssue({
          code: 'custom',
          path: ['logicalRequestsUsed'],
          message: 'policy_blocked requires zero requests',
        });
      if (v.attemptsReserved !== 0)
        ctx.addIssue({
          code: 'custom',
          path: ['attemptsReserved'],
          message: 'policy_blocked requires zero reservations',
        });
      if (v.bytesUsed !== 0)
        ctx.addIssue({
          code: 'custom',
          path: ['bytesUsed'],
          message: 'policy_blocked requires zero bytes',
        });
      if (v.policyEdgeRefs.length === 0)
        ctx.addIssue({
          code: 'custom',
          path: ['policyEdgeRefs'],
          message: 'policy_blocked requires at least one policy edge ref',
        });
    }
    if ((v.state === 'disabled' || v.state === 'not_supported') && v.resultState === 'results')
      ctx.addIssue({
        code: 'custom',
        path: ['resultState'],
        message: 'disabled/not_supported cannot have results',
      });
  });
export const AcquisitionCoverageV1Schema = AcquisitionCoverageSchema;
export type AcquisitionCoverage = z.infer<typeof AcquisitionCoverageSchema>;
export type AcquisitionCoverageV1 = AcquisitionCoverage;

export const AcquisitionSliceSchema = z
  .object({
    schemaVersion: z.literal(ACQUISITION_CONTRACT_VERSION),
    runId: AcquisitionRunIdSchema,
    sliceId: AcquisitionSliceIdSchema,
    ordinal: z.number().int().nonnegative().max(100000),
    queryVariantId: text(256),
    query: text(2048),
    reason: text(1024),
    adapterIds: z.array(text(256)).min(1).max(100),
    localePackRefs: z.array(text(256)).max(100),
    domainPackRefs: z.array(text(256)).max(100),
    budget: z
      .object({
        logicalRequests: z.number().int().positive().max(10000),
        reservedAttempts: z.number().int().positive().max(10000),
        candidates: z.number().int().positive().max(10000),
        bytes: z.number().int().positive().max(100_000_000),
        milliseconds: z.number().int().positive().max(86_400_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.adapterIds).size !== v.adapterIds.length)
      ctx.addIssue({ code: 'custom', path: ['adapterIds'], message: 'duplicate adapter ID' });
  });
export const AcquisitionSliceV1Schema = AcquisitionSliceSchema;
export type AcquisitionSlice = z.infer<typeof AcquisitionSliceSchema>;
export type AcquisitionSliceV1 = AcquisitionSlice;

const uniqueDiscoveryIds = uniqueArray(AcquisitionCandidateIdSchema, 1, 32);
const uniqueEnvelopeEvidence = uniqueArray(DiscoveryEvidenceIdSchema, 1, 32);

const destinationFetchAcquisition = z
  .object({
    captureKind: z.literal('destination_fetch'),
    publisherSourceId: text(256),
    discoveryCandidateIds: uniqueDiscoveryIds,
    policyEdgeRefs: z
      .array(AcquisitionEdgeIdSchema)
      .min(1)
      .max(32)
      .superRefine((xs, ctx) => {
        if (new Set(xs as string[]).size !== xs.length)
          ctx.addIssue({ code: 'custom', message: 'duplicate policyEdgeRefs' });
      }),
    evidenceRefs: uniqueEnvelopeEvidence,
    fetchEdgeRef: AcquisitionEdgeIdSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.policyEdgeRefs.length !== 1)
      ctx.addIssue({
        code: 'custom',
        path: ['policyEdgeRefs'],
        message: 'destination_fetch requires exactly one policy edge ref',
      });
    else if (v.policyEdgeRefs[0] !== v.fetchEdgeRef)
      ctx.addIssue({
        code: 'custom',
        path: ['policyEdgeRefs'],
        message: 'fetchEdgeRef must be the sole policyEdgeRef',
      });
  });
const adapterListingAcquisition = z
  .object({
    captureKind: z.literal('adapter_listing'),
    publisherSourceId: text(256),
    discoveryCandidateIds: uniqueDiscoveryIds,
    policyEdgeRefs: z
      .array(AcquisitionEdgeIdSchema)
      .min(1)
      .max(32)
      .superRefine((xs, ctx) => {
        if (new Set(xs as string[]).size !== xs.length)
          ctx.addIssue({ code: 'custom', message: 'duplicate policyEdgeRefs' });
      }),
    evidenceRefs: uniqueEnvelopeEvidence,
    adapterId: text(256),
    acquisitionEdgeRef: AcquisitionEdgeIdSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.policyEdgeRefs.length !== 1)
      ctx.addIssue({
        code: 'custom',
        path: ['policyEdgeRefs'],
        message: 'adapter_listing requires exactly one policy edge ref',
      });
    else if (v.policyEdgeRefs[0] !== v.acquisitionEdgeRef)
      ctx.addIssue({
        code: 'custom',
        path: ['policyEdgeRefs'],
        message: 'acquisitionEdgeRef must be the sole policyEdgeRef',
      });
  });
const manualContentAcquisition = z
  .object({
    captureKind: z.literal('manual_content'),
    publisherSourceId: text(256),
    discoveryCandidateIds: uniqueDiscoveryIds,
    policyEdgeRefs: z
      .array(AcquisitionEdgeIdSchema)
      .min(1)
      .max(32)
      .superRefine((xs, ctx) => {
        if (new Set(xs as string[]).size !== xs.length)
          ctx.addIssue({ code: 'custom', message: 'duplicate policyEdgeRefs' });
      }),
    evidenceRefs: uniqueEnvelopeEvidence,
    submittedBy: z.object({ namespace: text(128), id: text(256) }).strict(),
    manualImportEdgeRef: AcquisitionEdgeIdSchema,
    userSuppliedContentEdgeRef: AcquisitionEdgeIdSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.policyEdgeRefs.length !== 2)
      ctx.addIssue({
        code: 'custom',
        path: ['policyEdgeRefs'],
        message: 'manual_content requires exactly two policy edge refs',
      });
    else {
      const set = new Set(v.policyEdgeRefs as string[]);
      if (set.size !== 2)
        ctx.addIssue({
          code: 'custom',
          path: ['policyEdgeRefs'],
          message: 'manual policy refs must be distinct',
        });
      if (!set.has(v.manualImportEdgeRef) || !set.has(v.userSuppliedContentEdgeRef))
        ctx.addIssue({
          code: 'custom',
          path: ['policyEdgeRefs'],
          message: 'policyEdgeRefs must contain both manual edges',
        });
      if (v.manualImportEdgeRef === v.userSuppliedContentEdgeRef)
        ctx.addIssue({
          code: 'custom',
          path: ['policyEdgeRefs'],
          message: 'manual edges must be distinct',
        });
    }
  });

export const AcquiredObservationEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(ACQUISITION_CONTRACT_VERSION),
    envelopeId: text(256),
    listing: SourceListingSchema,
    observation: SourceObservationSchema,
    acquisition: z.discriminatedUnion('captureKind', [
      destinationFetchAcquisition,
      adapterListingAcquisition,
      manualContentAcquisition,
    ]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.listing.currentObservationId !== v.observation.observationId ||
      v.listing.sourceListingId !== v.observation.sourceListingId
    )
      ctx.addIssue({
        code: 'custom',
        path: ['observation'],
        message: 'listing and observation IDs must link',
      });
  });
export const AcquiredObservationEnvelopeV1Schema = AcquiredObservationEnvelopeSchema;
export type AcquiredObservationEnvelope = z.infer<typeof AcquiredObservationEnvelopeSchema>;
export type AcquiredObservationEnvelopeV1 = AcquiredObservationEnvelope;

export const AcquisitionSliceResultSchema = z
  .object({
    schemaVersion: z.literal(ACQUISITION_CONTRACT_VERSION),
    runId: AcquisitionRunIdSchema,
    sliceId: AcquisitionSliceIdSchema,
    candidates: z.array(AcquisitionCandidateSchema).max(1000),
    coverage: z.array(AcquisitionCoverageSchema).max(100),
    warnings: z.array(text(1024)).max(100),
    evidence: z.array(DiscoveryEvidenceSchema).max(2000),
    observations: z.array(AcquiredObservationEnvelopeSchema).max(1000),
    policyEdges: z.array(AcquisitionPolicyEdgeSchema).max(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    const unique = (xs: readonly string[]) => new Set(xs).size === xs.length;
    const candidates = new Map(v.candidates.map((x) => [x.candidateId, x]));
    const evidence = new Map<string, DiscoveryEvidence>(v.evidence.map((x) => [x.evidenceId, x]));
    const edges = new Map(v.policyEdges.map((x) => [x.edgeId, x]));
    const envelopes = new Map(v.observations.map((x) => [x.envelopeId, x]));
    if (!unique(v.candidates.map((x) => x.candidateId)))
      ctx.addIssue({ code: 'custom', path: ['candidates'], message: 'duplicate candidate ID' });
    if (!unique(v.evidence.map((x) => x.evidenceId)))
      ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'duplicate evidence ID' });
    if (!unique(v.policyEdges.map((x) => x.edgeId)))
      ctx.addIssue({ code: 'custom', path: ['policyEdges'], message: 'duplicate policy edge ID' });
    if (!unique(v.observations.map((x) => x.envelopeId)))
      ctx.addIssue({ code: 'custom', path: ['observations'], message: 'duplicate envelope ID' });
    if (!unique(v.coverage.map((x) => x.adapterId)))
      ctx.addIssue({
        code: 'custom',
        path: ['coverage'],
        message: 'duplicate coverage adapter ID',
      });
    v.coverage.forEach((x, i) => {
      x.policyEdgeRefs.forEach((ref) => {
        if (!edges.has(ref))
          ctx.addIssue({
            code: 'custom',
            path: ['coverage', i],
            message: 'unknown policy edge reference',
          });
      });
      if (x.state === 'policy_blocked') {
        const hasBlockedAuthorized = x.policyEdgeRefs.some((ref) => {
          const edge = edges.get(ref);
          return edge?.state === 'blocked' && edge.effect === 'authorized_operation';
        });
        if (!hasBlockedAuthorized)
          ctx.addIssue({
            code: 'custom',
            path: ['coverage', i],
            message: 'policy_blocked requires blocked authorized_operation edge',
          });
      }
    });

    const isPermitted = (e: AcquisitionPolicyEdge) =>
      e.effect === 'authorized_operation' && e.state === 'permitted';
    const isProviderKind = (k: string) =>
      ['indexed_snippet', 'provider_generated_summary', 'provider_metadata'].includes(k);
    const isFetchTargetKind = (k: string) => ['publisher', 'board', 'ats_tenant'].includes(k);

    const matchesFetchTarget = (
      edge: AcquisitionPolicyEdge,
      prov: {
        publisher?: { kind: string; sourceId: string } | undefined;
        destination: { normalizedHost: string };
      },
    ) => {
      if (!isFetchTargetKind(edge.target.kind)) return false;
      const pub = prov.publisher;
      const destHost = prov.destination.normalizedHost;
      const hostMatch = !!edge.target.normalizedHost && edge.target.normalizedHost === destHost;
      if (pub)
        return (
          (edge.target.kind === pub.kind && edge.target.sourceId === pub.sourceId) || hostMatch
        );
      return hostMatch;
    };

    v.candidates.forEach((c, i) => {
      if (c.runId !== v.runId || c.sliceId !== v.sliceId)
        ctx.addIssue({
          code: 'custom',
          path: ['candidates', i],
          message: 'candidate run/slice linkage mismatch',
        });
      for (const ref of c.evidenceRefs) {
        if (!evidence.has(ref))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i, 'evidenceRefs'],
            message: 'unknown evidence reference',
          });
      }
      for (const ref of c.policyEdgeRefs) {
        if (!edges.has(ref))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i, 'policyEdgeRefs'],
            message: 'unknown policy edge reference',
          });
      }

      // state already enforced by discriminated union; additional defense not needed

      if (c.provenance.kind === 'indexed_discovery') {
        const fake = ['jobspy', 'manual'];
        for (const d of c.provenance.discoverers) {
          if (fake.includes(d.providerId.toLowerCase()))
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i, 'provenance'],
              message: 'synthetic provider not allowed',
            });
        }
        if (fake.includes(c.provenance.contentDonor.providerId.toLowerCase()))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i, 'provenance'],
            message: 'synthetic provider donor not allowed',
          });
      }

      // state-local ref membership enforced by schema uniqueness + following checks
      if (c.state === 'fetch_eligible') {
        if (!c.policyEdgeRefs.includes(c.fetchEdgeRef))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'fetchEdgeRef must be in policyEdgeRefs',
          });
      }
      if (c.state === 'destination_fetched') {
        if (!c.policyEdgeRefs.includes(c.fetchEdgeRef))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'fetchEdgeRef must be in policyEdgeRefs',
          });
        if (!c.evidenceRefs.includes(c.destinationEvidenceRef))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'destinationEvidenceRef must be in evidenceRefs',
          });
      }
      if (c.state === 'adapter_acquired') {
        if (!c.policyEdgeRefs.includes(c.acquisitionEdgeRef))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'acquisitionEdgeRef must be in policyEdgeRefs',
          });
        if (!c.evidenceRefs.includes(c.adapterEvidenceRef))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'adapterEvidenceRef must be in evidenceRefs',
          });
      }
      if (c.state === 'manual_content') {
        if (!c.policyEdgeRefs.includes(c.manualImportEdgeRef))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'manualImportEdgeRef must be in policyEdgeRefs',
          });
        if (!c.policyEdgeRefs.includes(c.userSuppliedContentEdgeRef))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'userSuppliedContentEdgeRef must be in policyEdgeRefs',
          });
        if (!c.evidenceRefs.includes(c.manualEvidenceRef))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'manualEvidenceRef must be in evidenceRefs',
          });
      }

      if (c.provenance.kind === 'indexed_discovery') {
        if (
          !c.provenance.discoverers.every((disc) =>
            c.policyEdgeRefs.some((ref) => {
              const e = edges.get(ref);
              return (
                e?.actor.kind === 'provider' &&
                e.actor.id === disc.providerId &&
                e.target.kind === 'discovery_provider' &&
                e.target.sourceId === disc.providerId &&
                e.operation === 'automatedSearch' &&
                e.route === 'indexed' &&
                isPermitted(e)
              );
            }),
          )
        )
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i, 'policyEdgeRefs'],
            message: 'indexed candidate requires authorized provider search edge',
          });
      }

      if (c.state === 'adapter_acquired') {
        const prov = c.provenance;
        const hasAdapterEdge = c.policyEdgeRefs.some((ref) => {
          const e = edges.get(ref);
          if (!e) return false;
          return (
            e.actor.kind === 'adapter' &&
            e.actor.id === prov.discoverer.adapterId &&
            e.operation === prov.discoverer.operation &&
            e.route === 'direct' &&
            e.target.kind === prov.publisher.kind &&
            e.target.sourceId === prov.publisher.sourceId &&
            isPermitted(e)
          );
        });
        if (!hasAdapterEdge)
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i, 'policyEdgeRefs'],
            message: 'adapter_acquired requires authorized adapter search edge',
          });
      }

      if (c.state === 'manual_content') {
        const prov = c.provenance;
        const donor = prov.contentDonor;
        const targetMatch = (e: AcquisitionPolicyEdge) => {
          if (prov.publisher)
            return (
              e.target.kind === prov.publisher.kind && e.target.sourceId === prov.publisher.sourceId
            );
          return e.target.kind === 'adapter' && e.target.sourceId === c.adapterId;
        };
        const importEdge = edges.get(c.manualImportEdgeRef);
        const contentEdge = edges.get(c.userSuppliedContentEdgeRef);
        const importOk =
          !!importEdge &&
          importEdge.actor.kind === 'user' &&
          importEdge.actor.namespace === donor.namespace &&
          importEdge.actor.id === donor.id &&
          importEdge.operation === 'manualImport' &&
          importEdge.route === 'user_supplied' &&
          targetMatch(importEdge) &&
          isPermitted(importEdge);
        const contentOk =
          !!contentEdge &&
          contentEdge.actor.kind === 'user' &&
          contentEdge.actor.namespace === donor.namespace &&
          contentEdge.actor.id === donor.id &&
          contentEdge.operation === 'userSuppliedContent' &&
          contentEdge.route === 'user_supplied' &&
          targetMatch(contentEdge) &&
          isPermitted(contentEdge);
        if (!importOk)
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'manualImport edge invalid',
          });
        if (!contentOk)
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'userSuppliedContent edge invalid',
          });
      }

      // safe fetch edge check without unsafe cast
      let fetchEdge: AcquisitionPolicyEdge | undefined;
      if (c.state === 'fetch_eligible' || c.state === 'destination_fetched')
        fetchEdge = edges.get(c.fetchEdgeRef);
      if (
        (c.state === 'fetch_eligible' || c.state === 'destination_fetched') &&
        c.provenance.kind === 'indexed_discovery'
      ) {
        if (
          fetchEdge?.state !== 'permitted' ||
          fetchEdge?.effect !== 'authorized_operation' ||
          fetchEdge?.operation !== 'automatedFetch' ||
          fetchEdge?.route !== 'direct'
        )
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'fetch edge must be authorized direct automatedFetch',
          });
        else {
          if (!isFetchTargetKind(fetchEdge?.target.kind ?? ''))
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'fetch edge target must be publisher/board/ats_tenant',
            });
          else if (!matchesFetchTarget(fetchEdge, c.provenance))
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'fetch edge target must match publisher or destination host',
            });
        }
      }

      // linked envelope safe access
      let linked: AcquiredObservationEnvelope | undefined;
      if (
        c.state === 'destination_fetched' ||
        c.state === 'adapter_acquired' ||
        c.state === 'manual_content'
      ) {
        linked = envelopes.get(c.observationEnvelopeRef);
        if (!linked) {
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'missing observation envelope',
          });
        }
      }

      if (c.state === 'destination_fetched' && linked) {
        const destRef = c.destinationEvidenceRef;
        if (
          linked.acquisition.captureKind !== 'destination_fetch' ||
          !c.evidenceRefs.includes(destRef) ||
          evidence.get(destRef)?.kind !== 'destination_content'
        )
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'destination linkage invalid',
          });
      }
      if (c.state === 'adapter_acquired' && linked) {
        const adRef = c.adapterEvidenceRef;
        if (
          linked.acquisition.captureKind !== 'adapter_listing' ||
          !c.evidenceRefs.includes(adRef) ||
          evidence.get(adRef)?.kind !== 'adapter_listing'
        )
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'adapter linkage invalid',
          });
      }
      if (c.state === 'manual_content' && linked) {
        const mRef = c.manualEvidenceRef;
        if (
          linked.acquisition.captureKind !== 'manual_content' ||
          !c.evidenceRefs.includes(mRef) ||
          evidence.get(mRef)?.kind !== 'user_supplied_content'
        )
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'manual linkage invalid',
          });
      }

      if (linked && !linked.acquisition.discoveryCandidateIds.includes(c.candidateId))
        ctx.addIssue({
          code: 'custom',
          path: ['candidates', i],
          message: 'candidate and envelope must mutually reference each other',
        });

      // route-local ref coverage
      let acquiredRef: string | undefined;
      if (c.state === 'destination_fetched') acquiredRef = c.destinationEvidenceRef;
      else if (c.state === 'adapter_acquired') acquiredRef = c.adapterEvidenceRef;
      else if (c.state === 'manual_content') acquiredRef = c.manualEvidenceRef;
      if (linked && acquiredRef && !linked.acquisition.evidenceRefs.includes(acquiredRef as never))
        ctx.addIssue({
          code: 'custom',
          path: ['observations'],
          message: 'envelope must include candidate acquired evidence',
        });

      if (c.state === 'destination_fetched' && linked) {
        const e = evidence.get(c.destinationEvidenceRef);
        if (e?.kind === 'destination_content') {
          const prov = c.provenance.kind === 'indexed_discovery' ? c.provenance : undefined;
          if (
            prov &&
            (e.observationId !== linked.observation.observationId ||
              e.sourceListingId !== linked.observation.sourceListingId ||
              e.targetCanonicalUrl !== prov.destination.canonicalUrl)
          )
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'destination evidence must match envelope IDs',
            });
          if (e.contentHash !== linked.observation.contentHash)
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'destination evidence hash must match observation',
            });
        }
      }
      if (c.state === 'adapter_acquired' && linked) {
        const e = evidence.get(c.adapterEvidenceRef);
        if (e?.kind === 'adapter_listing') {
          if (c.provenance.kind === 'direct_adapter') {
            if (
              e.sourceListingId !== linked.listing.sourceListingId ||
              e.observationId !== linked.observation.observationId ||
              e.publisherSourceId !== c.provenance.publisher.sourceId ||
              e.adapterId !== c.provenance.discoverer.adapterId
            )
              ctx.addIssue({
                code: 'custom',
                path: ['candidates', i],
                message: 'adapter evidence must match listing',
              });
          }
          if (e.contentHash !== linked.observation.contentHash)
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'adapter evidence hash must match observation',
            });
          if (
            linked.acquisition.captureKind === 'adapter_listing' &&
            e.adapterId !== linked.acquisition.adapterId
          )
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'adapter evidence adapterId must match envelope',
            });
          if (e.adapterId !== c.adapterId)
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'candidate adapterId must match evidence',
            });
          if (
            c.provenance.kind === 'direct_adapter' &&
            e.adapterId !== c.provenance.contentDonor.adapterId
          )
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'adapter donor must match evidence',
            });
          if (linked.listing.adapterId !== c.adapterId)
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'listing adapterId must match candidate',
            });
          if (
            linked.acquisition.captureKind === 'adapter_listing' &&
            linked.acquisition.adapterId !== c.adapterId
          )
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'envelope adapterId must match candidate',
            });
          if (
            c.provenance.kind === 'direct_adapter' &&
            linked.acquisition.publisherSourceId !== c.provenance.publisher.sourceId
          )
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'envelope publisherSourceId must match provenance',
            });
          if (linked.acquisition.publisherSourceId !== e.publisherSourceId)
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'envelope publisherSourceId must match evidence',
            });
        }
      }
      if (c.state === 'manual_content' && linked) {
        const e = evidence.get(c.manualEvidenceRef);
        const prov = c.provenance.kind === 'manual_content' ? c.provenance : undefined;
        if (!prov) {
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'manual provenance mismatch',
          });
        } else {
          if (e?.kind === 'user_supplied_content') {
            if (
              e.sourceListingId !== linked.listing.sourceListingId ||
              e.observationId !== linked.observation.observationId
            )
              ctx.addIssue({
                code: 'custom',
                path: ['candidates', i],
                message: 'manual evidence must match listing',
              });
            if (e.contentHash !== linked.observation.contentHash)
              ctx.addIssue({
                code: 'custom',
                path: ['candidates', i],
                message: 'manual evidence hash must match observation',
              });
            if (
              e.submittedBy.namespace !== prov.contentDonor.namespace ||
              e.submittedBy.id !== prov.contentDonor.id
            )
              ctx.addIssue({
                code: 'custom',
                path: ['candidates', i],
                message: 'manual evidence submitter must match donor',
              });
            if (
              linked.acquisition.captureKind !== 'manual_content' ||
              linked.acquisition.submittedBy.namespace !== prov.contentDonor.namespace ||
              linked.acquisition.submittedBy.id !== prov.contentDonor.id ||
              e.submittedBy.namespace !== linked.acquisition.submittedBy.namespace ||
              e.submittedBy.id !== linked.acquisition.submittedBy.id
            )
              ctx.addIssue({
                code: 'custom',
                path: ['candidates', i],
                message: 'manual envelope submitter must match donor',
              });
          }
          if (c.evidenceRefs.some((r) => evidence.get(r)?.kind === 'destination_content'))
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'manual cannot use destination evidence',
            });
          if (linked.listing.adapterId !== c.adapterId)
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'listing adapterId must match candidate',
            });
          const expectedPub = prov.publisher ? prov.publisher.sourceId : c.adapterId;
          if (linked.acquisition.publisherSourceId !== expectedPub)
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'envelope publisherSourceId must match provenance',
            });
        }
      }

      if (c.provenance.kind === 'indexed_discovery') {
        const providerEvidence = c.evidenceRefs
          .map((id) => evidence.get(id))
          .filter(
            (
              e,
            ): e is Extract<
              DiscoveryEvidence,
              { kind: 'indexed_snippet' | 'provider_generated_summary' | 'provider_metadata' }
            > => !!e && isProviderKind(e.kind),
          );
        for (const e of providerEvidence) {
          if (e.kind === 'provider_generated_summary' && e.generatedBy !== e.providerId)
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'summary generatedBy must match provider',
            });
          if (
            c.provenance.kind === 'indexed_discovery' &&
            e.targetCanonicalUrl !== c.provenance.destination.canonicalUrl
          )
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'provider evidence target URL mismatch',
            });
        }
        const donor = c.provenance.contentDonor;
        if (
          !providerEvidence.some(
            (e) => e.providerId === donor.providerId && e.kind === donor.representation,
          )
        )
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'content donor must match evidence',
          });
        if (c.state === 'destination_fetched' && linked) {
          const expectedPub = c.provenance.publisher
            ? c.provenance.publisher.sourceId
            : fetchEdge?.target.sourceId;
          if (linked.acquisition.publisherSourceId !== expectedPub)
            ctx.addIssue({
              code: 'custom',
              path: ['candidates', i],
              message: 'envelope publisherSourceId must match provenance or fetch target',
            });
        }
      }

      if (c.state === 'indexed_only' || c.state === 'fetch_eligible') {
        const bad = c.evidenceRefs.some((r) => {
          const k = evidence.get(r)?.kind;
          return (
            k === 'destination_content' || k === 'adapter_listing' || k === 'user_supplied_content'
          );
        });
        if (bad)
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'indexed/fetch_eligible permits only provider evidence',
          });
      }
      if (c.state === 'destination_fetched') {
        const bad = c.evidenceRefs.some((r) => {
          const k = evidence.get(r)?.kind;
          return k === 'adapter_listing' || k === 'user_supplied_content';
        });
        if (bad)
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'destination_fetched permits only provider and destination evidence',
          });
        if (!c.evidenceRefs.some((r) => evidence.get(r)?.kind === 'destination_content'))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'destination_fetched requires destination evidence',
          });
      }
      if (c.state === 'adapter_acquired') {
        const bad = c.evidenceRefs.some((r) => evidence.get(r)?.kind !== 'adapter_listing');
        if (bad)
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'adapter_acquired permits only adapter evidence',
          });
      }
      if (c.state === 'manual_content') {
        const bad = c.evidenceRefs.some((r) => evidence.get(r)?.kind !== 'user_supplied_content');
        if (bad)
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i],
            message: 'manual_content permits only user evidence',
          });
      }

      if (
        c.state === 'indexed_only' &&
        v.observations.some((o) => o.acquisition.discoveryCandidateIds.includes(c.candidateId))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['candidates', i],
          message: 'indexed_only cannot have observation envelope',
        });

      const providerEdges = c.policyEdgeRefs
        .map((id) => edges.get(id))
        .filter((e): e is AcquisitionPolicyEdge => !!e);
      for (const e of providerEdges.filter(
        (e) =>
          ['publisher', 'board', 'ats_tenant'].includes(e.target.kind) &&
          e.route === 'direct' &&
          e.effect === 'informational_capability',
      )) {
        const cv =
          e.state === 'blocked' && e.operation === 'automatedSearch'
            ? 'direct_search_blocked'
            : e.state === 'blocked' && e.operation === 'automatedFetch'
              ? 'destination_fetch_blocked'
              : ['requires_configuration', 'requires_review', 'not_supported'].includes(e.state)
                ? 'publisher_policy_unknown'
                : undefined;
        if (cv && !c.caveats.includes(cv))
          ctx.addIssue({
            code: 'custom',
            path: ['candidates', i, 'caveats'],
            message: `missing ${cv} caveat`,
          });
      }
    });

    v.observations.forEach((o, i) => {
      if (!o.acquisition.discoveryCandidateIds.some((id) => candidates.has(id)))
        ctx.addIssue({
          code: 'custom',
          path: ['observations', i, 'acquisition', 'discoveryCandidateIds'],
          message: 'unknown candidate reference',
        });
      for (const ref of o.acquisition.policyEdgeRefs) {
        if (!edges.has(ref))
          ctx.addIssue({
            code: 'custom',
            path: ['observations', i],
            message: 'unknown policy edge reference',
          });
      }
      for (const ref of o.acquisition.evidenceRefs) {
        if (!evidence.has(ref))
          ctx.addIssue({
            code: 'custom',
            path: ['observations', i],
            message: 'unknown evidence reference',
          });
      }
      const expectedKind =
        o.acquisition.captureKind === 'destination_fetch'
          ? 'destination_content'
          : o.acquisition.captureKind === 'adapter_listing'
            ? 'adapter_listing'
            : 'user_supplied_content';
      for (const ref of o.acquisition.evidenceRefs) {
        const item = evidence.get(ref);
        if (item && item.kind !== expectedKind)
          ctx.addIssue({
            code: 'custom',
            path: ['observations', i, 'acquisition', 'evidenceRefs'],
            message: 'capture kind must match evidence kind',
          });
      }
      if (
        o.acquisition.captureKind === 'destination_fetch' &&
        !o.acquisition.policyEdgeRefs.includes(o.acquisition.fetchEdgeRef)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['observations', i],
          message: 'fetchEdgeRef must be in envelope policyEdgeRefs',
        });
      if (
        o.acquisition.captureKind === 'adapter_listing' &&
        !o.acquisition.policyEdgeRefs.includes(o.acquisition.acquisitionEdgeRef)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['observations', i],
          message: 'acquisitionEdgeRef must be in envelope policyEdgeRefs',
        });
      if (
        o.acquisition.captureKind === 'manual_content' &&
        (!o.acquisition.policyEdgeRefs.includes(o.acquisition.manualImportEdgeRef) ||
          !o.acquisition.policyEdgeRefs.includes(o.acquisition.userSuppliedContentEdgeRef))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['observations', i],
          message: 'manual edges must be in envelope policyEdgeRefs',
        });

      // observation evidenceRefs must resolve to acquired evidence of captureKind and sets equal
      const obsSet = new Set(o.observation.evidenceRefs as string[]);
      const acqSet = new Set(o.acquisition.evidenceRefs as string[]);
      if (obsSet.size !== acqSet.size || [...obsSet].some((x) => !acqSet.has(x)))
        ctx.addIssue({
          code: 'custom',
          path: ['observations', i, 'observation', 'evidenceRefs'],
          message: 'observation and envelope evidence sets must be equal',
        });

      for (const ref of o.observation.evidenceRefs) {
        const ev = evidence.get(ref);
        if (!ev)
          ctx.addIssue({
            code: 'custom',
            path: ['observations', i, 'observation', 'evidenceRefs'],
            message: 'unknown observation evidence ref',
          });
        else if (ev.kind !== expectedKind)
          ctx.addIssue({
            code: 'custom',
            path: ['observations', i, 'observation', 'evidenceRefs'],
            message: 'observation evidence must match captureKind',
          });
        else if (!(o.acquisition.evidenceRefs as unknown as string[]).includes(ref))
          ctx.addIssue({
            code: 'custom',
            path: ['observations', i, 'observation', 'evidenceRefs'],
            message: 'observation evidence must be in envelope evidenceRefs',
          });
        else {
          const candId = o.acquisition.discoveryCandidateIds.find((id) =>
            (candidates.get(id)?.evidenceRefs as unknown as string[] | undefined)?.includes(
              ref as unknown as string,
            ),
          );
          if (!candId)
            ctx.addIssue({
              code: 'custom',
              path: ['observations', i, 'observation', 'evidenceRefs'],
              message: 'observation evidence must be in candidate evidenceRefs',
            });
        }
      }

      for (const id of o.acquisition.discoveryCandidateIds) {
        const cand = candidates.get(id);
        if (cand && 'observationEnvelopeRef' in cand) {
          const ref = (cand as { observationEnvelopeRef: string }).observationEnvelopeRef;
          if (ref !== o.envelopeId)
            ctx.addIssue({
              code: 'custom',
              path: ['observations', i],
              message: 'candidate and envelope must mutually reference each other',
            });
        } else if (cand) {
          ctx.addIssue({
            code: 'custom',
            path: ['observations', i],
            message: 'candidate and envelope must mutually reference each other',
          });
        }
        if (!candidates.has(id))
          ctx.addIssue({
            code: 'custom',
            path: ['observations', i],
            message: 'unknown candidate reference',
          });
        else if (candidates.get(id)?.state === 'indexed_only')
          ctx.addIssue({
            code: 'custom',
            path: ['observations', i],
            message: 'envelope candidate must be acquired',
          });
        // enforce linked candidate uses same route-local refs and matches capture state
        if (cand) {
          if (
            (o.acquisition.captureKind === 'destination_fetch' &&
              cand.state !== 'destination_fetched') ||
            (o.acquisition.captureKind === 'adapter_listing' &&
              cand.state !== 'adapter_acquired') ||
            (o.acquisition.captureKind === 'manual_content' && cand.state !== 'manual_content')
          )
            ctx.addIssue({
              code: 'custom',
              path: ['observations', i],
              message: 'envelope candidate capture state mismatch',
            });
          // route-local refs must match
          if (
            o.acquisition.captureKind === 'destination_fetch' &&
            cand.state === 'destination_fetched'
          ) {
            if (cand.fetchEdgeRef !== o.acquisition.fetchEdgeRef)
              ctx.addIssue({
                code: 'custom',
                path: ['observations', i],
                message: 'candidate fetchEdgeRef must match envelope',
              });
            if (!cand.policyEdgeRefs.includes(o.acquisition.fetchEdgeRef))
              ctx.addIssue({
                code: 'custom',
                path: ['observations', i],
                message: 'candidate must use envelope fetch edge',
              });
          }
          if (
            o.acquisition.captureKind === 'adapter_listing' &&
            cand.state === 'adapter_acquired'
          ) {
            if (cand.acquisitionEdgeRef !== o.acquisition.acquisitionEdgeRef)
              ctx.addIssue({
                code: 'custom',
                path: ['observations', i],
                message: 'candidate acquisitionEdgeRef must match envelope',
              });
          }
          if (o.acquisition.captureKind === 'manual_content' && cand.state === 'manual_content') {
            if (
              cand.manualImportEdgeRef !== o.acquisition.manualImportEdgeRef ||
              cand.userSuppliedContentEdgeRef !== o.acquisition.userSuppliedContentEdgeRef
            )
              ctx.addIssue({
                code: 'custom',
                path: ['observations', i],
                message: 'candidate manual edges must match envelope',
              });
          }
          // candidate must cover envelope evidence
          const candEvidence = new Set(cand.evidenceRefs as string[]);
          for (const evRef of o.acquisition.evidenceRefs as string[]) {
            if (!candEvidence.has(evRef))
              ctx.addIssue({
                code: 'custom',
                path: ['observations', i],
                message: 'candidate must cover envelope evidence',
              });
          }
        }
      }
    });
  });
export const AcquisitionSliceResultV1Schema = AcquisitionSliceResultSchema;
export type AcquisitionSliceResult = z.infer<typeof AcquisitionSliceResultSchema>;
export type AcquisitionSliceResultV1 = AcquisitionSliceResult;
export function isPermittedAcquisitionEdge(edge: AcquisitionPolicyEdge): boolean {
  return edge.effect === 'authorized_operation' && edge.state === 'permitted';
}
