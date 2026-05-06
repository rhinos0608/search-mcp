export type {
   // Re-export all types explicitly to avoid ambiguity
   ResearchPhase,
   QueryClassification,
   SourceType,
   ExtractionStatus,
   SourceEntry,
   EvidenceDirectness,
   ClaimType,
   Finding,
   ContradictionType,
   ContradictionStatus,
   Contradiction,
   GapCategory,
   GapStatus,
   GapRecord,
   ResolvedGap,
   SearchCluster,
   FailureAnalysis,
   GapTargetStatus,
   GapTargetSource,
   GapTarget,
   EvaluationResult,
   ResearchAction,
   Gate,
   KnowledgeType,
   KnowledgeItem,
   TraceAction,
   TraceEvent,
   SearchAttempt,
   LanguageProfile,
   ClaimEdgeType,
   ClaimEdge,
   SubQuestionStatus,
   SubQuestion,
   SourceCandidate,
   ScoredCandidate,
   ResearchDepth,
   BudgetProfile,
   TreeProfile,
   TreeLearning,
   TreeResearchResult,
   BudgetState,
   ResearchTaxonomy,
   ResearchFlags,
   ResearchState,
   ResearchProgress,
   ResearchReport,
   ResearchResult,
   CompactFinding,
   CompactContradiction,
   CompactStatistics,
   CompactResearchResult,
   CompactionOptions,
   AuditIssue,
   AuditReport,
   ContentQualityAssessment,
   SubQuestionCoverage,
   WorkerReport,
   WorkerFinding,
   WorkerSource,
   SubThread,
   ResearchTools,
} from './types.js';
export * from './decomposer.js';
export * from './taxonomy.js';
export * from './state.js';
export * from './discovery.js';
export * from './extraction.js';
export * from './gapAnalysis.js';
export * from './audit.js';
export * from './synthesizer.js';
export * from './progress.js';
export * from './orchestrator.js';
export * from './agenda.js';
export * from './actionGates.js';
export * from './trace.js';
export * from './knowledge.js';
export * from './sourceRanking.js';
