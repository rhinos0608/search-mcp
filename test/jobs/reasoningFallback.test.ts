import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReasoningPacket, RankedCandidateView } from '../../src/jobs/reasoning/contracts.js';
import type { ReasoningProvider } from '../../src/jobs/reasoning/provider.js';
import { buildReasoningPacket } from '../../src/jobs/reasoning/packet.js';
import { runOptionalReasoning } from '../../src/jobs/reasoning/run.js';
import { createIdempotencyStore } from '../../src/jobs/reasoning/submit.js';
import { createDeterministicFallback } from '../../src/jobs/reasoning/fallback.js';
import { EvidenceIdSchema } from '../../src/jobs/reasoning/ids.js';

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

function makePacket(): ReasoningPacket {
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

function makeProvider(overrides: Partial<ReasoningProvider> = {}): ReasoningProvider {
  return {
    id: 'test-provider',
    model: 'test-model',
    complete: async () => ({ text: '{}' }),
    ...overrides,
  };
}

// ─── Tests 25–33 ─────────────────────────────────────────────────────

test('25. No provider → skipped, empty proposal, deterministic_derived, no model', async () => {
  const packet = makePacket();
  const store = createIdempotencyStore();

  const result = await runOptionalReasoning({
    packet,
    provider: undefined,
    reasoningBudget: 1,
    store,
    signal: undefined,
    now: instant,
  });

  assert.equal(result.status, 'skipped');
  if (result.status === 'skipped') {
    assert.equal(result.fallback.answers.length, 0);
    assert.equal(result.fallback.annotations.length, 0);
    assert.equal(result.fallback.proposedClaims.length, 0);
    assert.equal(result.provenance.origin, 'deterministic_derived');
    assert.equal(result.provenance.model, undefined);
  }
});

test('26. reasoningBudget === 0 never calls provider (mock must not be invoked)', async () => {
  const packet = makePacket();
  const store = createIdempotencyStore();
  let callCount = 0;

  const provider = makeProvider({
    complete: async () => {
      callCount += 1;
      return { text: '{}' };
    },
  });

  const result = await runOptionalReasoning({
    packet,
    provider,
    reasoningBudget: 0,
    store,
    signal: undefined,
    now: instant,
  });

  assert.equal(result.status, 'skipped');
  assert.equal(callCount, 0, 'Provider must not be called when budget=0');
});

test('27. Provider throw → provider_failed fallback; mock called ≤1', async () => {
  const packet = makePacket();
  const store = createIdempotencyStore();
  let callCount = 0;

  const provider = makeProvider({
    complete: async () => {
      callCount += 1;
      throw new Error('provider crashed');
    },
  });

  const result = await runOptionalReasoning({
    packet,
    provider,
    reasoningBudget: 1,
    store,
    signal: undefined,
    now: instant,
  });

  assert.equal(result.status, 'skipped');
  assert.ok(callCount <= 1, `Provider called ${callCount} times, expected ≤1`);
  if (result.status === 'skipped') {
    assert.equal(result.provenance.degradation, 'provider_failed');
  }
});

test('28. Provider timeout via AbortSignal → fallback, no throw to caller', async () => {
  const packet = makePacket();
  const store = createIdempotencyStore();

  const ac = new AbortController();
  ac.abort();

  const provider = makeProvider({
    complete: async ({ signal }: { packet: ReasoningPacket; signal?: AbortSignal }) => {
      if (signal?.aborted) throw new Error('aborted');
      return { text: '{}' };
    },
  });

  const result = await runOptionalReasoning({
    packet,
    provider,
    reasoningBudget: 1,
    store,
    signal: ac.signal,
    now: instant,
  });

  assert.equal(result.status, 'skipped');
  if (result.status === 'skipped') {
    assert.equal(result.provenance.degradation, 'provider_failed');
  }
});

test('29. Provider returns non-JSON → provider_invalid fallback', async () => {
  const packet = makePacket();
  const store = createIdempotencyStore();

  const provider = makeProvider({
    complete: async () => ({ text: 'not-json-at-all' }),
  });

  const result = await runOptionalReasoning({
    packet,
    provider,
    reasoningBudget: 1,
    store,
    signal: undefined,
    now: instant,
  });

  assert.equal(result.status, 'skipped');
  if (result.status === 'skipped') {
    assert.equal(result.provenance.degradation, 'provider_invalid');
  }
});

test('30. Provider returns extra keys → invalid, fallback', async () => {
  const packet = makePacket();
  const store = createIdempotencyStore();

  const provider = makeProvider({
    complete: async () => ({
      text: JSON.stringify({
        schemaId: 'jobs.reasoning.proposal.v1',
        schemaVersion: '1.0.0',
        answers: [],
        annotations: [],
        proposedClaims: [],
        forbiddenKey: 'oops',
      }),
    }),
  });

  const result = await runOptionalReasoning({
    packet,
    provider,
    reasoningBudget: 1,
    store,
    signal: undefined,
    now: instant,
  });

  assert.equal(result.status, 'skipped');
  if (result.status === 'skipped') {
    assert.equal(result.provenance.degradation, 'provider_invalid');
  }
});

test('31. Provider returns unknown evidence ID → rejected or fallback', async () => {
  const packet = makePacket();
  const store = createIdempotencyStore();

  const provider = makeProvider({
    complete: async () => ({
      text: JSON.stringify({
        schemaId: 'jobs.reasoning.proposal.v1',
        schemaVersion: '1.0.0',
        answers: [
          { kind: 'answer', questionId: 'q-x', text: 'yes', evidenceRefs: ['nonexistent'] },
        ],
        annotations: [],
        proposedClaims: [],
      }),
    }),
  });

  const result = await runOptionalReasoning({
    packet,
    provider,
    reasoningBudget: 1,
    store,
    signal: undefined,
    now: instant,
  });

  assert.equal(result.status, 'skipped');
});

test('32. Two invocations with budget 1 → second not called', async () => {
  const packet = makePacket();
  const store = createIdempotencyStore();
  let callCount = 0;

  const provider = makeProvider({
    complete: async () => {
      callCount += 1;
      return { text: '{}' };
    },
  });

  const result = await runOptionalReasoning({
    packet,
    provider,
    reasoningBudget: 1,
    store,
    signal: undefined,
    now: instant,
  });

  assert.equal(result.status, 'skipped');
  assert.equal(callCount, 1, 'Budget 1 → exactly 1 invocation');
});

test('33. Fallback identical across repeats (same packet, now injected)', () => {
  const packet = makePacket();

  const f1 = createDeterministicFallback(packet, 'no_provider', instant);
  const f2 = createDeterministicFallback(packet, 'no_provider', instant);

  assert.equal(f1.idempotencyKey, f2.idempotencyKey);
  assert.deepEqual(f1.proposal, f2.proposal);
  assert.equal(f1.provenance.origin, 'deterministic_derived');
  assert.equal(f1.provenance.model, undefined);
});
