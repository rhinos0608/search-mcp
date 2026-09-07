import { createHash } from 'node:crypto';
import type { ProfileId } from './contracts.js';
import type {
  ProfileCorrectionId,
  ProfileFactId,
  ProfilePreferenceId,
  ProfileProvenanceId,
  ProfileRevisionId,
  SavedProfilePacketId,
} from './contracts.js';
import { LOCAL_PROFILE_ID, PROFILE_PERSISTENCE_CONTRACT_VERSION } from './contracts.js';

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

function normalizeFact(term: {
  kind: string;
  packId: string;
  packVersion: string;
  termId: string;
}): string {
  return JSON.stringify([term.kind, term.packId, term.packVersion, term.termId]);
}

function normalizePreference(pref: Record<string, unknown>): string {
  // Canonical ordering for stable hashing regardless of insertion order
  if (pref.kind === 'work_mode') {
    return JSON.stringify(['work_mode', pref.value, pref.desired, pref.explicit]);
  }
  if (pref.kind === 'employment_type') {
    return JSON.stringify(['employment_type', pref.value, pref.desired, pref.explicit]);
  }
  if (pref.kind === 'term') {
    return JSON.stringify(['term', pref.dimension, pref.value, pref.desired, pref.explicit]);
  }
  if (pref.kind === 'minimum_compensation') {
    return JSON.stringify([
      'minimum_compensation',
      pref.amount,
      pref.currency,
      pref.period,
      pref.desired,
      pref.explicit,
    ]);
  }
  // Fallback: sorted keys
  const sorted = Object.keys(pref)
    .sort()
    .map((k) => [k, pref[k]]);
  return JSON.stringify(sorted);
}

export function factId(term: {
  kind: string;
  packId: string;
  packVersion: string;
  termId: string;
}): ProfileFactId {
  return deterministicId('profile-fact:', [
    'profile-fact',
    PROFILE_PERSISTENCE_CONTRACT_VERSION,
    normalizeFact(term),
  ]) as ProfileFactId;
}

export function preferenceId(pref: Record<string, unknown>): ProfilePreferenceId {
  return deterministicId('profile-preference:', [
    'profile-preference',
    PROFILE_PERSISTENCE_CONTRACT_VERSION,
    normalizePreference(pref),
  ]) as ProfilePreferenceId;
}

export function correctionId(
  kind: string,
  priorId: string,
  replacementId: string | null,
): ProfileCorrectionId {
  return deterministicId('profile-correction:', [
    'profile-correction',
    PROFILE_PERSISTENCE_CONTRACT_VERSION,
    kind,
    priorId,
    replacementId ?? 'null',
  ]) as ProfileCorrectionId;
}

export function revisionId(
  factIds: readonly string[],
  preferenceIds: readonly string[],
  correctionIds: readonly string[],
): ProfileRevisionId {
  return deterministicId('profile-revision:', [
    'profile-revision',
    PROFILE_PERSISTENCE_CONTRACT_VERSION,
    JSON.stringify([...factIds].sort()),
    JSON.stringify([...preferenceIds].sort()),
    JSON.stringify([...correctionIds].sort()),
  ]) as ProfileRevisionId;
}

export function provenanceId(
  profileId: ProfileId,
  revisionId: ProfileRevisionId,
): ProfileProvenanceId {
  return deterministicId('profile-provenance:', [
    'profile-provenance',
    PROFILE_PERSISTENCE_CONTRACT_VERSION,
    profileId,
    revisionId,
    'user_adoption',
  ]) as ProfileProvenanceId;
}

export function packetId(
  profileId: ProfileId,
  revisionId: ProfileRevisionId,
): SavedProfilePacketId {
  return deterministicId('profile-packet:', [
    'profile-packet',
    PROFILE_PERSISTENCE_CONTRACT_VERSION,
    profileId,
    revisionId,
  ]) as SavedProfilePacketId;
}

export { LOCAL_PROFILE_ID };
