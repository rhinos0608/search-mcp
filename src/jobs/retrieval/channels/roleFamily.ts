/**
 * Role-family graph scoring channel.
 *
 * Scores candidate-role-family proximity to intent-requested role families
 * using the DomainPack's role graph. Graph edges encode:
 *   equivalent_title → 1.0
 *   adjacent → 0.6
 *   capability_transfer → 0.4
 *   prerequisite → 0.3
 *   false_friend → 0.0
 *
 * Candidates with no role families get neutral 0.5 (missing evidence).
 */

import type { DomainPack, RoleEdge, RoleNode } from '../../packs/types.js';
import type { ChannelResult, ChannelScoreEntry } from '../contracts.js';

// ---------------------------------------------------------------------------
// Build adjacency from DomainPack
// ---------------------------------------------------------------------------

interface GraphIndex {
  /** node ID → node */
  readonly nodes: ReadonlyMap<string, RoleNode>;
  /** node ID → outgoing edges */
  readonly adjacency: ReadonlyMap<string, readonly RoleEdge[]>;
  /** label/alias lowercase → node ID */
  readonly aliasIndex: ReadonlyMap<string, string>;
}

function buildGraphIndex(domainPack: DomainPack): GraphIndex {
  const nodes = new Map<string, RoleNode>();
  for (const n of domainPack.roleNodes) nodes.set(n.id, n);

  const adjacency = new Map<string, RoleEdge[]>();
  for (const e of domainPack.edges) {
    const existing = adjacency.get(e.from);
    if (existing) existing.push(e);
    else adjacency.set(e.from, [e]);
  }

  const aliasIndex = new Map<string, string>();
  for (const n of domainPack.roleNodes) {
    aliasIndex.set(n.id.toLowerCase(), n.id);
    aliasIndex.set(n.label.toLowerCase(), n.id);
    for (const alias of n.aliases) aliasIndex.set(alias.toLowerCase(), n.id);
  }

  return { nodes, adjacency, aliasIndex };
}

// ---------------------------------------------------------------------------
// Resolve role family string → node ID
// ---------------------------------------------------------------------------

function resolveRoleId(name: string, graph: GraphIndex): string | undefined {
  return graph.aliasIndex.get(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// BFS proximity score from a set of source IDs to target IDs
// ---------------------------------------------------------------------------

function proximityScore(
  sourceIds: readonly string[],
  targetIds: readonly string[],
  graph: GraphIndex,
): number {
  if (sourceIds.length === 0 || targetIds.length === 0) return 0;

  // BFS from all sources simultaneously
  const dist = new Map<string, number>();
  const queue: { id: string; d: number }[] = [];

  for (const sid of sourceIds) {
    if (!dist.has(sid)) {
      dist.set(sid, 0);
      queue.push({ id: sid, d: 0 });
    }
  }

  // Build reverse adjacency for bidirectional traversal
  const reverseAdj = new Map<string, { to: string; edge: RoleEdge }[]>();
  for (const [from, edges] of graph.adjacency) {
    for (const edge of edges) {
      // Forward
      const fwd = reverseAdj.get(from) ?? [];
      fwd.push({ to: edge.to, edge });
      reverseAdj.set(from, fwd);
      // Reverse (bidirectional for graph proximity)
      const rev = reverseAdj.get(edge.to) ?? [];
      rev.push({ to: from, edge });
      reverseAdj.set(edge.to, rev);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const entry = queue[head];
    if (!entry) continue;
    const { id, d } = entry;
    head++;
    if (d > 4) continue; // depth cap

    const neighbors = reverseAdj.get(id) ?? [];
    for (const { to, edge } of neighbors) {
      if (dist.has(to)) continue;
      // false_friend edges do not contribute to proximity
      if (edge.type === 'false_friend') continue;
      dist.set(to, d + 1);
      queue.push({ id: to, d: d + 1 });
    }
  }

  // Find best proximity to any target
  let bestDist = Infinity;
  for (const tid of targetIds) {
    const d = dist.get(tid);
    if (d !== undefined && d < bestDist) bestDist = d;
  }

  if (bestDist === Infinity) return 0;

  // Map distance to score: exact = 1.0, dist 1 = 0.8, dist 2 = 0.5, dist 3 = 0.3, dist 4 = 0.1
  const distanceScoreMap: Readonly<Record<number, number>> = {
    0: 1.0,
    1: 0.8,
    2: 0.5,
    3: 0.3,
    4: 0.1,
  };
  return distanceScoreMap[bestDist] ?? 0;
}

// ---------------------------------------------------------------------------
// Score channel
// ---------------------------------------------------------------------------

export function scoreRoleFamily(input: {
  readonly intentRoleFamilies: readonly string[];
  readonly candidateRoleFamilies: ReadonlyMap<string, readonly string[]>;
  /** candidate ID → role family names */
  readonly domainPack: DomainPack;
}): ChannelResult {
  const graph = buildGraphIndex(input.domainPack);

  // Resolve intent role families to node IDs
  const targetIds: string[] = [];
  for (const rf of input.intentRoleFamilies) {
    const id = resolveRoleId(rf, graph);
    if (id) targetIds.push(id);
  }

  const entries: ChannelScoreEntry[] = [];

  for (const [candidateId, roleFamilies] of input.candidateRoleFamilies) {
    if (roleFamilies.length === 0) {
      // Missing evidence → neutral 0.5 — omit from entries; RRF handles absent candidates
      continue;
    }

    const sourceIds: string[] = [];
    for (const rf of roleFamilies) {
      const id = resolveRoleId(rf, graph);
      if (id) sourceIds.push(id);
    }

    if (sourceIds.length === 0 || targetIds.length === 0) {
      // Unresolvable roles → neutral 0.5 — omit from entries
      continue;
    }

    const score = proximityScore(sourceIds, targetIds, graph);
    entries.push({ candidateId, score });
  }

  // Determine fullyScored: false if any candidate was missing from entries
  const allCandidateIds = new Set(input.candidateRoleFamilies.keys());
  const scoredIds = new Set(entries.map((e) => e.candidateId));
  const fullyScored = [...allCandidateIds].every((id) => scoredIds.has(id));

  entries.sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));

  return {
    channelId: 'role_family',
    entries,
    fullyScored,
  };
}
