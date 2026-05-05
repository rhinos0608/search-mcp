/**
 * V4.0.0 Deep Research Orchestration Engine — shared types.
 *
 * Core data model for the research state machine: sources, findings,
 * contradictions, confidence, budgets, and progress reporting.
 *
 * This is a shell — populated during Phase 1 implementation.
 */

// ── Research phases ───────────────────────────────────────────────────────────

export type ResearchPhase =
  | 'idle'
  | 'decomposition'
  | 'taxonomy_revision'
  | 'discovery'
  | 'extraction'
  | 'gap_analysis'
  | 'audit'
  | 'synthesis'
  | 'complete';

// ── Query types ───────────────────────────────────────────────────────────────

export type QueryClassification =
  | 'explainer'
  | 'comparative'
  | 'technical'
  | 'applied-practitioner'
  | 'historical-timeline'
  | 'market-ecosystem'
  | 'literature-review'
  | 'decision-support';

// ── Sources ───────────────────────────────────────────────────────────────────

export type SourceType =
  | 'academic'
  | 'web'
  | 'github'
  | 'reddit'
  | 'hackernews'
  | 'stackoverflow'
  | 'documentation'
  | 'news'
  | 'patent'
  | 'podcast'
  | 'producthunt'
  | 'youtube';

export type ExtractionStatus = 'pending' | 'extracted' | 'failed';

export interface SourceEntry {
  id: string;
  title: string;
  url: string;
  author?: string;
  organization?: string;
  publishedDate?: string;
  accessDate: string;
  sourceType: SourceType;
  sourceConfidencePrior: number;
  domain: string;
  isPrimary: boolean;
  relevantSubQuestions: string[];
  extractionStatus: ExtractionStatus;
  limitations?: string;
  subQuestionId: string;
}

// ── Findings ──────────────────────────────────────────────────────────────────

export type ConfidenceLabel =
  | 'well-corroborated'
  | 'likely'
  | 'plausible-but-thin'
  | 'speculative'
  | 'unsupported-or-disputed';

export type EvidenceDirectness =
  | 'direct'
  | 'near-direct'
  | 'secondary'
  | 'anecdotal'
  | 'speculative';

export type ClaimType = 'primary' | 'secondary' | 'anecdotal';

export interface Finding {
  id: string;
  claim: string;
  normalizedClaim: string;
  subQuestionIds: string[];
  sourceIds: string[];
  evidenceSummary: string;
  evidenceExcerpt?: string;
  evidenceDirectness: EvidenceDirectness;
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  corroboratingSourceIds: string[];
  contradictingSourceIds: string[];
  caveats?: string;
  scope?: string;
  freshnessSensitive: boolean;
  lastUpdated: string;
  claimType: ClaimType;
  createdAt: string;
}

// ── Contradictions ────────────────────────────────────────────────────────────

export type ContradictionType =
  | 'factual_disagreement'
  | 'benchmark_disagreement'
  | 'terminology_mismatch'
  | 'time_version_mismatch'
  | 'scope_mismatch'
  | 'implementation_specific'
  | 'opinion_tradeoff'
  | 'vendor_vs_independent'
  | 'academic_vs_practitioner';

export type ContradictionStatus =
  | 'unresolved'
  | 'partially_resolved'
  | 'resolved'
  | 'apparent_only';

export interface Contradiction {
  id: string;
  claimA: string;
  claimB: string;
  sourceIdsA: string[];
  sourceIdsB: string[];
  contradictionType: ContradictionType;
  likelyExplanation?: string;
  resolutionStatus: ContradictionStatus;
  confidenceImpact: number;
  followUpSearchRecommended?: string;
}

// ── Gaps ──────────────────────────────────────────────────────────────────────

export type GapCategory =
  | 'unanswered_sub_question'
  | 'low_confidence'
  | 'unresolvable_contradiction'
  | 'missing_source_type'
  | 'missing_recency'
  | 'overrepresented_viewpoint';

export type GapStatus =
  | 'open'
  | 'in_progress'
  | 'partially_resolved'
  | 'resolved'
  | 'deferred'
  | 'unresolvable';

export interface GapRecord {
  id: string;
  category: GapCategory;
  description: string;
  subQuestionId?: string;
  relatedFindingId?: string;
  relatedContradictionId?: string;
  status: GapStatus;
  suggestedActions: string[];
  priority: number;
}

// ── Claim graph (lightweight) ─────────────────────────────────────────────────

export type ClaimEdgeType =
  | 'supports'
  | 'contradicts'
  | 'qualifies'
  | 'is_example_of'
  | 'depends_on';

export interface ClaimEdge {
  sourceFindingId: string;
  targetFindingId: string;
  edgeType: ClaimEdgeType;
  description?: string;
}

// ── Sub-questions ─────────────────────────────────────────────────────────────

export type SubQuestionStatus =
  | 'pending'
  | 'in_progress'
  | 'sufficient'
  | 'low_confidence'
  | 'contradictory'
  | 'unresolvable';

export interface SubQuestion {
  id: string;
  text: string;
  classification: QueryClassification;
  evidenceType: string;
  preferredSources: SourceType[];
  freshnessRequirement: string;
  failureModes: string[];
  budgetPriority: number;
  status: SubQuestionStatus;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

export interface SourceCandidate {
  title: string;
  url: string;
  snippet: string;
  sourceType: SourceType;
  estimatedQuality: number;
  estimatedRelevance: number;
  freshness: string;
  reasonForInclusion: string;
  subQuestionId: string;
}

// ── Budget ────────────────────────────────────────────────────────────────────

export type ResearchDepth = 'quick' | 'standard' | 'deep' | 'exhaustive';

export interface BudgetProfile {
  depth: ResearchDepth;
  maxSources: number;
  maxExtractions: number;
  maxGapLoops: number;
  maxToolCalls: number;
  maxTokens: number;
  maxTimeMs: number;
}

export interface BudgetState {
  toolCallsUsed: number;
  tokensUsed: number;
  extractionsUsed: number;
  gapLoopsUsed: number;
  startTime: number;
  maxToolCalls: number;
  maxTokens: number;
  maxExtractions: number;
  maxGapLoops: number;
  maxTimeMs: number;
}

// ── Taxonomy ──────────────────────────────────────────────────────────────────

export interface ResearchTaxonomy {
  originalQuery: string;
  subQuestions: SubQuestion[];
  revised: boolean;
  revisionHistory: string[];
}

export interface ResearchFlags {
  taxonomyRevised: boolean;
  audited: boolean;
  loopCount: number;
}

export interface ResearchState {
  query: string;
  taxonomy: ResearchTaxonomy;
  subQuestions: SubQuestion[];
  sources: SourceEntry[];
  findings: Finding[];
  contradictions: Contradiction[];
  openQuestions: string[];
  gaps: GapRecord[];
  claimGraph: ClaimEdge[];
  currentPhase: ResearchPhase;
  budget: BudgetState;
  flags: ResearchFlags;
}

// ── Progress (progressive rendering) ──────────────────────────────────────────

export type ResearchProgress =
  | {
      phase: 'decomposition';
      plan: { classification: QueryClassification; subQuestions: SubQuestion[] };
    }
  | { phase: 'discovery'; sources: { subQuestionId: string; count: number }[] }
  | { phase: 'extraction'; completed: number; total: number }
  | { phase: 'findings'; findings: Finding[] }
  | { phase: 'taxonomy_revision'; taxonomy: ResearchTaxonomy }
  | { phase: 'contradictions'; contradictions: Contradiction[] }
  | { phase: 'gap_analysis'; gaps: GapRecord[] }
  | { phase: 'synthesis'; outline: string }
  | { phase: 'limitations'; limitations: string[] }
  | { phase: 'complete' };

// ── Output ────────────────────────────────────────────────────────────────────

export interface ResearchReport {
  query: string;
  classification: QueryClassification;
  depth: ResearchDepth;
  executiveSummary: string;
  themes: { title: string; findings: string[]; confidence: ConfidenceLabel }[];
  contradictions: Contradiction[];
  uncertainties: string[];
  sourceNotes: string[];
  openQuestions: string[];
  recommendations?: string;
  limitations: string[];
  sourceCount: number;
  findingCount: number;
  confidenceDistribution: Record<ConfidenceLabel, number>;
}

export interface ResearchResult {
  report: ResearchReport;
  timeline: ResearchProgress[];
}
// ── Compact output (V4.2.0 — result compaction for MCP transport) ─────────────────

export interface CompactFinding {
  id: string;
  claim: string;
  evidenceSummary: string;
  evidenceExcerpt?: string;
  evidenceDirectness: EvidenceDirectness;
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  corroboratingSourceCount: number;
  contradictingSourceCount: number;
  sourceCount: number;
  claimType: ClaimType;
  subQuestionIds: string[];
}

export interface CompactContradiction {
  id: string;
  claimA: string;
  claimB: string;
  contradictionType: ContradictionType;
  resolutionStatus: ContradictionStatus;
  confidenceImpact: number;
}

export interface CompactStatistics {
  sourceCount: number;
  totalFindingCount: number;
  includedFindingCount: number;
  droppedLowConfidenceCount: number;
  droppedByCapCount: number;
  contradictionCount: number;
  confidenceDistribution: Record<ConfidenceLabel, number>;
  timelinePhaseCount: number;
  totalBytes?: number;
  furtherTruncated?: boolean;
}

export interface CompactResearchResult {
  query: string;
  classification: QueryClassification;
  depth: ResearchDepth;
  executiveSummary: string;
  findings: CompactFinding[];
  contradictions: CompactContradiction[];
  uncertainties: string[];
  openQuestions: string[];
  limitations: string[];
  recommendations?: string;
  statistics: CompactStatistics;
  fullResultFile: string | null;
  warning?: string;
}

export interface CompactionOptions {
  maxFindingsPerTheme?: number;
  minConfidence?: number;
  maxExcerptChars?: number;
  softSizeLimit?: number;
  hardSizeLimit?: number;
  maxSummaryChars?: number;
  fileBaseDir?: string;
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export interface AuditIssue {
  type: string;
  severity: 'error' | 'warning' | 'info';
  description: string;
  findingId?: string;
  sourceId?: string;
}

export interface AuditReport {
  passed: boolean;
  issues: AuditIssue[];
  stats: {
    totalClaims: number;
    unsourcedClaims: number;
    lowConfidenceClaims: number;
    unresolvedContradictions: number;
    mergedDuplicates: number;
    sourceDiversity: { type: string; count: number }[];
    taxonomyDrift: boolean;
  };
  timestamp: string;
}
