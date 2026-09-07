import { createHash } from 'node:crypto';
import {
  IdentityDecisionSchema,
  type IdentityDecision,
  type IdentityFeatureContribution,
} from '../domain/identity.js';
import type {
  IdentityDecisionId,
  EvidenceRef,
  SourceListingId,
  SourceObservationId,
} from '../domain/ids.js';
import { IDENTITY_RESOLVER_VERSION, type IdentityCluster, type PairScore } from './contracts.js';
import type { IdentitySubject } from './contracts.js';

/**
 * Propose an IdentityDecision from a PairScore.
 *
 * resolverVersion MUST be IDENTITY_RESOLVER_VERSION.
 * subjectObservationIds/ListingIds from the pair.
 * outcome from pair.proposedOutcome.
 */
export function proposeIdentityDecision(
  pair: PairScore,
  opts: {
    now: string;
    decisionId: IdentityDecisionId;
    leftListingId?: SourceListingId;
    rightListingId?: SourceListingId;
  },
): IdentityDecision {
  const listingIds: SourceListingId[] = [];
  if (opts.leftListingId) listingIds.push(opts.leftListingId);
  if (opts.rightListingId) listingIds.push(opts.rightListingId);

  return IdentityDecisionSchema.parse({
    decisionId: opts.decisionId,
    subjectObservationIds: [pair.leftObservationId, pair.rightObservationId],
    subjectListingIds: listingIds,
    outcome: pair.proposedOutcome,
    confidence: pair.confidence,
    featureContributions: pair.contributions,
    contradictoryEvidenceRefs: pair.contradictoryEvidenceRefs,
    resolverVersion: IDENTITY_RESOLVER_VERSION,
    createdAt: opts.now,
  });
}

/**
 * Build clusters from active (non-superseded) decisions.
 *
 * same_posting → union-find merge of subjects.
 * probable_cluster → grouping overlay; MUST NOT union same_posting clusters.
 * distinct/unresolved/split → no merge.
 */
export function clusterFromActiveDecisions(
  decisions: readonly IdentityDecision[],
): IdentityCluster[] {
  const active = activeDecisions(decisions);

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.has(root)) {
      const p = parent.get(root);
      if (p === undefined || p === root) break;
      root = p;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const d of active) {
    if (d.outcome !== 'same_posting') continue;
    const obs = d.subjectObservationIds;
    if (obs.length < 1) continue;
    const first = obs[0];
    if (first === undefined) continue;
    for (const id of obs) {
      if (!parent.has(id)) parent.set(id, id);
    }
    for (let i = 1; i < obs.length; i++) {
      const cur = obs[i];
      if (cur !== undefined) union(first, cur);
    }
  }

  const groups = new Map<string, { obsIds: Set<SourceObservationId>; decisionIds: Set<string> }>();
  for (const d of active) {
    if (d.outcome !== 'same_posting') continue;
    const first = d.subjectObservationIds[0];
    if (first === undefined) continue;
    const root = find(first);
    if (!groups.has(root)) groups.set(root, { obsIds: new Set(), decisionIds: new Set() });
    const g = groups.get(root);
    if (g === undefined) continue;
    for (const id of d.subjectObservationIds) g.obsIds.add(id);
    g.decisionIds.add(d.decisionId);
  }

  const clusters: IdentityCluster[] = [];
  for (const [, g] of groups) {
    const sortedObs = [...g.obsIds].sort();
    const sortedDecisions = [...g.decisionIds].sort();
    const cluster: IdentityCluster = {
      clusterId: sha256Hex(
        JSON.stringify(['identity-cluster', '1.0.0', 'same_posting', sortedObs]),
      ),
      kind: 'same_posting',
      memberObservationIds: sortedObs,
      memberListingIds: [],
      activeDecisionIds: sortedDecisions,
      revision: sha256Hex(JSON.stringify(sortedDecisions)),
    };
    clusters.push(cluster);
  }

  for (const d of active) {
    if (d.outcome !== 'probable_cluster') continue;
    const sortedObs = [...d.subjectObservationIds].sort();
    const sortedDecisions = [d.decisionId].sort();
    const cluster: IdentityCluster = {
      clusterId: sha256Hex(
        JSON.stringify(['identity-cluster', '1.0.0', 'probable_cluster', sortedObs]),
      ),
      kind: 'probable_cluster',
      memberObservationIds: sortedObs,
      memberListingIds: [],
      activeDecisionIds: sortedDecisions,
      revision: sha256Hex(JSON.stringify(sortedDecisions)),
    };
    clusters.push(cluster);
  }

  return clusters;
}

/**
 * Supersede a prior decision with a new one.
 *
 * Returns prior with supersededBy = next.decisionId; next.supersededBy absent.
 * Does not delete prior; does not mutate observations.
 */
export function supersedeDecision(
  prior: IdentityDecision,
  next: IdentityDecision,
): { prior: IdentityDecision; next: IdentityDecision } {
  const updatedPrior = { ...prior, supersededBy: next.decisionId };
  return {
    prior: IdentityDecisionSchema.parse(updatedPrior),
    next,
  };
}

/**
 * Merge subjects into a same_posting decision.
 *
 * MUST refuse if only organisation_normalized + title_normalized fire.
 * MUST refuse if any veto contribution ≤ -1.
 */
export function mergeSubjects(
  subjects: readonly IdentitySubject[],
  opts: {
    now: string;
    decisionId: IdentityDecisionId;
    confidence: number;
    contributions: IdentityFeatureContribution[];
    contradictoryEvidenceRefs: EvidenceRef[];
  },
): IdentityDecision {
  const nonWeakFeatures = opts.contributions.filter(
    (c) => c.feature !== 'organisation_normalized' && c.feature !== 'title_normalized',
  );
  if (nonWeakFeatures.length === 0) {
    throw new Error('MERGE_FORBIDDEN: only organisation and title features fire');
  }

  const hasVeto = opts.contributions.some((c) => c.contribution <= -1.0);
  if (hasVeto) {
    throw new Error('MERGE_FORBIDDEN: veto feature present');
  }

  const obsIds = subjects.map((s) => s.observation.observationId);
  const listingIds = subjects.map((s) => s.listing.sourceListingId);

  return IdentityDecisionSchema.parse({
    decisionId: opts.decisionId,
    subjectObservationIds: obsIds,
    subjectListingIds: listingIds,
    outcome: 'same_posting',
    confidence: opts.confidence,
    featureContributions: opts.contributions,
    contradictoryEvidenceRefs: opts.contradictoryEvidenceRefs,
    resolverVersion: IDENTITY_RESOLVER_VERSION,
    createdAt: opts.now,
  });
}

/**
 * Split a prior decision.
 *
 * outcome = 'split'.
 * subjectObservationIds remain the prior subject set (history preserves subjects).
 * Caller then appends new same_posting/distinct decisions for remaining groups.
 */
export function splitSubjects(
  prior: IdentityDecision,
  _remainingGroups: readonly (readonly SourceObservationId[])[],
  opts: { now: string; decisionId: IdentityDecisionId },
): IdentityDecision {
  return IdentityDecisionSchema.parse({
    decisionId: opts.decisionId,
    subjectObservationIds: prior.subjectObservationIds,
    subjectListingIds: prior.subjectListingIds,
    outcome: 'split',
    confidence: 1.0,
    featureContributions: [],
    contradictoryEvidenceRefs: [],
    resolverVersion: IDENTITY_RESOLVER_VERSION,
    createdAt: opts.now,
  });
}

/**
 * Filter decisions to active (supersededBy absent).
 */
export function activeDecisions(history: readonly IdentityDecision[]): IdentityDecision[] {
  return history.filter((d) => d.supersededBy === undefined);
}

/**
 * Follow the supersession chain from decisionId to the oldest-first lineage.
 */
export function decisionLineage(
  history: readonly IdentityDecision[],
  decisionId: IdentityDecisionId,
): IdentityDecision[] {
  const byId = new Map<string, IdentityDecision>();
  for (const d of history) byId.set(d.decisionId, d);

  const chain: IdentityDecision[] = [];
  const seen = new Set<string>();
  let current: IdentityDecision | undefined = byId.get(decisionId);

  while (current !== undefined && !seen.has(current.decisionId)) {
    seen.add(current.decisionId);
    const curId = current.decisionId;
    const superseder = history.find((d) => d.supersededBy === curId);
    if (superseder !== undefined) {
      chain.unshift(current);
      current = superseder;
    } else {
      chain.unshift(current);
      break;
    }
  }

  return chain;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
