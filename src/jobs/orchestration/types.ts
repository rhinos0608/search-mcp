import type { Sha256Hex, Instant } from '../evaluation/types.js';

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

export const ORCHESTRATION_CONTRACT_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// IDs (branded strings)
// ---------------------------------------------------------------------------

export type JobRunId = string;
export type JobSliceId = string;
export type JobCandidateId = string;
export type JobResultId = string;

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

export type PipelineStage =
  | 'acquisition'
  | 'extraction'
  | 'identity'
  | 'retrieval'
  | 'assessment'
  | 'ranking'
  | 'output';

// ---------------------------------------------------------------------------
// Run state machine
// ---------------------------------------------------------------------------

export type JobRunState =
  | 'created'
  | 'acquiring'
  | 'extracting'
  | 'resolving_identity'
  | 'retrieving'
  | 'assessing'
  | 'ranking'
  | 'finalizing'
  | 'completed'
  | 'budget_exhausted'
  | 'deadline_exceeded'
  | 'aborted'
  | 'failed';

// ---------------------------------------------------------------------------
// Slice state machine
// ---------------------------------------------------------------------------

export type SliceState =
  | 'planned'
  | 'reserved'
  | 'running'
  | 'completed'
  | 'skipped_budget'
  | 'skipped_deadline'
  | 'skipped_aborted'
  | 'failed_isolated';

// ---------------------------------------------------------------------------
// Candidate state machine
// ---------------------------------------------------------------------------

export type JobCandidateState =
  | 'discovered'
  | 'extracted'
  | 'identity_bound'
  | 'retrieved'
  | 'assessed'
  | 'ranked'
  | 'suppressed_duplicate'
  | 'dropped_budget'
  | 'dropped_policy';

// ---------------------------------------------------------------------------
// Result state
// ---------------------------------------------------------------------------

export type JobResultState = 'pending' | 'emitted' | 'withheld_coverage' | 'withheld_error';

// ---------------------------------------------------------------------------
// Budget types
// ---------------------------------------------------------------------------

export interface JobRunBudget {
  logicalRequests: number;
  reservedAttempts: number;
  candidates: number;
  bytes: number;
  milliseconds: number;
  pages: number;
  enrichment: number;
  reasoning: number;
}

export interface JobBudgetConsumed {
  logicalRequests: number;
  reservedAttempts: number;
  candidates: number;
  bytes: number;
  milliseconds: number;
  pages: number;
  enrichment: number;
  reasoning: number;
}

// ---------------------------------------------------------------------------
// Slice
// ---------------------------------------------------------------------------

export interface JobSlice {
  schemaVersion: typeof ORCHESTRATION_CONTRACT_VERSION;
  runId: JobRunId;
  sliceId: JobSliceId;
  ordinal: number;
  stage: PipelineStage;
  state: SliceState;
  queryVariantId: string;
  adapterIds: string[];
  localePackRefs: string[];
  domainPackRefs: string[];
  budget: Pick<
    JobRunBudget,
    'logicalRequests' | 'reservedAttempts' | 'candidates' | 'bytes' | 'milliseconds'
  >;
}

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

export interface JobCandidate {
  schemaVersion: typeof ORCHESTRATION_CONTRACT_VERSION;
  candidateId: JobCandidateId;
  runId: JobRunId;
  sliceId: JobSliceId;
  state: JobCandidateState;
  acquisitionCandidateId?: string;
  postingId?: string;
  identityDecisionId?: string;
  evidenceRefs: string[];
  utility?: number;
  coverage?: number;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface JobResult {
  schemaVersion: typeof ORCHESTRATION_CONTRACT_VERSION;
  resultId: JobResultId;
  runId: JobRunId;
  candidateId: JobCandidateId;
  state: JobResultState;
  rank?: number;
  flags: string[];
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface JobRun {
  schemaVersion: typeof ORCHESTRATION_CONTRACT_VERSION;
  runId: JobRunId;
  state: JobRunState;
  stage: PipelineStage | 'none';
  createdAt: Instant;
  intentFingerprint: Sha256Hex;
  planId?: string;
  budget: JobRunBudget;
  consumed: JobBudgetConsumed;
  slices: JobSlice[];
  candidates: JobCandidate[];
  results: JobResult[];
  coverage: unknown[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Observability snapshot
// ---------------------------------------------------------------------------

export interface ObservabilitySnapshot {
  runId: JobRunId;
  state: JobRunState;
  stage: PipelineStage | 'none';
  consumed: JobBudgetConsumed;
  remaining: JobBudgetConsumed;
  sliceCounts: Record<SliceState, number>;
  candidateCounts: Record<JobCandidateState, number>;
  resultCounts: Record<JobResultState, number>;
  coverageStates: Record<string, number>;
  durationMs: number;
}
