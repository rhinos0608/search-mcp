import { z } from 'zod/v4';
import type { SearchIntent } from '../domain/intent.js';
import type { JobPosting } from '../domain/posting.js';
import type { ScoreGroup } from '../assessment/contracts.js';
import type { EligibilityVerdict } from '../assessment/contracts.js';
import type { AcquisitionRunResult } from '../acquisition/coordinator.js';
import { ReasoningRunResultSchema } from '../reasoning/contracts.js';

export const JOBS_SEARCH_CONTRACT_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// Evidence state per candidate (observed / indexed / user provenance)
// ---------------------------------------------------------------------------

export const JobsSearchEvidenceStateSchema = z.enum([
  'observation_backed',
  'indexed_only',
  'user_supplied',
  'mixed_upgradeable',
]);
export type JobsSearchEvidenceState = z.infer<typeof JobsSearchEvidenceStateSchema>;

// ---------------------------------------------------------------------------
// Result candidate: utility / coverage / confidence / eligibility separate
// ---------------------------------------------------------------------------

export const JobsSearchCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    evidenceState: JobsSearchEvidenceStateSchema,
    /** Expected utility: weighted group mean, never RRF. */
    utility: z.number().min(0).max(1),
    /** Coverage ratio across assessed components. */
    coverage: z.number().min(0).max(1),
    /** Confidence: min-evidence-weighted, falls with missing evidence. */
    confidence: z.number().min(0).max(1),
    eligibility: z.enum(['eligible', 'conditionally_eligible', 'ineligible']),
    eligibilityGates: z
      .array(
        z
          .object({
            gateId: z.string().min(1),
            status: z.enum(['eligible', 'conditionally_eligible', 'ineligible']),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .max(32),
    groupScores: z.record(
      z.enum([
        'relevance',
        'candidateFit',
        'preferenceFit',
        'marketState',
        'evidenceQuality',
        'personalAdaptation',
      ]),
      z.number().min(0).max(1),
    ),
    /** RRF metadata only — never an input to utility. textBm25Score is the
    per-candidate BM25 channel score (null when the channel did not score). */
    retrievalMetadata: z
      .object({
        rrfRank: z.number().int().positive().nullable(),
        rrfScore: z.number().nonnegative().nullable(),
        scoredChannelCount: z.number().int().nonnegative(),
        textBm25Score: z.number().nullable(),
      })
      .strict(),
    flags: z.array(z.string().min(1)).max(16),
    caveats: z.array(z.string().min(1)).max(16),
    evidenceRefs: z.array(z.string().min(1)).max(128),
    /** Provenance labels retained per candidate (observed/indexed/user). */
    provenance: z
      .array(z.enum(['observed', 'indexed', 'user_supplied', 'deterministic_derived']))
      .max(8),
    sourceListingIds: z.array(z.string().min(1)).max(16),
    observationIds: z.array(z.string().min(1)).max(16),
    title: z.string().min(1).nullable(),
    organisation: z.string().min(1).nullable(),
    profileApplied: z.boolean(),
    rank: z.number().int().positive(),
    /** Active identity decision, when resolver merged or evaluated observations. */
    identityDecisionId: z.string().min(1).optional(),
    /** Revision of identity decision used for this candidate (none when unavailable). */
    identityDecisionRevision: z.string().min(1),
    /** Canonical, credential-free posting URL — an apply/inspect locator, never evidence text. */
    listingUrl: z.url().max(8192).optional(),
    /** Apply URL when extraction observed one. */
    applyUrl: z.url().max(8192).optional(),
    /** Bounded location label when extraction observed one. */
    location: z.string().min(1).max(256).optional(),
    /** Raw salary text when extraction resolved one. */
    salaryText: z.string().min(1).max(256).optional(),
    /** Bounded description; indexed placeholders are never copied here. */
    description: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type JobsSearchCandidate = z.infer<typeof JobsSearchCandidateSchema>;

// ---------------------------------------------------------------------------
// Coverage outcome per slice/adapter (nothing disappears silently)
// ---------------------------------------------------------------------------

export const JobsSearchCoverageOutcomeSchema = z
  .object({
    sliceId: z.string().min(1),
    adapterId: z.string().min(1),
    state: z.enum([
      'succeeded',
      'partial',
      'failed',
      'disabled',
      'policy_blocked',
      'not_supported',
      'skipped_budget',
      'skipped_deadline',
      'skipped_aborted',
    ]),
    candidatesProduced: z.number().int().nonnegative(),
    isolated: z.boolean(),
  })
  .strict();
export type JobsSearchCoverageOutcome = z.infer<typeof JobsSearchCoverageOutcomeSchema>;

// ---------------------------------------------------------------------------
// Request (private internal contract — MCP surface stays later)
// ---------------------------------------------------------------------------

export interface JobsSearchRequest {
  readonly intent: SearchIntent;
  readonly plan: import('../acquisition/coordinator.js').AcquisitionSlicePlanItem[];
  readonly runId: string;
  readonly capturedAt: string;
  readonly budget: import('../acquisition/coordinator.js').AcquisitionRunBudget;
  readonly domainPack?: import('../packs/types.js').DomainPack;
  readonly localePack?: import('../packs/types.js').LocalePack;
  readonly profileInput?: unknown;
  readonly allowedProfileTermRefs?: ReadonlySet<string>;
  readonly learnedResidual?: import('../feedback/contracts.js').LearnedResidual;
  readonly explicitPreferenceKeys?: readonly import('../feedback/contracts.js').ResidualFeatureKey[];
  readonly reasoningProvider?: import('../reasoning/provider.js').ReasoningProvider;
  readonly reasoningBudget?: number;
  readonly groupWeights?: Partial<Record<ScoreGroup, number>>;
  readonly nowMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly monotonicNow?: () => number;
}

export interface JobsSearchDeps {
  readonly policyRegistry: import('../acquisition/policy/registry.js').SourcePolicyRegistry;
  readonly capabilityRegistry: import('../acquisition/adapterRegistry.js').AdapterCapabilityRegistry;
  readonly ports: readonly import('../acquisition/providers/ports.js').IndexedProviderPort[];
  readonly scrapeJobs: (
    params: Record<string, unknown>,
  ) => Promise<import('../acquisition/adapters/jobspy.js').JobSpyScrapeResult>;
  readonly idempotencyStore?: import('../reasoning/submit.js').IdempotencyStore;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export const JobsSearchResultSchema = z
  .object({
    schemaVersion: z.literal(JOBS_SEARCH_CONTRACT_VERSION),
    runId: z.string().min(1),
    status: z.enum(['completed', 'partial', 'budget_exhausted', 'deadline_exceeded', 'aborted']),
    candidates: z.array(JobsSearchCandidateSchema).max(100),
    coverageOutcomes: z.array(JobsSearchCoverageOutcomeSchema).max(100),
    acquisitionStatus: z.string().min(1),
    warnings: z.array(z.string().min(1)).max(100),
    /** Validated model advisory; never merged into posting facts. */
    reasoningAdvisory: ReasoningRunResultSchema.optional(),
    eligibilitySummary: z.record(
      z.enum(['eligible', 'conditionally_eligible', 'ineligible']),
      z.number().int().nonnegative(),
    ),
    versions: z
      .object({
        contractVersion: z.literal(JOBS_SEARCH_CONTRACT_VERSION),
        acquisitionVersion: z.string().min(1),
        extractorVersion: z.string().min(1),
        identityResolverVersion: z.string().min(1),
        retrievalVersion: z.string().min(1),
        assessmentVersion: z.string().min(1),
        rankingVersion: z.string().min(1),
        reasoningFallback: z.string().min(1).optional(),
        packVersions: z.array(z.string().min(1)).max(8),
      })
      .strict(),
  })
  .strict();
export type JobsSearchResult = z.infer<typeof JobsSearchResultSchema>;

// ---------------------------------------------------------------------------
// Errors (typed, no silent disappearance)
// ---------------------------------------------------------------------------

export const JobsSearchErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'BUDGET_EXHAUSTED',
  'DEADLINE_EXCEEDED',
  'ABORTED',
  'ACQUISITION_FAILED',
  'NO_CANDIDATES',
]);
export type JobsSearchErrorCode = z.infer<typeof JobsSearchErrorCodeSchema>;

export class JobsSearchError extends Error {
  readonly code: JobsSearchErrorCode;
  /** Optional bounded acquisition warnings attached on the error path (additive). */
  readonly warnings?: readonly string[];
  constructor(code: JobsSearchErrorCode, message: string, warnings?: readonly string[]) {
    super(message);
    this.name = 'JobsSearchError';
    this.code = code;
    if (warnings !== undefined) this.warnings = Object.freeze([...warnings]);
  }
}

export type { AcquisitionRunResult, EligibilityVerdict, JobPosting };
