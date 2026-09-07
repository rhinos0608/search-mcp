import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REASONING_CONTRACT_VERSION,
  ReasoningPacketSchema,
  ReasoningAllowedResponseSchemaSchema,
  type RankedCandidateView,
} from '../../src/jobs/reasoning/contracts.js';
import { buildReasoningPacket, hashReasoningPacket } from '../../src/jobs/reasoning/packet.js';
import { EvidenceIdSchema, ReasoningPacketIdSchema } from '../../src/jobs/reasoning/ids.js';

const instant = '2026-01-01T00:00:00Z' as const;

const baseGrouped = {
  relevance: 0.5,
  candidateFit: 0.5,
  preferenceFit: 0.5,
  marketState: 0.5,
  evidenceQuality: 0.5,
  personalAdaptation: 0.5,
};

function makeCandidate(
  rank: number,
  overrides: Partial<RankedCandidateView> = {},
): RankedCandidateView {
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
    ...overrides,
  };
}

test('1. REASONING_CONTRACT_VERSION === "1.0.0"', () => {
  assert.equal(REASONING_CONTRACT_VERSION, '1.0.0');
});

test('2. Packet schema accepts minimal valid packet; rejects unknown keys', () => {
  const candidates = [makeCandidate(1)];
  const packet = buildReasoningPacket({
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
    candidates,
    questions: [],
    excerpts: [],
    now: instant,
  });

  const parsed = ReasoningPacketSchema.safeParse(packet);
  assert.ok(parsed.success, `Expected valid parse, got: ${JSON.stringify(parsed.error)}`);

  const withUnknown = { ...packet, unknownField: 'oops' };
  assert.equal(ReasoningPacketSchema.safeParse(withUnknown).success, false);
});

test('3. Candidate cap 8; 9th dropped by builder in rank order', () => {
  const candidates = Array.from({ length: 9 }, (_, i) => makeCandidate(i + 1));
  const packet = buildReasoningPacket({
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
    candidates,
    questions: [],
    excerpts: [],
    now: instant,
  });

  assert.equal(packet.candidates.length, 8);
  assert.equal(packet.candidates[7]!.rank, 8);
});

test('4. Excerpt >400 chars rejected by assertPacketRedacted', () => {
  assert.throws(
    () =>
      buildReasoningPacket({
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
        excerpts: [
          {
            evidenceId: EvidenceIdSchema.parse('evidence-001'),
            kind: 'text_span',
            excerpt: 'x'.repeat(401),
          },
        ],
        now: instant,
      }),
    (e: Error) => e.message === 'RAW_PROFILE_EXPOSURE',
  );
});

test('5. Packet JSON >32768 → PACKET_BUDGET_EXCEEDED', () => {
  const bigCandidate = makeCandidate(1, {
    title: 'x'.repeat(200),
    organisation: 'y'.repeat(200),
    normalizedTitle: 'z'.repeat(200),
  });

  const excerpts = Array.from({ length: 16 }, (_, i) => ({
    evidenceId: EvidenceIdSchema.parse(`evidence-${String(i).padStart(3, '0')}`),
    kind: 'text_span' as const,
    excerpt: 'x'.repeat(2500),
  }));

  assert.throws(
    () =>
      buildReasoningPacket({
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
        candidates: [bigCandidate],
        questions: [],
        excerpts,
        now: instant,
      }),
    (e: Error) => e.message === 'PACKET_BUDGET_EXCEEDED',
  );
});

test('6. Hash stable for identical canonical object; changes if title changes', () => {
  const c1 = makeCandidate(1);

  const base = {
    schemaVersion: '1.0.0' as const,
    packetId: ReasoningPacketIdSchema.parse(
      'reasoning-packet:00000000-0000-1000-8000-000000000000',
    ),
    packetRevision: 0,
    producedAt: instant,
    runId: 'run-1',
    versions: {
      contractVersion: '1.0.0' as const,
      rankingVersion: 'ranking-v1',
      packVersions: ['pack-v1'],
      promptVersion: 'jobs.reasoning.prompt.v1' as const,
    },
    rankingRevision: 'rev-1',
    intentStrictness: 'normal' as const,
    unknownPolicy: 'include' as const,
    candidates: [c1],
    questions: [],
    evidenceExcerpts: [],
    allowedEvidenceIds: [] as never[],
    allowedResponseSchema: {
      schemaId: 'jobs.reasoning.proposal.v1' as const,
      schemaVersion: '1.0.0' as const,
    },
    redacted: true as const,
  };

  const h1 = hashReasoningPacket(base);
  const h2 = hashReasoningPacket(base);
  assert.equal(h1, h2, 'Same input → same hash');

  const changed = { ...base, candidates: [makeCandidate(1, { title: 'Different Title' })] };
  const h3 = hashReasoningPacket(changed);
  assert.notEqual(h1, h3, 'Changed data → different hash');
});

test('7. Hash independent of key insertion order', () => {
  const c1 = makeCandidate(1);
  const base = {
    schemaVersion: '1.0.0' as const,
    packetId: ReasoningPacketIdSchema.parse(
      'reasoning-packet:00000000-0000-1000-8000-000000000000',
    ),
    packetRevision: 0,
    producedAt: instant,
    runId: 'run-1',
    versions: {
      contractVersion: '1.0.0' as const,
      rankingVersion: 'ranking-v1',
      packVersions: ['pack-v1'],
      promptVersion: 'jobs.reasoning.prompt.v1' as const,
    },
    rankingRevision: 'rev-1',
    intentStrictness: 'normal' as const,
    unknownPolicy: 'include' as const,
    candidates: [c1],
    questions: [],
    evidenceExcerpts: [],
    allowedEvidenceIds: [] as never[],
    allowedResponseSchema: {
      schemaId: 'jobs.reasoning.proposal.v1' as const,
      schemaVersion: '1.0.0' as const,
    },
    redacted: true as const,
  };

  const h1 = hashReasoningPacket(base);

  const reversed: typeof base = {} as typeof base;
  const keys = Object.keys(base).reverse();
  for (const k of keys) {
    (reversed as Record<string, unknown>)[k] = (base as Record<string, unknown>)[k];
  }
  const h2 = hashReasoningPacket(reversed);
  assert.equal(h1, h2, 'Key order should not affect hash');
});

test('8. allowedEvidenceIds covers all nested refs', () => {
  const c1 = makeCandidate(1, {
    evidenceRefs: [EvidenceIdSchema.parse('ev-a'), EvidenceIdSchema.parse('ev-b')],
  });

  const packet = buildReasoningPacket({
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
    candidates: [c1],
    questions: [],
    excerpts: [
      { evidenceId: EvidenceIdSchema.parse('ev-c'), kind: 'text_span', excerpt: 'test excerpt' },
    ],
    now: instant,
  });

  const allowed = new Set(packet.allowedEvidenceIds as string[]);
  assert.ok(allowed.has('ev-a'), 'Should contain ev-a from candidate');
  assert.ok(allowed.has('ev-b'), 'Should contain ev-b from candidate');
  assert.ok(allowed.has('ev-c'), 'Should contain ev-c from excerpt');
});

test('9. Forbidden packet fields (description, applyUrl, contactMetadata, sourceUrl) rejected', () => {
  const packet = buildReasoningPacket({
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

  assert.equal(ReasoningPacketSchema.safeParse({ ...packet, description: 'text' }).success, false);
  assert.equal(
    ReasoningPacketSchema.safeParse({ ...packet, applyUrl: 'https://x.com' }).success,
    false,
  );
  assert.equal(
    ReasoningPacketSchema.safeParse({ ...packet, contactMetadata: { email: 'x@y.com' } }).success,
    false,
  );
  assert.equal(
    ReasoningPacketSchema.safeParse({ ...packet, sourceUrl: 'https://x.com' }).success,
    false,
  );
});

test('10. allowedResponseSchema.schemaId frozen', () => {
  assert.equal(
    ReasoningAllowedResponseSchemaSchema.parse({
      schemaId: 'jobs.reasoning.proposal.v1',
      schemaVersion: '1.0.0',
    }).schemaId,
    'jobs.reasoning.proposal.v1',
  );
  assert.equal(
    ReasoningAllowedResponseSchemaSchema.safeParse({ schemaId: 'wrong', schemaVersion: '1.0.0' })
      .success,
    false,
  );
});
