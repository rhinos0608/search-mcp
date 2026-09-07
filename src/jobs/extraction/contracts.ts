import { z } from 'zod/v4';
import { InstantSchema, SourceListingIdSchema, SourceObservationIdSchema } from '../domain/ids.js';

export const EXTRACTION_CONTRACT_VERSION = '1.0.0' as const;
export const EXTRACTOR_VERSION = '1.0.0' as const;

// ── Branded IDs ────────────────────────────────────────────────────────

export type ExtractionRunId = `extraction-run:${string}`;
export type ExtractionProjectionId = `extraction-projection:${string}`;
export type JobsEvidenceId = `jobs-evidence:${string}`;
export type RequirementId = `requirement:${string}`;
export type ExtractionClaimCandidateId = `claim-candidate:${string}`;

export const ExtractionRunIdSchema = z
  .string()
  .regex(/^extraction-run:[0-9a-f]{64}$/u) as z.ZodType<ExtractionRunId>;
export const ExtractionProjectionIdSchema = z
  .string()
  .regex(/^extraction-projection:[0-9a-f]{64}$/u) as z.ZodType<ExtractionProjectionId>;
export const JobsEvidenceIdSchema = z
  .string()
  .regex(/^jobs-evidence:[0-9a-f]{64}$/u) as z.ZodType<JobsEvidenceId>;
export const RequirementIdSchema = z
  .string()
  .regex(/^requirement:[0-9a-f]{64}$/u) as z.ZodType<RequirementId>;
export const ExtractionClaimCandidateIdSchema = z
  .string()
  .regex(/^claim-candidate:[0-9a-f]{64}$/u) as z.ZodType<ExtractionClaimCandidateId>;

// ── Adapter kinds ──────────────────────────────────────────────────────

export const ExtractionAdapterKindSchema = z.enum(['job_board', 'ats', 'government', 'manual']);
export type ExtractionAdapterKind = z.infer<typeof ExtractionAdapterKindSchema>;

// ── Methods ────────────────────────────────────────────────────────────

export const ExtractionMethodSchema = z.enum([
  'jsonld_jobposting',
  'structured_field',
  'html_field',
  'text_span',
  'regex_normalize',
  'title_normalize',
  'pack_interpretation',
  'pdf_text',
  'office_text',
]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

// ── Constants ──────────────────────────────────────────────────────────

export const EXTRACTION_BOUNDED_TEXT_MAX = 32_768 as const;
export const EXTRACTION_EXCERPT_MAX = 2_048 as const;
export const EXTRACTION_DESCRIPTION_MAX = 32_768 as const;
export const PARSER_MAX_INPUT_BYTES: number = 10 * 1024 * 1024;

// ── ExtractionAttachment ───────────────────────────────────────────────

export const ExtractionAttachmentSchema = z
  .object({
    mediaType: z.enum(['pdf', 'office']),
    ext: z.string().min(1).max(16).optional(),
    bytes: z.instanceof(Uint8Array),
    contentHash: z.string().min(1).max(256),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.bytes.byteLength === 0) {
      ctx.addIssue({ code: 'custom', path: ['bytes'], message: 'empty attachment' });
    }
    if (v.bytes.byteLength > PARSER_MAX_INPUT_BYTES) {
      ctx.addIssue({ code: 'custom', path: ['bytes'], message: 'parser input exceeds limit' });
    }
  });

// ── ExtractionPackContext ──────────────────────────────────────────────

// Lazy import of pack types to avoid circular deps at bundle time
import type { LocalePack, DomainPack } from '../packs/types.js';

export const ExtractionPackContextSchema = z
  .object({
    locale: z.custom<LocalePack>().optional(),
    domain: z.custom<DomainPack>().optional(),
  })
  .strict();
export type ExtractionPackContext = z.infer<typeof ExtractionPackContextSchema>;

// ── Input schema ───────────────────────────────────────────────────────

import {
  AcquiredObservationEnvelopeSchema,
  DiscoveryEvidenceSchema,
} from '../acquisition/contracts.js';

export const ExtractObservationInputSchema = z
  .object({
    schemaVersion: z.literal(EXTRACTION_CONTRACT_VERSION),
    envelope: AcquiredObservationEnvelopeSchema,
    evidence: z.array(DiscoveryEvidenceSchema).min(1).max(32),
    packs: ExtractionPackContextSchema.default({}),
    attachments: z.array(ExtractionAttachmentSchema).max(3).default([]),
    now: InstantSchema.optional(),
    parserLimits: z
      .object({
        timeoutMs: z.number().int().positive().max(60_000),
        maxOutputBytes: z.number().int().positive().max(2_000_000),
        maxInputBytes: z.number().int().positive().max(PARSER_MAX_INPUT_BYTES),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = new Set(v.envelope.acquisition.evidenceRefs as string[]);
    for (const e of v.evidence) {
      if (!ids.has(e.evidenceId)) {
        ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'evidence not in envelope' });
      }
    }
    if (!(v.envelope.observation as { immutable: unknown }).immutable) {
      ctx.addIssue({
        code: 'custom',
        path: ['envelope', 'observation'],
        message: 'observation must be immutable',
      });
    }
  });
export type ExtractObservationInput = z.infer<typeof ExtractObservationInputSchema>;

// ── Errors ─────────────────────────────────────────────────────────────

export const ExtractionErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNSUPPORTED_CAPTURE_KIND',
  'INDEXED_ONLY_FORBIDDEN',
  'PAYLOAD_MISSING',
  'CONTENT_TYPE_UNSUPPORTED',
  'PARSER_INPUT_EXCEEDS_LIMIT',
  'PARSER_TIMEOUT',
  'PARSER_OVERFLOW',
  'PARSER_ABORTED',
  'PARSER_FAILED',
  'BUDGET_EXCEEDED',
  'OBSERVATION_IMMUTABLE',
]);
export type ExtractionErrorCode = z.infer<typeof ExtractionErrorCodeSchema>;

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;
  constructor(code: ExtractionErrorCode, message: string) {
    super(message);
    this.name = 'ExtractionError';
    this.code = code;
  }
}

// ── Warnings and coverage ──────────────────────────────────────────────

export const ExtractionWarningSchema = z.enum([
  'content_scrubbed',
  'parser_partial',
  'unstructured_fallback',
  'structured_unstructured_conflict',
  'pack_interpretation_applied',
  'identified_position_detected',
  'salary_parse_failed',
  'missing_title',
  'missing_organisation',
  'indexed_evidence_ignored',
  'attachment_parsed',
  'attachment_parse_failed',
  'html_parse_partial',
]);
export type ExtractionWarning = z.infer<typeof ExtractionWarningSchema>;

export const ExtractionCoverageSchema = z.enum(['succeeded', 'partial', 'failed']);

// ── Scrub summary ──────────────────────────────────────────────────────

export const ExtractionScrubSummarySchema = z
  .object({
    clean: z.boolean(),
    redactions: z.number().int().nonnegative().max(10_000),
    riskScore: z.number().min(0).max(1),
    threatTypes: z
      .array(
        z.enum([
          'prompt_injection',
          'instruction_override',
          'data_exfiltration',
          'impersonation',
          'payload_smuggling',
          'xss_injection',
        ]),
      )
      .max(16),
  })
  .strict();
export type ExtractionScrubSummary = z.infer<typeof ExtractionScrubSummarySchema>;

// ── Hot field paths ────────────────────────────────────────────────────

export const ExtractionFieldPathSchema = z.enum([
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
]);
export type ExtractionFieldPath = z.infer<typeof ExtractionFieldPathSchema>;

// ── Hot fields ─────────────────────────────────────────────────────────

export const ExtractionHotFieldsSchema = z
  .object({
    title: z.string().min(1).max(1024).optional(),
    normalizedTitle: z.string().min(1).max(1024).optional(),
    organisation: z.string().min(1).max(1024).optional(),
    organisationUnit: z.string().min(1).max(1024).optional(),
    sector: z.string().min(1).max(256).optional(),
    industry: z.string().min(1).max(256).optional(),
    workMode: z.enum(['onsite', 'hybrid', 'remote', 'unknown']).optional(),
    employmentType: z
      .enum(['full_time', 'part_time', 'casual', 'contract', 'temporary', 'internship', 'unknown'])
      .optional(),
    hoursFte: z.number().positive().optional(),
    seniority: z.enum(['entry', 'mid', 'senior', 'lead', 'executive', 'unknown']).optional(),
    postedAt: InstantSchema.optional(),
    closingAt: InstantSchema.optional(),
    startAt: InstantSchema.optional(),
    applyUrl: z.url().max(8192).optional(),
    description: z.string().min(1).max(EXTRACTION_DESCRIPTION_MAX).optional(),
    vacancyCount: z.number().int().nonnegative().optional(),
    securityClearance: z.string().min(1).max(256).optional(),
    workRights: z.string().min(1).max(256).optional(),
    targetedPosition: z.boolean().optional(),
    lifecycleState: z.enum(['discovered', 'active']).optional(),
    verificationState: z.enum(['unverified', 'partially_verified']).optional(),
  })
  .strict();
export type ExtractionHotFields = z.infer<typeof ExtractionHotFieldsSchema>;

// ── Extracted requirement ──────────────────────────────────────────────

import { RequirementSchema } from '../domain/posting.js';

export const ExtractedRequirementSchema = z
  .object({
    requirementId: RequirementIdSchema,
    rawText: z.string().min(1).max(1024),
    category: RequirementSchema.shape.category,
    force: RequirementSchema.shape.force,
    semanticCapability: z.string().min(1).max(256).optional(),
    years: RequirementSchema.shape.years,
    qualification: z.string().min(1).max(256).optional(),
    licence: z.string().min(1).max(256).optional(),
    clearance: z.string().min(1).max(256).optional(),
    registration: z.string().min(1).max(256).optional(),
    evidenceRefs: z.array(JobsEvidenceIdSchema).min(1).max(8),
    confidence: z.number().min(0).max(1),
    interpretationProvenance: z.string().min(1).max(256),
  })
  .strict();
export type ExtractedRequirement = z.infer<typeof ExtractedRequirementSchema>;

// ── Projection ─────────────────────────────────────────────────────────

export const ExtractionProjectionSchema = z
  .object({
    schemaVersion: z.literal(EXTRACTION_CONTRACT_VERSION),
    projectionId: ExtractionProjectionIdSchema,
    extractorVersion: z.literal(EXTRACTOR_VERSION),
    adapterKind: ExtractionAdapterKindSchema,
    captureKind: z.enum(['destination_fetch', 'adapter_listing', 'manual_content']),
    observationId: SourceObservationIdSchema,
    sourceListingId: SourceListingIdSchema,
    contentHash: z.string().min(1),
    fields: ExtractionHotFieldsSchema,
    locations: z.array(z.custom<unknown>()).max(16),
    salaries: z.array(z.custom<unknown>()).max(8),
    classifications: z.array(z.custom<unknown>()).max(16),
    roleFamilies: z
      .array(
        z
          .object({
            family: z.string().min(1).max(256),
            confidence: z.number().min(0).max(1),
            evidenceRefs: z.array(JobsEvidenceIdSchema).min(1).max(8),
          })
          .strict(),
      )
      .max(16),
    requirements: z.array(ExtractedRequirementSchema).max(128),
    desirableCriteria: z.array(z.string().min(1).max(1024)).max(64),
    applicationRequirements: z.array(z.string().min(1).max(1024)).max(64),
    selectionQuestions: z.array(z.string().min(1).max(1024)).max(64),
    licencesChecksRegistration: z.array(z.string().min(1).max(256)).max(32),
    fieldEvidenceLinks: z
      .array(
        z
          .object({
            fieldPath: z.string().min(1).max(256),
            evidenceRefs: z.array(JobsEvidenceIdSchema).min(1).max(8),
          })
          .strict(),
      )
      .max(128),
    flags: z.array(z.custom<string>()).max(16),
    warnings: z.array(ExtractionWarningSchema).max(32),
    scrub: ExtractionScrubSummarySchema,
    coverage: ExtractionCoverageSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type ExtractionProjection = z.infer<typeof ExtractionProjectionSchema>;

// ── Result ─────────────────────────────────────────────────────────────

import { ClaimCandidateSchema, ResolvedClaimSchema } from '../domain/claims.js';
import { EvidenceSchema } from '../domain/evidence.js';

export const ExtractionResultSchema = z
  .object({
    schemaVersion: z.literal(EXTRACTION_CONTRACT_VERSION),
    runId: ExtractionRunIdSchema,
    projection: ExtractionProjectionSchema,
    evidence: z.array(EvidenceSchema).min(1).max(256),
    claimCandidates: z.array(ClaimCandidateSchema).min(1).max(512),
    claimResolutions: z.record(z.string().min(1).max(256), ResolvedClaimSchema),
    observationId: SourceObservationIdSchema,
    sourceListingId: SourceListingIdSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.observationId !== v.projection.observationId) {
      ctx.addIssue({ code: 'custom', message: 'observationId mismatch' });
    }
    const ev = new Set(v.evidence.map((e) => e.evidenceId));
    for (const c of v.claimCandidates) {
      for (const ref of c.evidenceRefs) {
        if (!ev.has(ref)) {
          ctx.addIssue({ code: 'custom', message: 'claim evidence ref unknown' });
        }
      }
      if (c.origin === 'model_derived') {
        ctx.addIssue({ code: 'custom', message: 'W5 default path forbids model_derived' });
      }
    }
  });
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

// ── Confidence defaults ────────────────────────────────────────────────

export const METHOD_CONFIDENCE: Record<ExtractionMethod, number> = {
  jsonld_jobposting: 0.95,
  structured_field: 0.9,
  html_field: 0.75,
  pdf_text: 0.7,
  office_text: 0.7,
  text_span: 0.55,
  regex_normalize: 0.5,
  title_normalize: 0.5,
  pack_interpretation: 0.5,
};
