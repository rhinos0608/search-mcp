import { logger } from '../logger.js';
import type { FindingCluster, FindingClusterRelation, ClusterRevisionDecision } from './types.js';

/**
 * Validate and de-duplicate cluster revision decisions.
 * Resolves conflicts where multiple decisions reference the same cluster ID
 * by keeping the first decision and discarding later conflicting ones.
 */
export function validateClusterDecisions(
  decisions: ClusterRevisionDecision[],
): ClusterRevisionDecision[] {
  const consumed = new Set<string>();
  const validated: ClusterRevisionDecision[] = [];

  for (const decision of decisions) {
    // Check if any cluster ID is already consumed
    const hasConsumed = decision.clusterIds.some((id) => consumed.has(id));
    if (hasConsumed) {
      logger.warn(
        { action: decision.action, clusterIds: decision.clusterIds },
        'Cluster revision decision skipped — one or more cluster IDs already consumed by a prior decision',
      );
      continue;
    }

    // Consume all cluster IDs in this decision
    for (const id of decision.clusterIds) {
      consumed.add(id);
    }
    validated.push(decision);
  }

  return validated;
}

/**
 * Apply a merge decision: combine two clusters into one.
 * Returns a new cluster list with the merged cluster replacing the originals.
 * If either cluster ID doesn't exist, returns clusters unchanged with a warning.
 */
export function applyClusterMerge(
  clusters: FindingCluster[],
  decision: ClusterRevisionDecision,
): FindingCluster[] {
  // merge requires exactly 2 cluster IDs
  const [leftId, rightId] = decision.clusterIds;
  if (!leftId || !rightId) {
    logger.warn({ clusterIds: decision.clusterIds }, 'Merge decision missing cluster IDs');
    return clusters;
  }

  const leftCluster = clusters.find((c) => c.id === leftId);
  const rightCluster = clusters.find((c) => c.id === rightId);
  if (!leftCluster || !rightCluster) {
    logger.warn({ leftId, rightId }, 'Merge decision references non-existent clusters');
    return clusters;
  }

  // Build union of all edges from both clusters plus cross-edges between them
  const mergedFindingIds = [...new Set([...leftCluster.findingIds, ...rightCluster.findingIds])];

  // Filter edges connecting two findings within the merged set
  const mergedEdges = leftCluster.edges
    .concat(rightCluster.edges)
    .filter(
      (e) =>
        mergedFindingIds.includes(e.leftFindingId) && mergedFindingIds.includes(e.rightFindingId),
    );

  const strongEdges = mergedEdges.filter((e) => e.strength === 'strong');
  const weakEdges = mergedEdges.filter((e) => e.strength === 'weak');
  const bridgeEdges = mergedEdges.filter((e) => e.bridge);

  // Pick the representative claim from the higher-confidence cluster
  const representativeClaim =
    leftCluster.confidence >= rightCluster.confidence
      ? leftCluster.representativeClaim
      : rightCluster.representativeClaim;

  // Compute relation counts
  const relationCounts: Partial<Record<FindingClusterRelation, number>> = {};
  for (const edge of mergedEdges) {
    const count = relationCounts[edge.relation] ?? 0;
    relationCounts[edge.relation] = count + 1;
  }

  const mergedCluster: FindingCluster = {
    id: `${leftId}+${rightId}`,
    findingIds: mergedFindingIds,
    representativeClaim,
    method: 'hybrid',
    confidence: Math.max(leftCluster.confidence, rightCluster.confidence),
    edges: mergedEdges,
    strongEdges,
    weakEdges,
    bridgeEdges,
    relationCounts,
    mergeStatus: 'llm_merged',
  };

  // Replace the two clusters with the merged one
  return clusters.filter((c) => c.id !== leftId && c.id !== rightId).concat(mergedCluster);
}

/**
 * Apply a split decision: split one cluster into sub-clusters.
 * Filters splitGroupIndices to only include finding IDs that belong to the
 * target cluster (defensive against LLM including non-member IDs).
 * Returns clusters unchanged if target not found or fewer than 2 groups result.
 */
export function applyClusterSplit(
  clusters: FindingCluster[],
  decision: ClusterRevisionDecision,
): FindingCluster[] {
  // split requires exactly 1 cluster ID and splitGroupIndices
  const [targetId] = decision.clusterIds;
  if (!targetId || !decision.splitGroupIndices) {
    logger.warn(
      { clusterIds: decision.clusterIds },
      'Split decision missing cluster ID or group indices',
    );
    return clusters;
  }

  const targetCluster = clusters.find((c) => c.id === targetId);
  if (!targetCluster) {
    logger.warn({ targetId }, 'Split decision references non-existent cluster');
    return clusters;
  }

  // Defensive filter: only include finding IDs that belong to the target cluster
  const validFindingIds = new Set(targetCluster.findingIds);
  const filteredSplitEntries = Object.entries(decision.splitGroupIndices).filter(([findingId]) =>
    validFindingIds.has(findingId),
  );

  if (filteredSplitEntries.length < Object.keys(decision.splitGroupIndices).length) {
    logger.warn(
      {
        targetId,
        skipped: Object.keys(decision.splitGroupIndices).length - filteredSplitEntries.length,
      },
      'Split decision contained non-member finding IDs; filtered out',
    );
  }

  // Group findings by splitGroupIndices
  const groups = new Map<number, string[]>();
  for (const [findingId, groupIndex] of filteredSplitEntries) {
    const existing = groups.get(groupIndex) ?? [];
    existing.push(findingId);
    groups.set(groupIndex, existing);
  }

  if (groups.size < 2) {
    logger.warn(
      { targetId, groups: groups.size },
      'Split decision produced fewer than 2 groups; skipping',
    );
    return clusters;
  }

  // Build a sub-cluster for each group
  const subClusters: FindingCluster[] = [];
  let groupOrd = 0;
  for (const [, findingIds] of groups) {
    const subEdges = targetCluster.edges.filter(
      (e) => findingIds.includes(e.leftFindingId) && findingIds.includes(e.rightFindingId),
    );
    const strongEdges = subEdges.filter((e) => e.strength === 'strong');
    const weakEdges = subEdges.filter((e) => e.strength === 'weak');
    const bridgeEdges = subEdges.filter((e) => e.bridge);

    // Representative comes from the parent cluster
    const relationCounts: Partial<Record<FindingClusterRelation, number>> = {};
    for (const edge of subEdges) {
      const count = relationCounts[edge.relation] ?? 0;
      relationCounts[edge.relation] = count + 1;
    }

    subClusters.push({
      id: `${targetId}-${String(groupOrd)}`,
      findingIds,
      representativeClaim: targetCluster.representativeClaim,
      method: targetCluster.method,
      confidence:
        findingIds.length > 0
          ? targetCluster.confidence * (findingIds.length / targetCluster.findingIds.length)
          : targetCluster.confidence,
      edges: subEdges,
      strongEdges,
      weakEdges,
      bridgeEdges,
      relationCounts,
      mergeStatus: 'llm_split',
    });

    groupOrd++;
  }

  // Replace the original cluster with the sub-clusters
  return clusters.filter((c) => c.id !== targetId).concat(subClusters);
}

/**
 * Apply a keep decision: update mergeStatus to 'llm_kept'.
 * Returns clusters unchanged if target not found.
 */
export function applyClusterKeep(
  clusters: FindingCluster[],
  decision: ClusterRevisionDecision,
): FindingCluster[] {
  const [targetId] = decision.clusterIds;
  if (!targetId) {
    logger.warn({ clusterIds: decision.clusterIds }, 'Keep decision missing cluster ID');
    return clusters;
  }

  return clusters.map((c) => (c.id === targetId ? { ...c, mergeStatus: 'llm_kept' as const } : c));
}
