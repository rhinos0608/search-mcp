import {
  FEEDBACK_CONTRACT_VERSION,
  FEEDBACK_PROFILE_ID,
  LEARNING_RATE,
  LEARNING_WEIGHT,
  PERSONAL_ADAPTATION_ABS_MAX,
  RATING_MAP,
  RESIDUAL_FEATURE_ABS_MAX,
  type GroupedScoreBreakdown,
  type InteractionType,
  type LearnedResidual,
  type ResidualFeatureKey,
  FeedbackError,
} from './contracts.js';
import { canonicalKey, residualSnapshotId } from './ids.js';

// ---------------------------------------------------------------------------
// Clamp helpers
// ---------------------------------------------------------------------------

export function clampResidualValue(n: number): number {
  if (n > RESIDUAL_FEATURE_ABS_MAX) return RESIDUAL_FEATURE_ABS_MAX;
  if (n < -RESIDUAL_FEATURE_ABS_MAX) return -RESIDUAL_FEATURE_ABS_MAX;
  return n;
}

export function clampPersonalAdaptation(n: number): number {
  if (n > PERSONAL_ADAPTATION_ABS_MAX) return PERSONAL_ADAPTATION_ABS_MAX;
  if (n < -PERSONAL_ADAPTATION_ABS_MAX) return -PERSONAL_ADAPTATION_ABS_MAX;
  return n;
}

// ---------------------------------------------------------------------------
// Learning signal
// ---------------------------------------------------------------------------

export function learningSignal(type: InteractionType, rating?: 1 | 2 | 3 | 4 | 5): number {
  if (type === 'view') return LEARNING_WEIGHT.view;
  if (type === 'rating') return LEARNING_WEIGHT.rating * RATING_MAP[rating ?? 3];
  return LEARNING_WEIGHT[type];
}

// ---------------------------------------------------------------------------
// Explicit key set
// ---------------------------------------------------------------------------

export function explicitKeySet(keys: readonly ResidualFeatureKey[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const k of keys) {
    set.add(canonicalKey(k));
  }
  return set;
}

// ---------------------------------------------------------------------------
// Zero residual
// ---------------------------------------------------------------------------

export function zeroResidual(now: string): LearnedResidual {
  const features: { key: ResidualFeatureKey; value: number }[] = [];
  return {
    snapshotId: residualSnapshotId({ profileId: FEEDBACK_PROFILE_ID, features }),
    contractVersion: FEEDBACK_CONTRACT_VERSION,
    profileId: FEEDBACK_PROFILE_ID,
    features,
    updatedAt: now,
    interactionCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Update residual (normative math)
// ---------------------------------------------------------------------------

export function updateResidual(input: {
  residual: LearnedResidual;
  type: InteractionType;
  rating?: 1 | 2 | 3 | 4 | 5;
  featureKeys: readonly ResidualFeatureKey[];
  explicitPreferenceKeys: readonly ResidualFeatureKey[];
  now: string;
  learningRate?: number;
}): LearnedResidual {
  if (input.learningRate !== undefined && input.learningRate !== LEARNING_RATE) {
    throw new FeedbackError('LEARNING_RATE_FORBIDDEN', 'learning_rate_immutable');
  }

  const signal = learningSignal(input.type, input.rating);

  // Build mutable feature map from existing residual
  const featureMap = new Map<string, { key: ResidualFeatureKey; value: number }>();
  for (const f of input.residual.features) {
    const ck = canonicalKey(f.key);
    featureMap.set(ck, { key: f.key, value: f.value });
  }

  // Only apply learning when signal !== 0
  if (signal !== 0) {
    const explicit = explicitKeySet(input.explicitPreferenceKeys);

    for (const fk of input.featureKeys) {
      const ck = canonicalKey(fk);
      // I3: skip if explicit preference key
      if (explicit.has(ck)) continue;

      const current = featureMap.get(ck);
      const currentVal = current?.value ?? 0;
      const next = clampResidualValue(currentVal + LEARNING_RATE * signal);

      if (next === 0) {
        featureMap.delete(ck);
      } else {
        featureMap.set(ck, { key: fk, value: next });
      }
    }
  }

  // Sort by canonical key
  const sorted = [...featureMap.values()].sort((a, b) => {
    const ka = canonicalKey(a.key);
    const kb = canonicalKey(b.key);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return {
    snapshotId: residualSnapshotId({ profileId: FEEDBACK_PROFILE_ID, features: sorted }),
    contractVersion: FEEDBACK_CONTRACT_VERSION,
    profileId: FEEDBACK_PROFILE_ID,
    features: sorted,
    updatedAt: input.now,
    interactionCount: input.residual.interactionCount + 1,
  };
}

// ---------------------------------------------------------------------------
// Apply learned residual to grouped scores
// ---------------------------------------------------------------------------

export function applyLearnedResidual(input: {
  grouped: GroupedScoreBreakdown;
  residual: LearnedResidual;
  candidateFeatureKeys: readonly ResidualFeatureKey[];
  explicitPreferenceKeys: readonly ResidualFeatureKey[];
}): GroupedScoreBreakdown {
  const explicit = explicitKeySet(input.explicitPreferenceKeys);

  // Build residual map
  const residualMap = new Map<string, number>();
  for (const f of input.residual.features) {
    residualMap.set(canonicalKey(f.key), f.value);
  }

  let dot = 0;
  for (const fk of input.candidateFeatureKeys) {
    const ck = canonicalKey(fk);
    // I4: skip explicit keys
    if (explicit.has(ck)) continue;
    dot += residualMap.get(ck) ?? 0;
  }

  const personalAdaptation = clampPersonalAdaptation(dot);

  // W11: personalAdaptation input is discarded (not added)
  return {
    relevance: input.grouped.relevance,
    candidateFit: input.grouped.candidateFit,
    preferenceFit: input.grouped.preferenceFit,
    marketState: input.grouped.marketState,
    evidenceQuality: input.grouped.evidenceQuality,
    personalAdaptation,
  };
}
