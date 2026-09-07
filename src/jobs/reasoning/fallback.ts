import { randomUUID } from 'node:crypto';
import type { Instant } from '../domain/ids.js';
import type { ReasoningPacket, ReasoningProposalBody, ReasoningRunResult } from './contracts.js';
import { ReasoningSubmissionSchema } from './contracts.js';
import type { ReasoningSubmission } from './contracts.js';

export function createDeterministicFallback(
  packet: ReasoningPacket,
  reason: 'no_provider' | 'budget_zero' | 'provider_failed' | 'provider_invalid',
  now: Instant,
): ReasoningSubmission {
  const emptyProposal: ReasoningProposalBody = {
    schemaId: 'jobs.reasoning.proposal.v1',
    schemaVersion: '1.0.0',
    answers: [],
    annotations: [],
    proposedClaims: [],
  };

  return ReasoningSubmissionSchema.parse({
    schemaVersion: '1.0.0',
    submissionId: `reasoning-submission:${randomUUID()}`,
    packetId: packet.packetId,
    packetHash: packet.packetHash,
    expectedPacketRevision: packet.packetRevision,
    idempotencyKey: `fallback:${String(packet.packetId)}:${reason}:${now}`,
    proposal: emptyProposal,
    provenance: {
      component: 'jobs.reasoning',
      version: '1.0.0',
      origin: 'deterministic_derived',
      producedAt: now,
      degradation: reason,
    },
  });
}

export function fallbackSkipped(
  packet: ReasoningPacket,
  reason: 'no_provider' | 'budget_zero' | 'provider_failed' | 'provider_invalid',
  now: Instant,
): ReasoningRunResult {
  const submission = createDeterministicFallback(packet, reason, now);
  return {
    status: 'skipped',
    fallback: submission.proposal,
    provenance: submission.provenance,
  };
}

export function fallbackRejected(
  packet: ReasoningPacket,
  reason: 'provider_invalid',
  now: Instant,
): {
  status: 'rejected';
  fallback: ReasoningProposalBody;
  provenance: ReasoningSubmission['provenance'];
} {
  const submission = createDeterministicFallback(packet, reason, now);
  return {
    status: 'rejected',
    fallback: submission.proposal,
    provenance: submission.provenance,
  };
}
