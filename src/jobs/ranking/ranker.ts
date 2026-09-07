/**
 * W9 Ranking — utility aggregation and diversity presentation.
 *
 * Takes assessment output and produces final rankings.
 * Diversity is presentation-only, preserving utility and transparent moves/score-gap exemptions.
 * No RRF/union metadata in utility inputs.
 */

import type { ScoreGroup } from '../assessment/contracts.js';
import {
  ASSESSMENT_CONTRACT_VERSION,
  SCORE_GROUPS,
  DEFAULT_GROUP_WEIGHTS,
} from '../assessment/contracts.js';
export { computeUtilityScore } from '../assessment/scorer.js';

// ---------------------------------------------------------------------------
// Ranking input
// ---------------------------------------------------------------------------

export interface RankingInput {
  readonly runId: string;
  readonly emittedAt: string;
  readonly assessments: readonly CandidateAssessmentInput[];
  readonly groupWeights?: Partial<Record<ScoreGroup, number>>;
  /** Maximum candidates to return. Undefined = no truncation. */
  readonly topK?: number;
}

export interface CandidateAssessmentInput {
  readonly candidateId: string;
  readonly utilityScore: number;
  readonly groupScores: Readonly<Record<ScoreGroup, number>>;
  readonly eligibilityStatus: 'eligible' | 'conditionally_eligible' | 'ineligible';
  readonly flags: readonly string[];
}

// ---------------------------------------------------------------------------
// Ranking result
// ---------------------------------------------------------------------------

export interface RankedCandidate {
  readonly candidateId: string;
  readonly rank: number;
  readonly utilityScore: number;
  /** Per-group scores. */
  readonly groupScores: Readonly<Record<ScoreGroup, number>>;
  /** Eligibility status. */
  readonly eligibilityStatus: 'eligible' | 'conditionally_eligible' | 'ineligible';
  /** Flags. */
  readonly flags: readonly string[];
}

export interface RankingResult {
  readonly schemaVersion: typeof ASSESSMENT_CONTRACT_VERSION;
  readonly runId: string;
  readonly candidates: readonly RankedCandidate[];
  readonly groupWeights: Readonly<Record<ScoreGroup, number>>;
  readonly activeGroupCount: number;
  readonly emittedAt: string;
  /** Diversity moves applied (presentation only, utility preserved). */
  readonly diversityMoves: readonly DiversityMove[];
}

// ---------------------------------------------------------------------------
// Diversity (presentation only)
// ---------------------------------------------------------------------------

export interface DiversityMove {
  readonly candidateId: string;
  readonly fromRank: number;
  readonly toRank: number;
  readonly reason: string;
}

/**
 * Apply diversity presentation moves.
 * Preserves utility order — only moves candidates within score-gap exemptions.
 * Score gap must be < maxGap for a move to be eligible.
 */
export function applyDiversityPresentation(
  ranked: readonly RankedCandidate[],
  _maxGap = 0.05,
): { readonly candidates: readonly RankedCandidate[]; readonly moves: readonly DiversityMove[] } {
  // Unimplemented: score-gap (_maxGap) exemption and DiversityMove generation.
  // Presentation-only identity until the algorithm is implemented.
  void _maxGap;
  return { candidates: [...ranked], moves: [] };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export function rankCandidates(input: RankingInput): RankingResult {
  const weights: Record<ScoreGroup, number> = { ...DEFAULT_GROUP_WEIGHTS };
  if (input.groupWeights) {
    for (const g of SCORE_GROUPS) {
      const w = input.groupWeights[g];
      if (w !== undefined) weights[g] = w;
    }
  }

  // Compute active group count (groups with non-zero weight)
  let activeGroupCount = 0;
  for (const g of SCORE_GROUPS) {
    if (weights[g] > 0) activeGroupCount++;
  }

  // Build ranked candidates (sort by utilityScore desc, then candidateId asc)
  const ranked: MutableRankedCandidate[] = input.assessments.map((assessment) => ({
    candidateId: assessment.candidateId,
    rank: 0,
    utilityScore: assessment.utilityScore,
    groupScores: { ...assessment.groupScores },
    eligibilityStatus: assessment.eligibilityStatus,
    flags: [...assessment.flags],
  }));

  // Stable sort
  ranked.sort((a, b) => {
    const scoreDiff = b.utilityScore - a.utilityScore;
    if (scoreDiff !== 0) return scoreDiff;
    if (a.candidateId < b.candidateId) return -1;
    if (a.candidateId > b.candidateId) return 1;
    return 0;
  });

  // Assign ranks
  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i];
    if (item) item.rank = i + 1;
  }

  // Apply diversity presentation
  const { candidates: diversified, moves } = applyDiversityPresentation(ranked);

  if (input.topK !== undefined && (!Number.isInteger(input.topK) || input.topK < 0)) {
    throw new Error(`INVALID_TOP_K: ${String(input.topK)}`);
  }
  const limit = input.topK ?? diversified.length;
  const truncated = diversified.slice(0, limit);

  return {
    schemaVersion: ASSESSMENT_CONTRACT_VERSION,
    runId: input.runId,
    candidates: truncated,
    groupWeights: weights,
    activeGroupCount,
    emittedAt: input.emittedAt,
    diversityMoves: moves,
  };
}

// ---------------------------------------------------------------------------
// Mutable internal type
// ---------------------------------------------------------------------------

interface MutableRankedCandidate {
  candidateId: string;
  rank: number;
  utilityScore: number;
  groupScores: Record<ScoreGroup, number>;
  eligibilityStatus: 'eligible' | 'conditionally_eligible' | 'ineligible';
  flags: string[];
}
