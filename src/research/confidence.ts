/**
 * Three-dimensional confidence model for deep research.
 *
 * Separates evidence confidence, extraction confidence, and consistency
 * confidence into distinct dimensions rather than collapsing them into a
 * single number. Provides aggregate measures (minimum and harmonic mean).
 *
 * This is a pure computation engine — all data is passed as parameters.
 * No HTTP calls or external state access.
 */

import type { SourceType, Finding, Contradiction } from './types.js';

// ── Source authority by type ────────────────────────────────────────────────

const SOURCE_AUTHORITY: Record<SourceType, number> = {
  academic: 0.9,
  github: 0.8,
  documentation: 0.75,
  web: 0.5,
  reddit: 0.3,
  hackernews: 0.4,
  stackoverflow: 0.6,
  news: 0.6,
  patent: 0.85,
  podcast: 0.45,
  producthunt: 0.35,
  youtube: 0.4,
};

// ── Output interfaces ──────────────────────────────────────────────────────

export interface EvidenceConfidence {
  /** 0-1 aggregate of evidence dimensions. */
  score: number;
  /** 0-1 from domain trust / source type. */
  sourceAuthority: number;
  /** 0-1 recency score. */
  sourceFreshness: number;
  /** How many independent sources corroborate this claim. */
  corroborationCount: number;
  /** 0-1 from domain trust config (1.0 when disabled). */
  domainTrustFactor: number;
}

export interface ExtractionConfidence {
  /** 0-1 aggregate of extraction dimensions. */
  score: number;
  /** 0-1: LLM=0.8, regex=0.5, direct=0.9. */
  methodReliability: number;
  /** 0-1: well-structured vs noisy content. */
  contentQuality: number;
  /** 0-1 from content scrubber risk score. */
  riskScore: number;
}

export interface ConsistencyConfidence {
  /** 0-1 aggregate of consistency dimensions. */
  score: number;
  /** 0-1: what fraction of sources agree. */
  agreementRatio: number;
  /** Status of contradictions affecting this claim. */
  contradictionStatus: 'none' | 'unresolved' | 'partially_resolved' | 'resolved';
}

export interface ThreeDimensionalConfidence {
  evidence: EvidenceConfidence;
  extraction: ExtractionConfidence;
  consistency: ConsistencyConfidence;
  /** Minimum of the three scores (conservative). */
  aggregate: number;
  /** Harmonic mean of the three scores. */
  harmonicMean: number;
}

// ── Parameter interfaces ───────────────────────────────────────────────────

export interface ComputeEvidenceConfidenceParams {
  sourceType: SourceType;
  domain: string;
  /** ISO date string for the source's publication date. */
  publishedDate?: string;
  /** Source IDs that corroborate this claim (length determines corroboration). */
  corroboratingSourceIds: string[];
  /** Whether domain trust evaluation is enabled. */
  domainTrustEnabled: boolean;
  /** Score from domain trust evaluation (0-1). Optional — defaults to 0.5 when domain trust is enabled but no score is provided. */
  domainTrustScore?: number;
}

export interface ComputeExtractionConfidenceParams {
  method: 'llm' | 'regex' | 'direct';
  /** Length of the source content in characters. */
  sourceContentLength: number;
  /** Risk score from content scrubber (0-1), optional. */
  riskScore?: number;
}

export interface ComputeConsistencyConfidenceParams {
  /** Findings from different sources about the same claim. */
  findings: Finding[];
  /** Contradictions related to this claim. */
  contradictions: Contradiction[];
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Compute a freshness score (0-1) from an optional ISO date string. */
function computeFreshnessScore(publishedDate: string | undefined): number {
  if (!publishedDate) return 0.5;

  const published = new Date(publishedDate);
  if (isNaN(published.getTime())) return 0.5;

  const yearsSince = (Date.now() - published.getTime()) / (365.25 * 24 * 60 * 60 * 1000);

  if (yearsSince <= 1) return 0.9;
  if (yearsSince <= 2) return 0.7;
  if (yearsSince <= 3) return 0.5;
  return 0.3;
}

/** Compute a corroboration score (0-1) from the number of corroborating sources. */
function computeCorroborationScore(corroborationCount: number): number {
  if (corroborationCount >= 3) return 0.9;
  if (corroborationCount >= 2) return 0.7;
  if (corroborationCount >= 1) return 0.5;
  return 0.3;
}

/** Compute a content quality score (0-1) from content length in characters. */
function computeContentQualityScore(length: number): number {
  if (length >= 10_000) return 0.9;
  if (length >= 1_000) return 0.8;
  if (length >= 100) return 0.6;
  return 0.3;
}

/** Get method reliability for a given extraction method. */
function computeMethodReliability(method: 'llm' | 'regex' | 'direct'): number {
  switch (method) {
    case 'direct':
      return 0.9;
    case 'llm':
      return 0.8;
    case 'regex':
      return 0.5;
  }
}

// ── Public functions ───────────────────────────────────────────────────────

/**
 * Compute the evidence confidence dimension.
 *
 * Evaluates the strength of supporting sources based on source authority
 * (by type), freshness (by publication date), and corroboration count.
 */
export function computeEvidenceConfidence(
  params: ComputeEvidenceConfidenceParams,
): EvidenceConfidence {
  const authority = SOURCE_AUTHORITY[params.sourceType];
  const domainFactor = params.domainTrustEnabled ? (params.domainTrustScore ?? 0.5) : 1.0;

  const adjustedAuthority = authority * domainFactor;
  const freshness = computeFreshnessScore(params.publishedDate);
  const corroborationCount = params.corroboratingSourceIds.length;
  const corroborationScore = computeCorroborationScore(corroborationCount);

  // Weighted average: authority 0.4, freshness 0.2, corroboration 0.4
  const score = Math.min(
    1,
    Math.max(0, adjustedAuthority * 0.4 + freshness * 0.2 + corroborationScore * 0.4),
  );

  return {
    score,
    sourceAuthority: authority,
    sourceFreshness: freshness,
    corroborationCount,
    domainTrustFactor: domainFactor,
  };
}

/**
 * Compute the extraction confidence dimension.
 *
 * Evaluates the reliability of the extraction method, the quality of the
 * source content, and adjusts downward based on content scrubber risk.
 */
export function computeExtractionConfidence(
  params: ComputeExtractionConfidenceParams,
): ExtractionConfidence {
  const methodReliability = computeMethodReliability(params.method);
  const contentQuality = computeContentQualityScore(params.sourceContentLength);

  const rawRiskScore =
    typeof params.riskScore === 'number' && isFinite(params.riskScore)
      ? Math.max(0, Math.min(1, params.riskScore))
      : 0;
  const riskPenalty = 1 - rawRiskScore * 0.5;

  // Content quality acts as a cap on method reliability
  const baseScore = Math.min(methodReliability, contentQuality);
  const score = Math.max(0, Math.min(1, baseScore * riskPenalty));

  return {
    score,
    methodReliability,
    contentQuality,
    riskScore: rawRiskScore,
  };
}

/**
 * Compute the consistency confidence dimension.
 *
 * Evaluates agreement across sources and the status of any contradictions.
 * When no contradictions exist, confidence is high (0.9). Unresolved
 * contradictions drop confidence to 0.3.
 */
export function computeConsistencyConfidence(
  params: ComputeConsistencyConfidenceParams,
): ConsistencyConfidence {
  const { findings, contradictions } = params;

  // No contradictions → all sources agree
  if (contradictions.length === 0) {
    return {
      score: 0.9,
      agreementRatio: 1.0,
      contradictionStatus: 'none',
    };
  }

  // Determine worst contradiction status among all related contradictions
  const hasUnresolved = contradictions.some((c) => c.resolutionStatus === 'unresolved');
  const hasPartiallyResolved = contradictions.some(
    (c) => c.resolutionStatus === 'partially_resolved',
  );
  const allResolvedOrApparent = contradictions.every(
    (c) => c.resolutionStatus === 'resolved' || c.resolutionStatus === 'apparent_only',
  );

  let contradictionStatus: ConsistencyConfidence['contradictionStatus'];
  let score: number;

  if (hasUnresolved) {
    contradictionStatus = 'unresolved';
    score = 0.3;
  } else if (hasPartiallyResolved) {
    contradictionStatus = 'partially_resolved';
    score = 0.6;
  } else if (allResolvedOrApparent) {
    contradictionStatus = 'resolved';
    score = 0.8;
  } else {
    contradictionStatus = 'none';
    score = 0.9;
  }

  // Compute agreement ratio: fraction of source IDs that are NOT contradicted
  const contradictingSourceIds = new Set(
    contradictions.flatMap((c) => [...c.sourceIdsA, ...c.sourceIdsB]),
  );
  const allSourceIds = new Set(findings.flatMap((f) => f.sourceIds));

  let agreeingSources = 0;
  for (const sid of allSourceIds) {
    if (!contradictingSourceIds.has(sid)) agreeingSources++;
  }

  const agreementRatio = allSourceIds.size > 0 ? agreeingSources / allSourceIds.size : 0;

  return {
    score,
    agreementRatio,
    contradictionStatus,
  };
}

/**
 * Aggregate the three confidence dimensions into a single view.
 *
 * Uses the conservative minimum as the aggregate score (pessimistic),
 * and the harmonic mean as a balanced central tendency.
 */
export function aggregateConfidence(
  evidence: EvidenceConfidence,
  extraction: ExtractionConfidence,
  consistency: ConsistencyConfidence,
): ThreeDimensionalConfidence {
  const aggregate = Math.min(evidence.score, extraction.score, consistency.score);

  const harmonicMean =
    evidence.score === 0 || extraction.score === 0 || consistency.score === 0
      ? 0
      : 3 / (1 / evidence.score + 1 / extraction.score + 1 / consistency.score);

  return {
    evidence,
    extraction,
    consistency,
    aggregate,
    harmonicMean,
  };
}
