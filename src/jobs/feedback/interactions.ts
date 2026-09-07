import type { RecordInteractionInput, ResidualFeatureKey } from './contracts.js';
import { FeedbackError } from './contracts.js';
import { LEARNING_WEIGHT, RATING_MAP, type InteractionType } from './contracts.js';

// ---------------------------------------------------------------------------
// Parse and validate record interaction input
// ---------------------------------------------------------------------------

export function parseRecordInteractionInput(input: unknown): RecordInteractionInput {
  if (typeof input !== 'object' || input === null) {
    throw new FeedbackError('VALIDATION_ERROR', 'invalid_input');
  }

  const obj = input as Record<string, unknown>;

  const type = obj.type;
  if (
    type !== 'view' &&
    type !== 'click' &&
    type !== 'save' &&
    type !== 'apply' &&
    type !== 'dismiss' &&
    type !== 'rating'
  ) {
    throw new FeedbackError('VALIDATION_ERROR', 'invalid_input');
  }

  // Validate rating
  if (type === 'rating' && obj.rating === undefined) {
    throw new FeedbackError('VALIDATION_ERROR', 'rating_required');
  }
  if (type !== 'rating' && obj.rating !== undefined) {
    throw new FeedbackError('VALIDATION_ERROR', 'rating_not_allowed');
  }

  // Validate required fields
  const postingId = obj.postingId;
  if (typeof postingId !== 'string' || postingId.length === 0 || postingId.length > 256) {
    throw new FeedbackError('VALIDATION_ERROR', 'invalid_input');
  }

  const occurredAt = obj.occurredAt;
  if (typeof occurredAt !== 'string') {
    throw new FeedbackError('VALIDATION_ERROR', 'invalid_input');
  }

  const idempotencyKey = obj.idempotencyKey;
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > 128
  ) {
    throw new FeedbackError('VALIDATION_ERROR', 'invalid_input');
  }

  const featureKeys = obj.featureKeys as ResidualFeatureKey[];
  if (!Array.isArray(obj.featureKeys) || featureKeys.length > 64) {
    throw new FeedbackError('VALIDATION_ERROR', 'invalid_input');
  }

  const explicitPreferenceKeys = obj.explicitPreferenceKeys as ResidualFeatureKey[];
  if (!Array.isArray(obj.explicitPreferenceKeys) || explicitPreferenceKeys.length > 32) {
    throw new FeedbackError('VALIDATION_ERROR', 'invalid_input');
  }

  return {
    type,
    postingId,
    occurredAt,
    idempotencyKey,
    rating: obj.rating as 1 | 2 | 3 | 4 | 5 | undefined,
    featureKeys,
    runId: typeof obj.runId === 'string' ? obj.runId : undefined,
    explicitPreferenceKeys,
  };
}

// ---------------------------------------------------------------------------
// Learning signal (standalone for testing)
// ---------------------------------------------------------------------------

export function learningSignal(type: InteractionType, rating?: 1 | 2 | 3 | 4 | 5): number {
  if (type === 'view') return LEARNING_WEIGHT.view;
  if (type === 'rating') return LEARNING_WEIGHT.rating * RATING_MAP[rating ?? 3];
  return LEARNING_WEIGHT[type];
}
