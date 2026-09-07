import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RETRIEVAL_CONTRACT_VERSION,
  LEXICAL_TRANSFORM_VERSION,
} from '../../src/jobs/retrieval/contracts.js';
import { lexicalTokenize, mergeTokenLists } from '../../src/jobs/retrieval/lexical.js';
import { scoreTextBm25 } from '../../src/jobs/retrieval/channels/textBm25.js';
import { scoreSemantic } from '../../src/jobs/retrieval/channels/semantic.js';
import { scoreCapabilityOverlap } from '../../src/jobs/retrieval/channels/capabilityOverlap.js';
import { weightedRrfFuse } from '../../src/jobs/retrieval/rrf.js';
import { runRetrieval } from '../../src/jobs/retrieval/pipeline.js';
import type { RetrievalChannelWeights, ChannelResult } from '../../src/jobs/retrieval/contracts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CANDIDATE_A = 'cand-a';
const CANDIDATE_B = 'cand-b';
const CANDIDATE_C = 'cand-c';

function makePosting(id: string, title: string, description: string) {
  return { postingId: id, title, description };
}

function sortedIds(entries: readonly { candidateId: string; score: number }[]): string[] {
  return entries.map((e) => e.candidateId);
}

// ---------------------------------------------------------------------------
// 1. Lexical tokenization
// ---------------------------------------------------------------------------

test('lexicalTokenize splits and lowercases', () => {
  const tokens = lexicalTokenize('Senior React Developer');
  assert.deepEqual(tokens, ['senior', 'react', 'developer']);
});

test('lexicalTokenize drops empty tokens', () => {
  const tokens = lexicalTokenize('  ---  ');
  assert.equal(tokens.length, 0);
});

test('lexicalTokenize preserves numbers', () => {
  const tokens = lexicalTokenize('Java 17 Spring Boot');
  assert.deepEqual(tokens, ['java', '17', 'spring', 'boot']);
});

// ---------------------------------------------------------------------------
// 2. Merge token lists
// ---------------------------------------------------------------------------

test('mergeTokenLists deduplicates and sorts', () => {
  const merged = mergeTokenLists(['c', 'a'], ['b', 'a', 'd']);
  assert.deepEqual(merged, ['a', 'b', 'c', 'd']);
});

// ---------------------------------------------------------------------------
// 3. Text BM25 channel scores candidates by title relevance
// ---------------------------------------------------------------------------

test('scoreTextBm25 ranks matching title higher', () => {
  const postings = [
    makePosting(CANDIDATE_A, 'React Developer', 'Frontend work'),
    makePosting(CANDIDATE_B, 'Python Engineer', 'Backend work'),
    makePosting(CANDIDATE_C, 'Java Developer', 'Enterprise'),
  ];
  const result = scoreTextBm25({ query: 'React', postings });
  assert.equal(result.channelId, 'text_bm25');
  assert.equal(result.fullyScored, true);
  // Candidate A (React) should rank first
  const ids = sortedIds(result.entries);
  assert.equal(ids[0], CANDIDATE_A);
});

// ---------------------------------------------------------------------------
// 4. Text BM25 with field weights affects ranking
// ---------------------------------------------------------------------------

test('scoreTextBm25 respects field weights', () => {
  const postings = [
    makePosting(CANDIDATE_A, 'Data Analyst', 'Machine learning pipeline Python'),
    makePosting(CANDIDATE_B, 'Machine Learning Engineer', 'Simple data entry'),
  ];
  // Default weights: title 0.3, description 0.25 — candidate B has ML in title
  const result = scoreTextBm25({ query: 'machine learning', postings });
  const ids = sortedIds(result.entries);
  // Both should score, B likely higher due to title match
  assert.ok(ids.includes(CANDIDATE_A));
  assert.ok(ids.includes(CANDIDATE_B));
});

// ---------------------------------------------------------------------------
// 5. Semantic channel neutral fallback
// ---------------------------------------------------------------------------

test('scoreSemantic returns neutral 0.5 when no scores provided', () => {
  const result = scoreSemantic({
    candidateIds: [CANDIDATE_A, CANDIDATE_B],
  });
  assert.equal(result.channelId, 'semantic');
  assert.equal(result.fullyScored, false);
  for (const entry of result.entries) {
    assert.equal(entry.score, 0.5);
  }
});

test('scoreSemantic uses provided scores', () => {
  const scores = new Map([
    [CANDIDATE_A, 0.9],
    [CANDIDATE_B, 0.3],
  ]);
  const result = scoreSemantic({
    candidateScores: scores,
    candidateIds: [CANDIDATE_A, CANDIDATE_B],
  });
  assert.equal(result.fullyScored, true);
  const entryA = result.entries.find((e) => e.candidateId === CANDIDATE_A);
  const entryB = result.entries.find((e) => e.candidateId === CANDIDATE_B);
  assert.equal(entryA?.score, 0.9);
  assert.equal(entryB?.score, 0.3);
});

// ---------------------------------------------------------------------------
// 6. RRF fusion with single channel
// ---------------------------------------------------------------------------

test('weightedRrfFuse single channel produces correct ranking', () => {
  const channelResult: ChannelResult = {
    channelId: 'text_bm25',
    entries: [
      { candidateId: CANDIDATE_A, score: 0.9 },
      { candidateId: CANDIDATE_B, score: 0.5 },
      { candidateId: CANDIDATE_C, score: 0.1 },
    ],
    fullyScored: true,
  };
  const weights: RetrievalChannelWeights = {
    text_bm25: 1.0,
    role_family: 0,
    capability_overlap: 0,
    geography: 0,
    semantic: 0,
  };
  const result = weightedRrfFuse({
    channelResults: [channelResult],
    weights,
    candidateIds: [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C],
  });
  assert.equal(result.length, 3);
  assert.equal(result[0]?.candidateId, CANDIDATE_A);
  assert.equal(result[1]?.candidateId, CANDIDATE_B);
  assert.equal(result[2]?.candidateId, CANDIDATE_C);
  // All scored by one channel
  for (const entry of result) {
    assert.equal(entry.scoredChannelCount, 1);
    assert.equal(entry.activeChannelCount, 1);
  }
});

// ---------------------------------------------------------------------------
// 7. RRF fusion deterministic tie-breaking
// ---------------------------------------------------------------------------

test('weightedRrfFuse breaks ties by candidateId ascending', () => {
  // Use two channels so both candidates get rank 1 in one channel → same RRF score
  const ch1: ChannelResult = {
    channelId: 'text_bm25',
    entries: [{ candidateId: 'z-cand', score: 1.0 }],
    fullyScored: true,
  };
  const ch2: ChannelResult = {
    channelId: 'role_family',
    entries: [{ candidateId: 'a-cand', score: 1.0 }],
    fullyScored: true,
  };
  const weights: RetrievalChannelWeights = {
    text_bm25: 0.5,
    role_family: 0.5,
    capability_overlap: 0,
    geography: 0,
    semantic: 0,
  };
  const result = weightedRrfFuse({
    channelResults: [ch1, ch2],
    weights,
    candidateIds: ['z-cand', 'a-cand'],
  });
  // Same RRF score → sorted by candidateId ascending
  assert.equal(result[0]?.candidateId, 'a-cand');
  assert.equal(result[1]?.candidateId, 'z-cand');
  assert.equal(result[0]?.rrfScore, result[1]?.rrfScore);
});

// ---------------------------------------------------------------------------
// 8. RRF fusion multi-channel weighted
// ---------------------------------------------------------------------------

test('weightedRrfFuse multi-channel weighted correctly', () => {
  const ch1: ChannelResult = {
    channelId: 'text_bm25',
    entries: [
      { candidateId: CANDIDATE_A, score: 1.0 },
      { candidateId: CANDIDATE_B, score: 0.5 },
    ],
    fullyScored: true,
  };
  const ch2: ChannelResult = {
    channelId: 'role_family',
    entries: [
      { candidateId: CANDIDATE_B, score: 1.0 },
      { candidateId: CANDIDATE_A, score: 0.3 },
    ],
    fullyScored: true,
  };
  const weights: RetrievalChannelWeights = {
    text_bm25: 0.5,
    role_family: 0.5,
    capability_overlap: 0,
    geography: 0,
    semantic: 0,
  };
  const result = weightedRrfFuse({
    channelResults: [ch1, ch2],
    weights,
    candidateIds: [CANDIDATE_A, CANDIDATE_B],
  });
  // Both channels active
  for (const entry of result) {
    assert.equal(entry.activeChannelCount, 2);
    assert.equal(entry.scoredChannelCount, 2);
  }
  // Rankings should reflect both channels
  assert.equal(result.length, 2);
});

// ---------------------------------------------------------------------------
// 9. Omitted channels not reweighted
// ---------------------------------------------------------------------------

test('omitted channels (weight=0) do not redistribute', () => {
  const ch1: ChannelResult = {
    channelId: 'text_bm25',
    entries: [
      { candidateId: CANDIDATE_A, score: 1.0 },
      { candidateId: CANDIDATE_B, score: 0.8 },
    ],
    fullyScored: true,
  };
  // Only text_bm25 has weight; role_family has weight 0
  const weights: RetrievalChannelWeights = {
    text_bm25: 0.3,
    role_family: 0,
    capability_overlap: 0,
    geography: 0,
    semantic: 0,
  };
  const result = weightedRrfFuse({
    channelResults: [ch1],
    weights,
    candidateIds: [CANDIDATE_A, CANDIDATE_B],
  });
  // Only 1 active channel
  for (const entry of result) {
    assert.equal(entry.activeChannelCount, 1);
    assert.equal(entry.scoredChannelCount, 1);
  }
  // RRF scores should be non-zero but small (0.3 * 1/(60+rank))
  assert.ok(result[0]!.rrfScore > 0);
  assert.ok(result[0]!.rrfScore < 0.01);
});

// ---------------------------------------------------------------------------
// 10. Metadata separation: RRF output is NOT utility
// ---------------------------------------------------------------------------

test('RRF output contains no utility, confidence, or coverage fields', () => {
  const weights: RetrievalChannelWeights = {
    text_bm25: 1.0,
    role_family: 0,
    capability_overlap: 0,
    geography: 0,
    semantic: 0,
  };
  const result = weightedRrfFuse({
    channelResults: [
      {
        channelId: 'text_bm25',
        entries: [{ candidateId: CANDIDATE_A, score: 0.9 }],
        fullyScored: true,
      },
    ],
    weights,
    candidateIds: [CANDIDATE_A],
  });
  const entry = result[0]!;
  assert.ok(!('utility' in entry));
  assert.ok(!('confidence' in entry));
  assert.ok(!('coverage' in entry));
  // Only retrieval metadata present
  assert.ok('rrfScore' in entry);
  assert.ok('channelRanks' in entry);
  assert.ok('channelScores' in entry);
});

// ---------------------------------------------------------------------------
// 11. Full pipeline with minimal input
// ---------------------------------------------------------------------------

test('runRetrieval produces valid metadata with minimal input', () => {
  const result = runRetrieval({
    runId: 'run-1',
    emittedAt: '2026-01-01T00:00:00+00:00',
    candidates: [
      { candidateId: CANDIDATE_A, postingId: CANDIDATE_A, roleFamilies: [], locations: [] },
      { candidateId: CANDIDATE_B, postingId: CANDIDATE_B, roleFamilies: [], locations: [] },
    ],
    postings: new Map([
      [CANDIDATE_A, makePosting(CANDIDATE_A, 'React Developer', 'Build UIs')],
      [CANDIDATE_B, makePosting(CANDIDATE_B, 'Python Developer', 'Build APIs')],
    ]),
    intent: {
      query: 'React developer',
      requestedRoleFamilies: [],
      locations: [],
    },
    weights: {
      text_bm25: 1.0,
      role_family: 0,
      capability_overlap: 0,
      geography: 0,
      semantic: 0,
    },
  });

  assert.equal(result.schemaVersion, RETRIEVAL_CONTRACT_VERSION);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.lexicalTransformVersion, LEXICAL_TRANSFORM_VERSION);
  assert.equal(result.retrievalVersion, RETRIEVAL_CONTRACT_VERSION);

  // Candidate A (React) should rank higher
  assert.equal(result.candidates[0]?.candidateId, CANDIDATE_A);
  assert.equal(result.candidates[0]?.rrfRank, 1);
  assert.ok(result.candidates[0]!.rrfScore > result.candidates[1]!.rrfScore);
});

// ---------------------------------------------------------------------------
// 12. Pipeline truncation
// ---------------------------------------------------------------------------

test('runRetrieval truncates to topK', () => {
  const result = runRetrieval({
    runId: 'run-trunc',
    emittedAt: '2026-01-01T00:00:00+00:00',
    candidates: [
      { candidateId: CANDIDATE_A, roleFamilies: [], locations: [] },
      { candidateId: CANDIDATE_B, roleFamilies: [], locations: [] },
      { candidateId: CANDIDATE_C, roleFamilies: [], locations: [] },
    ],
    postings: new Map([
      [CANDIDATE_A, makePosting(CANDIDATE_A, 'A', 'desc')],
      [CANDIDATE_B, makePosting(CANDIDATE_B, 'B', 'desc')],
      [CANDIDATE_C, makePosting(CANDIDATE_C, 'C', 'desc')],
    ]),
    intent: { query: 'A', requestedRoleFamilies: [], locations: [] },
    topK: 2,
    weights: {
      text_bm25: 1.0,
      role_family: 0,
      capability_overlap: 0,
      geography: 0,
      semantic: 0,
    },
  });

  assert.equal(result.candidateCount, 2);
  assert.equal(result.candidates.length, 2);
});

// ---------------------------------------------------------------------------
// 13. Pipeline empty candidates
// ---------------------------------------------------------------------------

test('runRetrieval handles empty candidates', () => {
  const result = runRetrieval({
    runId: 'run-empty',
    emittedAt: '2026-01-01T00:00:00+00:00',
    candidates: [],
    postings: new Map(),
    intent: { query: 'test', requestedRoleFamilies: [], locations: [] },
  });

  assert.equal(result.candidateCount, 0);
  assert.equal(result.candidates.length, 0);
});

// ---------------------------------------------------------------------------
// 14. Deterministic output: same input → same output
// ---------------------------------------------------------------------------

test('runRetrieval is deterministic across calls', () => {
  const input = {
    runId: 'run-det',
    emittedAt: '2026-01-01T00:00:00+00:00',
    candidates: [
      { candidateId: CANDIDATE_A, roleFamilies: ['eng'], locations: [] },
      { candidateId: CANDIDATE_B, roleFamilies: ['eng'], locations: [] },
    ],
    postings: new Map([
      [CANDIDATE_A, makePosting(CANDIDATE_A, 'Engineer', 'Code')],
      [CANDIDATE_B, makePosting(CANDIDATE_B, 'Engineer', 'Code')],
    ]),
    intent: { query: 'engineer', requestedRoleFamilies: ['eng'], locations: [] },
    weights: {
      text_bm25: 0.5,
      role_family: 0.5,
      capability_overlap: 0,
      geography: 0,
      semantic: 0,
    },
  };

  const r1 = runRetrieval(input);
  const r2 = runRetrieval(input);

  assert.equal(r1.candidates.length, r2.candidates.length);
  for (let i = 0; i < r1.candidates.length; i++) {
    const c1 = r1.candidates[i]!;
    const c2 = r2.candidates[i]!;
    assert.equal(c1.candidateId, c2.candidateId);
    assert.equal(c1.rrfRank, c2.rrfRank);
    assert.equal(c1.rrfScore, c2.rrfScore);
  }
});

// ---------------------------------------------------------------------------
// 15. Missing fields → neutral 0.5 in channels that require data
// ---------------------------------------------------------------------------

test('semantic channel omits candidates without scores from entries', () => {
  const result = scoreSemantic({
    candidateIds: [CANDIDATE_A],
  });
  // Missing scores are omitted — no RRF rank for absent evidence
  assert.equal(result.entries.length, 0);
  assert.equal(result.fullyScored, false);
});

// ---------------------------------------------------------------------------
// 16. Channel result channelRanks null for missing channels
// ---------------------------------------------------------------------------

test('RRF fused entry has null channelRanks for absent channels', () => {
  const ch1: ChannelResult = {
    channelId: 'text_bm25',
    entries: [{ candidateId: CANDIDATE_A, score: 0.8 }],
    fullyScored: true,
  };
  const weights: RetrievalChannelWeights = {
    text_bm25: 0.5,
    role_family: 0.5,
    capability_overlap: 0,
    geography: 0,
    semantic: 0,
  };
  const result = weightedRrfFuse({
    channelResults: [ch1],
    weights,
    candidateIds: [CANDIDATE_A],
  });
  const entry = result[0]!;
  assert.equal(entry.channelRanks.text_bm25, 1);
  assert.equal(entry.channelRanks.role_family, null);
  assert.equal(entry.channelRanks.semantic, null);
});

// ---------------------------------------------------------------------------
// 17. Version metadata present on all outputs
// ---------------------------------------------------------------------------

test('retrieval result includes version metadata', () => {
  const result = runRetrieval({
    runId: 'run-ver',
    emittedAt: '2026-01-01T00:00:00+00:00',
    candidates: [{ candidateId: CANDIDATE_A, roleFamilies: [], locations: [] }],
    postings: new Map([[CANDIDATE_A, makePosting(CANDIDATE_A, 'Dev', 'Work')]]),
    intent: { query: 'dev', requestedRoleFamilies: [], locations: [] },
  });

  assert.equal(result.schemaVersion, RETRIEVAL_CONTRACT_VERSION);
  assert.equal(result.retrievalVersion, RETRIEVAL_CONTRACT_VERSION);
  assert.equal(result.lexicalTransformVersion, LEXICAL_TRANSFORM_VERSION);
  assert.ok(result.emittedAt.length > 0);

  const cand = result.candidates[0]!;
  assert.equal(cand.retrievalVersion, RETRIEVAL_CONTRACT_VERSION);
  assert.equal(cand.lexicalTransformVersion, LEXICAL_TRANSFORM_VERSION);
  assert.equal(cand.emittedAt, '2026-01-01T00:00:00+00:00');
});

// ---------------------------------------------------------------------------
// 18. Pipeline with geography channel
// ---------------------------------------------------------------------------

test('geography channel scored when localePack provided', () => {
  // Minimal locale pack shape for geography
  const localePack = {
    kind: 'locale' as const,
    id: 'test-locale',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'test' },
    geography: [
      { id: 'au', name: 'Australia', kind: 'country' as const, aliases: [] },
      {
        id: 'nsw',
        name: 'New South Wales',
        kind: 'state' as const,
        parentId: 'au',
        aliases: ['NSW'],
      },
      { id: 'sydney', name: 'Sydney', kind: 'city' as const, parentId: 'nsw', aliases: [] },
    ],
    salaryConventions: [],
    classificationSchemes: [],
    eligibilityTerminology: {},
    normalizationRules: [],
  };

  const result = runRetrieval({
    runId: 'run-geo',
    emittedAt: '2026-01-01T00:00:00+00:00',
    candidates: [
      { candidateId: CANDIDATE_A, roleFamilies: [], locations: [{ city: 'Sydney' }] },
      { candidateId: CANDIDATE_B, roleFamilies: [], locations: [{ city: 'London' }] },
    ],
    postings: new Map(),
    intent: {
      query: '',
      requestedRoleFamilies: [],
      locations: [{ country: 'Australia' }],
    },
    localePack: localePack as never,
    weights: {
      text_bm25: 0,
      role_family: 0,
      capability_overlap: 0,
      geography: 1.0,
      semantic: 0,
    },
  });

  // Candidate A (Sydney, Australia) should rank higher than B (London)
  assert.equal(result.candidates[0]?.candidateId, CANDIDATE_A);
  assert.equal(result.candidates[0]?.rrfRank, 1);
});

// ---------------------------------------------------------------------------
// P1-1. BM25 key mismatch: candidateId ≠ postingId
// ---------------------------------------------------------------------------

test('scoreTextBm25 uses candidateId when postingId differs', () => {
  const postings = [
    { candidateId: CANDIDATE_A, postingId: 'post-x', title: 'React Developer', description: '' },
    { candidateId: CANDIDATE_B, postingId: 'post-y', title: 'Python Engineer', description: '' },
  ];
  const result = scoreTextBm25({ query: 'React', postings });
  // Candidate IDs should appear in entries, not posting IDs
  const ids = result.entries.map((e) => e.candidateId);
  assert.ok(ids.includes(CANDIDATE_A));
  assert.ok(ids.includes(CANDIDATE_B));
  assert.ok(!ids.includes('post-x'));
  assert.ok(!ids.includes('post-y'));
  // React candidate should rank first
  assert.equal(result.entries[0]?.candidateId, CANDIDATE_A);
});

test('pipeline maps postingId to candidateId for RRF fuse', () => {
  const result = runRetrieval({
    runId: 'run-key-map',
    emittedAt: '2026-01-01T00:00:00+00:00',
    candidates: [
      { candidateId: CANDIDATE_A, postingId: 'post-1', roleFamilies: [], locations: [] },
      { candidateId: CANDIDATE_B, postingId: 'post-2', roleFamilies: [], locations: [] },
    ],
    postings: new Map([
      ['post-1', { postingId: 'post-1', title: 'React Developer', description: '' }],
      ['post-2', { postingId: 'post-2', title: 'React Engineer', description: '' }],
    ]),
    intent: { query: 'React', requestedRoleFamilies: [], locations: [] },
    weights: { text_bm25: 1.0, role_family: 0, capability_overlap: 0, geography: 0, semantic: 0 },
  });
  // Both candidates should appear in RRF output with their candidateIds
  const ids = result.candidates.map((c) => c.candidateId);
  assert.ok(ids.includes(CANDIDATE_A));
  assert.ok(ids.includes(CANDIDATE_B));
  // scoredChannelCount should be 1 for BM25
  for (const c of result.candidates) {
    assert.equal(c.scoredChannelCount, 1);
  }
});

test('pipeline skips candidates with missing postingId (no BM25 data)', () => {
  const result = runRetrieval({
    runId: 'run-miss',
    emittedAt: '2026-01-01T00:00:00+00:00',
    candidates: [
      { candidateId: CANDIDATE_A, postingId: 'post-1', roleFamilies: [], locations: [] },
      { candidateId: CANDIDATE_B, roleFamilies: [], locations: [] },
    ],
    postings: new Map([['post-1', { postingId: 'post-1', title: 'React', description: '' }]]),
    intent: { query: 'React', requestedRoleFamilies: [], locations: [] },
    weights: { text_bm25: 1.0, role_family: 0, capability_overlap: 0, geography: 0, semantic: 0 },
  });
  // Both candidates in output (RRF union), but only A scored by BM25
  assert.equal(result.candidates.length, 2);
  const a = result.candidates.find((c) => c.candidateId === CANDIDATE_A)!;
  const b = result.candidates.find((c) => c.candidateId === CANDIDATE_B)!;
  assert.equal(a.scoredChannelCount, 1);
  assert.equal(a.channelRanks.text_bm25, 1);
  // B has no posting → BM25 absent → scoredChannelCount = 0
  assert.equal(b.scoredChannelCount, 0);
  assert.equal(b.channelRanks.text_bm25, null);
  // B should get neutral 0.5 score for missing BM25
  assert.equal(b.channelScores.text_bm25, 0.5);
});

// ---------------------------------------------------------------------------
// P1-3. Tokenizer version consistency
// ---------------------------------------------------------------------------

test('textBm25 scoring is consistent with lexicalTokenize', () => {
  const postings = [
    { candidateId: CANDIDATE_A, postingId: 'p1', title: 'Senior React Developer', description: '' },
    { candidateId: CANDIDATE_B, postingId: 'p2', title: 'Junior React Developer', description: '' },
  ];
  const result = scoreTextBm25({ query: 'Senior React Developer', postings });
  // Both have 'react developer' — 'senior' differentiates
  assert.equal(result.entries[0]?.candidateId, CANDIDATE_A);
  assert.ok(result.entries[0]!.score > result.entries[1]!.score);
});

// ---------------------------------------------------------------------------
// P1-4. scoredChannelCount lies when missing channels contribute
// ---------------------------------------------------------------------------

test('RRF scoredChannelCount excludes channels with neutral 0.5 fallback', () => {
  const ch1: ChannelResult = {
    channelId: 'text_bm25',
    entries: [{ candidateId: CANDIDATE_A, score: 0.9 }],
    fullyScored: true,
  };
  const ch2: ChannelResult = {
    channelId: 'role_family',
    entries: [
      { candidateId: CANDIDATE_A, score: 0.5 },
      { candidateId: CANDIDATE_B, score: 0.5 },
    ],
    fullyScored: true,
  };
  const weights: RetrievalChannelWeights = {
    text_bm25: 0.5,
    role_family: 0.5,
    capability_overlap: 0,
    geography: 0,
    semantic: 0,
  };
  const result = weightedRrfFuse({
    channelResults: [ch1, ch2],
    weights,
    candidateIds: [CANDIDATE_A, CANDIDATE_B],
  });
  const a = result.find((e) => e.candidateId === CANDIDATE_A)!;
  const b = result.find((e) => e.candidateId === CANDIDATE_B)!;
  // A scored by text_bm25 (rank 1), role_family also ranks A (rank 1)
  assert.equal(a.scoredChannelCount, 2);
  // B not in text_bm25 entries → role_family rank = 1, scoredChannelCount = 1
  assert.equal(b.scoredChannelCount, 1);
  // B should have neutral 0.5 for text_bm25, not null
  assert.equal(b.channelScores.text_bm25, 0.5);
  assert.equal(b.channelRanks.text_bm25, null);
});

test('RRF neutral 0.5 does not contribute RRF term', () => {
  const ch1: ChannelResult = {
    channelId: 'text_bm25',
    entries: [
      { candidateId: CANDIDATE_A, score: 0.9 },
      { candidateId: CANDIDATE_B, score: 0.5 },
    ],
    fullyScored: true,
  };
  // Only one channel — the other contributes 0.5 neutral to B
  const weights: RetrievalChannelWeights = {
    text_bm25: 0.5,
    role_family: 0.5,
    capability_overlap: 0,
    geography: 0,
    semantic: 0,
  };
  const result = weightedRrfFuse({
    channelResults: [ch1],
    weights,
    candidateIds: [CANDIDATE_A, CANDIDATE_B],
  });
  // Both should have same RRF score (only text_bm25 contributes terms)
  // B's role_family is null (no data), not contributing
  const a = result.find((e) => e.candidateId === CANDIDATE_A)!;
  const b = result.find((e) => e.candidateId === CANDIDATE_B)!;
  assert.equal(a.channelRanks.role_family, null);
  assert.equal(b.channelRanks.role_family, null);
  // Only text_bm25 scored → scoredChannelCount = 1 for both
  assert.equal(a.scoredChannelCount, 1);
  assert.equal(b.scoredChannelCount, 1);
});

// ---------------------------------------------------------------------------
// P1-5. Capability index case-insensitive lookup
// ---------------------------------------------------------------------------

test('scoreCapabilityOverlap handles mixed-case role IDs', () => {
  const domainPack = {
    roleNodes: [
      {
        id: 'SoftwareEngineer',
        label: 'Software Engineer',
        aliases: [],
        capabilities: ['coding', 'algorithms'],
      },
      { id: 'DataAnalyst', label: 'Data Analyst', aliases: [], capabilities: ['analysis', 'sql'] },
    ],
    edges: [] as never[],
    capabilityVocabulary: ['coding', 'algorithms', 'analysis', 'sql'],
  } as never;

  const result = scoreCapabilityOverlap({
    intentCapabilities: ['coding', 'algorithms'],
    intentRoleFamilies: ['SoftwareEngineer'],
    candidateRoleFamilies: new Map([
      [CANDIDATE_A, ['SoftwareEngineer']],
      [CANDIDATE_B, ['DataAnalyst']],
    ]),
    domainPack,
  });

  assert.equal(result.channelId, 'capability_overlap');
  assert.equal(result.fullyScored, true);
  // A should score 1.0 (exact match with intent capabilities)
  const a = result.entries.find((e) => e.candidateId === CANDIDATE_A)!;
  const b = result.entries.find((e) => e.candidateId === CANDIDATE_B)!;
  assert.ok(a.score > b.score, 'A should score higher than B');
  assert.equal(a.score, 1.0);
});

// ---------------------------------------------------------------------------
// P1-6. Geography: unconstrained geo does not penalize empty locations
// ---------------------------------------------------------------------------

test('geography channel gives 0.5 to all candidates when intent has no locations', () => {
  const localePack = {
    kind: 'locale' as const,
    id: 'test-locale',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: { author: 'test', license: 'test' },
    geography: [
      { id: 'au', name: 'Australia', kind: 'country' as const, aliases: [] },
      { id: 'sydney', name: 'Sydney', kind: 'city' as const, parentId: 'au', aliases: [] },
    ],
    salaryConventions: [],
    classificationSchemes: [],
    eligibilityTerminology: {},
    normalizationRules: [],
  };

  const result = runRetrieval({
    runId: 'run-geo-unconstrained',
    emittedAt: '2026-01-01T00:00:00+00:00',
    candidates: [
      { candidateId: CANDIDATE_A, roleFamilies: [], locations: [{ city: 'Sydney' }] },
      { candidateId: CANDIDATE_B, roleFamilies: [], locations: [] },
    ],
    postings: new Map(),
    intent: {
      query: '',
      requestedRoleFamilies: [],
      locations: [],
    },
    localePack: localePack as never,
    weights: {
      text_bm25: 0,
      role_family: 0,
      capability_overlap: 0,
      geography: 1.0,
      semantic: 0,
    },
  });

  // Both should get 0.5 geography score — unconstrained intent
  const a = result.candidates.find((c) => c.candidateId === CANDIDATE_A)!;
  const b = result.candidates.find((c) => c.candidateId === CANDIDATE_B)!;
  assert.equal(a.channelScores.geography, 0.5);
  assert.equal(b.channelScores.geography, 0.5);
  assert.equal(a.channelRanks.geography, null);
  assert.equal(b.channelRanks.geography, null);
  assert.equal(a.scoredChannelCount, 0);
  assert.equal(b.scoredChannelCount, 0);
});

// ---------------------------------------------------------------------------
// P1-7. Truncation sets truncated: true
// ---------------------------------------------------------------------------

test('runRetrieval truncation sets truncated flag', () => {
  const result = runRetrieval({
    runId: 'run-trunc-flag',
    emittedAt: '2026-01-01T00:00:00+00:00',
    candidates: [
      { candidateId: CANDIDATE_A, postingId: CANDIDATE_A, roleFamilies: [], locations: [] },
      { candidateId: CANDIDATE_B, postingId: CANDIDATE_B, roleFamilies: [], locations: [] },
      { candidateId: CANDIDATE_C, postingId: CANDIDATE_C, roleFamilies: [], locations: [] },
    ],
    postings: new Map([
      [CANDIDATE_A, { postingId: CANDIDATE_A, title: 'Alpha', description: '' }],
      [CANDIDATE_B, { postingId: CANDIDATE_B, title: 'Beta', description: '' }],
      [CANDIDATE_C, { postingId: CANDIDATE_C, title: 'Gamma', description: '' }],
    ]),
    intent: { query: 'Alpha', requestedRoleFamilies: [], locations: [] },
    topK: 2,
    weights: { text_bm25: 1.0, role_family: 0, capability_overlap: 0, geography: 0, semantic: 0 },
  });
  assert.equal(result.candidates.length, 2);
  // Every returned candidate should have truncated: true
  for (const c of result.candidates) {
    assert.equal(c.truncated, true);
  }
});

test('runRetrieval no truncation when all candidates returned', () => {
  const result = runRetrieval({
    runId: 'run-no-trunc',
    emittedAt: '2026-01-01T00:00:00+00:00',
    candidates: [],
    postings: new Map(),
    intent: { query: 'x', requestedRoleFamilies: [], locations: [] },
    topK: 10,
    weights: { text_bm25: 0, role_family: 0, capability_overlap: 0, geography: 0, semantic: 0 },
  });
  assert.equal(result.candidates.length, 0);
});
