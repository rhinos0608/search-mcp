/**
 * V4.0.0 Deep Research Orchestration Engine — shared types.
 *
 * Core data model for the research state machine: sources, findings,
 * contradictions, confidence, budgets, and progress reporting.
 *
 * This is a shell — populated during Phase 1 implementation.
 */

import type { BrowserSessionConfig } from '../browser/types.js';

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
  | 'complete'
  | 'tree_research';

// ── Query types ───────────────────────────────────────────────────────────────

export type QueryClassification =
  | 'explainer'
  | 'comparative'
  | 'technical'
  | 'applied-practitioner'
  | 'current-events'
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
  | 'official_docs'
  | 'official_blog'
  | 'package_registry'
  | 'vendor_docs'
  | 'forum'
  | 'social'
  | 'news'
  | 'patent'
  | 'pubmed'
  | 'wikipedia'
  | 'podcast'
  | 'producthunt'
  | 'youtube'
  | 'browser-interactive'
  | 'openalex'
  | 'crossref'
  | 'datacite'
  | 'ror'
  | 'semantic_scholar'
  | 'gdelt'
  | 'wikidata'
  | 'unknown';

/**
 * Source quality tier used for synthesis gating.
 * Tier 1 = primary evidence (arXiv, official blogs, repos, conference proceedings).
 * Tier 2 = reputable secondary (established tech publications, HN discussions with substance).
 * Tier 3 = community/ambient (Reddit threads, YouTube videos, Medium cross-posts).
 * Tier 4 = low-quality/excluded (SEO blogs, event calendars, homepages, social posts unless explicitly needed).
 */
export type SourceQualityTier = 1 | 2 | 3 | 4;

export type AuthorityClass =
  | 'official_spec'
  | 'official_changelog'
  | 'official_repo'
  | 'official_vendor'
  | 'package_registry'
  | 'vendor_sdk_docs'
  | 'third_party_analysis'
  | 'news'
  | 'encyclopedia'
  | 'forum_social'
  | 'unknown';

export type ClaimAuthorityRequirement =
  | 'primary_required'
  | 'primary_preferred'
  | 'secondary_ok'
  | 'any_ok';

export type ReleaseEntityType =
  | 'protocol'
  | 'specification'
  | 'sdk'
  | 'package'
  | 'client_app'
  | 'server'
  | 'blog_post'
  | 'proposal'
  | 'roadmap'
  | 'unknown';

export interface ReleaseEntity {
  canonicalName: string;
  entityType: ReleaseEntityType;
  owner?: string;
  ecosystem?: string;
  packageName?: string;
  repo?: string;
  version?: string;
  releaseDate?: string;
  sourceIds: string[];
  confidence: number;
}

export type TemporalEventType =
  | 'released'
  | 'announced'
  | 'proposed'
  | 'documented'
  | 'discussed'
  | 'updated'
  | 'deprecated'
  | 'unknown';

export type DateConfidence = 'exact' | 'inferred' | 'publication_only' | 'unknown';

export interface TemporalClaim {
  claim: string;
  eventType: TemporalEventType;
  eventDate?: string;
  publicationDate?: string;
  version?: string;
  entity: ReleaseEntity;
  sourceIds: string[];
  confidence: number;
  dateConfidence: DateConfidence;
}

export type ClaimRisk =
  | 'entity_mismatch'
  | 'temporal_misattribution'
  | 'weak_authority'
  | 'weak_evidence_alignment'
  | 'marketing_language'
  | 'cluster_bridge';

export interface EvidenceAlignment {
  score: number;
  method: 'lexical_anchor_overlap' | 'semantic_vector_overlap' | 'hybrid_lexical_semantic';
  matchedTerms: string[];
  missingAnchorTerms: string[];
  semanticScore?: number;
  semanticMatches?: {
    field: 'evidenceSummary' | 'evidenceExcerpt';
    score: number;
    snippet: string;
  }[];
  evidenceSnippet?: string;
  explanation: string;
}

export type FindingClusterEdgeMethod = 'direct' | 'lexical' | 'vector';

export type FindingClusterRelation =
  | 'same_claim'
  | 'near_duplicate'
  | 'supports'
  | 'elaborates'
  | 'contradicts'
  | 'background';

export type FindingClusterEdgeStrength = 'strong' | 'weak';

export interface FindingClusterEdge {
  leftFindingId: string;
  rightFindingId: string;
  method: FindingClusterEdgeMethod;
  relation: FindingClusterRelation;
  strength: FindingClusterEdgeStrength;
  score: number;
  rationale: string;
  lexicalOverlap?: number;
  anchorOverlap?: number;
  semanticScore?: number;
  bridge?: boolean;
  /** When true, this edge falls in the LLM-review band and should be evaluated by the LLM. */
  needsLlmReview?: boolean;
}

export interface FindingCluster {
  id: string;
  findingIds: string[];
  representativeClaim: string;
  method: FindingClusterEdgeMethod | 'hybrid';
  confidence: number;
  edges: FindingClusterEdge[];
  strongEdges: FindingClusterEdge[];
  weakEdges: FindingClusterEdge[];
  bridgeEdges: FindingClusterEdge[];
  relationCounts: Partial<Record<FindingClusterRelation, number>>;
  confidenceCapReason?: string;
  /** Whether this cluster needs LLM review for merge decisions. */
  mergeStatus?: 'auto_merged' | 'needs_llm_review' | 'split' | 'llm_merged' | 'llm_split' | 'llm_kept';
}

export interface ClusterRevisionDecision {
  action: 'merge' | 'split' | 'keep' | 'abstain';
  clusterIds: string[];
  reasoning: string;
  splitGroupIndices?: Record<string, number>;
}

export interface ResearchClaim {
  id: string;
  text: string;
  subjectEntity: ReleaseEntity;
  predicate: string;
  object?: string;
  eventDate?: string;
  publicationDate?: string;
  version?: string;
  sourceIds: string[];
  authorityClass: AuthorityClass;
  authorityRequirement: ClaimAuthorityRequirement;
  supportLevel: 'primary' | 'secondary' | 'weak' | 'conflicting';
  evidenceAlignment?: EvidenceAlignment;
  confidence: number;
  risks: ClaimRisk[];
}

export interface LatestOfficialVersion {
  entity: string;
  version: string;
  sourceId: string;
  changelogUrl: string;
  confidence: number;
}

export interface SourceRecord {
  id: string;
  index: number;
  title: string;
  url: string;
  domain: string;
  sourceType: SourceType;
  authorityClass: AuthorityClass;
  usedInReport: boolean;
  citedClaimIds: string[];
  extractedFindingIds: string[];
}

export type ReportAuditIssueType =
  | 'source_authority'
  | 'entity_mismatch'
  | 'temporal_misattribution'
  | 'unsupported_claim'
  | 'evidence_alignment'
  | 'cluster_integrity'
  | 'citation_mismatch'
  | 'internal_count_mismatch'
  | 'source_diversity'
  | 'marketing_language';

export type AuditEnforcement = 'none' | 'caveat_required' | 'quarantine' | 'block';

export interface ReportAuditIssue {
  id?: string;
  type: ReportAuditIssueType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  claim?: string;
  sourceIds?: string[];
  relatedFindingIds?: string[];
  relatedClusterId?: string;
  explanation: string;
  suggestedFix?: string;
  enforcement?: AuditEnforcement;
}

export interface ReportAuditResult {
  pass: boolean;
  severity: 'ok' | 'warning' | 'fail';
  issues: ReportAuditIssue[];
  requiredRevisions: string[];
}

/**
 * Citable category labels for findings — more specific than generic "architecture".
 * Helps the audit pass detect category mismatches (e.g. TTT labeled as
 * "architecture" when it is really a "training/inference paradigm").
 */
export type FindingCategory =
  | 'architecture'
  | 'training_paradigm'
  | 'inference_framework'
  | 'world_model'
  | 'evaluation_method'
  | 'application'
  | 'community_reaction'
  | 'benchmark'
  | 'definition'
  | 'other';

export type ExtractionStatus = 'pending' | 'extracted' | 'failed';

// ── Phase 2: Source lifecycle tracking ─────────────────────────────────────

/** How a source was ultimately used (or not) in the research. */
export type SourceUsageStatus = 'searched' | 'selected' | 'read' | 'used' | 'discarded' | 'failed';

/** Why a source was discarded (examined but contributed no findings). */
export type DiscardReason =
  | 'duplicate'
  | 'stale'
  | 'low_relevance'
  | 'thin_content'
  | 'extraction_failed'
  | 'bot_challenge'
  | 'paywall'
  | 'no_findings'
  | 'unsupported'
  | 'budget_exceeded';

export interface SourceEntry {
  id: string;
  title: string;
  url: string;
  author?: string;
  organization?: string;
  publishedDate?: string;
  accessDate: string;
  sourceType: SourceType;
  domain: string;
  authorityClass?: AuthorityClass;
  isPrimary: boolean;
  relevantSubQuestions: string[];
  extractionStatus: ExtractionStatus;
  limitations?: string;
  subQuestionId: string;
  /** Phase 2: Current usage status in the research lifecycle. */
  usageStatus?: SourceUsageStatus;
  /** Phase 2: Reason for discard when usageStatus is 'discarded'. */
  discardReason?: DiscardReason;
  /** Phase 2: Quality score (0-1) from content assessment. */
  qualityScore?: number;
  /** Phase 2: Relevance score (0-1) to the research question. */
  relevanceScore?: number;
  /** Phase 2: Freshness score (0-1) based on recency. */
  freshnessScore?: number;
  /** Phase 2: Which worker agent first discovered this source. */
  workerId?: string;
}

/**
 * Per-source LLM-generated summary for synthesis context.
 * Replaces raw compacted content blocks with summarized, attributed content.
 */
export interface SourceSummary {
  url: string;
  title: string;
  sourceType: SourceType;
  domain: string;
  publishedDate?: string;
  /** 2-3 sentence summary of key information relevant to the research question. */
  summary: string;
  /** 3-5 verbatim excerpts from the source most relevant to the research question. */
  keyExcerpts: string[];
  /** Quality assessment (0-1) based on content depth and relevance. */
  qualityScore?: number;
}

// ── Findings ──────────────────────────────────────────────────────────────────

export type EvidenceDirectness =
  | 'direct'
  | 'near-direct'
  | 'secondary'
  | 'anecdotal'
  | 'speculative';

export type ClaimType = 'primary' | 'secondary' | 'anecdotal';

// ── V5.0.0 Structured claim extraction ───────────────────────────────────────

/** Claim polarity — whether the claim asserts, negates, or conditions. */
export type ClaimPolarity = 'asserted' | 'negated' | 'conditional';

/** Epistemic hedge — how certain the source is about this claim. */
export type ClaimHedge = 'certain' | 'likely' | 'possible' | 'speculative';

/** What kind of evidence supports this claim. */
export type ClaimEvidenceType = 'study' | 'benchmark' | 'claim' | 'opinion' | 'anecdote';

/**
 * Canonical quantifier object — normalizes "10% improvement",
 * "reduced by a tenth", and "one-tenth efficiency gain" into the
 * same structured form for cross-source clustering.
 */
export interface CanonicalQuantifier {
  /** Numeric value (e.g. 10, -10, 0.1). */
  value: number;
  /** Unit of measurement (e.g. 'percent', 'seconds', 'dollars'). */
  unit: string;
  /** Comparison direction: 'increase', 'decrease', 'absolute', 'ratio'. */
  comparisonType: 'increase' | 'decrease' | 'absolute' | 'ratio';
  /** What this is compared against (e.g. 'baseline', 'previous version', 'competitor X'). */
  baseline?: string;
  /** Original textual form before normalization. */
  originalText?: string;
}

/**
 * Structured claim — the output of LLM extraction from a ranked passage.
 * This is the canonical internal representation before conversion to Findings.
 */
export interface StructuredClaim {
  /** The subject entity or concept being described. */
  subject: string;
  /** The relationship or property asserted. */
  predicate: string;
  /** The value, entity, or concept on the receiving end (optional). */
  object?: string;
  /** Normalized quantitative claim (optional). */
  quantifier?: CanonicalQuantifier;
  /** Whether this is asserted, negated, or conditional. */
  polarity: ClaimPolarity;
  /** How certain the source is about this claim. */
  hedge: ClaimHedge;
  /** What kind of evidence supports this. */
  evidenceType: ClaimEvidenceType;
  /** The original text span containing this claim. */
  sourceSpan: string;
  /** Source URL this claim was extracted from. */
  sourceUrl?: string;
  /** Source publication date if available. */
  sourceDate?: string;
  /** Relevance score assigned by the cross-encoder (pre-extraction). */
  retrievalScore?: number;
}

/** Normalized canonical form of a claim for cross-source comparison. */
export interface NormalizedClaimKey {
  /** Lowercased, stemmed subject. */
  subject: string;
  /** Lowercased, stemmed predicate. */
  predicate: string;
  /** Canonical quantifier string (e.g. '10%_increase') or undefined. */
  quantifierCanonical?: string;
}

export interface Finding {
  id: string;
  claim: string;
  normalizedClaim: string;
  subQuestionIds: string[];
  sourceIds: string[];
  evidenceSummary: string;
  evidenceExcerpt?: string;
  evidenceDirectness: EvidenceDirectness;
  evidenceAlignment?: EvidenceAlignment;
  caveats?: string;
  scope?: string;
  freshnessSensitive: boolean;
  lastUpdated: string;
  claimType: ClaimType;
  /** Structured provenance fields used to prevent entity/date/source collapses during synthesis. */
  subjectEntity?: ReleaseEntity;
  temporalClaim?: TemporalClaim;
  authorityRequirement?: ClaimAuthorityRequirement;
  authorityClass?: AuthorityClass;
  provenanceRisks?: ClaimRisk[];
  /** Cluster assigned by direct/lexical/vector finding linkage during synthesis. */
  clusterId?: string;
  /** Explicit category label for audit accuracy (architecture, training_paradigm, world_model, etc.). */
  category?: FindingCategory;
  /** Source quality tier of the best source backing this finding. */
  bestSourceTier?: SourceQualityTier;
  createdAt: string;
  /** Post-extraction relevance score (0-1) against the original research query. */
  relevanceScore?: number;
  /** Human-readable explanation for the relevance score. */
  relevanceReason?: string;
  /** If this finding was split from a multi-claim parent, the parent finding's ID. */
  splitFromId?: string;
  /** Source perspective: who is making this claim? */
  perspective?: Perspective;
  /** Whether the source has a potential conflict of interest. */
  conflictOfInterest?: boolean;
  /** Epistemic status of this claim within the broader literature. */
  epistemicStatus?: EpistemicStatus;
  // ── V5.0.0 structured fields ──────────────────────────────────────────
  /** Whether this claim is asserted, negated, or conditional. */
  polarity?: ClaimPolarity;
  /** How certain the source is about this claim. */
  hedge?: ClaimHedge;
  /** What kind of evidence backs this. */
  evidenceType?: ClaimEvidenceType;
  /** Normalized quantifier for cross-source comparison. */
  quantifier?: CanonicalQuantifier;
  /** Canonical claim key for cross-source clustering. */
  canonicalKey?: NormalizedClaimKey;
  /** Cross-encoder relevance score (pre-extraction retrieval). */
  retrievalScore?: number;
  /** Whether the retrieval score came from an exact chunk match rather than a fallback. */
  retrievalScoreMatched?: boolean;
}

// ── Source-perspective metadata ────────────────────────────────────────────────

export type Perspective =
  | 'vendor'
  | 'academic'
  | 'practitioner'
  | 'official'
  | 'community'
  | 'media'
  | 'unknown';

export type EpistemicStatus = 'consensus' | 'contested' | 'emerging' | 'speculative' | 'unknown';

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
  followUpSearchRecommended?: string;
}

// ── Gaps ──────────────────────────────────────────────────────────────────────

export type GapCategory =
  | 'unanswered_sub_question'
  | 'low_confidence'
  | 'unresolvable_contradiction'
  | 'missing_source_type'
  | 'missing_recency'
  | 'overrepresented_viewpoint'
  | 'thin_coverage'
  | 'low_content_depth'
  | 'single_source_dependency'
  | 'promotional_bias';

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

export interface ResolvedGap {
  id: string;
  question: string;
  parentQuestion?: string;
  answer?: string;
  resolvedAt: string;
}

export interface SearchCluster {
  insight: string;
  question: string;
  urls: string[];
}

// ── Grounding types (Phase 1: synthesis claim grounding) ──────────────────

/** Result of grounding a single synthesis claim against source chunks. */
export interface GroundedClaim {
  /** The claim sentence text. */
  text: string;
  /** Cosine similarity to the nearest source chunk embedding (0-1). */
  nearestSourceScore: number;
  /** ID of the nearest source chunk, if any. */
  nearestSourceChunkId?: string;
  /** Whether the claim passes the grounding threshold (default 0.72). */
  grounded: boolean;
  /** Extracted dates found in the claim but not in any source. */
  unverifiedDates?: string[];
  /** Extracted numbers found in the claim but not in any source. */
  unverifiedNumbers?: string[];
  /** Extracted named entities (proper nouns) found in the claim but not in any source. */
  unverifiedEntities?: string[];
}

export interface GroundingResult {
  claims: GroundedClaim[];
  groundedCount: number;
  ungroundedCount: number;
  /** Ungrounded claims that should be flagged as uncertainties. */
  warnings: string[];
}

// ── New: FailureMode (operational replacement for old FailureAnalysis) ────────

export interface FailureAnalysis {
  recap: string;
  blame: string;
  improvement: string;
}

// ── New: GapTarget (typed agenda item with lifecycle) ─────────────────────────-

export type GapTargetStatus = 'open' | 'active' | 'resolved' | 'abandoned' | 'duplicate';

export type GapTargetSource =
  | 'decomposition'
  | 'gap_analysis'
  | 'failure_analysis'
  | 'citation_chase';

export interface GapTarget {
  id: string;
  question: string;
  normalizedQuestion: string;
  parentId?: string;
  parentQuestion?: string;
  status: GapTargetStatus;
  priority: number;
  attempts: number;
  createdAtStep: number;
  lastTriedAtStep?: number;
  source: GapTargetSource;
  failureReason?: string;
  resolution?: {
    answer: string;
    evidenceSummary: string;
  };
}

// ── New: EvaluationResult (canonical evaluation consumed by Agenda, Gates, FailureAnalysis, Synthesis) ─

export interface EvaluationResult {
  pass: boolean;
  score: number;
  missingDimensions: string[];
  unsupportedClaims: string[];
  contradictions: string[];
  requiredNextEvidence: string[];
  reason: string;
}

// ── New: Gate / ActionType (computed per iteration) ────────────────────────────

export type ResearchAction =
  | 'answer'
  | 'decompose'
  | 'discover'
  | 'extract'
  | 'fill_gaps'
  | 'generate_queries'
  | 'contradiction_scan'
  | 'audit'
  | 'synthesize'
  | 'complete';

export interface Gate {
  action: ResearchAction;
  allowed: boolean;
  reason?: string;
}

// ── New: KnowledgeItem (intermediate between findings and LLM context) ─────────

export type KnowledgeType = 'finding' | 'gap_resolution' | 'contradiction' | 'serp_hypothesis';

export interface KnowledgeItem {
  id: string;
  question: string;
  answer: string;
  references: string[];
  type: KnowledgeType;
  sourceFindingIds: string[];
  createdAtStep: number;
}

// ── New: TraceEvent (unified diary/progress/timeline event) ────────────────────

export type TraceAction =
  | 'search'
  | 'visit'
  | 'extract'
  | 'evaluate'
  | 'answer_attempt'
  | 'gap_added'
  | 'gap_resolved'
  | 'audit'
  | 'warning'
  | 'synthesize';

export interface TraceEvent {
  step: number;
  phase: string;
  action: TraceAction;
  targetId?: string;
  sourceIds?: string[];
  findingIds?: string[];
  result?: string;
  gateChanges?: string[];
  timestamp: string;
}

// ── New: SearchAttempt (tracked for adaptive strategy) ─────────────────────────

export interface SearchAttempt {
  subQuestionId: string;
  queries: string[];
  backends: SourceType[];
  resultCount: number;
  timestamp: string;
}

export interface LanguageProfile {
  code: string;
  style: string;
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

// ── Browser interactive extraction plans ──────────────────────────────────────

/** Plan for interactive browser extraction (login walls, SPAs, bot challenges). */
export interface InteractiveExtractionPlan {
  /** Sequence of browser actions to execute before extraction. */
  actions: InteractiveAction[];
  /** Extraction strategy after actions complete. */
  extraction: {
    /** NL instruction for what to extract (requires LLM). */
    instruction?: string;
    /** CSS selector scoping the content area. */
    selector?: string;
  };
  /** Max time for the plan execution in ms. */
  maxTimeMs?: number;
}

/** A single browser action in an extraction plan. */
export interface InteractiveAction {
  type: 'navigate' | 'click' | 'type' | 'wait' | 'evaluate' | 'scroll' | 'screenshot' | 'select';
  /** Target ref (from snapshot), CSS selector, or text to match. */
  target?: string;
  /** Value for type/select actions. */
  value?: string;
  /** Timeout per action in ms. */
  timeout?: number;
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
  /** Phase 6: Intent for freshness scoring — controls how recency is valued. */
  freshnessIntent?: 'recent' | 'historical' | 'any';
  failureModes: string[];
  budgetPriority: number;
  status: SubQuestionStatus;
  /** Whether this sub-question requires authenticated access (login-walled content). */
  requiresAuth?: boolean;
  /** Plan for interactive browser extraction if the page has bot detection. */
  extractionPlan?: InteractiveExtractionPlan;
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

export interface ScoredCandidate extends SourceCandidate {
  freqBoost: number;
  authorityBoost: number;
  diversityScore: number;
  totalScore: number;
  readPriorityScore: number;
  evidenceWeight: number;
}

// ── Budget ────────────────────────────────────────────────────────────────────

export type ResearchDepth = 'quick' | 'standard' | 'deep' | 'exhaustive' | 'tree';

export interface BudgetProfile {
  depth: ResearchDepth;
  maxSources: number;
  maxExtractions: number;
  maxGapLoops: number;
  /** Minimum gap-loop sanity passes before early-stop heuristics may halt. */
  minGapLoops: number;
  maxToolCalls: number;
  maxTokens: number;
  maxTimeMs: number;
  maxStateEntries: number;
}

export interface TreeProfile {
  treeBreadth: number;
  treeDepth: number;
  treeConcurrency: number;
  treeContextWordLimit: number;
}

export interface TreeLearning {
  learning: string;
  citation?: string;
  sourceUrl?: string;
}

export interface TreeResearchResult {
  learnings: string[];
  allLearnings: TreeLearning[];
  visitedUrls: string[];
  citations: Record<string, string>;
  context: string[];
  sources: SourceEntry[];
  researchQuestions: { query: string; researchGoal: string }[];
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
  stateEntriesUsed: number;
  maxStateEntries: number;
  stepCosts: Record<string, number>;
  maxTimeMs: number;
  /** Per-gap-loop findings count for confidence plateau detection. */
  findingsAddedPerLoop: number[];
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
  gapTargets: string[];
  allQuestions: string[];
  resolvedGaps: ResolvedGap[];
  searchClusters: SearchCluster[];
  diary: string[];
  language?: LanguageProfile;
  searchAttempts: SearchAttempt[];
  /** V5.0.0: Worker agent reports keyed by report ID. */
  workerReports: Record<string, WorkerReport>;
  /** V5.0.0: Content quality assessments keyed by URL. */
  contentQuality: Record<string, ContentQualityAssessment>;
  /** V5.0.0: Per-sub-question coverage metrics. */
  subQuestionCoverage: SubQuestionCoverage[];
}

// ── Intent tracking ──────────────────────────────────────────────────────────

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
  | { phase: 'complete' }
  | { phase: 'action'; actionType: string; detail: string; timestamp: string };

// ── Output ────────────────────────────────────────────────────────────────────

export interface EvidenceItem {
  id: string;
  sourceIds: string[];
  findingId?: string;
  summary: string;
  excerpt?: string;
  alignment?: EvidenceAlignment;
}

export type EvidenceGraphNodeType =
  | 'source'
  | 'evidence'
  | 'finding'
  | 'cluster'
  | 'audit_issue'
  | 'synthesis_claim';

export type EvidenceGraphEdgeRelation =
  | 'source_provides_evidence'
  | 'evidence_supports_finding'
  | 'finding_member_of_cluster'
  | 'cluster_has_audit_issue'
  | 'finding_has_audit_issue'
  | 'synthesis_renders_finding'
  | 'synthesis_renders_cluster'
  | 'synthesis_has_audit_issue';

export interface EvidenceGraphEdge {
  fromId: string;
  toId: string;
  relation: EvidenceGraphEdgeRelation;
  reason: string;
  confidence?: number;
}

export interface EvidenceGraphFindingNode {
  id: string;
  claim: string;
  sourceIds: string[];
  evidenceItemIds: string[];
  clusterId?: string;
  confidence?: number;
  confidenceCapReason?: string;
}

export interface SynthesisClaimNode {
  id: string;
  text: string;
  findingIds: string[];
  clusterIds: string[];
  auditIssueIds: string[];
}

export interface EvidenceGraph {
  sources: SourceRecord[];
  evidence: EvidenceItem[];
  findings: EvidenceGraphFindingNode[];
  clusters: FindingCluster[];
  findingClusterEdges: FindingClusterEdge[];
  auditIssues: ReportAuditIssue[];
  synthesisClaims: SynthesisClaimNode[];
  edges: EvidenceGraphEdge[];
}

export interface ResearchReport {
  query: string;
  classification: QueryClassification;
  depth: ResearchDepth;
  /** 'deep' = normal deep research with extracted findings.
   * 'source_note_synthesis' = no findings were extracted; report is based on source notes/snippets only.
   * 'extraction_fallback' = extraction was re-attempted after initial zero-finding result. */
  degradationMode?: 'deep' | 'source_note_synthesis' | 'extraction_fallback';
  executiveSummary: string;
  /** Full narrative report in markdown — the primary output. */
  narrativeMarkdown: string;
  themes: {
    title: string;
    narrative: string;
    findings?: string[];
    sourceCitations?: { id: string; url: string; title: string }[];
  }[];
  contradictions: Contradiction[];
  uncertainties: string[];
  sourceNotes: string[];
  openQuestions: string[];
  recommendations?: string;
  limitations: string[];
  sourceCount: number;
  findingCount: number;
  /** Count of distinct source types (corpuses) across all sources. */
  sourceTypeCount: number;
  /** Breakdown of sources by type: [{ type, count }]. */
  sourceDiversity: { type: string; count: number }[];
  /** Curated evidence sources cited in the narrative (quality-gated, primary-preferring. Tier 1-3 always included; tier 4 only if backing a finding). */
  evidenceSources: {
    index: number;
    title: string;
    url: string;
    sourceType: SourceType;
    authorityClass?: AuthorityClass;
    tier: SourceQualityTier;
    domain: string;
  }[];
  sourceRegistry?: SourceRecord[];
  claimLedger?: ResearchClaim[];
  findingClusters?: FindingCluster[];
  findingClusterEdges?: FindingClusterEdge[];
  evidenceGraph?: EvidenceGraph;
  latestOfficialVersion?: LatestOfficialVersion;
  reportAudit?: ReportAuditResult;
  /** Per-sub-question coverage summary for gap detection. */
  subQuestionCoverage?: SubQuestionCoverage[];
}

export interface ResearchResult {
  report: ResearchReport;
  timeline: ResearchProgress[];
  /** Canonical final findings from ResearchState; compact output should prefer this over timeline events. */
  canonicalFindings?: Finding[];
}
// ── Compact output (V4.2.0 — result compaction for MCP transport) ─────────────────

export interface CompactFinding {
  id: string;
  claim: string;
  evidenceSummary: string;
  evidenceExcerpt?: string;
  evidenceDirectness: EvidenceDirectness;
  sourceCount: number;
  sourceIds?: string[];
  claimType: ClaimType;
  subQuestionIds: string[];
  evidenceAlignment?: EvidenceAlignment;
  provenanceRisks?: ClaimRisk[];
  clusterId?: string;
}

export interface CompactContradiction {
  id: string;
  claimA: string;
  claimB: string;
  contradictionType: ContradictionType;
  resolutionStatus: ContradictionStatus;
}

export interface CompactStatistics {
  sourceCount: number;
  /** Count of distinct source types (corpuses). */
  sourceTypeCount: number;
  /** Breakdown of sources by type: [{ type, count }]. */
  sourceDiversity: { type: string; count: number }[];
  totalFindingCount: number;
  includedFindingCount: number;
  droppedByCapCount: number;
  contradictionCount: number;
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
  /** Suggested correction for category mismatch issues. */
  suggestedCorrection?: string;
}

export interface AuditReport {
  passed: boolean;
  issues: AuditIssue[];
  stats: {
    totalClaims: number;
    unsourcedClaims: number;
    unresolvedContradictions: number;
    mergedDuplicates: number;
    sourceDiversity: { type: string; count: number }[];
    taxonomyDrift: boolean;
  };
  timestamp: string;
}

// ── V5.0.0: Worker Agents & Content Quality ──────────────────────────────────

/** Content quality assessment for a fetched page. */
export interface ContentQualityAssessment {
  /** Whether the page has substantive analytical content (not just marketing/nav). */
  isSubstantive: boolean;
  /** 0-1 score based on word count, heading structure, data/table presence. */
  contentDepth: number;
  /** Detected marketing/promotional content. */
  isPromotional: boolean;
  /** Contains tables, code blocks, benchmarks, or structured data. */
  hasData: boolean;
  /** Cites other sources (inline links, references section). */
  hasCitations: boolean;
  /** Reading depth level. */
  readingLevel: 'surface' | 'intermediate' | 'deep';
  /** Human-readable summary of quality assessment. */
  summary: string;
  /** Specific signals that triggered promotional detection. */
  promotionalSignals?: string[];
}

/** Per-sub-question coverage metrics for gap analysis. */
export interface SubQuestionCoverage {
  subQuestionId: string;
  subQuestionText: string;
  sourceCount: number;
  uniqueDomainCount: number;
  findingCount: number;
  averageContentDepth: number;
  hasPromotionalSources: boolean;
  sourceTypes: SourceType[];
  status: 'adequate' | 'thin' | 'risky' | 'uncovered';
}

/** A worker agent's investigation report for one research question. */
export interface WorkerReport {
  /** Unique report ID. */
  id: string;
  /** The question the worker was assigned. */
  question: string;
  /** Parent sub-question ID if this was a follow-up thread. */
  parentSubQuestionId?: string;
  /** Structured findings extracted by the worker. */
  findings: WorkerFinding[];
  /** Sources the worker visited and analyzed. */
  sources: WorkerSource[];
  /** Interesting sub-threads the worker identified for further investigation. */
  subThreads: SubThread[];
  /** Quality assessments for each visited source. */
  contentQuality: Record<string, ContentQualityAssessment>;
  /** Narrative summary written by the worker. */
  narrativeSummary: string;
  /** Search queries the worker used. */
  searchQueries: string[];
  /** Trail of LLM reflection decisions made during investigation. */
  reflectionTrail?: string[];
  /** Total tokens consumed by this worker. */
  tokensUsed: number;
  /** Elapsed time in ms. */
  elapsedMs: number;
}

/** Confidence level for a finding's source citation mapping. */
export type CitationConfidence =
  | 'explicit' // LLM provided structured sourceIndices for this finding
  | 'inferred' // Resolved via secondary method (regex, similarity)
  | 'unattributed'; // No source could be determined

/** A single finding from a worker agent. */
export interface WorkerFinding {
  /** Unique finding ID. */
  id: string;
  /** The claim text. */
  claim: string;
  /** Evidence excerpt from the source. */
  evidence: string;
  /** Source URLs backing this claim. */
  sourceUrls: string[];
  /** How confident we are that the sourceUrls correctly map to this claim. */
  citationConfidence: CitationConfidence;
  /** Caveats or limitations the worker noted. */
  caveats?: string;
}

/** A source the worker visited and assessed. */
export interface WorkerSource {
  /** Source URL. */
  url: string;
  /** Page title. */
  title: string;
  /** Source type. */
  sourceType: SourceType;
  /** Domain. */
  domain: string;
  /** Content quality assessment. */
  quality: ContentQualityAssessment;
  /** Why the worker chose this source. */
  relevanceRationale: string;
  /** Publication date if known. */
  publishedDate?: string;
  /** Phase 2: Current usage status in the research lifecycle. */
  usageStatus?: SourceUsageStatus;
  /** Phase 2: Reason for discard when usageStatus is 'discarded'. */
  discardReason?: DiscardReason;
  /** Phase 2: Quality score (0-1) from content assessment. */
  qualityScore?: number;
  /** Phase 2: Relevance score (0-1) to the research question. */
  relevanceScore?: number;
  /** Phase 2: Freshness score (0-1) based on recency. */
  freshnessScore?: number;
  /** Phase 2: Which worker agent first discovered this source. */
  workerId?: string;
}

/** A sub-thread identified by a worker for further investigation. */
export interface SubThread {
  /** The follow-up question the worker suggests. */
  question: string;
  /** Why this thread is worth chasing. */
  rationale: string;
  /** Priority (1 = highest, 5 = lowest). */
  priority: number;
  /** Suggested source types to search. */
  suggestedSourceTypes: SourceType[];
}

/** Tool interface exposed to worker agents. */
export interface ResearchTools {
  webSearch(
    query: string,
    limit?: number,
  ): Promise<
    {
      title: string;
      url: string;
      description: string;
      age?: string;
      extraSnippet?: string;
      deepLinks?: { title: string; url: string }[];
    }[]
  >;
  webCrawl(
    url: string,
    maxPages?: number,
  ): Promise<{ title: string; url: string; markdown: string }[]>;
  webRead(url: string): Promise<{ title: string; url: string; markdown: string }>;
  academicSearch(
    query: string,
    limit?: number,
  ): Promise<{ title: string; url: string; abstract?: string; year?: number }[]>;
  githubSearch(
    query: string,
    limit?: number,
  ): Promise<{ fullName: string; htmlUrl: string; description: string }[]>;
  redditSearch(
    query: string,
    limit?: number,
  ): Promise<
    { title: string; url: string; selftext?: string; created_utc?: number; permalink: string }[]
  >;
  hackernewsSearch(
    query: string,
    limit?: number,
  ): Promise<{ title: string; url: string; text?: string }[]>;

  // ── YouTube ─────────────────────────────────────────────────────────────
  /** Search YouTube videos. */
  youtubeSearch(
    query: string,
    limit?: number,
  ): Promise<
    { title: string; videoId: string; channelTitle: string; publishedAt: string; url: string }[]
  >;
  /** Fetch transcript for a YouTube video. */
  youtubeTranscript(
    videoId: string,
    language?: string,
  ): Promise<{ text: string; duration: number; offset: number }[]>;

  // ── Reddit comments ─────────────────────────────────────────────────────
  /** Fetch comment tree for a Reddit thread. */
  redditComments(
    url: string,
    limit?: number,
  ): Promise<{
    post: { title: string; selftext: string };
    comments: { body: string; author: string; permalink: string; depth: number }[];
  }>;

  // ── Semantic search tools ───────────────────────────────────────────────
  /** Semantic YouTube: search + transcripts + rank by query relevance. */
  semanticYoutube(
    query: string,
    options?: { maxVideos?: number; channel?: string; topK?: number },
  ): Promise<{
    chunks: { text: string; videoId: string; title: string; score: number; url: string }[];
    videoCount: number;
    failedTranscripts: number;
    warnings: string[];
  }>;

  /** Semantic Reddit: search + comments + rank by query relevance. */
  semanticReddit(
    query: string,
    options?: { subreddit?: string; maxPosts?: number; topK?: number },
  ): Promise<{
    chunks: { text: string; postTitle: string; score: number; url: string }[];
    postCount: number;
    failedPosts: number;
    warnings: string[];
  }>;

  /** Semantic GitHub code search within a repo. */
  semanticGitHubCode(
    query: string,
    repo: string,
    options?: { language?: string; maxFiles?: number; topK?: number },
  ): Promise<{
    results: {
      path: string;
      url: string;
      language: string;
      symbolName?: string;
      text?: string;
      score: number;
    }[];
    warnings: string[];
  }>;

  /** Semantic crawl: crawl a URL and retrieve chunks relevant to query. */
  semanticCrawl(
    url: string,
    query: string,
    options?: { maxPages?: number; topK?: number },
  ): Promise<{
    chunks: { text: string; url: string; section: string; score: number }[];
    pagesCrawled: number;
    warnings: string[];
  }>;

  // ── Medical/Reference ──────────────────────────────────────────────────
  /** Search PubMed for medical/scientific literature. */
  pubmedSearch(
    query: string,
    limit?: number,
  ): Promise<
    {
      title: string;
      link: string;
      snippet: string;
      publishedDate?: string | undefined;
      authors?: string[] | undefined;
      journal?: string | undefined;
    }[]
  >;
  /** Search Wikipedia for general knowledge. */
  wikipediaSearch(
    query: string,
    language?: string,
  ): Promise<
    {
      title: string;
      link: string;
      snippet: string;
      pageId?: number | undefined;
      language?: string | undefined;
    }[]
  >;

  // ── Developer Q&A ────────────────────────────────────────────────────────
  /** Search Stack Overflow / Stack Exchange for technical Q&A. */
  stackoverflowSearch(
    query: string,
    limit?: number,
  ): Promise<
    {
      title: string;
      link: string;
      bodySnippet: string;
      answerCount: number;
      score: number;
      tags: string[];
      isAnswered: boolean;
    }[]
  >;

  // ── Free academic/discovery backends ────────────────────────────────────
  /** Search OpenAlex for scholarly works (free, no API key). */
  openalexSearch(
    query: string,
    limit?: number,
  ): Promise<
    {
      title: string;
      link: string;
      snippet: string;
      publishedDate?: string | undefined;
      authors?: string[] | undefined;
      doi?: string | undefined;
      citedByCount?: number | undefined;
      type?: string | undefined;
    }[]
  >;

  /** Search Crossref for DOIs and citation metadata (free, no API key). */
  crossrefSearch(
    query: string,
    limit?: number,
  ): Promise<
    {
      title: string;
      link: string;
      snippet: string;
      publishedDate?: string | undefined;
      authors?: string[] | undefined;
      doi?: string | undefined;
      publisher?: string | undefined;
      type?: string | undefined;
    }[]
  >;

  /** Search DataCite for research datasets and DOIs (free, no API key). */
  dataciteSearch(
    query: string,
    limit?: number,
  ): Promise<
    {
      title: string;
      link: string;
      snippet: string;
      publishedDate?: string | undefined;
      publisher?: string | undefined;
      doi?: string | undefined;
      resourceType?: string | undefined;
    }[]
  >;

  /** Search ROR for research organizations (free, no API key). */
  rorSearch(
    query: string,
    limit?: number,
  ): Promise<
    {
      title: string;
      link: string;
      snippet: string;
      types?: string[] | undefined;
      country?: string | undefined;
      city?: string | undefined;
      established?: number | undefined;
      rorId?: string | undefined;
    }[]
  >;

  /** Search Semantic Scholar for papers (free, rate-limited). */
  semanticScholarSearch(
    query: string,
    limit?: number,
  ): Promise<
    {
      title: string;
      link: string;
      snippet: string;
      publishedDate?: string | undefined;
      authors?: string[] | undefined;
      citationCount?: number | undefined;
      doi?: string | undefined;
      paperId?: string | undefined;
    }[]
  >;

  /** Search GDELT for global news/events (free, no API key). */
  gdeltSearch(
    query: string,
    limit?: number,
  ): Promise<
    {
      title: string;
      link: string;
      snippet: string;
      publishedDate?: string | undefined;
      sourceCountry?: string | undefined;
      tone?: string | undefined;
      domain?: string | undefined;
    }[]
  >;

  /** Search Wikidata for knowledge graph entities (free, no API key). */
  wikidataSearch(
    query: string,
    limit?: number,
  ): Promise<
    {
      title: string;
      link: string;
      snippet: string;
      qid?: string | undefined;
      aliases?: string[] | undefined;
    }[]
  >;
  // ── Browser interactive extraction ──────────────────────────────────
  /** Create a browser session for interactive extraction. */
  browserSession: (config: BrowserSessionConfig) => Promise<{ sessionId: string }>;

  /** Extract content interactively (login walls, SPAs, bot challenges). */
  browserExtract: (
    sessionId: string,
    url: string,
    plan: InteractiveExtractionPlan,
  ) => Promise<{
    content: string;
    findings: Finding[];
    sources: SourceEntry[];
    screenshots?: string[];
  }>;

  /** Close the browser session. */
  browserClose: (sessionId: string) => Promise<void>;
}
