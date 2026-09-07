import { z } from 'zod/v4';

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

export const RETRIEVAL_CONTRACT_VERSION = '1.0.0' as const;

export const LEXICAL_TRANSFORM_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// Channel identifiers
// ---------------------------------------------------------------------------

export const RetrievalChannelIdSchema = z.enum([
  'text_bm25',
  'role_family',
  'capability_overlap',
  'geography',
  'semantic',
]);
export type RetrievalChannelId = z.infer<typeof RetrievalChannelIdSchema>;

// ---------------------------------------------------------------------------
// Channel weights (frozen at call time, no redistribution on omission)
// ---------------------------------------------------------------------------

export const RetrievalChannelWeightsSchema = z
  .object({
    text_bm25: z.number().min(0).max(1),
    role_family: z.number().min(0).max(1),
    capability_overlap: z.number().min(0).max(1),
    geography: z.number().min(0).max(1),
    semantic: z.number().min(0).max(1).default(0),
  })
  .strict();
export type RetrievalChannelWeights = z.infer<typeof RetrievalChannelWeightsSchema>;

// Default weights: semantic disabled, others evenly distributed among 4 channels
export const DEFAULT_RETRIEVAL_WEIGHTS: RetrievalChannelWeights = {
  text_bm25: 0.3,
  role_family: 0.25,
  capability_overlap: 0.2,
  geography: 0.25,
  semantic: 0,
} as const;

// ---------------------------------------------------------------------------
// Per-channel scoring result
// ---------------------------------------------------------------------------

export interface ChannelScoreEntry {
  readonly candidateId: string;
  readonly score: number;
}

export interface ChannelResult {
  readonly channelId: RetrievalChannelId;
  /** Entries sorted by score descending. Candidates absent from channel get neutral 0.5. */
  readonly entries: readonly ChannelScoreEntry[];
  /** True if channel had data for all candidates. False when some got neutral fallback. */
  readonly fullyScored: boolean;
}

// ---------------------------------------------------------------------------
// Candidate retrieval metadata (W8 output — NOT utility)
// ---------------------------------------------------------------------------

export const CandidateRetrievalMetadataSchema = z
  .object({
    candidateId: z.string().min(1),
    rrfRank: z.number().int().positive(),
    rrfScore: z.number().nonnegative(),
    channelScores: z.record(RetrievalChannelIdSchema, z.number().nullable()),
    channelRanks: z.record(RetrievalChannelIdSchema, z.number().int().positive().nullable()),
    /** Number of channels that contributed real (non-neutral) scores. */
    scoredChannelCount: z.number().int().nonnegative(),
    /** Total non-zero-weight channels considered. */
    activeChannelCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    retrievalVersion: z.string().min(1),
    lexicalTransformVersion: z.string().min(1),
    emittedAt: z.string().min(1),
  })
  .strict();
export type CandidateRetrievalMetadata = z.infer<typeof CandidateRetrievalMetadataSchema>;

// ---------------------------------------------------------------------------
// Retrieval result
// ---------------------------------------------------------------------------

export const RetrievalResultSchema = z
  .object({
    schemaVersion: z.literal(RETRIEVAL_CONTRACT_VERSION),
    runId: z.string().min(1),
    candidates: z.array(CandidateRetrievalMetadataSchema),
    weightsUsed: RetrievalChannelWeightsSchema,
    lexicalTransformVersion: z.string().min(1),
    retrievalVersion: z.string().min(1),
    candidateCount: z.number().int().nonnegative(),
    emittedAt: z.string().min(1),
  })
  .strict();
export type RetrievalResult = z.infer<typeof RetrievalResultSchema>;

// ---------------------------------------------------------------------------
// Text BM25 field config
// ---------------------------------------------------------------------------

export const TextFieldWeightSchema = z
  .object({
    field: z.enum([
      'title',
      'normalisedTitle',
      'organisation',
      'description',
      'responsibilities',
      'requirements',
    ]),
    weight: z.number().min(0).max(1),
  })
  .strict();
export type TextFieldWeight = z.infer<typeof TextFieldWeightSchema>;

export const DEFAULT_TEXT_FIELD_WEIGHTS: readonly TextFieldWeight[] = [
  { field: 'title', weight: 0.3 },
  { field: 'normalisedTitle', weight: 0.1 },
  { field: 'organisation', weight: 0.1 },
  { field: 'description', weight: 0.25 },
  { field: 'responsibilities', weight: 0.15 },
  { field: 'requirements', weight: 0.1 },
] as const;

// ---------------------------------------------------------------------------
// RRF config
// ---------------------------------------------------------------------------

export const RrfConfigSchema = z
  .object({
    k: z.number().positive().default(60),
  })
  .strict();
export type RrfConfig = z.infer<typeof RrfConfigSchema>;
