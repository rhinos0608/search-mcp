/**
 * V5.0.0 ClaimClustering — cross-source claim normalization and clustering.
 *
 * After structured claim extraction, we normalize claims into canonical
 * keys (subject + predicate + quantifier) and cluster them across sources.
 * This enables the "5 sources say X, 2 say not-X" analysis that single-source
 * extraction cannot provide.
 *
 * The clustering can use either rule-based heuristics (deterministic, fast)
 * or LLM-based clustering (higher recall).
 */

import { logger } from '../logger.js';
import type {
  Finding,
  NormalizedClaimKey,
  ClaimPolarity,
} from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClaimCluster {
  /** Cluster ID. */
  id: string;
  /** IDs of findings in this cluster. */
  findingIds: string[];
  /** Clearest formulation of the shared claim. */
  representativeClaim: string;
  /** Number of distinct sources supporting this cluster. */
  sourceCount: number;
  /** Number of findings total */
  findingCount: number;
  /** Consensus level. */
  consensus: ClaimConsensus;
  /** If contradictory, description of the conflict. */
  contradiction?: ContradictionDescription;
  /** Aggregated canonical key. */
  canonicalKey: NormalizedClaimKey;
  /** Source URL list for citation. */
  sources: { url?: string; id: string }[];
}

export type ClaimConsensus =
  | 'strong_agreement'    // 3+ sources agree
  | 'moderate_agreement'  // 2 sources agree
  | 'mixed'               // Some agreement, some disagreement
  | 'contradictory'       // Directly contradicting claims
  | 'single_source';      // Only one source

export interface ContradictionDescription {
  /** The conflicting claim text. */
  contradictoryClaim: string;
  /** The conflicting claim's polarity. */
  conflictingPolarity?: ClaimPolarity;
  /** Finding ID of the conflicting claim. */
  conflictingFindingId: string;
}

export interface ClusteringResult {
  clusters: ClaimCluster[];
  /** Total distinct sources across all clusters. */
  totalSources: number;
  /** Total findings clustered. */
  totalFindings: number;
  /** Findings that couldn't be clustered (usually singletons). */
  unclustered: string[];
}

// ── Normalization helpers ────────────────────────────────────────────────────

/**
 * Normalize a subject string for comparison.
 * Lowercase, strip punctuation, remove stop-word suffixes.
 */
function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a predicate string for comparison.
 * Lowercase, strip punctuation, stem common verbs.
 */
function normalizePredicate(predicate: string): string {
  return predicate
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    // Stem common verb forms: "reduces", "reduced", "reducing" → "reduce"
    .replace(/\b(reduces|reduced|reducing)\b/g, 'reduce')
    .replace(/\b(increases|increased|increasing)\b/g, 'increase')
    .replace(/\b(improves|improved|improving)\b/g, 'improve')
    .replace(/\b(achieves|achieved|achieving)\b/g, 'achieve')
    .replace(/\b(outperforms|outperformed|outperforming)\b/g, 'outperform')
    .replace(/\b(surpasses|surpassed|surpassing)\b/g, 'surpass')
    .replace(/\b(shows|showed|showing)\b/g, 'show')
    .replace(/\b(indicates|indicated|indicating)\b/g, 'indicate')
    .replace(/\b(suggests|suggested|suggesting)\b/g, 'suggest')
    .replace(/\b(provides|provided|providing)\b/g, 'provide')
    .replace(/\b(enables|enabled|enabling)\b/g, 'enable')
    .replace(/\b(requires|required|requiring)\b/g, 'require')
    .replace(/\b(uses|used|using)\b/g, 'use')
    .replace(/\b(employs|employed|employing)\b/g, 'employ')
    .trim();
}

/**
 * Build a canonical cluster key from a finding's structured fields.
 */
function buildClusterKey(finding: Finding): string {
  if (finding.canonicalKey) {
    const { subject, predicate, quantifierCanonical } = finding.canonicalKey;
    const base = `${normalizeSubject(subject)}::${normalizePredicate(predicate)}`;
    return quantifierCanonical ? `${base}::${quantifierCanonical}` : base;
  }

  // Fallback: use normalizedClaim
  const claim = finding.normalizedClaim;
  // Extract subject-like portion (first 3 content words)
  const words = claim.split(/\s+/).filter((w) => w.length > 3).slice(0, 5);
  return words.join('_');
}

/**
 * Determine if two canonical keys should be in the same cluster.
 * Uses fuzzy matching: same subject root + similar predicate.
 */
function fuzzyMatchKeys(keyA: string, keyB: string): boolean {
  if (keyA === keyB) return true;

  const partsA = keyA.split('::');
  const partsB = keyB.split('::');

  // Must share the same subject (first segment)
  const subjectA = partsA[0];
  const subjectB = partsB[0];

  if (!subjectA || !subjectB) return false;

  // Subjects should overlap substantially
  const wordsA = new Set(subjectA.split(/\s+/).filter(Boolean));
  const wordsB = new Set(subjectB.split(/\s+/).filter(Boolean));
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  const minSize = Math.min(wordsA.size, wordsB.size);
  if (minSize === 0) return false;

  const subjectOverlap = overlap / minSize;

  // If subjects strongly overlap and predicates share at least one word, cluster them
  if (subjectOverlap >= 0.6) {
    const predA = partsA[1]?.split(/\s+/).filter(Boolean) ?? [];
    const predB = partsB[1]?.split(/\s+/).filter(Boolean) ?? [];
    const predOverlap = predA.some((w) => predB.includes(w));
    return predOverlap || subjectOverlap >= 1.0;
  }

  return false;
}

// ── Consensus determination ─────────────────────────────────────────────────

function determineConsensus(
  findings: Finding[],
  distinctSources: Set<string>,
): ClaimConsensus {
  const polarities = new Set(findings.map((f) => f.polarity));
  const hasAsserted = polarities.has('asserted');
  const hasNegated = polarities.has('negated');
  const hasUncertain = findings.some((f) => f.polarity === 'conditional');
  const hasHedged = findings.some((f) => f.hedge !== undefined && f.hedge !== 'certain');

  if (distinctSources.size >= 3) {
    if (hasAsserted && hasNegated) return 'contradictory';
    if (hasAsserted && (hasUncertain || hasHedged)) return 'mixed';
    return 'strong_agreement';
  }

  if (distinctSources.size === 2) {
    if (hasAsserted && hasNegated) return 'contradictory';
    if (hasAsserted && (hasUncertain || hasHedged)) return 'mixed';
    return 'moderate_agreement';
  }

  return 'single_source';
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Cluster findings across sources using rule-based canonical key matching.
 *
 * For a Finding to be clustered, it must have:
 * - canonicalKey (set by LlmClaimExtractor)
 * Or fall back to normalizedClaim-based clustering.
 *
 * @param findings  All findings from the current research run.
 * @returns         Clustering result with clusters and unclustered IDs.
 */
export function clusterFindings(findings: Finding[]): ClusteringResult {
  if (findings.length === 0) {
    return { clusters: [], totalSources: 0, totalFindings: 0, unclustered: [] };
  }

  // Build canonical keys for all findings
  const keys = new Map<string, string>(); // findingId → clusterKey
  for (const f of findings) {
    keys.set(f.id, buildClusterKey(f));
  }

  // Group by matched keys
  const keyGroups = new Map<string, string[]>(); // clusterKey → [findingId, ...]
  const processed = new Set<string>();
  const emptyKeyIds = new Set<string>();

  for (const f of findings) {
    if (processed.has(f.id)) continue;

    const key = keys.get(f.id);
    if (!key) {
      emptyKeyIds.add(f.id);
      processed.add(f.id);
      continue;
    }

    // Find all matching findings
    const group: string[] = [f.id];
    processed.add(f.id);

    for (const other of findings) {
      if (processed.has(other.id)) continue;
      const otherKey = keys.get(other.id);
      if (!otherKey) continue;

      if (fuzzyMatchKeys(key, otherKey)) {
        group.push(other.id);
        processed.add(other.id);
      }
    }

    keyGroups.set(key, group);
  }

  // Build clusters
  const clusters: ClaimCluster[] = [];
  const unclustered: string[] = [];
  let clusterIdx = 0;
  const allSources = new Set<string>();

  for (const [key, findingIds] of keyGroups) {
    if (findingIds.length === 0) continue;

    const clusterFindings = findingIds
      .map((id) => findings.find((f) => f.id === id))
      .filter((f): f is Finding => f !== undefined);

    if (clusterFindings.length === 0) continue;

    // Collect distinct source IDs
    const distinctSources = new Set<string>();
    const sources: { url?: string; id: string }[] = [];
    for (const f of clusterFindings) {
      for (const sId of f.sourceIds) {
        if (!sId) continue;
        distinctSources.add(sId);
        allSources.add(sId);
        sources.push({ id: sId });
      }
    }

    const consensus = determineConsensus(clusterFindings, distinctSources);

    // Find contradictions
    let contradiction: ContradictionDescription | undefined;
    if (consensus === 'contradictory') {
      const asserted = clusterFindings.find((f) => f.polarity === 'asserted');
      const negated = clusterFindings.find((f) => f.polarity === 'negated');
      if (asserted && negated) {
        const desc: ContradictionDescription = {
          contradictoryClaim: negated.claim,
          conflictingFindingId: negated.id,
        };
        if (negated.polarity) {
          desc.conflictingPolarity = negated.polarity;
        }
        contradiction = desc;
      }
    }

    // Pick best representative claim (longest detailed claim)
    const sorted = [...clusterFindings].sort((a, b) => b.claim.length - a.claim.length);
    const representative = sorted[0]?.claim ?? '';

    // Reconstruct canonical key from the key string
    const keyParts = key.split('::');
    const canonicalKey: NormalizedClaimKey = {
      subject: keyParts[0] ?? '',
      predicate: keyParts[1] ?? '',
    };
    if (keyParts[2]) {
      canonicalKey.quantifierCanonical = keyParts[2];
    }

    const cluster: ClaimCluster = {
      id: `cluster-${String(clusterIdx++)}`,
      findingIds,
      representativeClaim: representative,
      sourceCount: distinctSources.size,
      findingCount: clusterFindings.length,
      consensus,
      canonicalKey,
      sources,
    };
    if (contradiction) {
      cluster.contradiction = contradiction;
    }
    clusters.push(cluster);
  }

  // Collect unclustered
  for (const f of findings) {
    if (emptyKeyIds.has(f.id)) {
      unclustered.push(f.id);
    }
  }

  // Sort clusters: contradictions first (most interesting), then by source count desc
  clusters.sort((a, b) => {
    if (a.consensus === 'contradictory' && b.consensus !== 'contradictory') return -1;
    if (a.consensus !== 'contradictory' && b.consensus === 'contradictory') return 1;
    return b.sourceCount - a.sourceCount;
  });

  logger.info(
    {
      totalFindings: findings.length,
      clusters: clusters.length,
      unclustered: unclustered.length,
      strongAgreement: clusters.filter((c) => c.consensus === 'strong_agreement').length,
      mixed: clusters.filter((c) => c.consensus === 'mixed').length,
      contradictory: clusters.filter((c) => c.consensus === 'contradictory').length,
    },
    'Claim clustering complete',
  );

  return {
    clusters,
    totalSources: allSources.size,
    totalFindings: findings.length,
    unclustered,
  };
}

/**
 * Convert clusters back into enriched findings (for synthesis consumption).
 * Each cluster gets a clusterId and cross-source consensus metadata.
 */
export function applyClustersToFindings(
  findings: Finding[],
  result: ClusteringResult,
): Finding[] {
  const clusterMap = new Map<string, string>(); // findingId → clusterId

  for (const cluster of result.clusters) {
    for (const fid of cluster.findingIds) {
      clusterMap.set(fid, cluster.id);
    }
  }

  return findings.map((f) => {
    const clusterId = clusterMap.get(f.id);
    if (!clusterId) return f;

    // Find the cluster
    const cluster = result.clusters.find((c) => c.id === clusterId);
    if (!cluster) return f;

    const updated: Finding = {
      ...f,
      clusterId,
    };
    // If this finding is in a contradictory cluster but is the minority view,
    // mark its epistemic status accordingly
    if (!f.epistemicStatus && cluster.contradiction) {
      if (
        cluster.consensus === 'contradictory' &&
        f.polarity === cluster.contradiction.conflictingPolarity
      ) {
        updated.epistemicStatus = 'contested';
      } else if (f.polarity === 'asserted') {
        updated.epistemicStatus = 'emerging';
      }
    }
    return updated;
  });
}
