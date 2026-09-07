/**
 * Geography scoring channel.
 *
 * Matches candidate locations against intent-requested locations using the
 * LocalePack's GeographyNode hierarchy. Supports:
 *   - Exact city/region/country match → 1.0
 *   - Parent hierarchy match (city→region, region→country) → 0.7
 *   - Alias match → 0.9
 *   - Remote eligibility match → 0.8
 *   - No match → 0.0
 *
 * Candidates with no location data → neutral 0.5.
 */

import type { LocalePack } from '../../packs/types.js';
import type { ChannelResult, ChannelScoreEntry } from '../contracts.js';

// ---------------------------------------------------------------------------
// Geography node type (inferred from pack schema)
// ---------------------------------------------------------------------------

interface GeoNode {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly parentId?: string;
  readonly aliases: readonly string[];
}

// ---------------------------------------------------------------------------
// Build geography index
// ---------------------------------------------------------------------------

interface GeoIndex {
  /** node ID → node */
  readonly nodes: ReadonlyMap<string, GeoNode>;
  /** lowercase name/alias → node ID */
  readonly nameIndex: ReadonlyMap<string, string>;
  /** node ID → parent ID */
  readonly parentMap: ReadonlyMap<string, string>;
}

function buildGeoIndex(localePack: LocalePack): GeoIndex {
  const nodes = new Map<string, GeoNode>();
  const nameIndex = new Map<string, string>();
  const parentMap = new Map<string, string>();

  for (const node of localePack.geography) {
    nodes.set(node.id, node as GeoNode);
    nameIndex.set(node.id.toLowerCase(), node.id);
    nameIndex.set(node.name.toLowerCase(), node.id);
    for (const alias of node.aliases) nameIndex.set(alias.toLowerCase(), node.id);
    if (node.parentId) parentMap.set(node.id, node.parentId);
  }

  return { nodes, nameIndex, parentMap };
}

/** Get all ancestor IDs (inclusive) for a node. */
function ancestors(nodeId: string, geo: GeoIndex): string[] {
  const chain: string[] = [nodeId];
  let current = nodeId;
  for (;;) {
    const parent = geo.parentMap.get(current);
    if (!parent || parent === current) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Score a candidate location against intent locations
// ---------------------------------------------------------------------------

function scoreLocationMatch(
  intentLocationIds: readonly string[],
  geo: GeoIndex,
  candidateCity?: string,
  candidateRegion?: string,
  candidateCountry?: string,
  candidateRemote?: boolean,
): number {
  // If intent has no location constraints, any location matches
  if (intentLocationIds.length === 0) return 1.0;

  // Collect candidate location node IDs (resolved from names)
  const candidateNodeIds: string[] = [];
  for (const entry of [candidateCity, candidateRegion, candidateCountry]) {
    if (!entry) continue;
    const id = geo.nameIndex.get(entry.toLowerCase());
    if (id) candidateNodeIds.push(id);
  }

  // Check remote match
  if (candidateRemote) {
    // Remote candidates match any intent location
    return 0.8;
  }

  if (candidateNodeIds.length === 0) return 0.5; // no location data

  // For each intent location, find best candidate match
  let bestScore = 0;
  for (const intentId of intentLocationIds) {
    const intentChain = new Set(ancestors(intentId, geo));

    for (const candId of candidateNodeIds) {
      // Exact match
      if (candId === intentId) {
        bestScore = Math.max(bestScore, 1.0);
        continue;
      }
      // Candidate is ancestor of intent (e.g. candidate country = intent country)
      if (intentChain.has(candId)) {
        bestScore = Math.max(bestScore, 0.7);
        continue;
      }
      // Intent is ancestor of candidate (e.g. intent country contains candidate city)
      const candChain = new Set(ancestors(candId, geo));
      if (candChain.has(intentId)) {
        bestScore = Math.max(bestScore, 0.7);
        continue;
      }
      // Check alias overlap
      const intentNode = geo.nodes.get(intentId);
      const candNode = geo.nodes.get(candId);
      if (intentNode && candNode) {
        const intentAliases = new Set([
          intentNode.name.toLowerCase(),
          ...intentNode.aliases.map((a) => a.toLowerCase()),
        ]);
        const candAliases = new Set([
          candNode.name.toLowerCase(),
          ...candNode.aliases.map((a) => a.toLowerCase()),
        ]);
        for (const a of candAliases) {
          if (intentAliases.has(a)) {
            bestScore = Math.max(bestScore, 0.9);
            break;
          }
        }
      }
    }
  }

  return bestScore;
}

// ---------------------------------------------------------------------------
// Score channel
// ---------------------------------------------------------------------------

export function scoreGeography(input: {
  readonly intentLocations: readonly {
    readonly city?: string;
    readonly region?: string;
    readonly country?: string;
    readonly remoteEligible?: boolean;
  }[];
  readonly candidateLocations: ReadonlyMap<
    string,
    readonly {
      readonly city?: string;
      readonly region?: string;
      readonly country?: string;
      readonly remoteEligible?: boolean;
    }[]
  >;
  readonly localePack: LocalePack;
}): ChannelResult {
  const geo = buildGeoIndex(input.localePack);

  // Resolve intent locations to geography node IDs
  const intentLocationIds: string[] = [];
  for (const loc of input.intentLocations) {
    for (const entry of [loc.city, loc.region, loc.country]) {
      if (!entry) continue;
      const id = geo.nameIndex.get(entry.toLowerCase());
      if (id && !intentLocationIds.includes(id)) intentLocationIds.push(id);
    }
  }

  const entries: ChannelScoreEntry[] = [];

  for (const [candidateId, locations] of input.candidateLocations) {
    // Intent has no location constraints — all candidates equal, omit from entries
    if (intentLocationIds.length === 0) {
      continue;
    }

    // Candidate has no location data — neutral 0.5 (missing evidence), omit from entries
    if (locations.length === 0) {
      continue;
    }

    // Score each candidate location, take the best
    let bestScore = 0;
    let anyResolved = false;
    for (const loc of locations) {
      const s = scoreLocationMatch(
        intentLocationIds,
        geo,
        loc.city,
        loc.region,
        loc.country,
        loc.remoteEligible,
      );
      if (s !== 0.5) anyResolved = true; // 0.5 = unresolvable names
      bestScore = Math.max(bestScore, s);
    }

    // Omit when all location names failed to resolve (no real geography evidence)
    if (!anyResolved) continue;

    entries.push({ candidateId, score: bestScore });
  }

  // Determine fullyScored: false if any candidate was missing from entries
  const allCandidateIds = new Set(input.candidateLocations.keys());
  const scoredIds = new Set(entries.map((e) => e.candidateId));
  const fullyScored = [...allCandidateIds].every((id) => scoredIds.has(id));

  entries.sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));

  return {
    channelId: 'geography',
    entries,
    fullyScored,
  };
}
