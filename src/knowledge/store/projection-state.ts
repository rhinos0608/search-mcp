/**
 * V7.0.0 — Projection event types, constants, state, and rollback helpers.
 *
 * Shared infrastructure for the projection builder and event handlers.
 * Split from the handlers to keep file sizes under 400 lines.
 */

import type { KgEvent, KgEventType, KgNode, KgEdge, KgFamily, KgSource } from '../types.js';

// ────────────────────────────────────────────────────────────────────
// Event handler signature
// ────────────────────────────────────────────────────────────────────

export type EventHandler = (event: KgEvent, state: ProjectionState) => void;

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

export const ROLLBACK_CLASSES: Record<KgEventType, string> = {
  RUN_STARTED: 'audit_only',
  RUN_COMPLETED: 'audit_only',
  RUN_FAILED: 'audit_only',
  PROJECTION_REBUILT: 'audit_only',
  NODE_ADDED: 'pure_run_local',
  NODE_RELABELED: 'cross_run_mutation',
  NODE_METADATA_UPDATED: 'cross_run_mutation',
  EXTRACTION_CONFIDENCE_REVISED: 'cross_run_mutation',
  EDGE_ADDED: 'pure_run_local',
  EDGE_REMOVED: 'dynamic_edge',
  RELATIONSHIP_STRENGTH_REVISED: 'cross_run_mutation',
  CONTRADICTION_FLAGGED: 'pure_run_local',
  ENTITY_MERGED: 'cross_run_mutation',
  ENTITY_SPLIT: 'cross_run_mutation',
  CLAIM_EXTRACTED: 'audit_only',
  EXTRACTION_FAILED: 'audit_only',
  SOURCE_ADDED: 'pure_run_local',
  SOURCE_CHANGED: 'cross_run_mutation',
  SOURCE_RETRACTED: 'cross_run_mutation',
  FAMILY_CLASSIFIED: 'pure_run_local',
  FAMILY_CREATED: 'pure_run_local',
  FAMILY_RELATED: 'pure_run_local',
  FAMILY_RELATION_REMOVED: 'cross_run_mutation',
  FAMILY_RENAMED: 'cross_run_mutation',
  FAMILY_MERGED: 'cross_run_mutation',
  RUN_ROLLED_BACK: 'audit_only',
};

export const AUDIT_ONLY_EVENTS: ReadonlySet<KgEventType> = new Set([
  'RUN_STARTED',
  'RUN_COMPLETED',
  'RUN_FAILED',
  'PROJECTION_REBUILT',
  'CLAIM_EXTRACTED',
  'EXTRACTION_FAILED',
  'RUN_ROLLED_BACK',
]);

// ────────────────────────────────────────────────────────────────────
// Merge tracking
// ────────────────────────────────────────────────────────────────────

export interface RepointedEdge {
  edgeId: string;
  field: 'from_id' | 'to_id';
  originalNodeId: string;
}

export interface MergeRecord {
  fromId: string;
  intoId: string;
  fromLabel: string;
  mergedEventId: string;
  repointedEdges: RepointedEdge[];
}

// ────────────────────────────────────────────────────────────────────
// In-memory rebuild state
// ────────────────────────────────────────────────────────────────────

export interface ProjectionState {
  nodes: Map<string, KgNode>;
  edges: Map<string, KgEdge>;
  families: Map<string, KgFamily>;
  sources: Map<string, KgSource>;
  nodeFamilies: {
    nodeId: string;
    familyId: string;
    confidence: number | null;
    isPrimary: number;
    runId: string | null;
    classifierVersion: string | null;
  }[];
  /** Set of "nodeId|familyId" keys for O(1) duplicate lookup */
  nodeFamilyKeys: Set<string>;
  /** Reverse index: fromId → Set of edge IDs */
  edgesByFromId: Map<string, Set<string>>;
  /** Reverse index: toId → Set of edge IDs */
  edgesByToId: Map<string, Set<string>>;
  eventRefs: {
    eventId: string;
    refType: string;
    refId: string;
  }[];
  rolledBackRuns: Set<string>;
  mergeHistory: Map<string, MergeRecord>;
}

export function createEmptyState(): ProjectionState {
  return {
    nodes: new Map(),
    edges: new Map(),
    families: new Map(),
    sources: new Map(),
    nodeFamilies: [],
    nodeFamilyKeys: new Set(),
    edgesByFromId: new Map(),
    edgesByToId: new Map(),
    eventRefs: [],
    rolledBackRuns: new Set(),
    mergeHistory: new Map(),
  };
}

// ────────────────────────────────────────────────────────────────────
// Rollback skip helper
// ────────────────────────────────────────────────────────────────────

export function isEventSkippedByRollback(event: KgEvent, state: ProjectionState): boolean {
  if (AUDIT_ONLY_EVENTS.has(event.eventType)) return true;

  const rollbackClass = ROLLBACK_CLASSES[event.eventType];
  if (!state.rolledBackRuns.has(event.runId)) return false;

  if (rollbackClass === 'pure_run_local') return true;
  if (rollbackClass === 'audit_only') return true;

  // EDGE_REMOVED: dynamic — check if edge was added in the same run
  if (rollbackClass === 'dynamic_edge') {
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    const edgeId = payload.edge_id as string | undefined;
    if (edgeId !== undefined) {
      const existingEdge = state.edges.get(edgeId);
      if (existingEdge?.runId === event.runId) {
        return true;
      }
    }
    return false;
  }

  // cross_run_mutation always applied
  return false;
}
