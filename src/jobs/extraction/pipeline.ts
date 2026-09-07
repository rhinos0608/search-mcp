import type { DiscoveryEvidence } from '../acquisition/contracts.js';
import type { Evidence } from '../domain/evidence.js';
import type { ClaimCandidate } from '../domain/claims.js';
import { resolveClaim } from '../domain/claims.js';
import type {
  ExtractObservationInput,
  ExtractionResult,
  ExtractionProjection,
  ExtractionHotFields,
  ExtractionMethod,
  ExtractionAdapterKind,
  ExtractionWarning,
  ExtractionScrubSummary,
} from './contracts.js';
import {
  EXTRACTION_CONTRACT_VERSION,
  EXTRACTOR_VERSION,
  METHOD_CONFIDENCE,
  ExtractionError,
} from './contracts.js';
import type { JobsEvidenceId } from './contracts.js';
import { extractionRunId, extractionProjectionId, jobsEvidenceId } from './ids.js';
import { extractScrub } from './scrub.js';
import { extractJsonLdJobPosting } from './structured.js';
import {
  extractTitleFromText,
  extractOrganisationFromText,
  extractWorkModeFromText,
  extractEmploymentTypeFromText,
  normalizeTitle,
} from './normalize.js';

// ── Adapter kind dispatch ──────────────────────────────────────────────

function classifyAdapterKind(input: ExtractObservationInput): ExtractionAdapterKind {
  const acq = input.envelope.acquisition;
  if (acq.captureKind === 'manual_content') return 'manual';
  if (acq.captureKind === 'adapter_listing') {
    if (input.envelope.listing.adapterId === 'jobspy') return 'job_board';
    return 'job_board';
  }
  // destination_fetch — check publisher
  const prov = acq as { publisher?: { kind?: string } };
  if (prov.publisher?.kind === 'ats_tenant') return 'ats';
  if (prov.publisher?.kind === 'board') return 'job_board';
  const sourceId = acq.publisherSourceId;
  if (sourceId.startsWith('gov:')) return 'government';
  return 'job_board';
}

// ── Payload collection ─────────────────────────────────────────────────

interface Payload {
  text: string;
  evidenceId: string;
  kind: string;
}

function collectPayloads(evidence: readonly DiscoveryEvidence[]): {
  payloads: Payload[];
  warnings: string[];
} {
  const payloads: Payload[] = [];
  const warnings: string[] = [];
  for (const e of evidence) {
    if (
      e.kind === 'destination_content' &&
      'boundedText' in e &&
      typeof e.boundedText === 'string'
    ) {
      payloads.push({ text: e.boundedText, evidenceId: e.evidenceId, kind: 'destination_content' });
    } else if (
      e.kind === 'adapter_listing' &&
      'boundedText' in e &&
      typeof e.boundedText === 'string'
    ) {
      payloads.push({ text: e.boundedText, evidenceId: e.evidenceId, kind: 'adapter_listing' });
    } else if (
      e.kind === 'user_supplied_content' &&
      'boundedText' in e &&
      typeof e.boundedText === 'string'
    ) {
      payloads.push({
        text: e.boundedText,
        evidenceId: e.evidenceId,
        kind: 'user_supplied_content',
      });
    } else if (
      e.kind === 'indexed_snippet' ||
      e.kind === 'provider_generated_summary' ||
      e.kind === 'provider_metadata'
    ) {
      warnings.push('indexed_evidence_ignored');
    }
  }
  return { payloads, warnings };
}

// ── Text extraction ────────────────────────────────────────────────────

interface ExtractedField {
  fieldPath: string;
  value: unknown;
  evidenceId: string;
  method: ExtractionMethod;
  origin: 'observed' | 'user_supplied' | 'deterministic_derived';
  confidence: number;
}

function extractFromText(
  text: string,
  observationId: string,
  origin: 'observed' | 'user_supplied',
): ExtractedField[] {
  const fields: ExtractedField[] = [];

  const title = extractTitleFromText(text);
  if (title) {
    const eid = jobsEvidenceId(observationId, 'text_span', 'title', null, null, null);
    fields.push({
      fieldPath: 'title',
      value: title,
      evidenceId: eid,
      method: 'text_span',
      origin,
      confidence: METHOD_CONFIDENCE.text_span,
    });
    const normTitle = normalizeTitle(title);
    const normEid = jobsEvidenceId(observationId, 'text_span', 'normalizedTitle', null, null, null);
    fields.push({
      fieldPath: 'normalizedTitle',
      value: normTitle,
      evidenceId: normEid,
      method: 'title_normalize',
      origin: 'deterministic_derived',
      confidence: METHOD_CONFIDENCE.title_normalize,
    });
  }

  const org = extractOrganisationFromText(text);
  if (org) {
    const eid = jobsEvidenceId(observationId, 'text_span', 'organisation', null, null, null);
    fields.push({
      fieldPath: 'organisation',
      value: org,
      evidenceId: eid,
      method: 'text_span',
      origin,
      confidence: METHOD_CONFIDENCE.text_span,
    });
  }

  const workMode = extractWorkModeFromText(text);
  if (workMode) {
    const eid = jobsEvidenceId(observationId, 'text_span', 'workMode', null, null, null);
    fields.push({
      fieldPath: 'workMode',
      value: workMode,
      evidenceId: eid,
      method: 'regex_normalize',
      origin: 'deterministic_derived',
      confidence: METHOD_CONFIDENCE.regex_normalize,
    });
  }

  const empType = extractEmploymentTypeFromText(text);
  if (empType) {
    const eid = jobsEvidenceId(observationId, 'text_span', 'employmentType', null, null, null);
    fields.push({
      fieldPath: 'employmentType',
      value: empType,
      evidenceId: eid,
      method: 'regex_normalize',
      origin: 'deterministic_derived',
      confidence: METHOD_CONFIDENCE.regex_normalize,
    });
  }

  return fields;
}

// ── Evidence and claim builders ─────────────────────────────────────────

function buildEvidence(field: ExtractedField, observationId: string, capturedAt: string): Evidence {
  return {
    evidenceId: field.evidenceId as Evidence['evidenceId'],
    subjectType: 'posting',
    subjectId: 'projection',
    fieldPath: field.fieldPath,
    kind: field.method === 'text_span' ? 'text_span' : 'structured_field',
    observationId: observationId as Evidence['observationId'],
    capturedAt: capturedAt,
    extractorVersion: EXTRACTOR_VERSION,
    confidence: field.confidence,
    retentionClass: 'bounded_excerpt',
  };
}

function buildClaimCandidate(
  field: ExtractedField,
  _observationId: string,
  producedAt: string,
): ClaimCandidate<unknown> {
  return {
    candidateId:
      `claim-candidate:${field.evidenceId}` as unknown as ClaimCandidate<unknown>['candidateId'],
    value: field.value,
    evidenceRefs: [field.evidenceId as unknown as ClaimCandidate<unknown>['evidenceRefs'][number]],
    confidence: field.confidence,
    origin: field.origin,
    method: field.method,
    provenance: {
      component: 'jobs.extraction',
      version: EXTRACTOR_VERSION,
      producedAt: producedAt,
    },
  };
}

// ── Main extraction ────────────────────────────────────────────────────

export async function extractObservation(
  input: ExtractObservationInput,
): Promise<ExtractionResult> {
  const now = input.now ?? new Date().toISOString();
  const obs = input.envelope.observation;
  const listing = input.envelope.listing;
  const adapterKind = classifyAdapterKind(input);
  const captureKind = input.envelope.acquisition.captureKind;

  // Collect payloads
  const { payloads, warnings: payloadWarnings } = collectPayloads(input.evidence);

  // Check for no payload
  if (payloads.length === 0 && input.attachments.length === 0) {
    throw new ExtractionError('PAYLOAD_MISSING', 'no usable content');
  }

  // Scrub each payload
  const scrubbedPayloads = payloads.map((p) => {
    const { content, scrubSummary } = extractScrub(p.text);
    return { ...p, scrubbed: content, scrubSummary };
  });

  // Accumulate scrub summaries
  const allThreatTypes = new Set<string>();
  let totalRedactions = 0;
  let maxRiskScore = 0;
  let allClean = true;
  for (const sp of scrubbedPayloads) {
    if (!sp.scrubSummary.clean) allClean = false;
    totalRedactions += sp.scrubSummary.redactions;
    maxRiskScore = Math.max(maxRiskScore, sp.scrubSummary.riskScore);
    for (const t of sp.scrubSummary.threatTypes) allThreatTypes.add(t);
  }

  const combinedScrub: ExtractionScrubSummary = {
    clean: allClean,
    redactions: totalRedactions,
    riskScore: maxRiskScore,
    threatTypes: [...allThreatTypes] as ExtractionScrubSummary['threatTypes'],
  };

  // Extract fields
  const fields = new Map<string, ExtractedField>();
  const evidenceMap = new Map<string, Evidence>();
  const warnings: ExtractionWarning[] = [...(payloadWarnings as ExtractionWarning[])];
  if (!allClean) warnings.push('content_scrubbed');

  const primaryText = scrubbedPayloads.map((p) => p.scrubbed).join('\n');

  // JSON-LD extraction
  for (const sp of scrubbedPayloads) {
    try {
      const trimmed = sp.scrubbed.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const jsonData: unknown = JSON.parse(trimmed);
        const ldResult = extractJsonLdJobPosting(jsonData, obs.observationId);
        for (const [fieldPath, extracted] of Object.entries(ldResult.fields)) {
          fields.set(fieldPath, {
            fieldPath,
            value: extracted.value,
            evidenceId: extracted.evidenceId,
            method: extracted.method,
            origin: 'observed',
            confidence: METHOD_CONFIDENCE[extracted.method],
          });
        }
      }
    } catch {
      // not JSON-LD — skip
    }
  }

  // Unstructured extraction
  const unstructuredFields = extractFromText(primaryText, obs.observationId, 'observed');
  for (const uf of unstructuredFields) {
    if (!fields.has(uf.fieldPath)) {
      fields.set(uf.fieldPath, uf);
    } else {
      const existing = fields.get(uf.fieldPath);
      if (
        existing &&
        existing.value !== uf.value &&
        existing.origin === 'observed' &&
        uf.origin === 'observed'
      ) {
        warnings.push('structured_unstructured_conflict');
      }
    }
  }

  // Build evidence and claims
  const allEvidence: Evidence[] = [];
  const allClaimCandidates: ClaimCandidate<unknown>[] = [];

  for (const field of fields.values()) {
    const ev = buildEvidence(field, obs.observationId, now);
    allEvidence.push(ev);
    evidenceMap.set(field.fieldPath, ev);
    allClaimCandidates.push(buildClaimCandidate(field, obs.observationId, now));
  }

  // Build hot fields (omit unresolved — never null)
  const hotFields: Partial<ExtractionHotFields> = {};
  const hotFieldPaths = [
    'title',
    'normalizedTitle',
    'organisation',
    'organisationUnit',
    'sector',
    'industry',
    'workMode',
    'employmentType',
    'hoursFte',
    'seniority',
    'postedAt',
    'closingAt',
    'startAt',
    'applyUrl',
    'description',
    'vacancyCount',
    'securityClearance',
    'workRights',
    'targetedPosition',
    'lifecycleState',
    'verificationState',
  ] as const;

  for (const fp of hotFieldPaths) {
    const field = fields.get(fp);
    if (field) {
      (hotFields as Record<string, unknown>)[fp] = field.value;
    }
  }

  // Lifecycle and verification
  if (captureKind === 'destination_fetch') {
    hotFields.verificationState = 'partially_verified';
    hotFields.lifecycleState = hotFields.title || hotFields.description ? 'active' : 'discovered';
  } else if (captureKind === 'adapter_listing') {
    hotFields.verificationState = 'unverified';
    hotFields.lifecycleState = 'discovered';
  } else {
    // manual_content
    hotFields.verificationState = 'unverified';
    hotFields.lifecycleState = 'discovered';
  }

  // Coverage
  let coverage: ExtractionResult['projection']['coverage'] = 'succeeded';
  if (!hotFields.title && !hotFields.organisation && !hotFields.description) {
    coverage = 'failed';
  } else if (
    warnings.includes('unstructured_fallback') ||
    warnings.includes('structured_unstructured_conflict')
  ) {
    coverage = 'partial';
  }

  if (!hotFields.title) warnings.push('missing_title');
  if (!hotFields.organisation) warnings.push('missing_organisation');

  // Confidence
  const hotConfidences = [...fields.values()]
    .filter((f) => f.fieldPath in hotFields)
    .map((f) => f.confidence);
  const confidence = hotConfidences.length > 0 ? Math.min(...hotConfidences) : 0;

  // Claim resolutions
  const claimResolutions: Record<string, ReturnType<typeof resolveClaim<unknown>>> = {};
  const candidatesByField = new Map<string, ClaimCandidate<unknown>[]>();
  for (const cc of allClaimCandidates) {
    const field = [...fields.values()].find(
      (f) => f.evidenceId === (cc.evidenceRefs[0] as unknown as string),
    );
    if (field) {
      const list = candidatesByField.get(field.fieldPath) ?? [];
      list.push(cc);
      candidatesByField.set(field.fieldPath, list);
    }
  }
  for (const [fp, ccs] of candidatesByField) {
    claimResolutions[fp] = resolveClaim(ccs);
  }

  // Build projection
  const projectionIdVal = extractionProjectionId(obs.observationId, obs.contentHash);
  const runIdVal = extractionRunId(obs.observationId, obs.contentHash, adapterKind, captureKind);

  const projection: ExtractionProjection = {
    schemaVersion: EXTRACTION_CONTRACT_VERSION,
    projectionId: projectionIdVal,
    extractorVersion: EXTRACTOR_VERSION,
    adapterKind,
    captureKind,
    observationId: obs.observationId,
    sourceListingId: listing.sourceListingId,
    contentHash: obs.contentHash,
    fields: hotFields,
    locations: [],
    salaries: [],
    classifications: [],
    roleFamilies: [],
    requirements: [],
    desirableCriteria: [],
    applicationRequirements: [],
    selectionQuestions: [],
    licencesChecksRegistration: [],
    fieldEvidenceLinks: [...evidenceMap.entries()].map(([fieldPath, ev]) => ({
      fieldPath,
      evidenceRefs: [ev.evidenceId as unknown as JobsEvidenceId],
    })),
    flags: [],
    warnings,
    scrub: combinedScrub,
    coverage,
    confidence,
  };

  const result: ExtractionResult = {
    schemaVersion: EXTRACTION_CONTRACT_VERSION,
    runId: runIdVal,
    projection,
    evidence: allEvidence,
    claimCandidates: allClaimCandidates,
    claimResolutions: claimResolutions,
    observationId: obs.observationId,
    sourceListingId: listing.sourceListingId,
  };

  // Deep freeze
  deepFreeze(result);
  return result;
}

function deepFreeze(value: unknown): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
}
