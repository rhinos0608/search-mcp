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
   domain: string;
   isPrimary: boolean;
   relevantSubQuestions: string[];
   extractionStatus: ExtractionStatus;
   limitations?: string;
   subQuestionId: string;
}

// ── Findings ──────────────────────────────────────────────────────────────────



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

// ── New: FailureMode (operational replacement for old FailureAnalysis) ────────

export interface FailureAnalysis {
   recap: string;
   blame: string;
   improvement: string;
}

// ── New: GapTarget (typed agenda item with lifecycle) ─────────────────────────-

export type GapTargetStatus =
   | 'open'
   | 'active'
   | 'resolved'
   | 'abandoned'
   | 'duplicate';

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

export type KnowledgeType =
   | 'finding'
   | 'gap_resolution'
   | 'contradiction'
   | 'serp_hypothesis';

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
   maxToolCalls: number;
   maxTokens: number;
   maxTimeMs: number;
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
   stepCosts: Record<string, number>;
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

export interface ResearchReport {
   query: string;
   classification: QueryClassification;
   depth: ResearchDepth;
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
   /** Per-sub-question coverage summary for gap detection. */
   subQuestionCoverage?: SubQuestionCoverage[];
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
   /** Total tokens consumed by this worker. */
   tokensUsed: number;
   /** Elapsed time in ms. */
   elapsedMs: number;
}

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
   webSearch(query: string, limit?: number): Promise<{ title: string; url: string; description: string; age?: string; extraSnippet?: string; deepLinks?: { title: string; url: string }[] }[]>;
   webCrawl(url: string, maxPages?: number): Promise<{ title: string; url: string; markdown: string }[]>;
   webRead(url: string): Promise<{ title: string; url: string; markdown: string }>;
   academicSearch(query: string, limit?: number): Promise<{ title: string; url: string; abstract?: string; year?: number }[]>;
   githubSearch(query: string, limit?: number): Promise<{ fullName: string; htmlUrl: string; description: string }[]>;
   redditSearch(query: string, limit?: number): Promise<{ title: string; url: string; selftext?: string; created_utc?: number; permalink: string }[]>;
   hackernewsSearch(query: string, limit?: number): Promise<{ title: string; url: string; text?: string }[]>;

   // ── YouTube ─────────────────────────────────────────────────────────────
   /** Search YouTube videos. */
   youtubeSearch(query: string, limit?: number): Promise<{ title: string; videoId: string; channelTitle: string; publishedAt: string; url: string }[]>;
   /** Fetch transcript for a YouTube video. */
   youtubeTranscript(videoId: string, language?: string): Promise<{ text: string; duration: number; offset: number }[]>;

   // ── Reddit comments ─────────────────────────────────────────────────────
   /** Fetch comment tree for a Reddit thread. */
   redditComments(url: string, limit?: number): Promise<{ post: { title: string; selftext: string }; comments: { body: string; author: string; permalink: string; depth: number }[] }>;

   // ── Semantic search tools ───────────────────────────────────────────────
   /** Semantic YouTube: search + transcripts + rank by query relevance. */
   semanticYoutube(query: string, options?: { maxVideos?: number; channel?: string; topK?: number }): Promise<{ chunks: { text: string; videoId: string; title: string; score: number; url: string }[]; videoCount: number; failedTranscripts: number; warnings: string[] }>;

   /** Semantic Reddit: search + comments + rank by query relevance. */
   semanticReddit(query: string, options?: { subreddit?: string; maxPosts?: number; topK?: number }): Promise<{ chunks: { text: string; postTitle: string; score: number; url: string }[]; postCount: number; failedPosts: number; warnings: string[] }>;

   /** Semantic GitHub code search within a repo. */
   semanticGitHubCode(query: string, repo: string, options?: { language?: string; maxFiles?: number; topK?: number }): Promise<{ results: { path: string; url: string; language: string; symbolName?: string; text?: string; score: number }[]; warnings: string[] }>;

   /** Semantic crawl: crawl a URL and retrieve chunks relevant to query. */
   semanticCrawl(url: string, query: string, options?: { maxPages?: number; topK?: number }): Promise<{ chunks: { text: string; url: string; section: string; score: number }[]; pagesCrawled: number; warnings: string[] }>;
}
