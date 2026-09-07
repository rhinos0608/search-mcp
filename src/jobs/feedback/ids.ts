import { createHash } from 'node:crypto';
import {
  FEEDBACK_CONTRACT_VERSION,
  FEEDBACK_PROFILE_ID,
  type InteractionId,
  type ResidualFeatureKey,
  type ResidualSnapshotId,
} from './contracts.js';

// ---------------------------------------------------------------------------
// Deterministic ID generation — SHA-256 over UTF-8 JSON arrays
// ---------------------------------------------------------------------------

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

function deterministicId(prefix: string, components: readonly string[]): string {
  const canonical = JSON.stringify(components);
  return `${prefix}${sha256hex(canonical)}`;
}

export function canonicalKey(key: ResidualFeatureKey): string {
  return JSON.stringify([key.dimension, key.value]);
}

function roundForId(n: number): string {
  return n.toFixed(8);
}

// ---------------------------------------------------------------------------
// Public ID functions
// ---------------------------------------------------------------------------

export function interactionId(input: {
  profileId: typeof FEEDBACK_PROFILE_ID;
  idempotencyKey: string;
}): InteractionId {
  return deterministicId('feedback-interaction:', [
    'feedback-interaction',
    FEEDBACK_CONTRACT_VERSION,
    input.profileId,
    input.idempotencyKey,
  ]) as InteractionId;
}

export function residualSnapshotId(input: {
  profileId: typeof FEEDBACK_PROFILE_ID;
  features: readonly { key: ResidualFeatureKey; value: number }[];
}): ResidualSnapshotId {
  const sorted = input.features
    .map((f) => [canonicalKey(f.key), roundForId(f.value)])
    .sort((a, b) => {
      const ka = a[0];
      const kb = b[0];
      if (ka === undefined || kb === undefined) return 0;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  return deterministicId('feedback-residual:', [
    'feedback-residual',
    FEEDBACK_CONTRACT_VERSION,
    input.profileId,
    JSON.stringify(sorted),
  ]) as ResidualSnapshotId;
}
