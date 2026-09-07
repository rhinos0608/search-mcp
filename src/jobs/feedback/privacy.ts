import {
  FEEDBACK_CONTRACT_VERSION,
  PERSONAL_ADAPTATION_ABS_MAX,
  type FeedbackExport,
  type LearnedResidual,
  type RecordedInteraction,
  FeedbackError,
} from './contracts.js';

// ---------------------------------------------------------------------------
// Export redaction — only public projection
// ---------------------------------------------------------------------------

export function redactForExport(residual: LearnedResidual): FeedbackExport {
  const hasNonZero = residual.features.some((f) => f.value !== 0);

  return {
    contractVersion: FEEDBACK_CONTRACT_VERSION,
    residualVersion: residual.snapshotId,
    personalAdaptationBound: PERSONAL_ADAPTATION_ABS_MAX,
    featureCount: residual.features.length,
    interactionCount: residual.interactionCount,
    hasNonZeroResidual: hasNonZero,
  };
}

// ---------------------------------------------------------------------------
// Interaction log redaction — must throw, no legal log shape for raw row
// ---------------------------------------------------------------------------

export function redactInteractionForLog(_row: RecordedInteraction): never {
  throw new FeedbackError('FORBIDDEN_FORWARD', 'raw_interaction_forbidden');
}
