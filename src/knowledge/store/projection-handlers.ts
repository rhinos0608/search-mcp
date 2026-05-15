/**
 * V7.0.0 — Core projection event handlers.
 *
 * Handlers for node, edge, source, and basic entity operations.
 * Family and merge/split handlers are in projection-handlers-families.ts.
 *
 * Each handler is a pure state transformer — no I/O.
 * Rollback filtering happens in the builder loop before dispatch.
 */

import { logger } from '../../logger.js';
import type { KgEvent, KgNode, KgEdge, KgSource } from '../types.js';
import type { ProjectionState } from './projection-state.js';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function getNodeIdFromPayload(
  payload: Record<string, unknown>,
): string | undefined {
  return (
    (payload.node_id as string | undefined) ??
    (payload.entity_id as string | undefined)
  );
}

// ────────────────────────────────────────────────────────────────────
// Node handlers
// ────────────────────────────────────────────────────────────────────

export function handleNodeAdded(event: KgEvent, state: ProjectionState): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const nodeId = getNodeIdFromPayload(payload) ?? event.entityId ?? undefined;
  if (nodeId === undefined) {
    logger.warn({ eventId: event.id }, 'kg: NODE_ADDED missing node_id in payload');
    return;
  }

  if (state.nodes.has(nodeId)) return;

  const node: KgNode = {
    id: nodeId,
    label: (payload.label as string | undefined) ?? '',
    canonicalLabel: null,
    type: (payload.type as string | undefined) ?? 'concept',
    extractionConfidence: (payload.extraction_confidence as number | null) ?? null,
    primaryFamilyId: null,
    aliases: null,
    firstSeenRunId: event.runId,
    lastUpdated: event.timestamp,
    metadata: null,
  };

  state.nodes.set(nodeId, node);
  state.eventRefs.push({ eventId: event.id, refType: 'node', refId: nodeId });
}

export function handleNodeRelabeled(event: KgEvent, state: ProjectionState): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const nodeId = typeof payload.node_id === 'string' ? payload.node_id : undefined;
  const newLabel = typeof payload.new_label === 'string' ? payload.new_label : undefined;
  const oldLabel = typeof payload.old_label === 'string' ? payload.old_label : undefined;

  if (nodeId === undefined || newLabel === undefined || oldLabel === undefined) {
    logger.warn({ eventId: event.id, payload }, 'kg: NODE_RELABELED missing required fields');
    return;
  }

  const node = state.nodes.get(nodeId);
  if (node === undefined) {
    logger.warn({ eventId: event.id, nodeId }, 'kg: NODE_RELABELED node not found');
    return;
  }

  const aliases: string[] = node.aliases ? (JSON.parse(node.aliases) as string[]) : [];
  if (!aliases.includes(oldLabel)) {
    aliases.push(oldLabel);
  }
  node.aliases = JSON.stringify(aliases);
  node.label = newLabel;
  node.lastUpdated = event.timestamp;

  state.eventRefs.push({ eventId: event.id, refType: 'node', refId: nodeId });
}

export function handleNodeMetadataUpdated(event: KgEvent, state: ProjectionState): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const nodeId = payload.node_id as string;

  const node = state.nodes.get(nodeId);
  if (node === undefined) {
    logger.warn({ eventId: event.id, nodeId }, 'kg: NODE_METADATA_UPDATED node not found');
    return;
  }

  const existingMetadata: Record<string, unknown> = node.metadata
    ? (JSON.parse(node.metadata) as Record<string, unknown>)
    : {};
  const field =
    typeof payload.field === 'string' && payload.field.length > 0 ? payload.field : undefined;
  if (field === undefined) {
    logger.warn(
      { eventId: event.id, field: payload?.field },
      'kg: NODE_METADATA_UPDATED missing or invalid field',
    );
    return;
  }
  existingMetadata[field] = payload.new_value;
  node.metadata = JSON.stringify(existingMetadata);
  node.lastUpdated = event.timestamp;

  state.eventRefs.push({ eventId: event.id, refType: 'node', refId: nodeId });
}

export function handleExtractionConfidenceRevised(event: KgEvent, state: ProjectionState): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const nodeId = payload.node_id as string;
  const newVal = payload.new_val as number;

  const node = state.nodes.get(nodeId);
  if (node === undefined) {
    logger.warn({ eventId: event.id, nodeId }, 'kg: EXTRACTION_CONFIDENCE_REVISED node not found');
    return;
  }

  node.extractionConfidence = newVal;
  node.lastUpdated = event.timestamp;

  state.eventRefs.push({ eventId: event.id, refType: 'node', refId: nodeId });
}

// ────────────────────────────────────────────────────────────────────
// Edge handlers
// ────────────────────────────────────────────────────────────────────

export function handleEdgeAdded(event: KgEvent, state: ProjectionState): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const edgeId = (payload.edge_id as string | undefined) ?? event.entityId ?? undefined;
  if (edgeId === undefined) {
    logger.warn({ eventId: event.id }, 'kg: EDGE_ADDED missing edge_id in payload');
    return;
  }

  if (state.edges.has(edgeId)) return;

  const edge: KgEdge = {
    id: edgeId,
    fromId: (payload.from_id as string | undefined) ?? '',
    toId: (payload.to_id as string | undefined) ?? '',
    type: (payload.type as string | undefined) ?? 'supports',
    evidenceStrength: (payload.evidence_strength as number | null) ?? null,
    evidence: (payload.evidence as string | null) ?? null,
    evidenceVerbatim: Number(payload.evidence_verbatim) || 0,
    sourceId: (payload.source_id as string | null) ?? null,
    runId: event.runId,
    createdAt: event.timestamp,
  };

  state.edges.set(edgeId, edge);

  // Maintain reverse indexes
  const fromSet = state.edgesByFromId.get(edge.fromId) ?? new Set();
  fromSet.add(edgeId);
  state.edgesByFromId.set(edge.fromId, fromSet);
  const toSet = state.edgesByToId.get(edge.toId) ?? new Set();
  toSet.add(edgeId);
  state.edgesByToId.set(edge.toId, toSet);

  state.eventRefs.push({ eventId: event.id, refType: 'edge', refId: edgeId });
}

export function handleEdgeRemoved(event: KgEvent, state: ProjectionState): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const edgeId = payload.edge_id as string | undefined;

  if (edgeId === undefined) {
    logger.warn({ eventId: event.id }, 'kg: EDGE_REMOVED missing edge_id');
    return;
  }

  const removedEdge = state.edges.get(edgeId);
  if (removedEdge !== undefined) {
    // Clean up reverse indexes
    const fromSet = state.edgesByFromId.get(removedEdge.fromId);
    if (fromSet !== undefined) {
      fromSet.delete(edgeId);
      if (fromSet.size === 0) state.edgesByFromId.delete(removedEdge.fromId);
    }
    const toSet = state.edgesByToId.get(removedEdge.toId);
    if (toSet !== undefined) {
      toSet.delete(edgeId);
      if (toSet.size === 0) state.edgesByToId.delete(removedEdge.toId);
    }
  }

  state.edges.delete(edgeId);
  state.eventRefs.push({ eventId: event.id, refType: 'edge', refId: edgeId });
}

export function handleRelationshipStrengthRevised(event: KgEvent, state: ProjectionState): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const edgeId = payload.edge_id as string;
  const newVal = payload.new_val as number;

  const edge = state.edges.get(edgeId);
  if (edge === undefined) {
    logger.warn({ eventId: event.id, edgeId }, 'kg: RELATIONSHIP_STRENGTH_REVISED edge not found');
    return;
  }

  edge.evidenceStrength = newVal;

  state.eventRefs.push({ eventId: event.id, refType: 'edge', refId: edgeId });
}

// ────────────────────────────────────────────────────────────────────
// Contradiction
// ────────────────────────────────────────────────────────────────────

export function handleContradictionFlagged(event: KgEvent, state: ProjectionState): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const claimAId = payload.claim_a_id as string | undefined;
  const claimBId = payload.claim_b_id as string | undefined;

  if (claimAId !== undefined) {
    state.eventRefs.push({ eventId: event.id, refType: 'node', refId: claimAId });
  }
  if (claimBId !== undefined) {
    state.eventRefs.push({ eventId: event.id, refType: 'node', refId: claimBId });
  }
}

// ────────────────────────────────────────────────────────────────────
// Source handlers
// ────────────────────────────────────────────────────────────────────

export function handleSourceAdded(event: KgEvent, state: ProjectionState): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  let sourceId: string | undefined =
    (payload.source_id as string | undefined) ?? event.entityId ?? undefined;
  // Resilience: old events may lack source_id and entityId. Derive from URL or
  // fall back to event ID so data isn't silently dropped from the projection.
  if (sourceId === undefined) {
    const url = typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : null;
    if (url !== null) {
      // Stable ID from URL: same URL always maps to same source, enabling dedup across runs
      sourceId = `url:${Buffer.from(url).toString('base64').slice(0, 40)}`;
    } else {
      sourceId = event.id; // last resort: use event ID
    }
    logger.warn(
      { eventId: event.id, derivedSourceId: sourceId },
      'kg: SOURCE_ADDED missing source_id; derived from available payload data',
    );
  }

  if (state.sources.has(sourceId)) return;

  const source: KgSource = {
    id: sourceId,
    url: (payload.url as string | undefined) ?? '',
    canonicalUrl: (payload.canonical_url as string | null) ?? null,
    title: (payload.title as string | null) ?? null,
    domain: (payload.domain as string | null) ?? null,
    sourceKind: (payload.source_kind as string | null) ?? null,
    authorityScore: null,
    runId: event.runId,
    retrievedAt: (payload.retrieved_at as string | undefined) ?? event.timestamp,
    publishedAt: (payload.published_at as string | null) ?? null,
    contentHash: (payload.content_hash as string | undefined) ?? '',
    rawHash: (payload.raw_hash as string | null) ?? null,
    toolName: (payload.tool_name as string | null) ?? null,
  };

  state.sources.set(sourceId, source);
  state.eventRefs.push({ eventId: event.id, refType: 'source', refId: sourceId });
}

export function handleSourceChanged(event: KgEvent, state: ProjectionState): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const sourceId = payload.source_id as string;

  const source = state.sources.get(sourceId);
  if (source === undefined) {
    logger.warn({ eventId: event.id, sourceId }, 'kg: SOURCE_CHANGED source not found');
    return;
  }

  if (payload.new_content_hash !== undefined) {
    source.contentHash = payload.new_content_hash as string;
  }
  if (payload.url !== undefined) {
    source.url = payload.url as string;
  }
  source.retrievedAt = (payload.retrieved_at as string | undefined) ?? event.timestamp;

  state.eventRefs.push({ eventId: event.id, refType: 'source', refId: sourceId });
}

export function handleSourceRetracted(event: KgEvent, state: ProjectionState): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const sourceId = payload.source_id as string;

  state.sources.delete(sourceId);
  state.eventRefs.push({ eventId: event.id, refType: 'source', refId: sourceId });
}
