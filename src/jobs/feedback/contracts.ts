import { z } from 'zod/v4';
import { InstantSchema } from '../domain/ids.js';

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

export const FEEDBACK_CONTRACT_VERSION = '1.0.0' as const;
export const FEEDBACK_PROFILE_ID = 'profile:default' as const;

// ---------------------------------------------------------------------------
// Numeric bounds
// ---------------------------------------------------------------------------

export const LEARNING_RATE = 0.05 as const;
export const LEARNING_RATE_MAX = 0.05 as const;
export const RESIDUAL_FEATURE_ABS_MAX = 0.08 as const;
export const PERSONAL_ADAPTATION_ABS_MAX = 0.1 as const;
export const MAX_INTERACTIONS = 10_000 as const;
export const MAX_FEATURES = 64 as const;
export const MAX_IDEMPOTENCY_KEY = 128 as const;

// ---------------------------------------------------------------------------
// Learning weights and rating map
// ---------------------------------------------------------------------------

export const LEARNING_WEIGHT = {
  view: 0,
  click: 0.2,
  save: 0.5,
  apply: 1.0,
  dismiss: -0.6,
  rating: 0.8,
} as const;

export const RATING_MAP = {
  1: -1,
  2: -0.5,
  3: 0,
  4: 0.5,
  5: 1,
} as const;

// ---------------------------------------------------------------------------
// Interaction type enum
// ---------------------------------------------------------------------------

export const InteractionTypeSchema = z.enum([
  'view',
  'click',
  'save',
  'apply',
  'dismiss',
  'rating',
]);
export type InteractionType = z.infer<typeof InteractionTypeSchema>;

// ---------------------------------------------------------------------------
// Residual dimension and feature key
// ---------------------------------------------------------------------------

export const ResidualDimensionSchema = z.enum([
  'work_mode',
  'employment_type',
  'role',
  'location',
  'sector',
  'compensation_band',
]);
export type ResidualDimension = z.infer<typeof ResidualDimensionSchema>;

export const ResidualFeatureKeySchema = z
  .object({
    dimension: ResidualDimensionSchema,
    value: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
  })
  .strict()
  .superRefine((key, ctx) => {
    const VALID_WORK_MODE = ['onsite', 'hybrid', 'remote'] as const;
    const VALID_EMPLOYMENT = [
      'full_time',
      'part_time',
      'casual',
      'contract',
      'temporary',
      'internship',
    ] as const;
    const VALID_COMP_BAND = ['below_min', 'meets_min', 'unknown_comp'] as const;
    if (
      key.dimension === 'work_mode' &&
      !(VALID_WORK_MODE as readonly string[]).includes(key.value)
    ) {
      ctx.addIssue({ code: 'custom', message: `invalid work_mode value: ${key.value}` });
    }
    if (
      key.dimension === 'employment_type' &&
      !(VALID_EMPLOYMENT as readonly string[]).includes(key.value)
    ) {
      ctx.addIssue({ code: 'custom', message: `invalid employment_type value: ${key.value}` });
    }
    if (
      key.dimension === 'compensation_band' &&
      !(VALID_COMP_BAND as readonly string[]).includes(key.value)
    ) {
      ctx.addIssue({ code: 'custom', message: `invalid compensation_band value: ${key.value}` });
    }
  });
export type ResidualFeatureKey = z.infer<typeof ResidualFeatureKeySchema>;

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

export type InteractionId = `feedback-interaction:${string}`;
export type ResidualSnapshotId = `feedback-residual:${string}`;

export const InteractionIdSchema = z
  .string()
  .regex(/^feedback-interaction:[0-9a-f]{64}$/u) as z.ZodType<InteractionId>;
export const ResidualSnapshotIdSchema = z
  .string()
  .regex(/^feedback-residual:[0-9a-f]{64}$/u) as z.ZodType<ResidualSnapshotId>;

// ---------------------------------------------------------------------------
// Grouped score breakdown (W9-owned numbers, W11-owned write set)
// ---------------------------------------------------------------------------

export const GroupedScoreBreakdownSchema = z
  .object({
    relevance: z.number(),
    candidateFit: z.number(),
    preferenceFit: z.number(),
    marketState: z.number(),
    evidenceQuality: z.number(),
    personalAdaptation: z.number(),
  })
  .strict();
export type GroupedScoreBreakdown = z.infer<typeof GroupedScoreBreakdownSchema>;

// ---------------------------------------------------------------------------
// Core objects
// ---------------------------------------------------------------------------

export const RecordedInteractionSchema = z
  .object({
    interactionId: InteractionIdSchema,
    contractVersion: z.literal(FEEDBACK_CONTRACT_VERSION),
    profileId: z.literal(FEEDBACK_PROFILE_ID),
    type: InteractionTypeSchema,
    postingId: z.string().min(1).max(256),
    occurredAt: InstantSchema,
    idempotencyKey: z.string().min(1).max(MAX_IDEMPOTENCY_KEY),
    rating: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
      .optional(),
    featureKeys: z.array(ResidualFeatureKeySchema).max(MAX_FEATURES),
    runId: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.type === 'rating' && row.rating === undefined) {
      ctx.addIssue({ code: 'custom', path: ['rating'], message: 'rating_required' });
    }
    if (row.type !== 'rating' && row.rating !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['rating'], message: 'rating_not_allowed' });
    }
  });
export type RecordedInteraction = z.infer<typeof RecordedInteractionSchema>;

export const LearnedResidualSchema = z
  .object({
    snapshotId: ResidualSnapshotIdSchema,
    contractVersion: z.literal(FEEDBACK_CONTRACT_VERSION),
    profileId: z.literal(FEEDBACK_PROFILE_ID),
    features: z
      .array(
        z
          .object({
            key: ResidualFeatureKeySchema,
            value: z.number(),
          })
          .strict(),
      )
      .max(MAX_FEATURES),
    updatedAt: InstantSchema,
    interactionCount: z.number().int().nonnegative(),
  })
  .strict();
export type LearnedResidual = z.infer<typeof LearnedResidualSchema>;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const RecordInteractionInputSchema = z
  .object({
    type: InteractionTypeSchema,
    postingId: z.string().min(1).max(256),
    occurredAt: InstantSchema,
    idempotencyKey: z.string().min(1).max(MAX_IDEMPOTENCY_KEY),
    rating: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
      .optional(),
    featureKeys: z.array(ResidualFeatureKeySchema).max(MAX_FEATURES),
    runId: z.string().min(1).max(256).optional(),
    explicitPreferenceKeys: z.array(ResidualFeatureKeySchema).max(32),
  })
  .strict();
export type RecordInteractionInput = z.infer<typeof RecordInteractionInputSchema>;

export const DeleteInteractionInputSchema = z
  .object({
    election: z.literal(true),
    interactionId: InteractionIdSchema,
  })
  .strict();

export const DeleteAllFeedbackInputSchema = z
  .object({
    election: z.literal(true),
  })
  .strict();

export const ApplyResidualInputSchema = z
  .object({
    grouped: GroupedScoreBreakdownSchema,
    residual: LearnedResidualSchema,
    candidateFeatureKeys: z.array(ResidualFeatureKeySchema).max(MAX_FEATURES),
    explicitPreferenceKeys: z.array(ResidualFeatureKeySchema).max(32),
  })
  .strict();

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

export type FeedbackErrorCode =
  | 'VALIDATION_ERROR'
  | 'FORBIDDEN_FORWARD'
  | 'NOT_FOUND'
  | 'STORE_INCONSISTENT'
  | 'LEARNING_RATE_FORBIDDEN';

export const FeedbackErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'FORBIDDEN_FORWARD',
  'NOT_FOUND',
  'STORE_INCONSISTENT',
  'LEARNING_RATE_FORBIDDEN',
]);

export class FeedbackError extends Error {
  readonly code: FeedbackErrorCode;
  constructor(code: FeedbackErrorCode, message: string) {
    super(message);
    this.name = 'FeedbackError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// FeedbackExport (only public projection)
// ---------------------------------------------------------------------------

export interface FeedbackExport {
  contractVersion: typeof FEEDBACK_CONTRACT_VERSION;
  residualVersion: ResidualSnapshotId;
  personalAdaptationBound: typeof PERSONAL_ADAPTATION_ABS_MAX;
  featureCount: number;
  interactionCount: number;
  hasNonZeroResidual: boolean;
}
