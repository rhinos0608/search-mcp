import type {
  ClaimCandidate,
  Evidence,
  IdentityDecision,
  JobPosting,
  LifecycleEvent,
  Location,
  Requirement,
  ResolvedClaim,
  SourceListing,
  SourceObservation,
} from '../domain/index.js';

export const PERSISTENCE_CONTRACT_VERSION = '1.0.0' as const;
export const JOBS_SQLITE_SCHEMA_VERSION = 2 as const;

export const JobsStoreErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  OBSERVATION_IMMUTABLE: 'OBSERVATION_IMMUTABLE',
  IDENTITY_MERGE_FORBIDDEN: 'IDENTITY_MERGE_FORBIDDEN',
  LIFECYCLE_ILLEGAL: 'LIFECYCLE_ILLEGAL',
  SCHEMA_INCOMPATIBLE: 'SCHEMA_INCOMPATIBLE',
  PATH_UNCONFIGURED: 'PATH_UNCONFIGURED',
  PROFILE_EVIDENCE_FORBIDDEN: 'PROFILE_EVIDENCE_FORBIDDEN',
  INCOMPLETE_POSTING: 'INCOMPLETE_POSTING',
  IO_ERROR: 'IO_ERROR',
} as const;

export type JobsStoreErrorCode = (typeof JobsStoreErrorCode)[keyof typeof JobsStoreErrorCode];

export class JobsStoreError extends Error {
  readonly code: JobsStoreErrorCode;
  constructor(code: JobsStoreErrorCode, message: string) {
    super(message);
    this.name = 'JobsStoreError';
    this.code = code;
  }
}

export interface JobsTransactionFn {
  (...args: never[]): unknown;
  immediate: (...args: never[]) => unknown;
  deferred: (...args: never[]) => unknown;
  exclusive: (...args: never[]) => unknown;
}

// Factory detached from the Database object so no receiver is needed;
// better-sqlite3's transaction is already bound to its Database instance
// (open.ts wraps raw.transaction.bind(raw)). No `this` involved.
export type JobsTransactionFactory = (fn: (...args: never[]) => unknown) => JobsTransactionFn;

export interface JobsDatabase {
  prepare(source: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(source: string): this;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): this;
  /**
   * Synchronous native transaction factory (better-sqlite3 semantics).
   * `transaction(fn).immediate()` runs fn in BEGIN IMMEDIATE; nested calls
   * reuse the outer transaction via savepoints; throw rolls back.
   * Implementations without native support omit this; store falls back to
   * exec-based BEGIN/COMMIT/ROLLBACK.
   */
  transaction?: JobsTransactionFactory;
}

export type JobsDatabasePath = string;

export interface OpenJobsDbOptions {
  databasePath: JobsDatabasePath;
  busyTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Snapshot / diff / run / enrichment types (persist-owned)
// ---------------------------------------------------------------------------

export interface PostingSnapshot {
  snapshotId: string;
  postingId: string;
  canonicalRevision: number;
  identityDecisionRevision: string;
  capturedAt: string;
  projectionHash: string;
}

export interface PostingSnapshotDiff {
  diffId: string;
  postingId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  fieldPath: string;
  changeKind: 'added' | 'removed' | 'replaced';
  fromHash?: string;
  toHash?: string;
}

export interface JobsRun {
  runId: string;
  createdAt: string;
  intentHash: string;
  planId?: string;
  planVersion?: string;
  coverageJson: string;
  budgetJson: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface JobsSlice {
  sliceId: string;
  runId: string;
  adapterId: string;
  acquisitionRunId?: string;
  acquisitionSliceId?: string;
  queryVariantHash: string;
  reasonCode: string;
  coverage: 'succeeded' | 'partial' | 'failed' | 'disabled' | 'policy_blocked' | 'not_supported';
}

export interface JobsRunCandidate {
  runId: string;
  candidateId: string;
  postingId?: string;
  sliceId?: string;
  stage: 'retrieved' | 'enriched' | 'assessed' | 'ranked' | 'dropped';
}

export interface JobsRunResult {
  runId: string;
  postingId: string;
  rank: number;
  utility?: number;
  coverage?: number;
  confidence?: number;
}

export interface EnrichmentCacheRow {
  cacheKey: string;
  kind: 'listing' | 'attachment' | 'framework' | 'employer';
  contentHash: string;
  enrichmentVersion: string;
  boundedMetadataJson: string;
  createdAt: string;
  lastAccessedAt: string;
}

export interface SourceHealthSample {
  sampleId: string;
  sourceId: string;
  adapterId: string;
  sampledAt: string;
  outcome: 'succeeded' | 'partial' | 'failed' | 'disabled' | 'policy_blocked' | 'not_supported';
  httpStatus?: number;
  latencyMs?: number;
  resultCount?: number;
  errorCode?: string;
}

export interface PolicyRevisionRow {
  sourceId: string;
  revision: string;
  modesJson: string;
  reviewedAt: string;
  notes?: string;
}

export interface IdentityClusterRow {
  clusterId: string;
  kind: 'same_posting' | 'probable_cluster';
  revision: string;
  postingId?: string;
  members?: { observationId: string; sourceListingId: string }[];
  decisionIds?: string[];
}

export interface MigrationResult {
  applied: boolean;
  version: number;
}

// ---------------------------------------------------------------------------
// JobsStore — persistence is the serialization boundary
// Domain branded types are resolved at caller boundary, not here.
// ---------------------------------------------------------------------------

export interface JobsStore {
  readonly db: JobsDatabase;
  readonly schemaVersion: number;

  upsertListing(listing: SourceListing): void;
  insertObservation(observation: SourceObservation): void;
  getListing(id: string): SourceListing | undefined;
  getObservation(id: string): SourceObservation | undefined;
  listObservations(listingId: string): SourceObservation[];

  putPostingProjection(posting: JobPosting): void;
  getPosting(id: string): JobPosting | undefined;
  listPostingsByLifecycle(state: string): string[];

  setMemberships(postingId: string, listingIds: string[], decisionId: string): void;

  putEvidence(rows: Evidence[]): void;
  putClaimCandidates(
    postingId: string,
    fieldPath: string,
    candidates: ClaimCandidate<unknown>[],
  ): void;
  putClaimResolution(postingId: string, fieldPath: string, resolved: ResolvedClaim<unknown>): void;
  putRequirements(postingId: string, requirements: Requirement[]): void;
  putLocations(postingId: string, locations: Location[]): void;

  appendIdentityDecision(decision: IdentityDecision): void;
  supersedeIdentityDecision(priorId: string, next: IdentityDecision): void;
  listIdentityHistory(opts: {
    observationId?: string;
    listingId?: string;
    postingId?: string;
  }): IdentityDecision[];
  listActiveIdentityDecisions(): IdentityDecision[];
  putIdentityClusterProjection(clusters: IdentityClusterRow[]): void;

  insertSnapshot(snapshot: PostingSnapshot): void;
  insertDiff(diff: PostingSnapshotDiff): void;

  appendLifecycleEvent(event: LifecycleEvent): void;
  getLifecycleHistory(postingId: string): LifecycleEvent[];

  insertRun(run: JobsRun): void;
  insertSlice(slice: JobsSlice): void;
  insertRunCandidate(row: JobsRunCandidate): void;
  insertRunResult(row: JobsRunResult): void;
  getRun(runId: string): JobsRun | undefined;

  putEnrichmentCache(row: EnrichmentCacheRow): void;
  getEnrichmentCache(key: string): EnrichmentCacheRow | undefined;

  recordSourceHealth(row: SourceHealthSample): void;

  insertPolicyRevision(row: PolicyRevisionRow): void;
  getPolicyRevision(sourceId: string, revision: string): PolicyRevisionRow | undefined;

  applyMigrations(): MigrationResult;
  integrityCheck(): { ok: true } | { ok: false; errors: string[] };
  checkpointWal(): void;
  close(): void;
}

export interface JobsDatabaseOpener {
  open(databasePath: string): JobsDatabase;
}
