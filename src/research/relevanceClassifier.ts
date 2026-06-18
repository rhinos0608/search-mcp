/**
 * V5.0.0 RelevanceClassifier — adaptive relevance scoring for findings.
 *
 * V5 replaces the fixed 0.72 lexical threshold with adaptive scoring:
 *
 * - When findings have retrievalScore (from hybrid retrieval + cross-encoder
 *   rerank), the primary signal is semantic — the finding was extracted from
 *   a chunk that the cross-encoder scored as relevant to the query. This
 *   catches the "transformer attention" vs "how LLMs attend" paraphrase gap.
 *
 * - When findings don't have retrievalScore (legacy regex extractions),
 *   fall back to multi-signal lexical scoring but use adaptive thresholds
 *   (relative cutoff: 0.7 × top_score, or fit a two-component mixture).
 *
 * - Adaptive cutoff: threshold = max(0.5, median_of_top_half * 0.7).
 *   This handles query-level score distribution variation.
 *
 * - NO findings are dropped — they remain in state for reference.
 * - The synthesizer gates what enters themes using the score.
 */

import type { Finding } from './types.js';
import { logger } from '../logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RelevanceScore {
  /** 0-1 relevance score. >= threshold is "relevant". */
  score: number;
  /** Human-readable explanation. */
  reason: string;
  /** Whether this finding should be admissible for thematic inclusion. */
  admissible: boolean;
}

// ── Adaptive threshold computation ───────────────────────────────────────────

/**
 * Compute an adaptive relevance threshold from a list of scores.
 *
 * Strategy: if we have cross-encoder scores (high-quality signal),
 * use a relative cutoff: 0.7 × the 75th percentile score.
 * This automatically adapts to different query difficulty levels.
 *
 * If all scores are lexical (low-quality), use median_of_top_half × 0.7.
 *
 * Floor: 0.40 — below this nothing is meaningful.
 */
export function computeAdaptiveThreshold(scores: number[]): number {
  if (scores.length === 0) return 0.5;

  const sorted = [...scores].sort((a, b) => b - a);

  // If we have more than 10 scores, use the 75th percentile as reference
  if (sorted.length >= 10) {
    const p75Index = Math.floor(sorted.length * 0.25); // top 25%
    const p75Score = sorted[p75Index] ?? sorted[0] ?? 0;
    const threshold = Math.max(0.4, p75Score * 0.7);
    return Math.round(threshold * 1000) / 1000;
  }

  // Small number of findings — use top score as reference
  const topScore = sorted[0] ?? 0;
  const threshold = Math.max(0.4, topScore * 0.65);
  return Math.round(threshold * 1000) / 1000;
}

// ── Cross-encoder based scoring (V5 primary path) ────────────────────────────

/**
 * Score a finding using its retrievalScore (from cross-encoder rerank).
 *
 * The retrievalScore comes from the cross-encoder scoring the source chunk
 * against the research query BEFORE extraction. This means:
 * - The chunk was both lexically AND semantically relevant (hybrid retrieval)
 * - Then re-scored by a cross-encoder (joint query/passage model)
 * - Only then was LLM extraction run on it
 *
 * The relevance confidence is inherently higher than pure lexical scoring.
 */
function scoreFromRetrieval(
  finding: Pick<Finding, 'retrievalScore' | 'claim'>,
): RelevanceScore | null {
  if (finding.retrievalScore === undefined) {
    return null;
  }

  const score = finding.retrievalScore;
  const reason =
    score >= 0.6
      ? `Cross-encoder relevant (retrieval score ${score.toFixed(3)}): chunk confirmed semantically similar to query`
      : `Cross-encoder marginal (retrieval score ${score.toFixed(3)}): chunk has weak semantic alignment`;

  return {
    score: Math.round(score * 1000) / 1000,
    reason,
    admissible: score >= 0.5, // Will be refined by adaptive threshold later
  };
}

// ── Lexical scoring (V5 fallback path) ───────────────────────────────────────

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'can',
  'shall',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'some',
  'any',
  'no',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  'just',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'him',
  'his',
  'she',
  'her',
  'they',
  'them',
  'their',
  'what',
  'which',
  'who',
  'whom',
  'and',
  'but',
  'or',
  'if',
  'because',
  'about',
  'up',
  'down',
  'also',
  'well',
  'quite',
  'pretty',
  'rather',
  'while',
  'since',
  'until',
  'although',
  'though',
  'even',
  'yet',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\w']+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function tokenOverlap(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function queryTermCoverage(query: string, claim: string): number {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return 1;
  const claimTokens = new Set(tokenize(claim));
  let covered = 0;
  for (const term of queryTerms) {
    if (claimTokens.has(term)) covered++;
  }
  return covered / queryTerms.length;
}

function scoreLexical(query: string, text: string): number {
  const overlap = tokenOverlap(query, text);
  const coverage = queryTermCoverage(query, text);

  // Weighted: overlap (0.4) + coverage (0.4) + length penalty (0.2)
  const lengthScore = Math.min(1, text.length / 200); // favor longer, substantive claims
  return 0.4 * overlap + 0.4 * coverage + 0.2 * lengthScore;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Score a single finding against the original research query.
 *
 * V5: Prefers retrievalScore (cross-encoder) when available.
 * Falls back to lexical scoring for legacy findings.
 */
export function scoreFinding(
  query: string,
  finding: Pick<Finding, 'claim' | 'normalizedClaim' | 'retrievalScore'>,
): RelevanceScore {
  // V5: If we have a retrieval score from the cross-encoder, use it directly
  const retrievalResult = scoreFromRetrieval(finding);
  if (retrievalResult) return retrievalResult;

  // Fallback: lexical scoring
  const lexical = scoreLexical(query, finding.claim);

  // Adaptive threshold: more generous when we have a strong lexical match
  const threshold = lexical > 0.6 ? 0.55 : 0.45;
  const admissible = lexical >= threshold;

  const reason = admissible
    ? `Lexically relevant (${lexical.toFixed(3)}): text shares content words with query`
    : `Lexically marginal (${lexical.toFixed(3)}): weak word overlap with query`;

  return {
    score: Math.round(lexical * 1000) / 1000,
    reason,
    admissible,
  };
}

/**
 * Score arbitrary source/search text against the original research query.
 * Used for source candidate filtering during discovery.
 */
export function scoreTextRelevance(query: string, text: string): RelevanceScore {
  const lexical = scoreLexical(query, text);
  const threshold = 0.55; // Lower threshold for source titles/snippets
  const admissible = lexical >= threshold;

  return {
    score: Math.round(lexical * 1000) / 1000,
    reason: admissible
      ? `Relevant (${lexical.toFixed(3)}): source text aligns with query`
      : `Low relevance (${lexical.toFixed(3)}): source text has weak query alignment`,
    admissible,
  };
}

/**
 * Score all findings in the state against the original research query.
 * Returns a map of finding ID → RelevanceScore.
 *
 * V5: Uses adaptive thresholding — computes a per-query threshold from
 * the score distribution rather than using a fixed 0.72 constant.
 */
export function scoreAllFindings(
  query: string,
  findings: Pick<Finding, 'id' | 'claim' | 'normalizedClaim' | 'retrievalScore'>[],
): Map<string, RelevanceScore> {
  const results = new Map<string, RelevanceScore>();

  // Phase 1: Compute raw scores
  for (const f of findings) {
    const scored = scoreFinding(query, f);
    results.set(f.id, scored);
  }

  // Phase 2: Compute adaptive threshold from the score distribution
  const scores = [...results.values()].map((r) => r.score);
  const adaptiveThreshold = computeAdaptiveThreshold(scores);

  // Phase 3: Re-evaluate admissibility using the adaptive threshold
  for (const [id, result] of results) {
    const isAdmissible = result.score >= adaptiveThreshold;
    if (isAdmissible !== result.admissible) {
      results.set(id, {
        ...result,
        admissible: isAdmissible,
        reason: `${result.reason} [adaptive threshold: ${adaptiveThreshold.toFixed(3)}]`,
      });
    }
  }

  const admissible = [...results.values()].filter((r) => r.admissible).length;
  const total = findings.length;

  logger.info(
    {
      total,
      admissible,
      inadmissible: total - admissible,
      adaptiveThreshold,
      retrievalScoreCount: findings.filter((f) => f.retrievalScore !== undefined).length,
    },
    'V5 relevance classification complete',
  );

  return results;
}

/**
 * Determine which findings are admissible for thematic synthesis.
 * Uses the relevance score from scoreAllFindings.
 * Returns the set of admissible finding IDs.
 */
export function getAdmissibleFindings(scores: Map<string, RelevanceScore>): Set<string> {
  const admissible = new Set<string>();
  for (const [id, score] of scores) {
    if (score.admissible) admissible.add(id);
  }
  return admissible;
}
