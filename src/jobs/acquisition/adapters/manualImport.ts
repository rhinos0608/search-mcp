import { z } from 'zod/v4';

import {
  ACQUISITION_CONTRACT_VERSION,
  AcquisitionPolicyEdgeSchema,
  AcquisitionSliceResultSchema,
  AcquisitionSliceSchema,
} from '../contracts.js';
import {
  acquiredContentHash,
  deterministicAcquisitionId,
  normalizeHttpUrlMetadata,
  type HttpUrlMetadata,
} from '../adapterSupport.js';
import { InstantSchema } from '../../domain/ids.js';
import { validationError } from '../../../errors.js';

export const MANUAL_IMPORT_ADAPTER_ID = 'manual' as const;
export const MANUAL_IMPORT_ADAPTER_VERSION = '1.0.0' as const;

const text128 = z.string().trim().min(1).max(128);
const text256 = z.string().trim().min(1).max(256);
const text1024 = z.string().trim().min(1).max(1024);
const text32768 = z.string().trim().min(1).max(32768);
const url8192 = z.string().trim().min(1).max(8192);

const inlineTextContentSchema = z
  .object({
    kind: z.literal('inline_text'),
    text: text32768,
    destinationUrl: url8192.optional(),
  })
  .strict();

const structuredFieldsContentSchema = z
  .object({
    kind: z.literal('structured_fields'),
    title: text1024.optional(),
    company: text1024.optional(),
    location: text1024.optional(),
    description: text32768.optional(),
    salary: text1024.optional(),
    requirements: z.array(text1024).max(32).optional(),
    destinationUrl: url8192.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const hasField =
      v.title !== undefined ||
      v.company !== undefined ||
      v.location !== undefined ||
      v.description !== undefined ||
      v.salary !== undefined ||
      (v.requirements !== undefined && v.requirements.length > 0);
    if (!hasField) {
      ctx.addIssue({ code: 'custom', message: 'structured_fields requires at least one field' });
    }
  });

const urlOnlyContentSchema = z
  .object({
    kind: z.literal('url_only'),
    destinationUrl: url8192,
  })
  .strict();

const ManualImportContentSchema = z.discriminatedUnion('kind', [
  inlineTextContentSchema,
  structuredFieldsContentSchema,
  urlOnlyContentSchema,
]);

export type ManualImportContent = z.infer<typeof ManualImportContentSchema>;

export const ManualImportRequestSchema = z
  .object({
    slice: AcquisitionSliceSchema,
    capturedAt: InstantSchema,
    submittedBy: z.object({ namespace: text128, id: text256 }).strict(),
    content: ManualImportContentSchema,
    manualImportEdge: AcquisitionPolicyEdgeSchema,
    userSuppliedContentEdge: AcquisitionPolicyEdgeSchema,
    destinationFetchEdge: AcquisitionPolicyEdgeSchema.optional(),
  })
  .strict();

export type ManualImportRequest = z.infer<typeof ManualImportRequestSchema>;

const ManualImportResultImportedSchema = z
  .object({
    status: z.literal('imported'),
    caveats: z.tuple([z.literal('unverified_manual_content')]),
    sliceResult: AcquisitionSliceResultSchema,
  })
  .strict();

const ManualImportResultContentRequiredSchema = z
  .object({
    status: z.literal('content_required'),
    caveats: z.tuple([z.literal('content_required')]),
    sliceResult: AcquisitionSliceResultSchema,
  })
  .strict();

const ManualImportResultDestinationFetchRequiredSchema = z
  .object({
    status: z.literal('destination_fetch_required'),
    caveats: z.tuple([]).rest(z.never()),
    destination: z.object({
      rawUrl: z.string().min(1).max(8192),
      canonicalUrl: z.string().min(1).max(8192),
      normalizedHost: z.string().min(1).max(253),
    }),
    priorFetchEdgeRef: text256,
    policyRecheckRequired: z.literal(true),
    sliceResult: AcquisitionSliceResultSchema,
  })
  .strict();

const ManualImportResultNotExecutedSchema = z
  .object({
    status: z.literal('not_executed'),
    reason: z.enum(['manual_import_not_permitted', 'user_content_not_permitted']),
    caveats: z.tuple([]).rest(z.never()),
    sliceResult: AcquisitionSliceResultSchema,
  })
  .strict();

export const ManualImportResultSchema = z.discriminatedUnion('status', [
  ManualImportResultImportedSchema,
  ManualImportResultContentRequiredSchema,
  ManualImportResultDestinationFetchRequiredSchema,
  ManualImportResultNotExecutedSchema,
]);

export type ManualImportResult = z.infer<typeof ManualImportResultSchema>;

function throwValidation(msg: string): never {
  throw validationError(msg);
}

function sameTarget(
  a: { kind: string; sourceId: string; normalizedHost?: string | undefined },
  b: { kind: string; sourceId: string; normalizedHost?: string | undefined },
): boolean {
  return (
    a.kind === b.kind &&
    a.sourceId === b.sourceId &&
    (a.normalizedHost ?? '') === (b.normalizedHost ?? '')
  );
}

function derivePublisher(target: {
  kind: string;
  sourceId: string;
}): { kind: 'publisher' | 'board' | 'ats_tenant'; sourceId: string } | undefined {
  if (target.kind === 'publisher' || target.kind === 'board' || target.kind === 'ats_tenant') {
    return { kind: target.kind, sourceId: target.sourceId };
  }
  return undefined;
}

function validateManualEdge(
  edge: z.infer<typeof AcquisitionPolicyEdgeSchema>,
  submittedBy: { namespace: string; id: string },
  expectedOperation: 'manualImport' | 'userSuppliedContent',
): void {
  if (edge.actor.kind !== 'user') throwValidation('manual edge actor must be user');
  if (edge.actor.namespace !== submittedBy.namespace)
    throwValidation('manual edge namespace mismatch');
  if (edge.actor.id !== submittedBy.id) throwValidation('manual edge id mismatch');
  if (edge.route !== 'user_supplied') throwValidation('manual edge route must be user_supplied');
  if (edge.effect !== 'authorized_operation')
    throwValidation('manual edge effect must be authorized_operation');
  if (edge.operation !== expectedOperation) throwValidation('manual edge operation mismatch');
  if (edge.target.kind === 'discovery_provider') throwValidation('manual edge target invalid');
  if (edge.target.kind === 'adapter' && edge.target.sourceId !== MANUAL_IMPORT_ADAPTER_ID)
    throwValidation('manual adapter target must be manual');
}

function renderStructured(c: z.infer<typeof structuredFieldsContentSchema>): string {
  const parts: string[] = [];
  if (c.title !== undefined) parts.push(`Title: ${c.title.trim()}`);
  if (c.company !== undefined) parts.push(`Company: ${c.company.trim()}`);
  if (c.location !== undefined) parts.push(`Location: ${c.location.trim()}`);
  if (c.description !== undefined) parts.push(`Description: ${c.description.trim()}`);
  if (c.salary !== undefined) parts.push(`Salary: ${c.salary.trim()}`);
  if (c.requirements !== undefined && c.requirements.length > 0) {
    parts.push(`Requirements: ${c.requirements.map((r) => r.trim()).join('; ')}`);
  }
  const rendered = parts.join('\n');
  return rendered;
}

function buildCoverageForNotPermitted(edge: z.infer<typeof AcquisitionPolicyEdgeSchema>): {
  state: 'policy_blocked' | 'disabled' | 'not_supported';
  resultState: 'unknown';
} {
  if (edge.state === 'blocked') return { state: 'policy_blocked', resultState: 'unknown' };
  if (edge.state === 'requires_configuration' || edge.state === 'requires_review')
    return { state: 'disabled', resultState: 'unknown' };
  if (edge.state === 'not_supported') return { state: 'not_supported', resultState: 'unknown' };
  // fallback for permitted should not happen
  return { state: 'not_supported', resultState: 'unknown' };
}

export function runManualImport(request: ManualImportRequest): ManualImportResult {
  const parsed = ManualImportRequestSchema.safeParse(request);
  if (!parsed.success) throwValidation('invalid manual import request');
  const {
    slice,
    capturedAt,
    submittedBy,
    content,
    manualImportEdge,
    userSuppliedContentEdge,
    destinationFetchEdge,
  } = parsed.data;

  if (manualImportEdge.edgeId === userSuppliedContentEdge.edgeId)
    throwValidation('manual edges must be distinct');

  validateManualEdge(manualImportEdge, submittedBy, 'manualImport');
  validateManualEdge(userSuppliedContentEdge, submittedBy, 'userSuppliedContent');

  if (!sameTarget(manualImportEdge.target, userSuppliedContentEdge.target))
    throwValidation('manual edges must target same value');

  const publisher = derivePublisher(manualImportEdge.target);
  const publisherSourceId = publisher ? publisher.sourceId : MANUAL_IMPORT_ADAPTER_ID;

  const isManualPermitted = manualImportEdge.state === 'permitted';
  const isContentPermitted = userSuppliedContentEdge.state === 'permitted';

  if (!isManualPermitted || !isContentPermitted) {
    const failingEdge = !isManualPermitted ? manualImportEdge : userSuppliedContentEdge;
    const reason = !isManualPermitted
      ? 'manual_import_not_permitted'
      : 'user_content_not_permitted';
    const mapped = buildCoverageForNotPermitted(failingEdge);
    const coverage = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION as typeof ACQUISITION_CONTRACT_VERSION,
      adapterId: MANUAL_IMPORT_ADAPTER_ID,
      state: mapped.state,
      resultState: mapped.resultState,
      candidatesProduced: 0,
      logicalRequestsUsed: 0,
      attemptsReserved: 0,
      bytesUsed: 0,
      durationMs: 0,
      policyEdgeRefs: [failingEdge.edgeId],
    };
    const sliceResult = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION as typeof ACQUISITION_CONTRACT_VERSION,
      runId: slice.runId,
      sliceId: slice.sliceId,
      candidates: [],
      coverage: [coverage],
      warnings: [],
      evidence: [],
      observations: [],
      policyEdges: [manualImportEdge, userSuppliedContentEdge],
    };
    // validate
    const checked = AcquisitionSliceResultSchema.safeParse(sliceResult);
    if (!checked.success) throwValidation('invalid slice result');
    return {
      status: 'not_executed',
      reason: reason,
      caveats: [],
      sliceResult: checked.data,
    };
  }

  // both permitted beyond this point

  if (content.kind === 'inline_text' || content.kind === 'structured_fields') {
    let boundedText: string;
    let destinationMeta: HttpUrlMetadata | undefined;

    if (content.kind === 'inline_text') {
      boundedText = content.text.trim();
      if (boundedText.length === 0 || boundedText.length > 32768)
        throwValidation('invalid inline text');
      if (content.destinationUrl !== undefined) {
        const meta = normalizeHttpUrlMetadata(content.destinationUrl);
        if (!meta) throwValidation('invalid destination URL');
        destinationMeta = meta;
      }
    } else {
      const rendered = renderStructured(content);
      if (rendered.length === 0 || rendered.length > 32768)
        throwValidation('invalid structured content');
      boundedText = rendered;
      if (content.destinationUrl !== undefined) {
        const meta = normalizeHttpUrlMetadata(content.destinationUrl);
        if (!meta) throwValidation('invalid destination URL');
        destinationMeta = meta;
      }
    }

    if (slice.budget.candidates < 1) throwValidation('candidate budget exhausted');
    const bytesUsed = Buffer.byteLength(boundedText, 'utf8');
    if (bytesUsed > slice.budget.bytes) throwValidation('byte budget exhausted');

    const contentHash = acquiredContentHash(boundedText);
    const candidateId = deterministicAcquisitionId('candidate', [
      slice.sliceId,
      slice.runId,
      submittedBy.namespace,
      submittedBy.id,
      contentHash,
    ]);
    const evidenceId = deterministicAcquisitionId('evidence', [candidateId, contentHash]);
    const listingId = deterministicAcquisitionId('listing', [
      candidateId,
      MANUAL_IMPORT_ADAPTER_ID,
    ]);
    const observationId = deterministicAcquisitionId('observation', [listingId, contentHash]);
    const envelopeId = deterministicAcquisitionId('envelope', [candidateId, observationId]);

    const evidence = {
      evidenceId,
      kind: 'user_supplied_content' as const,
      boundedText,
      contentHash,
      capturedAt,
      submittedBy: { namespace: submittedBy.namespace, id: submittedBy.id },
      sourceListingId: listingId,
      observationId,
    };

    const listing: Record<string, unknown> = {
      sourceListingId: listingId,
      adapterId: MANUAL_IMPORT_ADAPTER_ID,
      firstSeenAt: capturedAt,
      lastSeenAt: capturedAt,
      currentObservationId: observationId,
    };
    if (destinationMeta) {
      listing.canonicalUrl = destinationMeta.canonicalUrl;
    }

    const observation = {
      observationId,
      sourceListingId: listingId,
      fetchedAt: capturedAt,
      contentHash,
      evidenceRefs: [evidenceId],
      extractionVersion: 'manual-import-v1',
      adapterVersion: MANUAL_IMPORT_ADAPTER_VERSION,
      fetchOutcome: 'success' as const,
      sourceConfidence: { user_supplied: 1 },
      immutable: true as const,
    };

    const acquisition: Record<string, unknown> = {
      captureKind: 'manual_content' as const,
      publisherSourceId,
      discoveryCandidateIds: [candidateId],
      policyEdgeRefs: [manualImportEdge.edgeId, userSuppliedContentEdge.edgeId],
      evidenceRefs: [evidenceId],
      submittedBy: { namespace: submittedBy.namespace, id: submittedBy.id },
      manualImportEdgeRef: manualImportEdge.edgeId,
      userSuppliedContentEdgeRef: userSuppliedContentEdge.edgeId,
    };

    const envelope = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION as typeof ACQUISITION_CONTRACT_VERSION,
      envelopeId,
      listing,
      observation,
      acquisition,
    };

    const provenance: Record<string, unknown> = {
      kind: 'manual_content' as const,
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      contentDonor: {
        kind: 'user' as const,
        namespace: submittedBy.namespace,
        id: submittedBy.id,
        representation: 'user_supplied_content' as const,
      },
      capturedAt,
    };
    if (publisher) {
      provenance.publisher = { kind: publisher.kind, sourceId: publisher.sourceId };
    }
    if (destinationMeta) {
      provenance.destination = {
        rawUrl: destinationMeta.rawUrl,
        canonicalUrl: destinationMeta.canonicalUrl,
        normalizedHost: destinationMeta.normalizedHost,
      };
    }

    const candidate = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION as typeof ACQUISITION_CONTRACT_VERSION,
      candidateId,
      runId: slice.runId,
      sliceId: slice.sliceId,
      adapterId: MANUAL_IMPORT_ADAPTER_ID,
      provenance,
      evidenceRefs: [evidenceId],
      policyEdgeRefs: [manualImportEdge.edgeId, userSuppliedContentEdge.edgeId],
      caveats: ['unverified_manual_content' as const],
      state: 'manual_content' as const,
      manualImportEdgeRef: manualImportEdge.edgeId,
      userSuppliedContentEdgeRef: userSuppliedContentEdge.edgeId,
      manualEvidenceRef: evidenceId,
      observationEnvelopeRef: envelopeId,
    };

    const coverage = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION as typeof ACQUISITION_CONTRACT_VERSION,
      adapterId: MANUAL_IMPORT_ADAPTER_ID,
      state: 'succeeded' as const,
      resultState: 'results' as const,
      candidatesProduced: 1,
      logicalRequestsUsed: 0,
      attemptsReserved: 0,
      bytesUsed,
      durationMs: 0,
      policyEdgeRefs: [manualImportEdge.edgeId, userSuppliedContentEdge.edgeId],
    };

    const sliceResultRaw = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION as typeof ACQUISITION_CONTRACT_VERSION,
      runId: slice.runId,
      sliceId: slice.sliceId,
      candidates: [candidate],
      coverage: [coverage],
      warnings: [],
      evidence: [evidence],
      observations: [envelope],
      policyEdges: [manualImportEdge, userSuppliedContentEdge],
    };

    const checked = AcquisitionSliceResultSchema.safeParse(sliceResultRaw);
    if (!checked.success) throwValidation('invalid slice result');

    return {
      status: 'imported',
      caveats: ['unverified_manual_content'],
      sliceResult: checked.data,
    };
  }

  // url_only is the remaining discriminated union variant
  const meta = normalizeHttpUrlMetadata((content as { destinationUrl: string }).destinationUrl);
  if (!meta) throwValidation('invalid destination URL');
  const destination = meta as HttpUrlMetadata;
  const destFetchPermitted =
    destinationFetchEdge?.state === 'permitted' &&
    destinationFetchEdge.effect === 'authorized_operation' &&
    destinationFetchEdge.operation === 'automatedFetch' &&
    destinationFetchEdge.route === 'direct' &&
    (destinationFetchEdge.target.kind === 'publisher' ||
      destinationFetchEdge.target.kind === 'board' ||
      destinationFetchEdge.target.kind === 'ats_tenant') &&
    (destinationFetchEdge.target.normalizedHost === destination.normalizedHost ||
      (destinationFetchEdge.target.kind === manualImportEdge.target.kind &&
        destinationFetchEdge.target.sourceId === manualImportEdge.target.sourceId));

  if (!destFetchPermitted) {
    const coverage = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION as typeof ACQUISITION_CONTRACT_VERSION,
      adapterId: MANUAL_IMPORT_ADAPTER_ID,
      state: 'succeeded' as const,
      resultState: 'no_results' as const,
      candidatesProduced: 0,
      logicalRequestsUsed: 0,
      attemptsReserved: 0,
      bytesUsed: 0,
      durationMs: 0,
      errorCode: 'CONTENT_REQUIRED' as const,
      policyEdgeRefs: [manualImportEdge.edgeId, userSuppliedContentEdge.edgeId],
    };
    const policyEdges = [manualImportEdge, userSuppliedContentEdge];
    if (destinationFetchEdge) policyEdges.push(destinationFetchEdge);
    const sliceResultRaw = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION as typeof ACQUISITION_CONTRACT_VERSION,
      runId: slice.runId,
      sliceId: slice.sliceId,
      candidates: [],
      coverage: [coverage],
      warnings: [],
      evidence: [],
      observations: [],
      policyEdges,
    };
    const checked = AcquisitionSliceResultSchema.safeParse(sliceResultRaw);
    if (!checked.success) throwValidation('invalid slice result');
    return {
      status: 'content_required',
      caveats: ['content_required'],
      sliceResult: checked.data,
    };
  }

  // permitted destination fetch -> handoff
  const coverage = {
    schemaVersion: ACQUISITION_CONTRACT_VERSION as typeof ACQUISITION_CONTRACT_VERSION,
    adapterId: MANUAL_IMPORT_ADAPTER_ID,
    state: 'succeeded' as const,
    resultState: 'no_results' as const,
    candidatesProduced: 0,
    logicalRequestsUsed: 0,
    attemptsReserved: 0,
    bytesUsed: 0,
    durationMs: 0,
    errorCode: 'DESTINATION_FETCH_REQUIRED' as const,
    policyEdgeRefs: [destinationFetchEdge.edgeId],
  };
  const sliceResultRaw = {
    schemaVersion: ACQUISITION_CONTRACT_VERSION as typeof ACQUISITION_CONTRACT_VERSION,
    runId: slice.runId,
    sliceId: slice.sliceId,
    candidates: [],
    coverage: [coverage],
    warnings: [],
    evidence: [],
    observations: [],
    policyEdges: [manualImportEdge, userSuppliedContentEdge, destinationFetchEdge],
  };
  const checked = AcquisitionSliceResultSchema.safeParse(sliceResultRaw);
  if (!checked.success) throwValidation('invalid slice result');
  return {
    status: 'destination_fetch_required',
    caveats: [],
    destination,
    priorFetchEdgeRef: destinationFetchEdge.edgeId,
    policyRecheckRequired: true as const,
    sliceResult: checked.data,
  };
}
