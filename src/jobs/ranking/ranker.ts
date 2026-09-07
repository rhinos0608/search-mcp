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
  // For now, diversity is a no-op (transparent moves only when explicitly enabled)
  // This preserves utility ordering exactly
  return { candidates: ranked, moves: [] };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export function rankCandidates(input: RankingInput): RankingResult {
  const weights = { ...DEFAULT_GROUP_WEIGHTS, ...input.groupWeights };

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
  ranked.sort(
    (a, b) => b.utilityScore - a.utilityScore || a.candidateId.localeCompare(b.candidateId),
  );

  // Assign ranks
  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i];
    if (item) item.rank = i + 1;
  }

  // Apply diversity presentation
  const { candidates: diversified, moves } = applyDiversityPresentation(ranked);

  // Truncate
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
// Utility (re-export for barrel)
// ---------------------------------------------------------------------------

/**
 * Compute utility score from group scores and weights.
 * Missing evidence groups use NEUTRAL (0.5) and are not redistributed.
 */
export function computeUtilityScore(
  groupScores: Readonly<Record<ScoreGroup, number>>,
  weights: Readonly<Record<ScoreGroup, number>>,
): number {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const group of SCORE_GROUPS) {
    const w = (weights as Record<string, number>)[group] ?? 0;
    if (w <= 0) continue;

    const score = (groupScores as Record<string, number>)[group] ?? 0.5; // NEUTRAL fallback
    weightedSum += score * w;
    totalWeight += w;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
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
