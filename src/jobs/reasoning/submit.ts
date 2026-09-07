import { isDeepStrictEqual } from 'node:util';
import {
  ReasoningSubmissionSchema,
  type ReasoningAcceptance,
  type ReasoningError,
  type ReasoningPacket,
} from './contracts.js';

/**
 * Request-scoped idempotency store. No disk.
 */
export interface IdempotencyStore {
  get(key: string): ReasoningAcceptance | undefined;
  set(key: string, value: ReasoningAcceptance): void;
}

export function createIdempotencyStore(): IdempotencyStore {
  const map = new Map<string, ReasoningAcceptance>();
  return {
    get(key) {
      return map.get(key);
    },
    set(key, value) {
      map.set(key, value);
    },
  };
}

function err(code: ReasoningError['code']): ReasoningError {
  return { ok: false, code, retryable: false };
}

// Forbidden top-level keys in proposal body → specific error codes
const FORBIDDEN_PREFERENCE = new Set([
  'preferences',
  'searchIntent',
  'unknownPolicy',
  'strictness',
]);
const FORBIDDEN_OBSERVATION = new Set(['observations', 'observationId', 'payloadRef', 'immutable']);
const FORBIDDEN_UTILITY = new Set(['expectedUtility', 'grouped', 'rank', 'evidenceCoverage']);

function checkForbiddenProposalKeys(raw: unknown): ReasoningError | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // Check top-level proposal body keys
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_PREFERENCE.has(key)) return err('PREFERENCE_MUTATION_FORBIDDEN');
    if (FORBIDDEN_OBSERVATION.has(key)) return err('OBSERVATION_MUTATION_FORBIDDEN');
    if (FORBIDDEN_UTILITY.has(key)) return err('UTILITY_MUTATION_FORBIDDEN');
  }

  // Check nested arrays in proposal body
  for (const arrayKey of ['answers', 'annotations', 'proposedClaims'] as const) {
    const arr = obj[arrayKey];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const itemObj = item as Record<string, unknown>;
      for (const key of Object.keys(itemObj)) {
        if (FORBIDDEN_PREFERENCE.has(key)) return err('PREFERENCE_MUTATION_FORBIDDEN');
        if (FORBIDDEN_OBSERVATION.has(key)) return err('OBSERVATION_MUTATION_FORBIDDEN');
        if (FORBIDDEN_UTILITY.has(key)) return err('UTILITY_MUTATION_FORBIDDEN');
      }
    }
  }

  return null;
}

/**
 * Validate and accept a reasoning submission against a packet.
 * Pure validation + idempotency — never writes to domain.
 */
export function acceptReasoningSubmission(
  packet: ReasoningPacket,
  submission: unknown,
  store: IdempotencyStore,
): ReasoningAcceptance | ReasoningError {
  // 1. Parse outer schema
  const parsed = ReasoningSubmissionSchema.safeParse(submission);
  if (!parsed.success) return err('SCHEMA_INVALID');
  const sub = parsed.data;

  // 2. Packet ID match
  if (sub.packetId !== packet.packetId) return err('SCHEMA_INVALID');

  // 3. Hash match
  if (sub.packetHash !== packet.packetHash) return err('PACKET_HASH_MISMATCH');

  // 4. Revision match
  if (sub.expectedPacketRevision !== packet.packetRevision) return err('REVISION_CONFLICT');

  // 5. Idempotency
  const existing = store.get(sub.idempotencyKey);
  if (existing) {
    if (
      existing.packetHash === sub.packetHash &&
      isDeepStrictEqual(existing.proposal, sub.proposal)
    ) {
      return { ...existing, idempotentReplay: true };
    }
    return err('IDEMPOTENCY_CONFLICT');
  }

  // 6. Evidence ID allowlist
  const allowed = new Set(packet.allowedEvidenceIds);
  for (const answer of sub.proposal.answers) {
    for (const ref of answer.evidenceRefs) {
      if (!allowed.has(ref)) return err('UNKNOWN_EVIDENCE_ID');
    }
  }
  for (const ann of sub.proposal.annotations) {
    for (const ref of ann.evidenceRefs) {
      if (!allowed.has(ref)) return err('UNKNOWN_EVIDENCE_ID');
    }
  }
  for (const claim of sub.proposal.proposedClaims) {
    for (const ref of claim.evidenceRefs) {
      if (!allowed.has(ref)) return err('UNKNOWN_EVIDENCE_ID');
    }
  }

  // 7. questionId/postingId must exist on packet
  const packetQuestionIds = new Set(packet.questions.map((q) => q.questionId));
  const packetPostingIds = new Set(packet.candidates.map((c) => c.postingId));
  for (const answer of sub.proposal.answers) {
    if (!packetQuestionIds.has(answer.questionId)) return err('SCHEMA_INVALID');
  }
  for (const ann of sub.proposal.annotations) {
    if (!packetPostingIds.has(ann.postingId)) return err('SCHEMA_INVALID');
  }
  for (const claim of sub.proposal.proposedClaims) {
    if (!packetPostingIds.has(claim.postingId)) return err('SCHEMA_INVALID');
  }

  // 8. Forbidden mutation keys on raw proposal (belt-and-suspenders with .strict())
  const forbiddenCheck = checkForbiddenProposalKeys(sub.proposal);
  if (forbiddenCheck) return forbiddenCheck;

  // 9. Store acceptance
  const acceptance: ReasoningAcceptance = {
    ok: true,
    submissionId: sub.submissionId,
    packetId: sub.packetId,
    packetHash: sub.packetHash,
    idempotentReplay: false,
    proposal: sub.proposal,
    provenance: sub.provenance,
  };

  store.set(sub.idempotencyKey, acceptance);
  return acceptance;
}
