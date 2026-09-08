import { z } from 'zod/v4';

import {
  ClaimCandidateSchema,
  ClassificationSchema,
  EvidenceSchema,
  InstantSchema,
  JobFlagSchema,
  JobPostingFieldEvidenceLinkSchema,
  LocationSchema,
  RequirementSchema,
  SalaryIntervalSchema,
} from '../domain/index.js';

export const ENRICHMENT_CONTRACT_VERSION = '1.0.0' as const;

// ── Schemas ──────────────────────────────────────────────────────────────────

export const EnrichmentStatusSchema = z.enum(['complete', 'partial', 'pass_through', 'failed']);

export const EnrichmentWarningCodeSchema = z.enum([
  'BUDGET_EXHAUSTED',
  'PACK_ABSENT_PASS_THROUGH',
  'EMPLOYER_UNMATCHED',
  'EMPLOYER_AMBIGUOUS',
  'CLASSIFICATION_UNMAPPED',
  'SALARY_UNNORMALIZED',
  'ATTACHMENT_SPAN_MISSING',
  'FRAMEWORK_UNMAPPED',
  'REGISTRATION_NOT_EVIDENCED',
  'IDENTIFIED_POSITION_STATED',
  'PROTECTED_ATTRIBUTE_NOT_INFERRED',
  'CLINICAL_TITLE_NOT_REGULATION',
]);

export const EnrichmentWarningSchema = z
  .object({
    code: EnrichmentWarningCodeSchema,
    fieldPath: z.string().min(1).max(256).optional(),
  })
  .strict();

export const EnrichmentBudgetSchema = z
  .object({
    units: z.number().int().nonnegative().max(10_000),
  })
  .strict();

export const EnrichmentClockSchema = z
  .object({
    producedAt: InstantSchema,
  })
  .strict();

// ── W5 input adapter ─────────────────────────────────────────────────────────

export const ExtractedFieldSnapshotSchema = z
  .object({
    schemaVersion: z.string().min(1).max(64),
    extractorVersion: z.string().min(1).max(256),
    observationId: z.string().min(1).brand<'SourceObservationId'>(),
    sourceListingId: z.string().min(1).brand<'SourceListingId'>(),
    title: z.string().min(1).max(2048).optional(),
    organisation: z.string().min(1).max(512).optional(),
    organisationUnit: z.string().min(1).max(512).optional(),
    sector: z.string().min(1).max(256).optional(),
    industry: z.string().min(1).max(256).optional(),
    locations: z.array(LocationSchema).max(32).optional(),
    workMode: z.enum(['onsite', 'hybrid', 'remote', 'unknown']).optional(),
    employmentType: z
      .enum(['full_time', 'part_time', 'casual', 'contract', 'temporary', 'internship', 'unknown'])
      .optional(),
    salaries: z.array(SalaryIntervalSchema).max(16).optional(),
    classifications: z.array(ClassificationSchema).max(16).optional(),
    requirements: z.array(RequirementSchema).max(256).optional(),
    roleFamilyHints: z.array(z.string().min(1).max(128)).max(32).optional(),
    targetedPosition: z.boolean().optional(),
    fieldEvidenceLinks: z.array(JobPostingFieldEvidenceLinkSchema).max(256),
    claimCandidates: z.array(ClaimCandidateSchema).max(512),
    evidence: z.array(EvidenceSchema).max(512),
  })
  .strict();

// ── Verified employer catalog ─────────────────────────────────────────────────

export const VerifiedEmployerRecordSchema = z
  .object({
    employerRecordId: z.string().min(1).max(256),
    catalogId: z.string().min(1).max(256),
    catalogVersion: z.string().min(1).max(64),
    legalName: z.string().min(1).max(512),
    aliases: z.array(z.string().min(1).max(512)).max(32).default([]),
    sector: z.string().min(1).max(256).optional(),
    organisationUnit: z.string().min(1).max(512).optional(),
    evidenceRefs: z.array(z.string().min(1)).min(1).max(32),
    license: z.string().min(1).max(256),
  })
  .strict();

export const VerifiedEmployerCatalogSchema = z
  .object({
    catalogId: z.string().min(1).max(256),
    catalogVersion: z.string().min(1).max(64),
    records: z.array(VerifiedEmployerRecordSchema).max(10_000),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    catalog.records.forEach((r, i) => {
      if (seen.has(r.employerRecordId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['records', i, 'employerRecordId'],
          message: `duplicate employerRecordId: ${r.employerRecordId}`,
        });
      }
      seen.add(r.employerRecordId);
    });
  });

// ── Result schemas ───────────────────────────────────────────────────────────

export const QualitySignalSchema = z
  .object({
    signalId: z.string().min(1),
    name: z.enum([
      'evidence_coverage',
      'source_verification',
      'junk_or_non_job_intent',
      'conflicting_claims',
      'missing_salary',
      'missing_classification',
      'missing_employer_verification',
      'registration_gap',
      'identified_position',
    ]),
    value: z.number().min(0).max(1),
    flags: z.array(JobFlagSchema).max(16),
    evidenceRefs: z.array(z.string().min(1)).max(32),
    notes: z.array(EnrichmentWarningCodeSchema).max(16),
  })
  .strict();

export const EnrichmentResultSchema = z
  .object({
    schemaVersion: z.literal(ENRICHMENT_CONTRACT_VERSION),
    enrichmentId: z.string().min(1),
    status: EnrichmentStatusSchema,
    observationId: z.string().min(1).brand<'SourceObservationId'>(),
    sourceListingId: z.string().min(1).brand<'SourceListingId'>(),
    packVersions: z.array(z.string().min(1).max(128)).max(8),
    catalogRef: z.string().min(1).max(256).optional(),
    derivedClaimCandidates: z.array(ClaimCandidateSchema).max(512),
    derivedEvidence: z.array(EvidenceSchema).max(512),
    fieldEvidenceLinks: z.array(JobPostingFieldEvidenceLinkSchema).max(256),
    salaries: z.array(SalaryIntervalSchema).max(16),
    classifications: z.array(ClassificationSchema).max(16),
    roleFamilies: z
      .array(
        z
          .object({
            family: z.string().min(1),
            confidence: z.number().min(0).max(1),
            evidenceRefs: z.array(z.string().min(1)),
          })
          .strict(),
      )
      .max(32),
    employer: z
      .object({
        employerRecordId: z.string().min(1).max(256).optional(),
        legalName: z.string().min(1).max(512).optional(),
        sector: z.string().min(1).max(256).optional(),
        organisationUnit: z.string().min(1).max(512).optional(),
        match: z.enum(['exact', 'alias', 'none', 'ambiguous']),
        evidenceRefs: z.array(z.string().min(1)).max(32),
      })
      .strict(),
    requirementsInterpreted: z.array(RequirementSchema).max(256),
    flags: z.array(JobFlagSchema).max(16),
    qualitySignals: z.array(QualitySignalSchema).max(32),
    warnings: z.array(EnrichmentWarningSchema).max(64),
    budgetRemaining: z.number().int().nonnegative().max(10_000),
    unitsConsumed: z.number().int().nonnegative().max(10_000),
  })
  .strict();

// ── Standalone helper result types ───────────────────────────────────────────

export const SalaryNormalizationResultSchema = z
  .object({
    stated: z.array(SalaryIntervalSchema).max(16),
    annualized: z.array(SalaryIntervalSchema).max(16),
    warnings: z.array(EnrichmentWarningSchema).max(16),
    unitsConsumed: z.number().int().nonnegative(),
  })
  .strict();

export const ClassificationMappingResultSchema = z
  .object({
    mapped: z.array(ClassificationSchema).max(16),
    unmapped: z.array(ClassificationSchema).max(16),
    warnings: z.array(EnrichmentWarningSchema).max(16),
    unitsConsumed: z.number().int().nonnegative(),
  })
  .strict();

// ── LocalePack / DomainPack: canonical packs/types schemas (single source) ────
// Re-exported — never redefined — so semver/refinement cannot diverge.
export {
  PackAttributionSchema,
  GeographyNodeSchema,
  SalaryConventionSchema,
  ClassificationSchemeSchema,
  RuleMetadataSchema,
  LocalePackSchema,
  RoleNodeSchema,
  RoleEdgeSchema,
  ExpansionGuardSchema,
  DomainPackSchema,
  type PackAttribution,
  type ValidationFixtureRef,
  type RuleMetadata,
  type LocalePack,
  type RoleNode,
  type RoleEdge,
  type ExpansionGuard,
  type DomainPack,
} from '../packs/types.js';
import {
  LocalePackSchema as CanonicalLocalePackSchema,
  DomainPackSchema as CanonicalDomainPackSchema,
} from '../packs/types.js';

// Re-exported canonical schemas under local names for structural use below.
// These are the SAME object identities as packs/types (no redefinition).
const LocalePackSchema = CanonicalLocalePackSchema;
const DomainPackSchema = CanonicalDomainPackSchema;

// ── Request ──────────────────────────────────────────────────────────────────

export const EnrichmentRequestSchema = z
  .object({
    schemaVersion: z.literal(ENRICHMENT_CONTRACT_VERSION),
    snapshot: ExtractedFieldSnapshotSchema,
    listing: z
      .object({
        sourceListingId: z.string().min(1),
        adapterId: z.string().min(1),
        currentObservationId: z.string().min(1),
      })
      .strict(),
    observation: z
      .object({
        observationId: z.string().min(1),
        sourceListingId: z.string().min(1),
        immutable: z.literal(true),
      })
      .strict(),
    localePack: LocalePackSchema.optional(),
    domainPack: DomainPackSchema.optional(),
    employerCatalog: VerifiedEmployerCatalogSchema.optional(),
    budget: EnrichmentBudgetSchema,
    clock: EnrichmentClockSchema,
    requirePacks: z.boolean().default(false),
    requireVerifiedEmployer: z.boolean().default(false),
  })
  .strict()
  .superRefine((req, ctx) => {
    if (req.snapshot.observationId !== req.observation.observationId) {
      ctx.addIssue({ code: 'custom', message: 'observation id mismatch' });
    }
    if (req.snapshot.sourceListingId !== req.listing.sourceListingId) {
      ctx.addIssue({ code: 'custom', message: 'listing id mismatch' });
    }
    if (req.listing.currentObservationId !== req.observation.observationId) {
      ctx.addIssue({ code: 'custom', message: 'listing observation mismatch' });
    }
  });

// ── Types ────────────────────────────────────────────────────────────────────

export type EnrichmentStatus = z.infer<typeof EnrichmentStatusSchema>;
export type EnrichmentWarning = z.infer<typeof EnrichmentWarningSchema>;
export type EnrichmentBudget = z.infer<typeof EnrichmentBudgetSchema>;
export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>;
export type EnrichmentRequest = z.infer<typeof EnrichmentRequestSchema>;
export type ExtractedFieldSnapshot = z.infer<typeof ExtractedFieldSnapshotSchema>;
export type VerifiedEmployerRecord = z.infer<typeof VerifiedEmployerRecordSchema>;
export type VerifiedEmployerCatalog = z.infer<typeof VerifiedEmployerCatalogSchema>;
export type QualitySignal = z.infer<typeof QualitySignalSchema>;
