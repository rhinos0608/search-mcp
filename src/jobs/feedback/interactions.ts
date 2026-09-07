import { RecordInteractionInputSchema, type RecordInteractionInput } from './contracts.js';
import { FeedbackError } from './contracts.js';
import { LEARNING_WEIGHT, RATING_MAP, type InteractionType } from './contracts.js';

// ---------------------------------------------------------------------------
// Parse and validate record interaction input
// ---------------------------------------------------------------------------

export function parseRecordInteractionInput(input: unknown): RecordInteractionInput {
  const result = RecordInteractionInputSchema.safeParse(input);
  if (!result.success) {
    throw new FeedbackError('VALIDATION_ERROR', result.error.issues[0]?.message ?? 'invalid_input');
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Learning signal (standalone for testing)
// ---------------------------------------------------------------------------

export function learningSignal(type: InteractionType, rating?: 1 | 2 | 3 | 4 | 5): number {
  if (type === 'view') return LEARNING_WEIGHT.view;
  if (type === 'rating') return LEARNING_WEIGHT.rating * RATING_MAP[rating ?? 3];
  return LEARNING_WEIGHT[type];
}
