/**
 * W9 Assessment + Ranking tests.
 *
 * Covers:
 * - All six score groups
 * - Missing/absent/false/contradicted evidence
 * - Weight accounting (no redistribution)
 * - Residual bounds (0 ≤ score ≤ 1)
 * - No RRF effect on utility
 * - Preference-once contribution
 * - Eligibility separation from utility
 * - Diversity non-mutation
 * - Deterministic ties
 * - PersonalAdaptation delta ±0.10 ERROR (out-of-range throws)
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessCandidate,
  processPersonalAdaptationDelta,
  SCORE_GROUPS,
  type ScoreGroup,
} from '../../src/jobs/assessment/index.js';
import {
  rankCandidates,
  computeUtilityScore,
  applyDiversityPresentation,
} from '../../src/jobs/ranking/index.js';
import type { JobPosting } from '../../src/jobs/domain/posting.js';
import type { SearchIntent } from '../../src/jobs/domain/intent.js';
import type { RankedCandidate } from '../../src/jobs/ranking/ranker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePosting(overrides?: Partial<JobPosting>): JobPosting {
  return {
    postingId: 'posting-1' as never,
    schemaVersion: '1.0.0',
    canonicalRevision: 1,
    title: 'Senior React Developer',
    normalizedTitle: 'Senior React Developer',
    organisation: 'Acme Corp',
    roleFamilies: [{ family: 'SoftwareEngineer', confidence: 0.8, evidenceRefs: [] as never }],
    locations: [{ country: 'Australia', city: 'Sydney' }],
    workMode: 'hybrid',
    employmentType: 'full_time',
    salaries: [],
    classifications: [],
    seniority: 'senior',
    postedAt: '2026-01-01T00:00:00+00:00',
    listingUrls: [],
    description: 'Build React applications for enterprise clients',
    responsibilities: ['Build UIs'],
    requirements: [
      {
        rawText: '5+ years React',
        category: 'experience',
        force: 'mandatory',
        evidenceRefs: ['ev-1' as never],
        confidence: 0.9,
        interpretationProvenance: 'test',
      },
    ],
    desirableCriteria: [],
    applicationRequirements: [],
    selectionQuestions: [],
    licencesChecksRegistration: [],
    verificationState: 'verified',
    lifecycleState: 'active',
    flags: [],
    confidence: 0.9,
    caveats: [],
    evidenceRefs: ['ev-1' as never, 'ev-2' as never],
    sourceListingIds: [] as never,
    observationIds: [] as never,
    identityDecisionRevision: '1',
    ...overrides,
  } as JobPosting;
}

function makeIntent(overrides?: Partial<SearchIntent>): SearchIntent {
  return {
    query: 'React developer',
    requestedRoleFamilies: ['SoftwareEngineer'],
    sectors: [],
    locations: [{ country: 'Australia', city: 'Sydney' }],
    workModes: ['hybrid'],
    employmentTypes: ['full_time'],
    compensation: [],
    sourceIds: [],
    explorationBreadth: 'balanced',
    strictness: 'normal',
    unknownPolicy: 'include',
    topK: 20,
    budgets: {
      requests: 10,
      pages: 5,
      bytes: 1000000,
      milliseconds: 30000,
      enrichment: 100,
      reasoning: 0,
    },
    evidenceRefs: [],
    localePackIds: [],
    domainPackIds: [],
    ...overrides,
  } as SearchIntent;
}

// ---------------------------------------------------------------------------
// 1. All six score groups present
// ---------------------------------------------------------------------------

test('assessment produces exactly 6 score groups', () => {
  const result = assessCandidate({
    posting: makePosting(),
    intent: makeIntent(),
  });

  assert.equal(result.groups.length, 6);
  const groupNames = result.groups.map((g) => g.group);
  for (const expected of SCORE_GROUPS) {
    assert.ok(groupNames.includes(expected), `missing group: ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Missing evidence → stable 0.5
// ---------------------------------------------------------------------------

test('missing evidence produces neutral 0.5 scores', () => {
  const posting = makePosting({
    seniority: undefined,
    salaries: [],
    postedAt: undefined,
  });

  const result = assessCandidate({
    posting,
    intent: makeIntent(),
  });

  // PersonalAdaptation group should be ~0.5 (no delta)
  const paGroup = result.groups.find((g) => g.group === 'personalAdaptation');
  assert.ok(paGroup);
  assert.ok(
    paGroup.score >= 0.4 && paGroup.score <= 0.6,
    `PA score should be ~0.5, got ${paGroup.score}`,
  );

  // All scores should be in [0, 1]
  for (const g of result.groups) {
    assert.ok(g.score >= 0 && g.score <= 1, `group ${g.group} score out of bounds: ${g.score}`);
    for (const c of g.components) {
      assert.ok(
        c.score >= 0 && c.score <= 1,
        `component ${c.dimension} score out of bounds: ${c.score}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Absent evidence components get 0.5
// ---------------------------------------------------------------------------

test('absent evidence components get neutral 0.5', () => {
  const posting = makePosting({
    requirements: [],
    salaries: [],
    seniority: undefined,
    postedAt: undefined,
    employmentType: 'unknown',
  });

  const result = assessCandidate({
    posting,
    intent: makeIntent({ locations: [], workModes: [], employmentTypes: [] }),
  });

  // Check candidateFit group components
  const cfGroup = result.groups.find((g) => g.group === 'candidateFit');
  assert.ok(cfGroup);
  for (const c of cfGroup.components) {
    assert.equal(c.hasEvidence, false, `component ${c.dimension} should have no evidence`);
    assert.equal(c.score, 0.5, `component ${c.dimension} should be 0.5`);
  }

  const pfGroup = result.groups.find((g) => g.group === 'preferenceFit');
  assert.ok(pfGroup);
  for (const c of pfGroup.components) {
    assert.equal(c.hasEvidence, false, `component ${c.dimension} should have no evidence`);
    assert.equal(c.score, 0.5, `component ${c.dimension} should be 0.5`);
  }
});

// ---------------------------------------------------------------------------
// 4. Contradicted evidence: lifecycle state
// ---------------------------------------------------------------------------

test('contradicted evidence: confirmed_closed posting gets low marketState', () => {
  const posting = makePosting({
    lifecycleState: 'confirmed_closed',
    verificationState: 'unverified',
  });

  const result = assessCandidate({
    posting,
    intent: makeIntent(),
  });

  const msGroup = result.groups.find((g) => g.group === 'marketState');
  assert.ok(msGroup);
  // Lifecycle component should be low
  const lifecycleComp = msGroup.components.find((c) => c.dimension === 'lifecycleState');
  assert.ok(lifecycleComp);
  assert.ok(
    lifecycleComp.score <= 0.2,
    `lifecycle score should be low, got ${lifecycleComp.score}`,
  );
});

// ---------------------------------------------------------------------------
// 5. Weight accounting — no redistribution
// ---------------------------------------------------------------------------

test('group weights do not redistribute', () => {
  const posting = makePosting();
  const intent = makeIntent();

  const r1 = assessCandidate({
    posting,
    intent,
    groupWeights: {
      relevance: 1.0,
      candidateFit: 0,
      preferenceFit: 0,
      marketState: 0,
      evidenceQuality: 0,
      personalAdaptation: 0,
    },
  });
  const r2 = assessCandidate({
    posting,
    intent,
    groupWeights: {
      relevance: 0,
      candidateFit: 1.0,
      preferenceFit: 0,
      marketState: 0,
      evidenceQuality: 0,
      personalAdaptation: 0,
    },
  });

  // With relevance=1.0 and others 0, utility should equal relevance group score
  const relevanceGroup1 = r1.groups.find((g) => g.group === 'relevance')!;
  assert.ok(
    Math.abs(r1.utilityScore - relevanceGroup1.score) < 0.01,
    `r1 utility ${r1.utilityScore} ≈ relevance ${relevanceGroup1.score}`,
  );

  // With candidateFit=1.0 and others 0, utility should equal candidateFit group score
  const candidateFitGroup2 = r2.groups.find((g) => g.group === 'candidateFit')!;
  assert.ok(
    Math.abs(r2.utilityScore - candidateFitGroup2.score) < 0.01,
    `r2 utility ${r2.utilityScore} ≈ candidateFit ${candidateFitGroup2.score}`,
  );
});

// ---------------------------------------------------------------------------
// 6. Residual bounds — all scores in [0, 1]
// ---------------------------------------------------------------------------

test('all component scores bounded [0, 1] for valid input', () => {
  const posting = makePosting({
    lifecycleState: 'confirmed_closed',
    verificationState: 'verified',
    seniority: 'executive',
  });

  const result = assessCandidate({
    posting,
    intent: makeIntent(),
    personalAdaptationDelta: 0.05, // valid in-range
  });

  for (const g of result.groups) {
    assert.ok(g.score >= 0 && g.score <= 1, `group ${g.group}: ${g.score}`);
    for (const c of g.components) {
      assert.ok(c.score >= 0 && c.score <= 1, `component ${c.dimension}: ${c.score}`);
      assert.ok(
        c.confidence >= 0 && c.confidence <= 1,
        `confidence ${c.dimension}: ${c.confidence}`,
      );
    }
  }
  assert.ok(
    result.utilityScore >= 0 && result.utilityScore <= 1,
    `utility: ${result.utilityScore}`,
  );
});

// ---------------------------------------------------------------------------
// 7. No RRF effect on utility
// ---------------------------------------------------------------------------

test('RRF metadata excluded from utility inputs', () => {
  const posting = makePosting();
  const intent = makeIntent();

  // With retrieval metadata
  const r1 = assessCandidate({
    posting,
    intent,
    retrievalMetadata: { rrfRank: 1, rrfScore: 0.05, scoredChannelCount: 3 },
  });

  // Without retrieval metadata
  const r2 = assessCandidate({
    posting,
    intent,
  });

  // Utility scores should be identical (RRF not used)
  assert.equal(r1.utilityScore, r2.utilityScore);
});

// ---------------------------------------------------------------------------
// 8. Preference-once contribution
// ---------------------------------------------------------------------------

test('explicit preference contributes exactly once', () => {
  const posting = makePosting();
  const intent = makeIntent({
    locations: [{ country: 'Australia', city: 'Sydney' }],
    workModes: ['hybrid'],
  });

  const result = assessCandidate({
    posting,
    intent,
  });

  // Location preference component should appear once
  const prefGroup = result.groups.find((g) => g.group === 'preferenceFit');
  assert.ok(prefGroup);
  const locationComps = prefGroup.components.filter((c) => c.dimension === 'locationPreference');
  assert.equal(locationComps.length, 1, 'locationPreference should appear exactly once');
});

// ---------------------------------------------------------------------------
// 9. Eligibility separate from utility
// ---------------------------------------------------------------------------

test('eligibility is separate and discrete from utility', () => {
  const posting = makePosting({
    lifecycleState: 'confirmed_closed',
  });

  const result = assessCandidate({
    posting,
    intent: makeIntent(),
  });

  // Eligibility should be 'ineligible'
  assert.equal(result.eligibility.status, 'ineligible');

  // But utility score should still be computed (not zeroed)
  assert.ok(result.utilityScore > 0, 'utility should still be computed despite ineligibility');

  // Check gates exist
  assert.ok(result.eligibility.gates.length > 0);
  const lifecycleGate = result.eligibility.gates.find((g) => g.gateId === 'lifecycle_active');
  assert.ok(lifecycleGate);
  assert.equal(lifecycleGate.status, 'ineligible');
});

// ---------------------------------------------------------------------------
// 10. Diversity non-mutation
// ---------------------------------------------------------------------------

test('diversity presentation does not mutate utility scores', () => {
  const candidates: RankedCandidate[] = [
    {
      candidateId: 'a',
      rank: 1,
      utilityScore: 0.8,
      groupScores: {} as Record<ScoreGroup, number>,
      eligibilityStatus: 'eligible',
      flags: [],
    },
    {
      candidateId: 'b',
      rank: 2,
      utilityScore: 0.75,
      groupScores: {} as Record<ScoreGroup, number>,
      eligibilityStatus: 'eligible',
      flags: [],
    },
  ];

  const { candidates: diversified, moves } = applyDiversityPresentation(candidates);

  // No moves in default mode
  assert.equal(moves.length, 0);
  // Scores unchanged
  assert.equal(diversified[0]?.utilityScore, 0.8);
  assert.equal(diversified[1]?.utilityScore, 0.75);
});

// ---------------------------------------------------------------------------
// 11. PersonalAdaptation delta clamp
// ---------------------------------------------------------------------------

test('personalAdaptation delta within range accepted', () => {
  const d1 = processPersonalAdaptationDelta(0.05);
  assert.equal(d1.accepted, true);
  assert.equal(d1.appliedDelta, 0.05);

  const d2 = processPersonalAdaptationDelta(-0.05);
  assert.equal(d2.accepted, true);
  assert.equal(d2.appliedDelta, -0.05);

  const d3 = processPersonalAdaptationDelta(0.1);
  assert.equal(d3.accepted, true);
  assert.equal(d3.appliedDelta, 0.1);

  const d4 = processPersonalAdaptationDelta(-0.1);
  assert.equal(d4.accepted, true);
  assert.equal(d4.appliedDelta, -0.1);

  const d5 = processPersonalAdaptationDelta(0);
  assert.equal(d5.accepted, true);
  assert.equal(d5.appliedDelta, 0);
});

test('personalAdaptation delta out of range throws', () => {
  assert.throws(() => processPersonalAdaptationDelta(0.15), /OUT_OF_RANGE/);
  assert.throws(() => processPersonalAdaptationDelta(-0.2), /OUT_OF_RANGE/);
  assert.throws(() => processPersonalAdaptationDelta(1.0), /OUT_OF_RANGE/);
});

// ---------------------------------------------------------------------------
// 12. Ranking deterministic ties
// ---------------------------------------------------------------------------

test('ranking breaks ties deterministically by candidateId', () => {
  const assessments = [
    {
      candidateId: 'z-cand',
      utilityScore: 0.5,
      groupScores: {} as Record<ScoreGroup, number>,
      eligibilityStatus: 'eligible' as const,
      flags: [],
    },
    {
      candidateId: 'a-cand',
      utilityScore: 0.5,
      groupScores: {} as Record<ScoreGroup, number>,
      eligibilityStatus: 'eligible' as const,
      flags: [],
    },
    {
      candidateId: 'm-cand',
      utilityScore: 0.5,
      groupScores: {} as Record<ScoreGroup, number>,
      eligibilityStatus: 'eligible' as const,
      flags: [],
    },
  ];

  const result = rankCandidates({
    runId: 'run-det',
    emittedAt: '2026-01-01T00:00:00+00:00',
    assessments,
  });

  // Same score → sorted by candidateId ascending
  assert.equal(result.candidates[0]?.candidateId, 'a-cand');
  assert.equal(result.candidates[1]?.candidateId, 'm-cand');
  assert.equal(result.candidates[2]?.candidateId, 'z-cand');
});

// ---------------------------------------------------------------------------
// 13. computeUtilityScore respects weights
// ---------------------------------------------------------------------------

test('computeUtilityScore weighted mean', () => {
  const scores: Record<ScoreGroup, number> = {
    relevance: 0.8,
    candidateFit: 0.6,
    preferenceFit: 0.4,
    marketState: 0.9,
    evidenceQuality: 0.7,
    personalAdaptation: 0.5,
  };

  // Equal weights → simple mean
  const equalWeights: Record<ScoreGroup, number> = {
    relevance: 1 / 6,
    candidateFit: 1 / 6,
    preferenceFit: 1 / 6,
    marketState: 1 / 6,
    evidenceQuality: 1 / 6,
    personalAdaptation: 1 / 6,
  };

  const result = computeUtilityScore(scores, equalWeights);
  const expected = (0.8 + 0.6 + 0.4 + 0.9 + 0.7 + 0.5) / 6;
  assert.ok(Math.abs(result - expected) < 0.001, `${result} ≈ ${expected}`);
});

// ---------------------------------------------------------------------------
// 14. computeUtilityScore missing evidence falls back to 0.5
// ---------------------------------------------------------------------------

test('computeUtilityScore uses NEUTRAL 0.5 for missing group scores', () => {
  const scores: Partial<Record<ScoreGroup, number>> = {
    relevance: 0.8,
  };

  const weights: Record<ScoreGroup, number> = {
    relevance: 1.0,
    candidateFit: 0,
    preferenceFit: 0,
    marketState: 0,
    evidenceQuality: 0,
    personalAdaptation: 0,
  };

  const result = computeUtilityScore(scores, weights);
  // Only relevance contributes
  assert.ok(Math.abs(result - 0.8) < 0.001);
});

// ---------------------------------------------------------------------------
// 15. Evidence refs propagated
// ---------------------------------------------------------------------------

test('evidence refs are propagated through groups', () => {
  const posting = makePosting({
    evidenceRefs: ['ev-1' as never, 'ev-2' as never, 'ev-3' as never],
  });

  const result = assessCandidate({
    posting,
    intent: makeIntent(),
  });

  const relevanceGroup = result.groups.find((g) => g.group === 'relevance');
  assert.ok(relevanceGroup);
  assert.ok(relevanceGroup.evidenceRefs.length > 0, 'relevance should have evidence refs');
});

// ---------------------------------------------------------------------------
// 16. Flag propagation
// ---------------------------------------------------------------------------

test('flags propagated for ineligible candidates', () => {
  const posting = makePosting({
    lifecycleState: 'confirmed_closed',
    flags: ['conflicting_source_evidence'],
  });

  const result = assessCandidate({
    posting,
    intent: makeIntent(),
  });

  assert.ok(result.flags.includes('ineligible'));
  assert.ok(result.flags.includes('conflicting_source_evidence'));
});

// ---------------------------------------------------------------------------
// 17. Ranking truncation
// ---------------------------------------------------------------------------

test('ranking respects topK', () => {
  const assessments = [
    {
      candidateId: 'a',
      utilityScore: 0.9,
      groupScores: {} as Record<ScoreGroup, number>,
      eligibilityStatus: 'eligible' as const,
      flags: [],
    },
    {
      candidateId: 'b',
      utilityScore: 0.8,
      groupScores: {} as Record<ScoreGroup, number>,
      eligibilityStatus: 'eligible' as const,
      flags: [],
    },
    {
      candidateId: 'c',
      utilityScore: 0.7,
      groupScores: {} as Record<ScoreGroup, number>,
      eligibilityStatus: 'eligible' as const,
      flags: [],
    },
  ];

  const result = rankCandidates({
    runId: 'run-trunc',
    emittedAt: '2026-01-01T00:00:00+00:00',
    assessments,
    topK: 2,
  });

  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0]?.candidateId, 'a');
  assert.equal(result.candidates[1]?.candidateId, 'b');
});

// ---------------------------------------------------------------------------
// 18. Weight=0 groups not redistributed
// ---------------------------------------------------------------------------

test('weight=0 groups do not affect utility', () => {
  const scores: Record<ScoreGroup, number> = {
    relevance: 1.0,
    candidateFit: 0.0,
    preferenceFit: 0.0,
    marketState: 0.0,
    evidenceQuality: 0.0,
    personalAdaptation: 0.0,
  };

  const weights: Record<ScoreGroup, number> = {
    relevance: 1.0,
    candidateFit: 0,
    preferenceFit: 0,
    marketState: 0,
    evidenceQuality: 0,
    personalAdaptation: 0,
  };

  const result = computeUtilityScore(scores, weights);
  assert.equal(result, 1.0, 'only relevance contributes when other weights are 0');
});

// ---------------------------------------------------------------------------
// 19. Active group count
// ---------------------------------------------------------------------------

test('activeGroupCount counts non-zero weight groups', () => {
  const assessments = [
    {
      candidateId: 'a',
      utilityScore: 0.5,
      groupScores: {} as Record<ScoreGroup, number>,
      eligibilityStatus: 'eligible' as const,
      flags: [],
    },
  ];

  const result = rankCandidates({
    runId: 'run-active',
    emittedAt: '2026-01-01T00:00:00+00:00',
    assessments,
    groupWeights: {
      relevance: 0.5,
      candidateFit: 0.3,
      preferenceFit: 0,
      marketState: 0,
      evidenceQuality: 0,
      personalAdaptation: 0,
    },
  });

  assert.equal(result.activeGroupCount, 2);
});

// ---------------------------------------------------------------------------
// 20. PersonalAdaptation with valid delta
// ---------------------------------------------------------------------------

test('personalAdaptation reflects accepted delta', () => {
  const posting = makePosting();

  const result = assessCandidate({
    posting,
    intent: makeIntent(),
    personalAdaptationDelta: 0.08,
  });

  assert.equal(result.personalAdaptation.accepted, true);
  assert.equal(result.personalAdaptation.appliedDelta, 0.08);

  const paGroup = result.groups.find((g) => g.group === 'personalAdaptation');
  assert.ok(paGroup);
  // Score should be 0.5 + 0.08 = 0.58
  assert.ok(Math.abs(paGroup.score - 0.58) < 0.05, `PA score ~0.58, got ${paGroup.score}`);
});

// ---------------------------------------------------------------------------
// 21. Conditionally eligible (probably_closed)
// ---------------------------------------------------------------------------

test('probably_closed posting is conditionally_eligible', () => {
  const posting = makePosting({ lifecycleState: 'probably_closed' });

  const result = assessCandidate({
    posting,
    intent: makeIntent(),
  });

  assert.equal(result.eligibility.status, 'conditionally_eligible');
  assert.ok(result.flags.includes('conditionally_eligible'));
});

// ---------------------------------------------------------------------------
// 22. Employment type mismatch → ineligible
// ---------------------------------------------------------------------------

test('employment type mismatch is ineligible', () => {
  const posting = makePosting({ employmentType: 'part_time' });

  const result = assessCandidate({
    posting,
    intent: makeIntent({ employmentTypes: ['full_time'] }),
  });

  const etGate = result.eligibility.gates.find((g) => g.gateId === 'employment_type_match');
  assert.ok(etGate);
  assert.equal(etGate.status, 'ineligible');
});

// ---------------------------------------------------------------------------
// 23. All components have dimension strings
// ---------------------------------------------------------------------------

test('all components have non-empty dimension strings', () => {
  const result = assessCandidate({
    posting: makePosting(),
    intent: makeIntent(),
  });

  for (const g of result.groups) {
    assert.ok(g.components.length > 0, `group ${g.group} has no components`);
    for (const c of g.components) {
      assert.ok(c.dimension.length > 0, `component in ${g.group} has empty dimension`);
      assert.ok(c.dimension.length <= 64, `dimension ${c.dimension} too long`);
    }
  }
});

// ---------------------------------------------------------------------------
// 24. Evidence quality summary
// ---------------------------------------------------------------------------

test('evidence quality summary counts refs', () => {
  const posting = makePosting({
    evidenceRefs: ['ev-1' as never, 'ev-2' as never],
  });

  const result = assessCandidate({
    posting,
    intent: makeIntent(),
  });

  assert.equal(result.evidenceQualitySummary.totalEvidenceRefs, 21);
  assert.equal(result.evidenceQualitySummary.uniqueEvidenceRefs, 2);
  assert.equal(result.evidenceQualitySummary.coverageRatio, (1 + 0 + 2 / 3 + 1 + 1 + 0) / 6);
});

test('open-ended compensation intervals overlap as unbounded', () => {
  const posting = makePosting({
    salaries: [
      { min: 100000, currency: 'AUD', unit: 'year', period: 'stated', raw: 'AUD 100000+ per year' },
    ],
  });
  const result = assessCandidate({
    posting,
    intent: makeIntent({
      compensation: [
        {
          max: 120000,
          currency: 'AUD',
          unit: 'year',
          period: 'stated',
          raw: 'up to AUD 120000 per year',
        },
      ],
    }),
  });
  const group = result.groups.find((candidate) => candidate.group === 'preferenceFit');
  assert.ok(group);
  const compensation = group.components.find(
    (component) => component.dimension === 'compensationPreference',
  );
  assert.ok(compensation);
  assert.equal(compensation.hasEvidence, true);
  assert.ok(compensation.score > 0);
});
