import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type RankedCandidateView,
  type ReasoningProposalBody,
} from '../../src/jobs/reasoning/contracts.js';
import { buildReasoningPacket } from '../../src/jobs/reasoning/packet.js';
import {
  acceptReasoningSubmission,
  createIdempotencyStore,
} from '../../src/jobs/reasoning/submit.js';
import { randomUUID } from 'node:crypto';
import { EvidenceIdSchema } from '../../src/jobs/reasoning/ids.js';
import type { ReasoningPacket } from '../../src/jobs/reasoning/contracts.js';

const instant = '2026-01-01T00:00:00Z' as const;

const baseGrouped = {
  relevance: 0.5,
  candidateFit: 0.5,
  preferenceFit: 0.5,
  marketState: 0.5,
  evidenceQuality: 0.5,
  personalAdaptation: 0.5,
};

function makeCandidate(rank: number): RankedCandidateView {
  return {
    postingId: `posting-${String(rank).padStart(3, '0')}` as ReturnType<
      (typeof import('../../src/jobs/domain/ids.js').JobPostingIdSchema)['parse']
    >,
    canonicalRevision: 1,
    identityDecisionRevision: 'id-rev-1',
    title: `Software Engineer ${String(rank)}`,
    organisation: `Acme Corp ${String(rank)}`,
    normalizedTitle: `software engineer ${String(rank)}`,
    workMode: 'remote',
    employmentType: 'full_time',
    expectedUtility: 0.8 - rank * 0.05,
    evidenceCoverage: 0.7,
    confidence: 0.6,
    grouped: baseGrouped,
    flags: [],
    evidenceRefs: [EvidenceIdSchema.parse(`ev-${String(rank).padStart(3, '0')}`)],
    rank,
  };
}

function makeTestPacket(): ReasoningPacket {
  return buildReasoningPacket({
    runId: 'run-1',
    rankingRevision: 'rev-1',
    rankingVersion: 'ranking-v1',
    packVersions: ['pack-v1'],
    intent: {
      strictness: 'normal',
      unknownPolicy: 'include',
      topK: 10,
      budgets: {
        requests: 100,
        pages: 10,
        bytes: 1_000_000,
        milliseconds: 30_000,
        enrichment: 0,
        reasoning: 1,
      },
    },
    candidates: [makeCandidate(1)],
    questions: [],
    excerpts: [],
    now: instant,
  });
}

function makeProposal(overrides: Partial<ReasoningProposalBody> = {}): ReasoningProposalBody {
  return {
    schemaId: 'jobs.reasoning.proposal.v1',
    schemaVersion: '1.0.0',
    answers: [],
    annotations: [],
    proposedClaims: [],
    ...overrides,
  };
}

function makeSubmission(packet: ReasoningPacket, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    submissionId: `reasoning-submission:${randomUUID()}`,
    packetId: packet.packetId,
    packetHash: packet.packetHash,
    expectedPacketRevision: packet.packetRevision,
    idempotencyKey: `test-key-${randomUUID()}`,
    proposal: makeProposal(),
    provenance: {
      component: 'jobs.reasoning',
      version: '1.0.0',
      origin: 'model_derived',
      model: 'test-model',
      promptVersion: 'jobs.reasoning.prompt.v1',
      producedAt: instant,
      degradation: 'none',
    },
    ...overrides,
  };
}

// ─── Tests 11–24 ─────────────────────────────────────────────────────

test('11. Happy path accept; idempotentReplay=false', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const sub = makeSubmission(packet);

  const result = acceptReasoningSubmission(packet, sub, store);
  assert.equal('ok' in result && result.ok, true);
  if ('ok' in result && result.ok) {
    assert.equal(result.idempotentReplay, false);
  }
});

test('12. Replay same key+hash+body → same submissionId stored, idempotentReplay=true', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const idempotencyKey = 'my-idempotent-key';

  const sub1 = makeSubmission(packet, { idempotencyKey });
  const r1 = acceptReasoningSubmission(packet, sub1, store);
  assert.equal('ok' in r1 && r1.ok, true);
  if (!('ok' in r1) || !r1.ok) return;
  const firstId = r1.submissionId;

  const sub2 = makeSubmission(packet, { idempotencyKey });
  const r2 = acceptReasoningSubmission(packet, sub2, store);
  assert.equal('ok' in r2 && r2.ok, true);
  if (!('ok' in r2) || !r2.ok) return;
  assert.equal(r2.submissionId, firstId, 'Same submissionId on replay');
  assert.equal(r2.idempotentReplay, true);
});

test('13. Same key different proposal → IDEMPOTENCY_CONFLICT', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const key = 'conflict-key';

  const sub1 = makeSubmission(packet, { idempotencyKey: key });
  const r1 = acceptReasoningSubmission(packet, sub1, store);
  assert.equal('ok' in r1 && r1.ok, true);

  const sub2 = makeSubmission(packet, {
    idempotencyKey: key,
    proposal: makeProposal({
      annotations: [
        {
          kind: 'annotation',
          postingId: packet.candidates[0]!.postingId,
          text: 'different',
          evidenceRefs: packet.allowedEvidenceIds.slice(0, 1),
          addFlags: ['model_assessment_unverified'],
        },
      ],
    }),
  });
  const r2 = acceptReasoningSubmission(packet, sub2, store);
  assert.equal(r2.ok, false);
  if ('code' in r2) assert.equal(r2.code, 'IDEMPOTENCY_CONFLICT');
});

test('14. Wrong packetHash → PACKET_HASH_MISMATCH', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const sub = makeSubmission(packet, { packetHash: 'a'.repeat(64) });

  const result = acceptReasoningSubmission(packet, sub, store);
  assert.equal(result.ok, false);
  if ('code' in result) assert.equal(result.code, 'PACKET_HASH_MISMATCH');
});

test('15. Wrong expectedPacketRevision → REVISION_CONFLICT', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const sub = makeSubmission(packet, { expectedPacketRevision: 999 });

  const result = acceptReasoningSubmission(packet, sub, store);
  assert.equal(result.ok, false);
  if ('code' in result) assert.equal(result.code, 'REVISION_CONFLICT');
});

test('16. Evidence ID not on packet → UNKNOWN_EVIDENCE_ID', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const sub = makeSubmission(packet, {
    proposal: makeProposal({
      answers: [
        {
          kind: 'answer',
          questionId: 'q-x',
          text: 'yes',
          evidenceRefs: [EvidenceIdSchema.parse('nonexistent-ev-id')],
        },
      ],
    }),
  });

  const result = acceptReasoningSubmission(packet, sub, store);
  assert.equal(result.ok, false);
  if ('code' in result) assert.equal(result.code, 'UNKNOWN_EVIDENCE_ID');
});

test('17. Proposal with preferences → rejected by strict schema', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const sub = makeSubmission(packet, {
    proposal: {
      schemaId: 'jobs.reasoning.proposal.v1',
      schemaVersion: '1.0.0',
      answers: [],
      annotations: [],
      proposedClaims: [],
      preferences: { location: 'Sydney' },
    },
  });

  const result = acceptReasoningSubmission(packet, sub, store);
  assert.equal(result.ok, false);
  if ('code' in result) assert.equal(result.code, 'SCHEMA_INVALID');
});

test('18. Proposal with observation fields → rejected by strict schema', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const sub = makeSubmission(packet, {
    proposal: {
      schemaId: 'jobs.reasoning.proposal.v1',
      schemaVersion: '1.0.0',
      answers: [],
      annotations: [],
      proposedClaims: [],
      observations: ['obs-1'],
    },
  });

  const result = acceptReasoningSubmission(packet, sub, store);
  assert.equal(result.ok, false);
  if ('code' in result) assert.equal(result.code, 'SCHEMA_INVALID');
});

test('19. Proposal origin "observed" fails schema validation', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const sub = makeSubmission(packet, {
    proposal: {
      schemaId: 'jobs.reasoning.proposal.v1',
      schemaVersion: '1.0.0',
      answers: [],
      annotations: [],
      proposedClaims: [
        {
          kind: 'model_claim',
          postingId: 'posting-001' as ReturnType<
            (typeof import('../../src/jobs/domain/ids.js').JobPostingIdSchema)['parse']
          >,
          fieldPath: 'title',
          value: 'test',
          evidenceRefs: [EvidenceIdSchema.parse('ev-001')],
          confidence: 0.5,
          origin: 'observed',
          method: 'optional_reasoning_v1',
        },
      ],
    },
  });

  const result = acceptReasoningSubmission(packet, sub, store);
  assert.equal(result.ok, false);
  if ('code' in result) assert.equal(result.code, 'SCHEMA_INVALID');
});

test('20. Proposal writes expectedUtility → rejected by strict schema', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const sub = makeSubmission(packet, {
    proposal: {
      schemaId: 'jobs.reasoning.proposal.v1',
      schemaVersion: '1.0.0',
      answers: [],
      annotations: [],
      proposedClaims: [],
      expectedUtility: 0.9,
    },
  });

  const result = acceptReasoningSubmission(packet, sub, store);
  assert.equal(result.ok, false);
  if ('code' in result) assert.equal(result.code, 'SCHEMA_INVALID');
});

test('21. Unknown questionId → SCHEMA_INVALID', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const sub = makeSubmission(packet, {
    proposal: makeProposal({
      answers: [{ kind: 'answer', questionId: 'nonexistent-q', text: 'yes', evidenceRefs: [] }],
    }),
  });

  const result = acceptReasoningSubmission(packet, sub, store);
  assert.equal(result.ok, false);
  if ('code' in result) assert.equal(result.code, 'SCHEMA_INVALID');
});

test('22. proposedClaims without evidence refs fail schema', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const sub = makeSubmission(packet, {
    proposal: makeProposal({
      proposedClaims: [
        {
          kind: 'model_claim',
          postingId: 'posting-001' as ReturnType<
            (typeof import('../../src/jobs/domain/ids.js').JobPostingIdSchema)['parse']
          >,
          fieldPath: 'title',
          value: 'test',
          evidenceRefs: [],
          confidence: 0.5,
          origin: 'model_derived',
          method: 'optional_reasoning_v1',
        },
      ],
    }),
  });

  const result = acceptReasoningSubmission(packet, sub, store);
  assert.equal(result.ok, false);
  if ('code' in result) assert.equal(result.code, 'SCHEMA_INVALID');
});

test('23. Extra proposal keys fail strict schema', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const sub = makeSubmission(packet, {
    proposal: {
      schemaId: 'jobs.reasoning.proposal.v1',
      schemaVersion: '1.0.0',
      answers: [],
      annotations: [],
      proposedClaims: [],
      extraField: 'should-fail',
    },
  });

  const result = acceptReasoningSubmission(packet, sub, store);
  assert.equal(result.ok, false);
  if ('code' in result) assert.equal(result.code, 'SCHEMA_INVALID');
});

test('24. Unsupported schemaVersion → SCHEMA_INVALID', () => {
  const packet = makeTestPacket();
  const store = createIdempotencyStore();
  const sub = makeSubmission(packet, { schemaVersion: '2.0.0' });

  const result = acceptReasoningSubmission(packet, sub, store);
  assert.equal(result.ok, false);
  if ('code' in result) assert.equal(result.code, 'SCHEMA_INVALID');
});
