import { z } from 'zod/v4';
import { EvidenceIdSchema, InstantSchema, JobPostingIdSchema } from '../domain/ids.js';
import { EvidenceKindSchema } from '../domain/evidence.js';
import { JobFlagSchema } from '../domain/posting.js';
import { PacketHashSchema, ReasoningPacketIdSchema, ReasoningSubmissionIdSchema } from './ids.js';

export const REASONING_CONTRACT_VERSION = '1.0.0' as const;

export const REASONING_BOUNDS = {
  maxCandidates: 8,
  maxQuestions: 8,
  maxEvidenceExcerpts: 16,
  maxExcerptChars: 400,
  maxPacketBytes: 32_768,
  maxAnswers: 8,
  maxAnnotations: 8,
  maxProposedClaims: 8,
  maxIdempotencyKeyChars: 128,
  maxProposalTextChars: 512,
  maxProviderInvocationsPerRun: 1,
} as const;

// ─── W9 port (input only) ────────────────────────────────────────────

export const GroupedUtilitySchema = z
  .object({
    relevance: z.number(),
    candidateFit: z.number(),
    preferenceFit: z.number(),
    marketState: z.number(),
    evidenceQuality: z.number(),
    personalAdaptation: z.number(),
  })
  .strict();

export const RankedCandidateViewSchema = z
  .object({
    postingId: JobPostingIdSchema,
    canonicalRevision: z.number().int().nonnegative(),
    identityDecisionRevision: z.string().min(1),
    title: z.string().min(1).max(200),
    organisation: z.string().min(1).max(200),
    normalizedTitle: z.string().min(1).max(200),
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
    expectedUtility: z.number(),
    evidenceCoverage: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    grouped: GroupedUtilitySchema,
    flags: z.array(JobFlagSchema).max(16),
    evidenceRefs: z.array(EvidenceIdSchema).max(32),
    rank: z.number().int().positive(),
  })
  .strict();

export type RankedCandidateView = z.infer<typeof RankedCandidateViewSchema>;

// ─── Packet ───────────────────────────────────────────────────────────

export const PacketEvidenceExcerptSchema = z
  .object({
    evidenceId: EvidenceIdSchema,
    kind: EvidenceKindSchema,
    fieldPath: z.string().min(1).max(128).optional(),
    excerpt: z.string().min(1).max(REASONING_BOUNDS.maxExcerptChars),
  })
  .strict();

export const AmbiguousQuestionSchema = z
  .object({
    questionId: z.string().min(1).max(128),
    kind: z.enum([
      'eligibility',
      'requirement_force',
      'identity',
      'missing_evidence',
      'conflict',
      'preference_tradeoff',
    ]),
    text: z.string().min(1).max(280),
    postingId: JobPostingIdSchema.optional(),
    evidenceRefs: z.array(EvidenceIdSchema).max(8),
  })
  .strict();

export const ReasoningAllowedResponseSchemaSchema = z
  .object({
    schemaId: z.literal('jobs.reasoning.proposal.v1'),
    schemaVersion: z.literal(REASONING_CONTRACT_VERSION),
  })
  .strict();

export const ReasoningPacketVersionsSchema = z
  .object({
    contractVersion: z.literal(REASONING_CONTRACT_VERSION),
    rankingVersion: z.string().min(1).max(64),
    packVersions: z.array(z.string().min(1).max(64)).max(16),
    extractorVersion: z.string().min(1).max(64).optional(),
    promptVersion: z.literal('jobs.reasoning.prompt.v1'),
  })
  .strict();

export const ReasoningPacketSchema = z
  .object({
    schemaVersion: z.literal(REASONING_CONTRACT_VERSION),
    packetId: ReasoningPacketIdSchema,
    packetRevision: z.number().int().nonnegative(),
    packetHash: PacketHashSchema,
    producedAt: InstantSchema,
    runId: z.string().min(1).max(128),
    versions: ReasoningPacketVersionsSchema,
    rankingRevision: z.string().min(1).max(128),
    profileRevision: z.string().min(1).max(128).optional(),
    intentStrictness: z.enum(['normal', 'strict']),
    unknownPolicy: z.enum(['include', 'exclude']),
    candidates: z.array(RankedCandidateViewSchema).max(REASONING_BOUNDS.maxCandidates),
    questions: z.array(AmbiguousQuestionSchema).max(REASONING_BOUNDS.maxQuestions),
    evidenceExcerpts: z
      .array(PacketEvidenceExcerptSchema)
      .max(REASONING_BOUNDS.maxEvidenceExcerpts),
    allowedEvidenceIds: z.array(EvidenceIdSchema).max(32),
    allowedResponseSchema: ReasoningAllowedResponseSchemaSchema,
    redacted: z.literal(true),
  })
  .strict();

export type ReasoningPacket = z.infer<typeof ReasoningPacketSchema>;

// ─── Proposal / submission ────────────────────────────────────────────

export const QuestionAnswerSchema = z
  .object({
    kind: z.literal('answer'),
    questionId: z.string().min(1).max(128),
    text: z.string().min(1).max(REASONING_BOUNDS.maxProposalTextChars),
    evidenceRefs: z.array(EvidenceIdSchema).min(1).max(8),
  })
  .strict();

export const CandidateAnnotationSchema = z
  .object({
    kind: z.literal('annotation'),
    postingId: JobPostingIdSchema,
    text: z.string().min(1).max(REASONING_BOUNDS.maxProposalTextChars),
    evidenceRefs: z.array(EvidenceIdSchema).min(1).max(8),
    addFlags: z.array(z.literal('model_assessment_unverified')).max(1),
  })
  .strict();

export const ProposedModelClaimSchema = z
  .object({
    kind: z.literal('model_claim'),
    postingId: JobPostingIdSchema,
    fieldPath: z.string().min(1).max(128),
    value: z.unknown(),
    evidenceRefs: z.array(EvidenceIdSchema).min(1).max(8),
    confidence: z.number().min(0).max(1),
    origin: z.literal('model_derived'),
    method: z.literal('optional_reasoning_v1'),
  })
  .strict();

export const ReasoningProposalBodySchema = z
  .object({
    schemaId: z.literal('jobs.reasoning.proposal.v1'),
    schemaVersion: z.literal(REASONING_CONTRACT_VERSION),
    answers: z.array(QuestionAnswerSchema).max(REASONING_BOUNDS.maxAnswers),
    annotations: z.array(CandidateAnnotationSchema).max(REASONING_BOUNDS.maxAnnotations),
    proposedClaims: z.array(ProposedModelClaimSchema).max(REASONING_BOUNDS.maxProposedClaims),
  })
  .strict();

export type ReasoningProposalBody = z.infer<typeof ReasoningProposalBodySchema>;

const FORBIDDEN_PROPOSAL_KEYS = [
  'preferences',
  'searchIntent',
  'unknownPolicy',
  'strictness',
  'observations',
  'observationId',
  'payloadRef',
  'immutable',
  'expectedUtility',
  'grouped',
  'rank',
  'evidenceCoverage',
] as const;

function hasForbiddenKey(obj: Record<string, unknown>): string | undefined {
  for (const key of FORBIDDEN_PROPOSAL_KEYS) {
    if (key in obj) return key;
  }
  return undefined;
}

export const ReasoningSubmissionSchema = z
  .object({
    schemaVersion: z.literal(REASONING_CONTRACT_VERSION),
    submissionId: ReasoningSubmissionIdSchema,
    packetId: ReasoningPacketIdSchema,
    packetHash: PacketHashSchema,
    expectedPacketRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1).max(REASONING_BOUNDS.maxIdempotencyKeyChars),
    proposal: ReasoningProposalBodySchema,
    provenance: z
      .object({
        component: z.literal('jobs.reasoning'),
        version: z.literal(REASONING_CONTRACT_VERSION),
        origin: z.enum(['model_derived', 'deterministic_derived']),
        model: z.string().min(1).max(128).optional(),
        promptVersion: z.string().min(1).max(64).optional(),
        producedAt: InstantSchema,
        degradation: z.enum([
          'none',
          'no_provider',
          'budget_zero',
          'provider_failed',
          'provider_invalid',
        ]),
      })
      .strict(),
  })
  .strict();

export type ReasoningSubmission = z.infer<typeof ReasoningSubmissionSchema>;

// ─── Errors ───────────────────────────────────────────────────────────

export const ReasoningErrorCodeSchema = z.enum([
  'PACKET_HASH_MISMATCH',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'UNKNOWN_EVIDENCE_ID',
  'PREFERENCE_MUTATION_FORBIDDEN',
  'OBSERVATION_MUTATION_FORBIDDEN',
  'OBSERVED_CLAIM_MUTATION_FORBIDDEN',
  'UTILITY_MUTATION_FORBIDDEN',
  'RAW_PROFILE_EXPOSURE',
  'SCHEMA_INVALID',
  'PACKET_BUDGET_EXCEEDED',
  'UNSUPPORTED_SCHEMA_VERSION',
]);

export type ReasoningErrorCode = z.infer<typeof ReasoningErrorCodeSchema>;

export const ReasoningErrorSchema = z
  .object({
    ok: z.literal(false),
    code: ReasoningErrorCodeSchema,
    retryable: z.literal(false),
  })
  .strict();

export type ReasoningError = z.infer<typeof ReasoningErrorSchema>;

// ─── Run result ───────────────────────────────────────────────────────

export const ReasoningAcceptanceSchema = z
  .object({
    ok: z.literal(true),
    submissionId: ReasoningSubmissionIdSchema,
    packetId: ReasoningPacketIdSchema,
    packetHash: PacketHashSchema,
    idempotentReplay: z.boolean(),
    proposal: ReasoningProposalBodySchema,
    provenance: ReasoningSubmissionSchema.shape.provenance,
  })
  .strict();

export type ReasoningAcceptance = z.infer<typeof ReasoningAcceptanceSchema>;

export const ReasoningRunResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('accepted'),
      acceptance: ReasoningAcceptanceSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('rejected'),
      error: ReasoningErrorSchema,
      fallback: ReasoningProposalBodySchema,
      provenance: ReasoningSubmissionSchema.shape.provenance,
    })
    .strict(),
  z
    .object({
      status: z.literal('skipped'),
      fallback: ReasoningProposalBodySchema,
      provenance: ReasoningSubmissionSchema.shape.provenance,
    })
    .strict(),
]);

export type ReasoningRunResult = z.infer<typeof ReasoningRunResultSchema>;

// ─── W9 port types (used by packet builder) ──────────────────────────

export type GroupedUtility = z.infer<typeof GroupedUtilitySchema>;
export type PacketEvidenceExcerpt = z.infer<typeof PacketEvidenceExcerptSchema>;
export type AmbiguousQuestion = z.infer<typeof AmbiguousQuestionSchema>;

// ─── Helpers (exported for submit.ts) ─────────────────────────────────

export { hasForbiddenKey, FORBIDDEN_PROPOSAL_KEYS };
