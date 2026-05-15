/**
 * V7.0.0 — Entity merge/split and family projection event handlers.
 *
 * Handlers for ENTITY_MERGED, ENTITY_SPLIT, and all FAMILY_* events.
 * Split from projection-handlers.ts to keep file sizes under 400 lines.
 *
 * Each handler is a pure state transformer — no I/O.
 * Rollback filtering happens in the builder loop before dispatch.
 */

import { logger } from '../../logger.js';
import type { KgEvent, KgNode, KgFamily } from '../types.js';
import type { ProjectionState, RepointedEdge } from './projection-state.js';

// ────────────────────────────────────────────────────────────────────
// Entity merge / split handlers
// ────────────────────────────────────────────────────────────────────

export function handleEntityMerged(
  event: KgEvent,
  state: ProjectionState,
): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const fromId = payload.from_id as string | undefined;
  const intoId = payload.into_id as string | undefined;

  if (fromId === undefined || intoId === undefined) {
    logger.warn({ eventId: event.id }, 'kg: ENTITY_MERGED missing from_id or into_id');
    return;
  }

  const fromNode = state.nodes.get(fromId);
  const intoNode = state.nodes.get(intoId);

  if (fromNode === undefined) {
    logger.warn({ eventId: event.id, fromId }, 'kg: ENTITY_MERGED target node not found');
    return;
  }
  if (intoNode === undefined) {
    logger.warn(
      { eventId: event.id, intoId },
      'kg: ENTITY_MERGED destination node not found',
    );
    return;
  }

  const repointedEdges: RepointedEdge[] = [];

  // Use reverse indexes for O(1) edge lookup
  const fromEdgeIds = state.edgesByFromId.get(fromId);
  if (fromEdgeIds !== undefined) {
    for (const edgeId of fromEdgeIds) {
      const edge = state.edges.get(edgeId);
      if (edge !== undefined) {
        edge.fromId = intoId;
        repointedEdges.push({ edgeId, field: 'from_id', originalNodeId: fromId });
      }
    }
  }
  const toEdgeIds = state.edgesByToId.get(fromId);
  if (toEdgeIds !== undefined) {
    for (const edgeId of toEdgeIds) {
      const edge = state.edges.get(edgeId);
      if (edge !== undefined) {
        edge.toId = intoId;
        repointedEdges.push({ edgeId, field: 'to_id', originalNodeId: fromId });
      }
    }
  }

  // Update reverse indexes
  state.edgesByFromId.delete(fromId);
  state.edgesByToId.delete(fromId);

  // Preserve from label in aliases
  let existingAliases: string[] = [];
  if (intoNode.aliases) {
    try {
      existingAliases = JSON.parse(intoNode.aliases) as string[];
    } catch {
      existingAliases = [];
    }
  }
  if (!existingAliases.includes(fromNode.label)) {
    existingAliases.push(fromNode.label);
  }
  intoNode.aliases = JSON.stringify(existingAliases);

  state.nodes.delete(fromId);

  state.mergeHistory.set(event.id, {
    fromId,
    intoId,
    fromLabel: fromNode.label,
    mergedEventId: event.id,
    repointedEdges,
  });

  state.eventRefs.push(
    { eventId: event.id, refType: 'node', refId: intoId },
    { eventId: event.id, refType: 'node', refId: fromId },
  );
}

export function handleEntitySplit(
  event: KgEvent,
  state: ProjectionState,
): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const splitNodeId = payload.split_node_id as string | undefined;
  const mergedEventId = payload.merged_event_id as string;
  const restoredLabel = (payload.restored_label as string | undefined) ?? '';

  if (splitNodeId === undefined) {
    logger.warn({ eventId: event.id }, 'kg: ENTITY_SPLIT missing split_node_id');
    return;
  }

  const mergeRecord = state.mergeHistory.get(mergedEventId);

  if (mergeRecord === undefined) {
    logger.warn(
      { eventId: event.id, mergedEventId },
      'kg: ENTITY_SPLIT merge record not found; creating standalone node',
    );
    const node: KgNode = {
      id: splitNodeId,
      label: restoredLabel || 'Restored Node',
      canonicalLabel: null,
      type: 'concept',
      extractionConfidence: null,
      primaryFamilyId: null,
      aliases: null,
      firstSeenRunId: event.runId,
      lastUpdated: event.timestamp,
      metadata: null,
    };
    state.nodes.set(splitNodeId, node);
    state.eventRefs.push({ eventId: event.id, refType: 'node', refId: splitNodeId });
    return;
  }

  const oldLabel = mergeRecord.fromLabel;
  const intoNode = state.nodes.get(mergeRecord.intoId);

  // Restore the node
  const restoredNode: KgNode = {
    id: splitNodeId,
    label: restoredLabel || oldLabel,
    canonicalLabel: null,
    type: intoNode?.type ?? 'concept',
    extractionConfidence: intoNode?.extractionConfidence ?? null,
    primaryFamilyId: null,
    aliases: null,
    firstSeenRunId: event.runId,
    lastUpdated: event.timestamp,
    metadata: null,
  };
  state.nodes.set(splitNodeId, restoredNode);

  // Restore repointed edges
  for (const repointed of mergeRecord.repointedEdges) {
    const edge = state.edges.get(repointed.edgeId);
    if (edge !== undefined) {
      if (repointed.field === 'from_id') {
        edge.fromId = splitNodeId;
      } else {
        edge.toId = splitNodeId;
      }
    }
  }

  // Remove fromLabel from into node's aliases
  if (intoNode?.aliases) {
    const aliases = JSON.parse(intoNode.aliases) as string[];
    const filtered = aliases.filter((a: string) => a !== oldLabel);
    intoNode.aliases = filtered.length > 0 ? JSON.stringify(filtered) : null;
  }

  state.eventRefs.push({ eventId: event.id, refType: 'node', refId: splitNodeId });
}

// ────────────────────────────────────────────────────────────────────
// Family handlers
// ────────────────────────────────────────────────────────────────────

export function handleFamilyCreated(
  event: KgEvent,
  state: ProjectionState,
): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const familyId = payload.family_id as string | undefined;
  if (familyId === undefined) {
    logger.warn({ eventId: event.id }, 'kg: FAMILY_CREATED missing family_id');
    return;
  }

  if (state.families.has(familyId)) return;

  const family: KgFamily = {
    id: familyId,
    label: (payload.label as string | undefined) ?? '',
    description: (payload.description as string | null) ?? null,
    createdAt: event.timestamp,
    lastActivity: event.timestamp,
    runCount: 0,
    relatedFamilies: null,
  };

  state.families.set(familyId, family);
  state.eventRefs.push({ eventId: event.id, refType: 'family', refId: familyId });
}

export function handleFamilyClassified(
  event: KgEvent,
  state: ProjectionState,
): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const entityId = payload.entity_id as string | undefined;
  const familyId = payload.family_id as string | undefined;

  if (entityId === undefined || familyId === undefined) {
    logger.warn(
      { eventId: event.id },
      'kg: FAMILY_CLASSIFIED missing entity_id or family_id',
    );
    return;
  }

  // Set primary family on node if not already set
  const node = state.nodes.get(entityId);
  if (node?.primaryFamilyId === null) {
    node.primaryFamilyId = familyId;
  }

  // Avoid duplicate node-family entries
  const pairKey = `${entityId}|${familyId}`;
  if (state.nodeFamilyKeys.has(pairKey)) return;

  const isPrimary =
    node?.primaryFamilyId === familyId ? 1 : 0;

  state.nodeFamilies.push({
    nodeId: entityId,
    familyId,
    confidence: (payload.confidence as number | null | undefined) ?? null,
    isPrimary,
    runId: event.runId,
    classifierVersion: (payload.classifier_version as string | null | undefined) ?? null,
  });
  state.nodeFamilyKeys.add(pairKey);

  // Update family metadata
  const family = state.families.get(familyId);
  if (family !== undefined) {
    family.lastActivity = event.timestamp;
    const distinctRunIds = new Set(
      state.nodeFamilies
        .filter((nf) => nf.familyId === familyId)
        .map((nf) => nf.runId)
        .filter(Boolean) as string[],
    );
    family.runCount = distinctRunIds.size;
  }

  state.eventRefs.push(
    { eventId: event.id, refType: 'node', refId: entityId },
    { eventId: event.id, refType: 'family', refId: familyId },
  );
}

export function handleFamilyRenamed(
  event: KgEvent,
  state: ProjectionState,
): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const familyId = payload.family_id as string;

  const family = state.families.get(familyId);
  if (family === undefined) {
    logger.warn(
      { eventId: event.id, familyId },
      'kg: FAMILY_RENAMED family not found',
    );
    return;
  }

  family.label = (payload.new_label as string | undefined) ?? family.label;
  family.lastActivity = event.timestamp;

  state.eventRefs.push({ eventId: event.id, refType: 'family', refId: familyId });
}

export function handleFamilyMerged(
  event: KgEvent,
  state: ProjectionState,
): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const fromId = payload.from_id as string | undefined;
  const intoId = payload.into_id as string | undefined;

  if (fromId === undefined || intoId === undefined) {
    logger.warn({ eventId: event.id }, 'kg: FAMILY_MERGED missing from_id or into_id');
    return;
  }

  const fromFamily = state.families.get(fromId);
  const intoFamily = state.families.get(intoId);

  if (fromFamily === undefined) {
    logger.warn({ eventId: event.id, fromId }, 'kg: FAMILY_MERGED source family not found');
    return;
  }
  if (intoFamily === undefined) {
    logger.warn(
      { eventId: event.id, intoId },
      'kg: FAMILY_MERGED target family not found',
    );
    return;
  }

  // Repoint all nodeFamilies from -> into
  for (const nf of state.nodeFamilies) {
    if (nf.familyId === fromId) {
      nf.familyId = intoId;
    }
  }

  // Update node primaryFamilyId references
  for (const [, node] of state.nodes) {
    if (node.primaryFamilyId === fromId) {
      node.primaryFamilyId = intoId;
    }
  }

  // Merge related_families
  const fromRelated = fromFamily.relatedFamilies
    ? (JSON.parse(fromFamily.relatedFamilies) as {
        relationId: string;
        familyId: string;
        relationType: string;
      }[])
    : [];

  const intoRelated = intoFamily.relatedFamilies
    ? (JSON.parse(intoFamily.relatedFamilies) as {
        relationId: string;
        familyId: string;
        relationType: string;
      }[])
    : [];

  const existingIds = new Set(intoRelated.map((r) => r.relationId));
  for (const rel of fromRelated) {
    if (!existingIds.has(rel.relationId)) {
      intoRelated.push(rel);
    }
  }
  intoFamily.relatedFamilies =
    intoRelated.length > 0 ? JSON.stringify(intoRelated) : null;

  // Update family stats
  const distinctRunIds = new Set(
    state.nodeFamilies
      .filter((nf) => nf.familyId === intoId)
      .map((nf) => nf.runId)
      .filter(Boolean) as string[],
  );
  intoFamily.runCount = distinctRunIds.size;
  intoFamily.lastActivity = event.timestamp;

  state.families.delete(fromId);

  state.eventRefs.push(
    { eventId: event.id, refType: 'family', refId: intoId },
    { eventId: event.id, refType: 'family', refId: fromId },
  );
}

export function handleFamilyRelated(
  event: KgEvent,
  state: ProjectionState,
): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const relationId = payload.relation_id as string | undefined;
  const familyA = payload.family_a as string | undefined;
  const familyB = payload.family_b as string | undefined;
  const relationType = (payload.relation_type as string | undefined) ?? 'adjacent';

  if (relationId === undefined || familyA === undefined || familyB === undefined) {
    logger.warn({ eventId: event.id }, 'kg: FAMILY_RELATED missing required fields');
    return;
  }

  const famA = state.families.get(familyA);
  const famB = state.families.get(familyB);

  if (famA === undefined) {
    logger.warn({ eventId: event.id, familyA }, 'kg: FAMILY_RELATED family_a not found');
    return;
  }
  if (famB === undefined) {
    logger.warn({ eventId: event.id, familyB }, 'kg: FAMILY_RELATED family_b not found');
    return;
  }

  const relA = famA.relatedFamilies
    ? (JSON.parse(famA.relatedFamilies) as {
        relationId: string;
        familyId: string;
        relationType: string;
      }[])
    : [];
  if (!relA.some((r) => r.relationId === relationId)) {
    relA.push({ relationId, familyId: familyB, relationType });
  }
  famA.relatedFamilies = JSON.stringify(relA);

  const relB = famB.relatedFamilies
    ? (JSON.parse(famB.relatedFamilies) as {
        relationId: string;
        familyId: string;
        relationType: string;
      }[])
    : [];
  if (!relB.some((r) => r.relationId === relationId)) {
    relB.push({ relationId, familyId: familyA, relationType });
  }
  famB.relatedFamilies = JSON.stringify(relB);

  famA.lastActivity = event.timestamp;
  famB.lastActivity = event.timestamp;

  state.eventRefs.push(
    { eventId: event.id, refType: 'family', refId: familyA },
    { eventId: event.id, refType: 'family', refId: familyB },
  );
}

export function handleFamilyRelationRemoved(
  event: KgEvent,
  state: ProjectionState,
): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const relationId = payload.relation_id as string | undefined;

  if (relationId === undefined) {
    logger.warn(
      { eventId: event.id },
      'kg: FAMILY_RELATION_REMOVED missing relation_id',
    );
    return;
  }

  for (const [, family] of state.families) {
    if (family.relatedFamilies === null) continue;
    const relations = JSON.parse(family.relatedFamilies) as {
      relationId: string;
      familyId: string;
      relationType: string;
    }[];
    const filtered = relations.filter((r) => r.relationId !== relationId);
    if (filtered.length !== relations.length) {
      family.relatedFamilies =
        filtered.length > 0 ? JSON.stringify(filtered) : null;
      family.lastActivity = event.timestamp;
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Run lifecycle handler
// ────────────────────────────────────────────────────────────────────

export function handleRunRolledBack(
  event: KgEvent,
  state: ProjectionState,
): void {
  const payload = JSON.parse(event.payload) as Record<string, unknown>;
  const runId = payload.run_id as string | undefined;

  if (runId === undefined) {
    logger.warn({ eventId: event.id }, 'kg: RUN_ROLLED_BACK missing run_id');
    return;
  }

  state.rolledBackRuns.add(runId);
  state.eventRefs.push({ eventId: event.id, refType: 'run', refId: runId });
}
