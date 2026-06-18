/**
 * V7.0.0 — Longitudinal Knowledge Graph type definitions.
 *
 * All types from the KG design spec, including event types,
 * projection entities, run lifecycle, pending storage,
 * contradictions, and configuration.
 */

// ────────────────────────────────────────────────────────────────────
// Event type literal union
// ────────────────────────────────────────────────────────────────────

export type KgEventType =
  | 'RUN_STARTED'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED'
  | 'PROJECTION_REBUILT'
  | 'NODE_ADDED'
  | 'NODE_RELABELED'
  | 'NODE_METADATA_UPDATED'
  | 'EXTRACTION_CONFIDENCE_REVISED'
  | 'EDGE_ADDED'
  | 'EDGE_REMOVED'
  | 'RELATIONSHIP_STRENGTH_REVISED'
  | 'CONTRADICTION_FLAGGED'
  | 'ENTITY_MERGED'
  | 'ENTITY_SPLIT'
  | 'CLAIM_EXTRACTED'
  | 'EXTRACTION_FAILED'
  | 'SOURCE_ADDED'
  | 'SOURCE_CHANGED'
  | 'SOURCE_RETRACTED'
  | 'FAMILY_CLASSIFIED'
  | 'FAMILY_CREATED'
  | 'FAMILY_RELATED'
  | 'FAMILY_RELATION_REMOVED'
  | 'FAMILY_RENAMED'
  | 'FAMILY_MERGED'
  | 'RUN_ROLLED_BACK';

// ────────────────────────────────────────────────────────────────────
// Rollback & run status types
// ────────────────────────────────────────────────────────────────────

export type RollbackClass = 'pure_run_local' | 'cross_run_mutation' | 'audit_only' | 'dynamic_edge';

export type RunStatus =
  | 'queued'
  | 'extracting'
  | 'canonicalizing'
  | 'classifying'
  | 'committed'
  | 'projecting'
  | 'completed'
  | 'failed'
  | 'rolled_back';

// ────────────────────────────────────────────────────────────────────
// Contradiction types
// ────────────────────────────────────────────────────────────────────

export type ContradictionType =
  | 'direct'
  | 'temporal'
  | 'scope'
  | 'numeric'
  | 'source_disagreement'
  | 'terminology';

export type ContradictionResolutionStatus =
  | 'unresolved'
  | 'resolved'
  | 'superseded'
  | 'source_error'
  | 'scope_distinction';

// ────────────────────────────────────────────────────────────────────
// Structured warnings
// ────────────────────────────────────────────────────────────────────

export type WarningCode =
  | 'PROJECTION_STALE'
  | 'EXTRACTION_PARTIAL'
  | 'EVIDENCE_UNVERIFIED'
  | 'FAMILY_PENDING'
  | 'ROLLBACK_FAMILY_REATTRIBUTED'
  | 'QUERY_TRUNCATED'
  | 'RUN_INCOMPLETE'
  | 'SOURCE_RETRACTED'
  | 'CONSOLIDATION_PENDING';

export interface StructuredWarning {
  code: WarningCode;
  severity: 'info' | 'warn' | 'error';
  message: string;
  source?: string;
}

// ────────────────────────────────────────────────────────────────────
// Event store row
// ────────────────────────────────────────────────────────────────────

export interface KgEvent {
  id: string; // ULID (sortable, no clock skew)
  timestamp: string; // ISO-8601
  eventType: KgEventType;
  eventVersion: number;
  runId: string;
  batchId: string | null;
  actor: string; // system|user|classifier|rollback
  entityId: string | null;
  entityType: string | null;
  payload: string; // JSON
  payloadHash: string | null;
}

// ────────────────────────────────────────────────────────────────────
// Run lifecycle row
// ────────────────────────────────────────────────────────────────────

export interface KgRun {
  runId: string;
  status: RunStatus;
  topic: string | null;
  query: string | null;
  sessionMode: number; // 0 = run mode, 1 = session mode
  startedAt: string;
  completedAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  entityCount: number | null;
  edgeCount: number | null;
  sourceCount: number | null;
  artifactPaths: string | null; // JSON
  idempotencyKey: string | null;
  active: number; // 0 or 1
}

// ────────────────────────────────────────────────────────────────────
// Projection entities
// ────────────────────────────────────────────────────────────────────

export interface KgNode {
  id: string;
  label: string;
  canonicalLabel: string | null;
  type: string;
  extractionConfidence: number | null;
  primaryFamilyId: string | null;
  aliases: string | null; // JSON array
  firstSeenRunId: string | null;
  lastUpdated: string | null;
  metadata: string | null; // JSON
}

export interface KgEdge {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  evidenceStrength: number | null;
  evidence: string | null;
  evidenceVerbatim: number; // boolean
  sourceId: string | null;
  runId: string | null;
  createdAt: string | null;
}

export interface KgFamily {
  id: string;
  label: string;
  description: string | null;
  createdAt: string | null;
  lastActivity: string | null;
  runCount: number | null;
  relatedFamilies: string | null; // JSON
}

export interface KgSource {
  id: string;
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  domain: string | null;
  sourceKind: string | null;
  authorityScore: number | null;
  runId: string;
  retrievedAt: string;
  publishedAt: string | null;
  contentHash: string;
  rawHash: string | null;
  toolName: string | null;
}

export interface KgNodeFamily {
  nodeId: string;
  familyId: string;
  confidence: number | null;
  isPrimary: number; // 0 or 1
  runId: string | null;
  classifierVersion: string | null;
}

// ────────────────────────────────────────────────────────────────────
// Event version adapter types
// ────────────────────────────────────────────────────────────────────

export type EventVersionAdapter = (event: KgEvent) => KgEvent;

export type EventVersionAdapters = Record<number, EventVersionAdapter>;

export type EventVersionRegistry = Record<string, EventVersionAdapters>;

// ────────────────────────────────────────────────────────────────────
// Knowledge graph configuration
// ────────────────────────────────────────────────────────────────────

export interface KnowledgeGraphConfig {
  enabled: boolean;
  dbPath: string;
  projection: {
    maxEvents: number;
    maxAgeMs: number;
  };
  solidification: {
    minRuns: number;
    minEntities: number;
    highConfidenceOverride: number;
    minVerbatimRatio: number;
    minSourceCount: number;
  };
  session: {
    maxBufferItems: number;
    maxIdleMs: number;
    captureStdio: boolean;
  };
  consolidation: {
    cadenceMs: number;
    annThreshold: number;
    /** Maximum number of family groups considered during the periodic consolidation pass. */
    maxFamilies: number;
  };
  relations: {
    /** Maximum number of related family groups tracked per entity. */
    maxFamilies: number;
    maxNodesPerFamily: number;
  };
}

// ────────────────────────────────────────────────────────────────────
// Compensation & rollback types
// ────────────────────────────────────────────────────────────────────

export type CompensationType =
  | 'ENTITY_SPLIT'
  | 'FAMILY_REATTRIBUTED'
  | 'FAMILY_RETIRED'
  | 'SOURCE_MANUAL_REVIEW';

export interface CompensationEvent {
  original_event_id: string;
  original_event_type: string;
  rollback_class: RollbackClass;
  compensation_type: CompensationType;
  description: string;
}

// ────────────────────────────────────────────────────────────────────
// Family relation types
// ────────────────────────────────────────────────────────────────────

export type FamilyRelationType = 'adjacent' | 'contradicts' | 'parent' | 'child' | 'supersedes';

// ────────────────────────────────────────────────────────────────────
// SOURCE_RETRACTED reason_type values
// ────────────────────────────────────────────────────────────────────

export type SourceRetractionReason =
  | 'publisher_retraction'
  | 'content_removed'
  | 'retrieval_failed'
  | 'user_invalidated'
  | 'duplicate'
  | 'replaced'
  | 'malicious'
  | 'low_quality';
