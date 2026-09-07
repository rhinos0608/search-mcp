/**
 * Capability overlap scoring channel.
 *
 * Measures Jaccard-like overlap between a candidate's role capabilities
 * (from DomainPack roleNodes) and the intent's requested capabilities.
 * Missing capability data → neutral 0.5.
 */

import type { DomainPack } from '../../packs/types.js';
import type { ChannelResult, ChannelScoreEntry } from '../contracts.js';

// ---------------------------------------------------------------------------
// Build capability index: role family → set of capabilities
// ---------------------------------------------------------------------------

function buildCapabilityIndex(domainPack: DomainPack): ReadonlyMap<string, ReadonlySet<string>> {
  const index = new Map<string, ReadonlySet<string>>();
  for (const node of domainPack.roleNodes) {
    index.set(node.id.toLowerCase(), new Set(node.capabilities.map((c) => c.toLowerCase())));
  }
  return index;
}

// ---------------------------------------------------------------------------
// Resolve role family name to node ID via lowercase alias index
// ---------------------------------------------------------------------------

function buildAliasIndex(domainPack: DomainPack): ReadonlyMap<string, string> {
  const aliasIndex = new Map<string, string>();
  for (const n of domainPack.roleNodes) {
    aliasIndex.set(n.id.toLowerCase(), n.id);
    aliasIndex.set(n.label.toLowerCase(), n.id);
    for (const alias of n.aliases) aliasIndex.set(alias.toLowerCase(), n.id);
  }
  return aliasIndex;
}

function resolveRoleId(name: string, aliasIndex: ReadonlyMap<string, string>): string | undefined {
  return aliasIndex.get(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Compute overlap score
// ---------------------------------------------------------------------------

function overlapScore(capsA: ReadonlySet<string>, capsB: ReadonlySet<string>): number {
  if (capsA.size === 0 && capsB.size === 0) return 0.5;
  if (capsA.size === 0 || capsB.size === 0) return 0.5;

  let intersection = 0;
  for (const c of capsA) {
    if (capsB.has(c)) intersection++;
  }
  const union = capsA.size + capsB.size - intersection;
  return union === 0 ? 0.5 : intersection / union;
}

// ---------------------------------------------------------------------------
// Score channel
// ---------------------------------------------------------------------------

export function scoreCapabilityOverlap(input: {
  readonly intentCapabilities: readonly string[];
  readonly intentRoleFamilies?: readonly string[];
  readonly candidateRoleFamilies: ReadonlyMap<string, readonly string[]>;
  /** candidate ID → extracted capabilities (override from extraction) */
  readonly candidateCapabilities?: ReadonlyMap<string, readonly string[]>;
  readonly domainPack: DomainPack;
}): ChannelResult {
  const capIndex = buildCapabilityIndex(input.domainPack);
  const aliasIndex = buildAliasIndex(input.domainPack);

  // Resolve intent capabilities to a set
  const intentCaps = new Set<string>();
  for (const c of input.intentCapabilities) {
    intentCaps.add(c.toLowerCase());
  }

  // Also gather capabilities from intent role families
  for (const rf of input.intentRoleFamilies ?? []) {
    const id = resolveRoleId(rf, aliasIndex);
    if (id) {
      const caps = capIndex.get(id.toLowerCase());
      if (caps) for (const c of caps) intentCaps.add(c);
    }
  }

  const entries: ChannelScoreEntry[] = [];

  for (const [candidateId, roleFamilies] of input.candidateRoleFamilies) {
    // Gather candidate capabilities
    let candidateCaps: ReadonlySet<string>;

    // Prefer explicit capabilities from extraction
    const explicit = input.candidateCapabilities?.get(candidateId);
    if (explicit && explicit.length > 0) {
      candidateCaps = new Set(explicit.map((c) => c.toLowerCase()));
    } else {
      // Resolve from role families
      const caps = new Set<string>();
      for (const rf of roleFamilies) {
        const id = resolveRoleId(rf, aliasIndex);
        if (id) {
          const nodeCaps = capIndex.get(id.toLowerCase());
          if (nodeCaps) for (const c of nodeCaps) caps.add(c);
        }
      }
      candidateCaps = caps;
    }

    if (candidateCaps.size === 0 || intentCaps.size === 0) {
      // Missing capability data → neutral 0.5 — omit from entries
      continue;
    }

    entries.push({ candidateId, score: overlapScore(candidateCaps, intentCaps) });
  }

  // Determine fullyScored: false if any candidate was missing from entries
  const allCandidateIds = new Set(input.candidateRoleFamilies.keys());
  const scoredIds = new Set(entries.map((e) => e.candidateId));
  const fullyScored = [...allCandidateIds].every((id) => scoredIds.has(id));

  entries.sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));

  return {
    channelId: 'capability_overlap',
    entries,
    fullyScored,
  };
}
