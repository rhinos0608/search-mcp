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
  immutable?: boolean;
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
  checkpoint: 'A' | 'B' | 'C' | 'D';
  passed: boolean;
  severity: GateSeverity;
  code: string;
  detail: string;
}

// Checkpoint A evidence is additive: unknown keys are ignored so future
// checkpoints can extend without breaking the A-gate contract.
// Every predicate-bearing evidence list is REQUIRED: P0/P1 gates fail when
// the list is absent or empty, so missing evidence can never pass vacuously.
export interface CheckpointEvidence {
  ObservabilitySnapshot?: unknown[];
  /** Frozen docs under test must carry `immutable: true`. Required. */
  frozenDocuments?: readonly { immutable?: unknown }[];
  /** No locale default may assert required authority. Required. */
  localeDefaults?: readonly { packId?: unknown; requiredAuthority?: unknown }[];
  /** Full telemetry fixtures (whole object scanned, not just .payload). */
  telemetryFixtures?: readonly unknown[];
  /** Per-edge policy decisions proving adapters do not define policy. */
  policyEdges?: readonly {
    edgeId?: unknown;
    decidedBy?: unknown;
    adapterDefined?: unknown;
    state?: unknown;
  }[];
  /** Manual-import url_only runs proving content_required without fetch. */
  manualImportRuns?: readonly {
    contentKind?: unknown;
    fetchPermitted?: unknown;
    status?: unknown;
    fetched?: unknown;
  }[];
  /** Posting projections proving multi-source records. */
  multiSourcePostings?: readonly { sourceListingIds?: unknown }[];
  // --- Checkpoint B/C evidence (REQUIRED lists; absent/empty fails) ---
  /** Extraction claim checks: { claimId, hasEvidenceRefs, origin }. */
  extractionClaims?: readonly {
    claimId?: unknown;
    hasEvidenceRefs?: unknown;
    origin?: unknown;
  }[];
  /** Relational projection rows present: { projection, present }. */
  projectionRows?: readonly { projection?: unknown; present?: unknown }[];
  /** Conflict checks: { state, alternativesPreserved }. */
  conflictCases?: readonly { state?: unknown; alternativesPreserved?: unknown }[];
  /** Identity merge/split probes: { scenario, merged }. */
  identityProbes?: readonly { scenario?: unknown; merged?: unknown }[];
  /** Lifecycle transition probes: { from, to, allowed }. */
  lifecycleProbes?: readonly { from?: unknown; to?: unknown; allowed?: unknown }[];
  /** Suite metric snapshots: { suiteId, fixedBudgetRecall, computedAtBudget }. */
  recallSnapshots?: readonly {
    suiteId?: unknown;
    fixedBudgetRecall?: unknown;
    computedAtBudget?: unknown;
  }[];
  /** BM25 determinism probes: { queryId, firstScore, secondScore }. */
  bm25Probes?: readonly {
    queryId?: unknown;
    firstScore?: unknown;
    secondScore?: unknown;
  }[];
  /** Missing-data probes: { scenario, usedNeutralPrior, redistributed }. */
  missingDataProbes?: readonly {
    scenario?: unknown;
    usedNeutralPrior?: unknown;
    redistributed?: unknown;
  }[];
  /** Grouped-score outputs: { dimensions, rrfInUtility }. */
  groupedOutputs?: readonly { dimensions?: unknown; rrfInUtility?: unknown }[];
  /** Standalone parity runs: { deterministic, reasoningDisabled, complete }. */
  standaloneRuns?: readonly {
    deterministic?: unknown;
    reasoningDisabled?: unknown;
    complete?: unknown;
  }[];
  /** Host packet checks: { bounded }. */
  hostPackets?: readonly { bounded?: unknown }[];
  // --- Checkpoint D evidence (REQUIRED lists; absent/empty fails) ---
  /** Precedence proofs: { scenario, explicitWins }. */
  precedenceProofs?: readonly { scenario?: unknown; explicitWins?: unknown }[];
  /** MCP family actions (absent until MCP surface lands): { compact, bounded }. */
  mcpActions?: readonly { compact?: unknown; bounded?: unknown }[];
  /** Module inventory: { module, inArchitectureTable }. */
  moduleInventory?: readonly { module?: unknown; inArchitectureTable?: unknown }[];
  /** Positive proof that product profile handling is request-scoped and nonpersistent. */
  profilePersistenceEvidence?: {
    /** Positive verified attestation that inactive profile persistence is not active. */
    inactiveProfileAttestation?: unknown;
    noProductionStoreWiring?: unknown;
    noWriteAction?: unknown;
    requestScopedOnly?: unknown;
    zeroPersistence?: unknown;
    reusableHandle?: unknown;
  };
}

export interface QualityGateReport {
  schemaVersion: typeof EVALUATION_CONTRACT_VERSION;
  checkpoint: 'A' | 'B' | 'C' | 'D';
  passed: boolean;
  gateApplicability: Record<string, 'applicable' | 'not_applicable'>;
  findings: GateFinding[];
  suiteMetrics: SuiteMetrics[];
  integrityFailures: number;
  policyFailures: number;
  successRate: number;
}
