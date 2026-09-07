// ---------------------------------------------------------------------------
// Shared primitives (reuses domain ID bounds)
// ---------------------------------------------------------------------------

/** Lowercase 64-char hex from SHA-256. */
export type Sha256Hex = string;

/** ISO-8601 with offset (same as InstantSchema from domain/ids). */
export type Instant = string;

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

export const EVALUATION_CONTRACT_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// Suite ID
// ---------------------------------------------------------------------------

export type EvalSuiteId =
  | 'generic'
  | 'sydney_nsw'
  | 'personalized'
  | 'identity_lifecycle'
  | 'extraction'
  | 'security'
  | 'source_replay'
  | 'pairwise';

// ---------------------------------------------------------------------------
// Label kinds
// ---------------------------------------------------------------------------

export type CorpusStatus = 'draft' | 'frozen';

export type LabelKind = 'binary' | 'graded' | 'pairwise';

/** Graded relevance 0–3. Binary is 0|3 mapped from relevant=false|true. */
export type GradedRelevance = 0 | 1 | 2 | 3;

// ---------------------------------------------------------------------------
// Frozen document
// ---------------------------------------------------------------------------

export interface FrozenDocument {
  documentId: string;
  postingId?: string;
  identityClusterId: string;
  sourceListingIds: string[];
  observationIds: string[];
  contentHash: Sha256Hex;
  capturedAt: Instant;
  asOf: Instant;
  fixturePath: string;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface BinaryLabel {
  kind: 'binary';
  queryId: string;
  documentId: string;
  relevant: boolean;
  annotator: string;
  labeledAt: Instant;
}

export interface GradedLabel {
  kind: 'graded';
  queryId: string;
  documentId: string;
  grade: GradedRelevance;
  annotator: string;
  labeledAt: Instant;
  /** If true, grade is utility/preference, never eligibility. */
  utilityNotEligibility: true;
}

export interface PairwiseLabel {
  kind: 'pairwise';
  queryId: string;
  preferredDocumentId: string;
  otherDocumentId: string;
  annotator: string;
  labeledAt: Instant;
  utilityNotEligibility: true;
}

export type EvalLabel = BinaryLabel | GradedLabel | PairwiseLabel;

// ---------------------------------------------------------------------------
// Eval query
// ---------------------------------------------------------------------------

export interface EvalQuery {
  queryId: string;
  suiteId: EvalSuiteId;
  intentFingerprint: Sha256Hex;
  /** Stored in fixture files only; never written to process logs. */
  intent: unknown;
  identityClusterId: string;
  asOf: Instant;
  split: 'train' | 'dev' | 'test';
  category: string;
  kPrecision: 10;
  kRecall: 20;
  kNdcg: 10;
  fixedBudget: number;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface EvalManifestRevisions {
  gitCommit: string;
  schemaVersion: string;
  policyRevision: string;
  rankingVersion: string;
  packVersions: string[];
  adapterVersions: string[];
  fixtureVersion: string;
  modelRevision?: string;
  runtimeRevision: string;
}

export interface EvalManifest {
  schemaVersion: typeof EVALUATION_CONTRACT_VERSION;
  corpusId: string;
  suiteId: EvalSuiteId;
  suiteVersion: string;
  status: CorpusStatus;
  frozenAt?: Instant;
  documents: { documentId: string; contentHash: Sha256Hex; fixturePath: string }[];
  queries: { queryId: string; intentFingerprint: Sha256Hex }[];
  labels: { labelId: string; contentHash: Sha256Hex }[];
  splits: { train: string[]; dev: string[]; test: string[] };
  revisions: EvalManifestRevisions;
  manifestHash: Sha256Hex;
}

// ---------------------------------------------------------------------------
// Frozen corpus
// ---------------------------------------------------------------------------

export interface FrozenCorpus {
  manifest: EvalManifest;
  documents: FrozenDocument[];
  queries: EvalQuery[];
  labels: EvalLabel[];
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface RankedItem {
  documentId: string;
  rank: number;
  score?: number;
}

export interface QueryMetrics {
  queryId: string;
  category: string;
  split: 'train' | 'dev' | 'test';
  precisionAt10: number;
  recallAt20: number;
  ndcgAt10: number;
  fixedBudgetRecall: number;
  pairwiseAccuracy?: number;
  unlabeledCount: number;
  labeledRelevantCount: number;
}

export interface SuiteMetrics {
  corpusId: string;
  suiteId: EvalSuiteId;
  suiteVersion: string;
  manifestHash: Sha256Hex;
  split: 'test';
  queryCount: number;
  macro: {
    precisionAt10: number;
    recallAt20: number;
    ndcgAt10: number;
    fixedBudgetRecall: number;
    pairwiseAccuracy?: number;
  };
  byCategory: Record<
    string,
    QueryMetrics[] | { precisionAt10: number; recallAt20: number; ndcgAt10: number }
  >;
  perQuery: QueryMetrics[];
}

// ---------------------------------------------------------------------------
// Quality gates
// ---------------------------------------------------------------------------

export type GateSeverity = 'P0' | 'P1' | 'P2';

export interface GateFinding {
  gateId: string;
  checkpoint: 'A' | 'B' | 'C' | 'D' | 'D17';
  passed: boolean;
  severity: GateSeverity;
  code: string;
  detail: string;
}

export interface CheckpointEvidence {
  ObservabilitySnapshot?: unknown[];
}

export interface QualityGateReport {
  schemaVersion: typeof EVALUATION_CONTRACT_VERSION;
  checkpoint: 'A' | 'B' | 'C' | 'D';
  passed: boolean;
  findings: GateFinding[];
  suiteMetrics: SuiteMetrics[];
  integrityFailures: number;
  policyFailures: number;
  successRate: number;
}
