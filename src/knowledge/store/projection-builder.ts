/**
 * V7.0.0 — Projection builder.
 *
 * Rebuilds the six projection tables (kg_nodes, kg_edges, kg_families,
 * kg_sources, kg_node_families, kg_event_refs) from the append-only
 * event store by replaying events through typed handlers into an
 * in-memory state, then atomically swapping the tables inside a
 * single SQLite transaction.
 *
 * Supports incremental rebuild from the latest compatible checkpoint
 * and always-allowed genesis rebuild.
 */

import { logger } from '../../logger.js';
import { getKgDb } from './db.js';
import { queryEvents, countEvents } from './events.js';
import { normalizeToLatest } from '../extractor/versions/v1.js';
import { createCheckpoint, computeProjectionChecksum } from './checkpoints.js';
import {
  AUDIT_ONLY_EVENTS,
  createEmptyState,
  isEventSkippedByRollback,
} from './projection-state.js';
import type { ProjectionState, EventHandler } from './projection-state.js'; // EventHandler type
import {
  handleNodeAdded,
  handleNodeRelabeled,
  handleNodeMetadataUpdated,
  handleExtractionConfidenceRevised,
  handleEdgeAdded,
  handleEdgeRemoved,
  handleRelationshipStrengthRevised,
  handleContradictionFlagged,
  handleSourceAdded,
  handleSourceChanged,
  handleSourceRetracted,
} from './projection-handlers.js';
import {
  handleEntityMerged,
  handleEntitySplit,
  handleFamilyCreated,
  handleFamilyClassified,
  handleFamilyRenamed,
  handleFamilyMerged,
  handleFamilyRelated,
  handleFamilyRelationRemoved,
  handleRunRolledBack,
} from './projection-handlers-families.js';
import type { KgEventType } from '../types.js';

// ────────────────────────────────────────────────────────────────────
// Event handler dispatch table
// ────────────────────────────────────────────────────────────────────

const EVENT_HANDLERS: Partial<Record<KgEventType, EventHandler>> = {
  NODE_ADDED: handleNodeAdded,
  EDGE_ADDED: handleEdgeAdded,
  ENTITY_MERGED: handleEntityMerged,
  ENTITY_SPLIT: handleEntitySplit,
  NODE_RELABELED: handleNodeRelabeled,
  NODE_METADATA_UPDATED: handleNodeMetadataUpdated,
  EXTRACTION_CONFIDENCE_REVISED: handleExtractionConfidenceRevised,
  EDGE_REMOVED: handleEdgeRemoved,
  RELATIONSHIP_STRENGTH_REVISED: handleRelationshipStrengthRevised,
  CONTRADICTION_FLAGGED: handleContradictionFlagged,
  SOURCE_ADDED: handleSourceAdded,
  SOURCE_CHANGED: handleSourceChanged,
  SOURCE_RETRACTED: handleSourceRetracted,
  FAMILY_CREATED: handleFamilyCreated,
  FAMILY_CLASSIFIED: handleFamilyClassified,
  FAMILY_RENAMED: handleFamilyRenamed,
  FAMILY_MERGED: handleFamilyMerged,
  FAMILY_RELATED: handleFamilyRelated,
  FAMILY_RELATION_REMOVED: handleFamilyRelationRemoved,
  RUN_ROLLED_BACK: handleRunRolledBack,
};

// ────────────────────────────────────────────────────────────────────
// Rebuild result
// ────────────────────────────────────────────────────────────────────

export interface ProjectionRebuildResult {
  rebuiltAt: string;
  eventsProcessed: number;
  durationMs: number;
  fromGenesis: boolean;
  checksum?: string;
}

// ────────────────────────────────────────────────────────────────────
// SQL for atomic swap
// ────────────────────────────────────────────────────────────────────

const DELETE_ALL_NODES = 'DELETE FROM kg_nodes';
const DELETE_ALL_EDGES = 'DELETE FROM kg_edges';
const DELETE_ALL_FAMILIES = 'DELETE FROM kg_families';
const DELETE_ALL_SOURCES = 'DELETE FROM kg_sources';
const DELETE_ALL_NODE_FAMILIES = 'DELETE FROM kg_node_families';
const DELETE_ALL_EVENT_REFS = 'DELETE FROM kg_event_refs';

const INSERT_NODE_SQL = `
  INSERT INTO kg_nodes
    (id, label, canonical_label, type, extraction_confidence,
     primary_family_id, aliases, first_seen_run_id, last_updated, metadata)
  VALUES
    (@id, @label, @canonicalLabel, @type, @extractionConfidence,
     @primaryFamilyId, @aliases, @firstSeenRunId, @lastUpdated, @metadata)
`;

const INSERT_EDGE_SQL = `
  INSERT INTO kg_edges
    (id, from_id, to_id, type, evidence_strength, evidence,
     evidence_verbatim, source_id, run_id, created_at)
  VALUES
    (@id, @fromId, @toId, @type, @evidenceStrength, @evidence,
     @evidenceVerbatim, @sourceId, @runId, @createdAt)
`;

const INSERT_FAMILY_SQL = `
  INSERT INTO kg_families
    (id, label, description, created_at, last_activity, run_count, related_families)
  VALUES
    (@id, @label, @description, @createdAt, @lastActivity, @runCount, @relatedFamilies)
`;

const INSERT_SOURCE_SQL = `
  INSERT INTO kg_sources
    (id, url, canonical_url, title, domain, source_kind, authority_score,
     run_id, retrieved_at, published_at, content_hash, raw_hash, tool_name)
  VALUES
    (@id, @url, @canonicalUrl, @title, @domain, @sourceKind, @authorityScore,
     @runId, @retrievedAt, @publishedAt, @contentHash, @rawHash, @toolName)
`;

const INSERT_NODE_FAMILY_SQL = `
  INSERT INTO kg_node_families
    (node_id, family_id, confidence, is_primary, run_id, classifier_version)
  VALUES
    (@nodeId, @familyId, @confidence, @isPrimary, @runId, @classifierVersion)
`;

const INSERT_EVENT_REF_SQL = `
  INSERT INTO kg_event_refs (event_id, ref_type, ref_id)
  VALUES (@eventId, @refType, @refId)
`;

// ────────────────────────────────────────────────────────────────────
// State -> DB flush
// ────────────────────────────────────────────────────────────────────

function flushStateToDb(state: ProjectionState): void {
  const db = getKgDb();
  if (db === null) {
    throw new Error('kg: cannot flush projection state: database not initialised');
  }

  const txn = db.transaction(() => {
    // Clear existing projection data
    db.prepare(DELETE_ALL_NODES).run();
    db.prepare(DELETE_ALL_EDGES).run();
    db.prepare(DELETE_ALL_FAMILIES).run();
    db.prepare(DELETE_ALL_SOURCES).run();
    db.prepare(DELETE_ALL_NODE_FAMILIES).run();
    db.prepare(DELETE_ALL_EVENT_REFS).run();

    // Insert nodes
    const insertNode = db.prepare(INSERT_NODE_SQL);
    for (const node of state.nodes.values()) {
      insertNode.run({
        id: node.id,
        label: node.label,
        canonicalLabel: node.canonicalLabel,
        type: node.type,
        extractionConfidence: node.extractionConfidence,
        primaryFamilyId: node.primaryFamilyId,
        aliases: node.aliases,
        firstSeenRunId: node.firstSeenRunId,
        lastUpdated: node.lastUpdated,
        metadata: node.metadata,
      });
    }

    // Insert edges
    const insertEdge = db.prepare(INSERT_EDGE_SQL);
    for (const edge of state.edges.values()) {
      insertEdge.run({
        id: edge.id,
        fromId: edge.fromId,
        toId: edge.toId,
        type: edge.type,
        evidenceStrength: edge.evidenceStrength,
        evidence: edge.evidence,
        evidenceVerbatim: edge.evidenceVerbatim,
        sourceId: edge.sourceId,
        runId: edge.runId,
        createdAt: edge.createdAt,
      });
    }

    // Insert families
    const insertFamily = db.prepare(INSERT_FAMILY_SQL);
    for (const family of state.families.values()) {
      insertFamily.run({
        id: family.id,
        label: family.label,
        description: family.description,
        createdAt: family.createdAt,
        lastActivity: family.lastActivity,
        runCount: family.runCount,
        relatedFamilies: family.relatedFamilies,
      });
    }

    // Insert sources
    const insertSource = db.prepare(INSERT_SOURCE_SQL);
    for (const source of state.sources.values()) {
      insertSource.run({
        id: source.id,
        url: source.url,
        canonicalUrl: source.canonicalUrl,
        title: source.title,
        domain: source.domain,
        sourceKind: source.sourceKind,
        authorityScore: source.authorityScore,
        runId: source.runId,
        retrievedAt: source.retrievedAt,
        publishedAt: source.publishedAt,
        contentHash: source.contentHash,
        rawHash: source.rawHash,
        toolName: source.toolName,
      });
    }

    // Insert node families
    const insertNodeFamily = db.prepare(INSERT_NODE_FAMILY_SQL);
    for (const nf of state.nodeFamilies) {
      insertNodeFamily.run({
        nodeId: nf.nodeId,
        familyId: nf.familyId,
        confidence: nf.confidence,
        isPrimary: nf.isPrimary,
        runId: nf.runId,
        classifierVersion: nf.classifierVersion,
      });
    }

    // Insert event refs
    const insertEventRef = db.prepare(INSERT_EVENT_REF_SQL);
    for (const ref of state.eventRefs) {
      insertEventRef.run(ref);
    }
  });

  txn();
}

// ────────────────────────────────────────────────────────────────────
// Load existing state from DB for incremental rebuilds
// ────────────────────────────────────────────────────────────────────

function loadStateFromDb(state: ProjectionState): void {
  const db = getKgDb();
  if (db === null) return;

  try {
    // Load nodes
    const nodes = db.prepare('SELECT * FROM kg_nodes').all() as Record<string, unknown>[];
    for (const row of nodes) {
      state.nodes.set(row.id as string, {
        id: row.id as string,
        label: row.label as string,
        canonicalLabel: (row.canonical_label as string | null) ?? '',
        type: row.type as string,
        extractionConfidence: (row.extraction_confidence as number | null) ?? null,
        primaryFamilyId: (row.primary_family_id as string | null) ?? null,
        aliases: (row.aliases as string | null) ?? '',
        firstSeenRunId: (row.first_seen_run_id as string | null) ?? null,
        lastUpdated: (row.last_updated as string | null) ?? null,
        metadata: (row.metadata as string | null) ?? '',
      });
    }

    // Load edges
    const edges = db.prepare('SELECT * FROM kg_edges').all() as Record<string, unknown>[];
    for (const row of edges) {
      const edgeId = row.id as string;
      const fromId = row.from_id as string;
      const toId = row.to_id as string;
      state.edges.set(edgeId, {
        id: edgeId,
        fromId,
        toId,
        type: row.type as string,
        evidenceStrength: (row.evidence_strength as number | null) ?? null,
        evidence: (row.evidence as string | null) ?? null,
        evidenceVerbatim: (row.evidence_verbatim as number | null) ?? 0,
        sourceId: (row.source_id as string | null) ?? null,
        runId: (row.run_id as string | null) ?? null,
        createdAt: (row.created_at as string | null) ?? null,
      });
      // Build reverse indexes
      const fromSet = state.edgesByFromId.get(fromId) ?? new Set();
      fromSet.add(edgeId);
      state.edgesByFromId.set(fromId, fromSet);
      const toSet = state.edgesByToId.get(toId) ?? new Set();
      toSet.add(edgeId);
      state.edgesByToId.set(toId, toSet);
    }

    // Load families
    const families = db.prepare('SELECT * FROM kg_families').all() as Record<string, unknown>[];
    for (const row of families) {
      state.families.set(row.id as string, {
        id: row.id as string,
        label: row.label as string,
        description: (row.description as string | null) ?? null,
        createdAt: (row.created_at as string | null) ?? null,
        lastActivity: (row.last_activity as string | null) ?? null,
        runCount: (row.run_count as number | null) ?? null,
        relatedFamilies: (row.related_families as string | null) ?? null,
      });
    }

    // Load sources
    const sources = db.prepare('SELECT * FROM kg_sources').all() as Record<string, unknown>[];
    for (const row of sources) {
      state.sources.set(row.id as string, {
        id: row.id as string,
        url: row.url as string,
        canonicalUrl: (row.canonical_url as string | null) ?? null,
        title: (row.title as string | null) ?? null,
        domain: (row.domain as string | null) ?? null,
        sourceKind: (row.source_kind as string | null) ?? null,
        authorityScore: (row.authority_score as number | null) ?? null,
        runId: row.run_id as string,
        retrievedAt: row.retrieved_at as string,
        publishedAt: (row.published_at as string | null) ?? null,
        contentHash: row.content_hash as string,
        rawHash: (row.raw_hash as string | null) ?? null,
        toolName: (row.tool_name as string | null) ?? null,
      });
    }

    // Load node families
    const nodeFams = db.prepare('SELECT * FROM kg_node_families').all() as Record<
      string,
      unknown
    >[];
    for (const row of nodeFams) {
      const nf = {
        nodeId: row.node_id as string,
        familyId: row.family_id as string,
        confidence: (row.confidence as number | null) ?? null,
        isPrimary: (row.is_primary as number | null) ?? 0,
        runId: (row.run_id as string | null) ?? null,
        classifierVersion: (row.classifier_version as string | null) ?? null,
      };
      state.nodeFamilies.push(nf);
      state.nodeFamilyKeys.add(`${nf.nodeId}|${nf.familyId}`);
    }

    // Load event refs
    const refs = db.prepare('SELECT * FROM kg_event_refs').all() as Record<string, unknown>[];
    for (const row of refs) {
      state.eventRefs.push({
        eventId: row.event_id as string,
        refType: row.ref_type as string,
        refId: row.ref_id as string,
      });
    }

    logger.info(
      {
        nodes: state.nodes.size,
        edges: state.edges.size,
        families: state.families.size,
        sources: state.sources.size,
        nodeFamilies: state.nodeFamilies.length,
        eventRefs: state.eventRefs.length,
      },
      'kg: loaded existing projection state from DB for incremental rebuild',
    );
  } catch (err) {
    state.nodes.clear();
    state.edges.clear();
    state.edgesByFromId.clear();
    state.edgesByToId.clear();
    state.families.clear();
    state.sources.clear();
    state.nodeFamilies.length = 0;
    state.nodeFamilyKeys.clear();
    state.eventRefs.length = 0;
    state.rolledBackRuns.clear();
    state.mergeHistory.clear();
    logger.warn({ err }, 'kg: failed to load state from DB for incremental rebuild');
  }
}

// ────────────────────────────────────────────────────────────────────
// Main rebuild function
// ────────────────────────────────────────────────────────────────────

/**
 * Rebuild the projection tables from the append-only event store.
 *
 * Strategy:
 * 1. Replay from genesis by default so the atomic table swap always has
 *    complete state. Cursor rebuilds are only used when explicitly requested.
 * 2. Query all events from the starting cursor (or from genesis).
 * 3. Replay each event through typed handlers into in-memory maps.
 * 4. Atomically DELETE all rows from projection tables and INSERT
 *    the accumulated state inside a single transaction.
 * 5. Create a new checkpoint.
 *
 * Readers see either the old complete projection or the new one —
 * never partial state — because the swap happens inside a transaction.
 *
 * Genesis rebuild is always available (spec line 270).
 */
export function rebuildProjection(
  opts: {
    full?: boolean;
    fromEventId?: string;
    validate?: boolean;
  } = {},
): ProjectionRebuildResult {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: rebuildProjection called before database initialised');
    return {
      rebuiltAt: new Date().toISOString(),
      eventsProcessed: 0,
      durationMs: 0,
      fromGenesis: true,
    };
  }

  const startTime = Date.now();
  const state = createEmptyState();

  // Step 1: Determine starting cursor
  // For genesis rebuilds, start from the beginning. For incremental rebuilds
  // (fromEventId), load the current projection state from DB tables first,
  // then replay only new events on top. This avoids truncating older state
  // that the cursor skips.
  let fromGenesis = true;
  let fromEventId: string | undefined;

  if (opts.fromEventId !== undefined) {
    fromEventId = opts.fromEventId;
    fromGenesis = false;
  }

  // Step 2: Query events (cursor is exclusive — events with id > cursor)
  const events = queryEvents(fromEventId !== undefined ? { cursor: fromEventId } : {});

  logger.info(
    {
      eventCount: events.length,
      fromGenesis,
      fromEventId: fromEventId ?? null,
    },
    'kg: rebuilding projection',
  );

  if (events.length === 0) {
    logger.warn('kg: rebuildProjection: no events to process');
    return {
      rebuiltAt: new Date().toISOString(),
      eventsProcessed: 0,
      durationMs: Date.now() - startTime,
      fromGenesis,
    };
  }

  // Step 3a: Pre-scan for RUN_ROLLED_BACK events to populate rolledBackRuns
  // This must happen BEFORE the main loop because RUN_ROLLED_BACK is
  // audit-only and would otherwise be skipped before its handler fires.
  for (const rawEvent of events) {
    const event = normalizeToLatest(rawEvent);
    if (event.eventType === 'RUN_ROLLED_BACK') {
      const payload = JSON.parse(event.payload) as { run_id?: string };
      if (payload.run_id) {
        state.rolledBackRuns.add(payload.run_id);
      }
    }
  }

  // Step 3a.5: For incremental rebuilds, load existing state from DB first
  if (!fromGenesis && events.length > 0) {
    loadStateFromDb(state);
  }

  // Step 3b: Replay events into in-memory state
  for (const rawEvent of events) {
    const event = normalizeToLatest(rawEvent);

    // Skip audit-only events
    if (AUDIT_ONLY_EVENTS.has(event.eventType)) continue;

    // Check rollback status
    if (isEventSkippedByRollback(event, state)) continue;

    // Dispatch to handler
    const handler = EVENT_HANDLERS[event.eventType];
    if (handler !== undefined) {
      handler(event, state);
    } else {
      logger.warn(
        { eventType: event.eventType, eventId: event.id },
        'kg: no handler registered for event type',
      );
    }
  }

  // Step 4: Atomic flush — DELETE + INSERT in single transaction
  // Guard: if incremental rebuild produced no productive state, preserve the
  // existing projection. Genesis rebuilds always flush (even empty) to ensure
  // consistency after rollbacks or schema changes.
  // Note: even for audit-only batches we advance the checkpoint so events
  // are not re-processed on the next rebuild.
  if (
    !fromGenesis &&
    state.nodes.size === 0 &&
    state.edges.size === 0 &&
    state.families.size === 0
  ) {
    logger.warn(
      { eventsProcessed: events.length },
      'kg: incremental rebuild produced no productive state; skipping flush to preserve existing projection',
    );
    // Advance the checkpoint so audit-only events aren't re-processed
    const lastEvent = events[events.length - 1];
    if (lastEvent !== undefined) {
      createCheckpoint(lastEvent.id, countEvents(), computeProjectionChecksum());
    }
    return {
      rebuiltAt: new Date().toISOString(),
      eventsProcessed: events.length,
      durationMs: Date.now() - startTime,
      fromGenesis,
    };
  }
  flushStateToDb(state);

  // Step 5: Compute checksum and create checkpoint
  const checksum = computeProjectionChecksum();

  const lastEvent = events[events.length - 1];
  if (lastEvent !== undefined) {
    createCheckpoint(lastEvent.id, countEvents(), checksum);
  }

  const durationMs = Date.now() - startTime;

  const result: ProjectionRebuildResult = {
    rebuiltAt: new Date().toISOString(),
    eventsProcessed: events.length,
    durationMs,
    fromGenesis,
  };

  if (opts.validate) {
    result.checksum = checksum;
  }

  logger.info(
    {
      eventsProcessed: result.eventsProcessed,
      durationMs: result.durationMs,
      fromGenesis: result.fromGenesis,
      nodeCount: state.nodes.size,
      edgeCount: state.edges.size,
      familyCount: state.families.size,
      sourceCount: state.sources.size,
    },
    'kg: projection rebuild complete',
  );

  return result;
}
