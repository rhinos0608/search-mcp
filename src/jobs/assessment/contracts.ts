/**
 * W9 Assessment contracts.
 *
 * Grouped score fields for candidate assessment:
 *   relevance, candidateFit, preferenceFit, marketState, evidenceQuality, personalAdaptation
 *
 * Frozen invariants:
 *   - Missing evidence → stable 0.5, coverage/confidence falls, weights never redistributed
 *   - Eligibility separate/discrete from expected utility
 *   - Explicit preference contributes exactly once
 *   - RRF/union metadata excluded from utility inputs
 *   - No LLM, no network, no locale defaults, no persistence
 *   - Strict/bounded schemas, deterministic ties, explainable evidence refs/flags
 */

import { z } from 'zod/v4';
import { InstantSchema, EvidenceRefSchema } from '../domain/ids.js';

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

export const ASSESSMENT_CONTRACT_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// Component score groups
// ---------------------------------------------------------------------------

/** Exactly these six groups. No more, no fewer. */
export const ScoreGroupSchema = z.enum([
  'relevance',
  'candidateFit',
  'preferenceFit',
  'marketState',
  'evidenceQuality',
  'personalAdaptation',
]);
export type ScoreGroup = z.infer<typeof ScoreGroupSchema>;

export const SCORE_GROUPS: readonly ScoreGroup[] = [
  'relevance',
  'candidateFit',
  'preferenceFit',
  'marketState',
  'evidenceQuality',
  'personalAdaptation',
] as const;

// ---------------------------------------------------------------------------
// Component score (within a group)
// ---------------------------------------------------------------------------

export const ComponentScoreSchema = z
  .object({
    /** Sub-dimension name within the group. */
    dimension: z.string().min(1).max(64),
    /** Score in [0, 1]. */
    score: z.number().min(0).max(1),
    /** Whether this component had real evidence (false = missing → 0.5 fallback). */
    hasEvidence: z.boolean(),
    /** Evidence refs supporting this score. Empty when missing/absent. */
    evidenceRefs: z.array(EvidenceRefSchema).max(32),
    /** Confidence in the score [0, 1]. Lower when evidence is weak/absent. */
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type ComponentScore = z.infer<typeof ComponentScoreSchema>;

// ---------------------------------------------------------------------------
// Assessment group (all components within a group)
// ---------------------------------------------------------------------------

export const AssessmentGroupSchema = z
  .object({
    group: ScoreGroupSchema,
    /** Aggregated score for this group: mean of component scores, weighted by confidence. */
    score: z.number().min(0).max(1),
    /** Number of components with real evidence. */
    coverage: z.number().int().nonnegative(),
    /** Total number of components evaluated. */
    totalComponents: z.number().int().positive(),
    /** Coverage ratio = coverage / totalComponents. */
    coverageRatio: z.number().min(0).max(1),
    /** Components in this group. */
    components: z.array(ComponentScoreSchema).min(1),
    /** Evidence refs aggregated across all components in this group. */
    evidenceRefs: z.array(EvidenceRefSchema).max(128),
  })
  .strict();
export type AssessmentGroup = z.infer<typeof AssessmentGroupSchema>;

// ---------------------------------------------------------------------------
// Eligibility (discrete, separate from utility)
// ---------------------------------------------------------------------------

export const EligibilityStatusSchema = z.enum(['eligible', 'conditionally_eligible', 'ineligible']);
export type EligibilityStatus = z.infer<typeof EligibilityStatusSchema>;

export const EligibilityGateSchema = z
  .object({
    gateId: z.string().min(1).max(128),
    status: EligibilityStatusSchema,
    reason: z.string().min(1).max(512),
    evidenceRefs: z.array(EvidenceRefSchema).max(16),
  })
  .strict();
export type EligibilityGate = z.infer<typeof EligibilityGateSchema>;

export const EligibilityVerdictSchema = z
  .object({
    status: EligibilityStatusSchema,
    gates: z.array(EligibilityGateSchema).max(32),
  })
  .strict();
export type EligibilityVerdict = z.infer<typeof EligibilityVerdictSchema>;

// ---------------------------------------------------------------------------
// Personal adaptation delta (W11)
// ---------------------------------------------------------------------------

export const PersonalAdaptationDeltaSchema = z
  .object({
    /** Raw delta from W11 learning. Accepted only within ±0.10. */
    delta: z.number().min(-1).max(1),
    /** Whether delta was within the accepted range. */
    accepted: z.boolean(),
    /** Applied delta (always within accepted range since out-of-range throws). */
    appliedDelta: z.number().min(-0.1).max(0.1),
    /** Evidence refs for the delta. */
    evidenceRefs: z.array(EvidenceRefSchema).max(16),
  })
  .strict();
export type PersonalAdaptationDelta = z.infer<typeof PersonalAdaptationDeltaSchema>;

/** Accepted delta range. */
export const W11_DELTA_RANGE = 0.1 as const;

// ---------------------------------------------------------------------------
// Assessment result (per candidate)
// ---------------------------------------------------------------------------

export const CandidateAssessmentSchema = z
  .object({
    candidateId: z.string().min(1),
    /** Six grouped scores. */
    groups: z.array(AssessmentGroupSchema).length(6),
    /** Overall utility score (0-1), weighted mean of group scores. */
    utilityScore: z.number().min(0).max(1),
    /** Eligibility verdict (discrete, separate from utility). */
    eligibility: EligibilityVerdictSchema,
    /** Personal adaptation delta handling. */
    personalAdaptation: PersonalAdaptationDeltaSchema,
    /** Evidence quality summary. */
    evidenceQualitySummary: z
      .object({
        totalEvidenceRefs: z.number().int().nonnegative(),
        uniqueEvidenceRefs: z.number().int().nonnegative(),
        coverageRatio: z.number().min(0).max(1),
      })
      .strict(),
    /** Flags for explainability. */
    flags: z.array(z.string().min(1).max(128)).max(16),
  })
  .strict();
export type CandidateAssessment = z.infer<typeof CandidateAssessmentSchema>;

// ---------------------------------------------------------------------------
// Assessment result (full)
// ---------------------------------------------------------------------------

export const AssessmentResultSchema = z
  .object({
    schemaVersion: z.literal(ASSESSMENT_CONTRACT_VERSION),
    runId: z.string().min(1),
    /** Candidate assessments, sorted by utilityScore desc, then candidateId asc. */
    candidates: z.array(CandidateAssessmentSchema),
    /** Group weights used for utility aggregation. */
    groupWeights: z.record(ScoreGroupSchema, z.number().min(0).max(1)),
    /** Total weight of groups with non-zero weight. */
    activeGroupCount: z.number().int().nonnegative(),
    /** Emitted timestamp. */
    emittedAt: InstantSchema,
  })
  .strict();
export type AssessmentResult = z.infer<typeof AssessmentResultSchema>;

// ---------------------------------------------------------------------------
// Default group weights
// ---------------------------------------------------------------------------

export const DEFAULT_GROUP_WEIGHTS: Record<ScoreGroup, number> = {
  relevance: 0.25,
  candidateFit: 0.2,
  preferenceFit: 0.15,
  marketState: 0.1,
  evidenceQuality: 0.15,
  personalAdaptation: 0.15,
} as const;

// ---------------------------------------------------------------------------
// Group weight schema
// ---------------------------------------------------------------------------

export const GroupWeightsSchema = z
  .record(ScoreGroupSchema, z.number().min(0).max(1))
  .refine((w) => Object.values(w).every((v) => v >= 0 && v <= 1), 'weights must be in [0, 1]');
export type GroupWeights = z.infer<typeof GroupWeightsSchema>;
