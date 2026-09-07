export {
  FEEDBACK_CONTRACT_VERSION,
  FEEDBACK_PROFILE_ID,
  LEARNING_RATE,
  LEARNING_RATE_MAX,
  RESIDUAL_FEATURE_ABS_MAX,
  PERSONAL_ADAPTATION_ABS_MAX,
  MAX_INTERACTIONS,
  MAX_FEATURES,
  MAX_IDEMPOTENCY_KEY,
  LEARNING_WEIGHT,
  RATING_MAP,
  InteractionTypeSchema,
  ResidualDimensionSchema,
  ResidualFeatureKeySchema,
  InteractionIdSchema,
  ResidualSnapshotIdSchema,
  GroupedScoreBreakdownSchema,
  RecordedInteractionSchema,
  LearnedResidualSchema,
  RecordInteractionInputSchema,
  DeleteInteractionInputSchema,
  DeleteAllFeedbackInputSchema,
  ApplyResidualInputSchema,
  FeedbackErrorCodeSchema,
  FeedbackError,
  FEEDBACK_PROFILE_ID as LOCAL_PROFILE_ID,
} from './contracts.js';
export type {
  InteractionType,
  ResidualDimension,
  ResidualFeatureKey,
  InteractionId,
  ResidualSnapshotId,
  GroupedScoreBreakdown,
  RecordedInteraction,
  LearnedResidual,
  RecordInteractionInput,
  FeedbackErrorCode,
  FeedbackExport,
} from './contracts.js';

export { interactionId, residualSnapshotId, canonicalKey } from './ids.js';
export {
  zeroResidual,
  clampResidualValue,
  clampPersonalAdaptation,
  updateResidual,
  applyLearnedResidual,
  learningSignal,
  explicitKeySet,
} from './residual.js';
export { parseRecordInteractionInput } from './interactions.js';
export { createFeedbackStore, onProfileDeleted } from './store.js';
export type { FeedbackPersistAdapter, FeedbackStore } from './store.js';
export { redactForExport, redactInteractionForLog } from './privacy.js';
