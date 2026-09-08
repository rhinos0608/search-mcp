import { z } from 'zod/v4';
import { ClaimCandidateSchema, ResolvedClaimSchema } from './claims.js';
import {
  EvidenceRefSchema,
  InstantSchema,
  JobPostingIdSchema,
  SourceListingIdSchema,
  SourceObservationIdSchema,
} from './ids.js';

export const LocationSchema = z
  .object({
    country: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    postcode: z.string().min(1).optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    remoteEligible: z.boolean().optional(),
  })
  .strict();
export type Location = z.infer<typeof LocationSchema>;
export const SalaryIntervalSchema = z
  .object({
    min: z.number().nonnegative().optional(),
    max: z.number().nonnegative().optional(),
    currency: z.string().min(3).max(3),
    unit: z.enum(['hour', 'day', 'week', 'month', 'year']),
    period: z.enum(['annualized', 'stated']).default('stated'),
    raw: z.string().min(1),
  })
  .refine(
    (v) => v.min === undefined || v.max === undefined || v.min <= v.max,
    'salary min must not exceed max',
  );
export type SalaryInterval = z.infer<typeof SalaryIntervalSchema>;
export const ClassificationSchema = z
  .object({
    scheme: z.string().min(1),
    value: z.string().min(1),
    level: z.string().min(1).optional(),
  })
  .strict();
export type Classification = z.infer<typeof ClassificationSchema>;
export const RequirementSchema = z
  .object({
    rawText: z.string().min(1),
    category: z.enum([
      'skill',
      'experience',
      'qualification',
      'licence',
      'clearance',
      'registration',
      'work_rights',
      'employment_check',
      'availability',
      'application_material',
      'other',
    ]),
    force: z.enum(['mandatory', 'preferred', 'uncertain']),
    semanticCapability: z.string().min(1).optional(),
    years: z
      .object({
        min: z.number().nonnegative().optional(),
        max: z.number().nonnegative().optional(),
        unit: z.enum(['month', 'year']),
      })
      .strict()
      .optional(),
    qualification: z.string().min(1).optional(),
    licence: z.string().min(1).optional(),
    clearance: z.string().min(1).optional(),
    registration: z.string().min(1).optional(),
    evidenceRefs: z.array(EvidenceRefSchema),
    confidence: z.number().min(0).max(1),
    interpretationProvenance: z.string().min(1),
  })
  .strict();
export type Requirement = z.infer<typeof RequirementSchema>;
export const JobPostingFieldEvidenceLinkSchema = z
  .object({
    fieldPath: z.string().min(1),
    evidenceRefs: z.array(EvidenceRefSchema).min(1),
  })
  .strict();
export type JobPostingFieldEvidenceLink = z.infer<typeof JobPostingFieldEvidenceLinkSchema>;

export const JobFlagSchema = z.enum([
  'conflicting_source_evidence',
  'stale_fallback',
  'partial_source_coverage',
  'identified_position_requirement',
  'model_assessment_unverified',
  'manual_import_unverified',
  'eligibility_unknown',
  'registration_not_evidenced',
]);
export type JobFlag = z.infer<typeof JobFlagSchema>;
export const JobPostingSchema = z
  .object({
    postingId: JobPostingIdSchema,
    schemaVersion: z.string().min(1),
    canonicalRevision: z.number().int().nonnegative(),
    title: z.string().min(1),
    normalizedTitle: z.string().min(1),
    organisation: z.string().min(1),
    organisationUnit: z.string().min(1).optional(),
    sector: z.string().min(1).optional(),
    industry: z.string().min(1).optional(),
    roleFamilies: z.array(
      z
        .object({
          family: z.string().min(1),
          confidence: z.number().min(0).max(1),
          evidenceRefs: z.array(EvidenceRefSchema),
        })
        .strict(),
    ),
    locations: z.array(LocationSchema).min(1),
    workMode: z.enum(['onsite', 'hybrid', 'remote', 'unknown']),
    employmentType: z.enum([
      'full_time',
      'part_time',
      'casual',
      'contract',
      'temporary',
      'internship',
      'unknown',
    ]),
    hoursFte: z.number().positive().optional(),
    salaries: z.array(SalaryIntervalSchema),
    classifications: z.array(ClassificationSchema),
    seniority: z.enum(['entry', 'mid', 'senior', 'lead', 'executive', 'unknown']).optional(),
    postedAt: InstantSchema.optional(),
    closingAt: InstantSchema.optional(),
    startAt: InstantSchema.optional(),
    applyUrl: z.url().optional(),
    listingUrls: z.array(z.url()),
    description: z.string().min(1),
    responsibilities: z.array(z.string().min(1)),
    requirements: z.array(RequirementSchema),
    desirableCriteria: z.array(z.string().min(1)),
    applicationRequirements: z.array(z.string().min(1)),
    selectionQuestions: z.array(z.string().min(1)),
    vacancyCount: z.number().int().nonnegative().optional(),
    securityClearance: z.string().min(1).optional(),
    licencesChecksRegistration: z.array(z.string().min(1)),
    workRights: z.string().min(1).optional(),
    targetedPosition: z.boolean().optional(),
    contactMetadata: z
      .record(z.string().min(1).max(128), z.string().max(2048))
      .refine(
        (value) => Object.keys(value).length <= 32,
        'contact metadata exceeds maximum entries',
      )
      .optional(),
    verificationState: z.enum(['unverified', 'partially_verified', 'verified']),
    lifecycleState: z.enum([
      'discovered',
      'active',
      'probably_closed',
      'confirmed_closed',
      'expired',
      'superseded',
    ]),
    flags: z.array(JobFlagSchema),
    confidence: z.number().min(0).max(1),
    caveats: z.array(z.string()),
    evidenceRefs: z.array(EvidenceRefSchema),
    /** Relational links keep field provenance queryable without EAV claims. */
    fieldEvidenceLinks: z.array(JobPostingFieldEvidenceLinkSchema).optional(),
    claimCandidates: z.array(ClaimCandidateSchema).optional(),
    claimResolutions: z.record(z.string().min(1), ResolvedClaimSchema).optional(),
    sourceListingIds: z.array(SourceListingIdSchema),
    observationIds: z.array(SourceObservationIdSchema),
    identityDecisionRevision: z.string().min(1),
  })
  .strict();
export type JobPosting = z.infer<typeof JobPostingSchema>;
