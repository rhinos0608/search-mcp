import { z } from 'zod/v4';
import { IdentityOutcomeSchema } from '../domain/identity.js';
import type { IdentityFeatureContribution } from '../domain/identity.js';
import type { EvidenceRef } from '../domain/ids.js';
import type { IdentityFeatureName, IdentityFeatureVector, PairScore } from './contracts.js';

type IdentityOutcome = z.infer<typeof IdentityOutcomeSchema>;

/** Frozen weights (research A.5). Sum of positive max = 1 before clamp. */
const WEIGHTS: Record<IdentityFeatureName, number> = {
  source_listing_id: 0.35,
  adapter_external_id: 0.35,
  canonical_url: 0.35,
  content_hash: 0.35,
  requisition_id: 0.35,
  apply_url: 0.12,
  description_fingerprint: 0.12,
  posted_at_proximity: 0.12,
  location_overlap: 0.12,
  salary_overlap: 0.12,
  organisation_normalized: 0.05,
  title_normalized: 0.05,
  contradictory_employer: -1.0,
  contradictory_location: -1.0,
  contradictory_dates: -1.0,
  contradictory_requisition: -1.0,
};

type FeatureStrength = 'strong' | 'corroborating' | 'weak' | 'veto';

const STRENGTH: Record<IdentityFeatureName, FeatureStrength> = {
  source_listing_id: 'strong',
  adapter_external_id: 'strong',
  canonical_url: 'strong',
  content_hash: 'strong',
  requisition_id: 'strong',
  apply_url: 'corroborating',
  description_fingerprint: 'corroborating',
  posted_at_proximity: 'corroborating',
  location_overlap: 'corroborating',
  salary_overlap: 'corroborating',
  organisation_normalized: 'weak',
  title_normalized: 'weak',
  contradictory_employer: 'veto',
  contradictory_location: 'veto',
  contradictory_dates: 'veto',
  contradictory_requisition: 'veto',
};

const STRONG_CAP = 0.85;
const CORROBORATING_CAP = 0.4;
const WEAK_CAP = 0.1;

/**
 * Score a pair of identity feature vectors.
 *
 * Hard rule: org+title only (zero strong, zero corroborating) → distinct/unresolved,
 * never same_posting or probable_cluster.
 */
export function scoreIdentityPair(
  left: IdentityFeatureVector,
  right: IdentityFeatureVector,
): PairScore {
  const contributions: IdentityFeatureContribution[] = [];
  const contradictoryEvidenceRefs: EvidenceRef[] = [];

  let strongCount = 0;
  let corroboratingCount = 0;
  let weakCount = 0;
  let vetoCount = 0;

  const allFeatureNames = Object.keys(WEIGHTS) as IdentityFeatureName[];

  for (const name of allFeatureNames) {
    const leftVal = left.features[name];
    const rightVal = right.features[name];

    if (leftVal === undefined || rightVal === undefined) continue;

    const strength = STRENGTH[name];
    const weight = WEIGHTS[name];

    if (strength === 'veto') {
      if (!leftVal || !rightVal) continue;
      vetoCount++;
      contributions.push({
        feature: name,
        contribution: weight,
        evidenceRefs: [
          ...(left.evidenceByFeature[name] ?? []),
          ...(right.evidenceByFeature[name] ?? []),
        ],
      });
      if (weight <= -1.0) {
        contradictoryEvidenceRefs.push(
          ...(left.evidenceByFeature[name] ?? []),
          ...(right.evidenceByFeature[name] ?? []),
        );
      }
      continue;
    }

    if (!valuesEqual(leftVal, rightVal)) continue;

    if (strength === 'strong') strongCount++;
    else if (strength === 'corroborating') corroboratingCount++;
    else weakCount++;

    contributions.push({
      feature: name,
      contribution: weight,
      evidenceRefs: [
        ...(left.evidenceByFeature[name] ?? []),
        ...(right.evidenceByFeature[name] ?? []),
      ],
    });
  }

  let strongSum = 0;
  let corroboratingSum = 0;
  let weakSum = 0;

  for (const c of contributions) {
    const s = STRENGTH[c.feature as IdentityFeatureName];
    if (s === 'strong') strongSum += c.contribution;
    else if (s === 'corroborating') corroboratingSum += c.contribution;
    else if (s === 'weak') weakSum += c.contribution;
  }

  const score = Math.max(
    0,
    Math.min(
      1,
      Math.min(strongSum, STRONG_CAP) +
        Math.min(corroboratingSum, CORROBORATING_CAP) +
        Math.min(weakSum, WEAK_CAP) +
        vetoCount * -1.0,
    ),
  );

  let proposedOutcome: IdentityOutcome;
  let confidence: number;

  if (vetoCount >= 1) {
    const hasEmployerVeto = contributions.some(
      (c) =>
        (c.feature === 'contradictory_employer' || c.feature === 'contradictory_requisition') &&
        c.contribution <= -1.0,
    );
    if (hasEmployerVeto) {
      proposedOutcome = 'distinct';
      confidence = Math.min(0.95, score);
    } else {
      proposedOutcome = 'unresolved';
      confidence = Math.min(0.6, score);
    }
  } else if (strongCount >= 1) {
    proposedOutcome = 'same_posting';
    confidence = Math.max(0.8, score);
  } else if (corroboratingCount >= 2) {
    proposedOutcome = 'probable_cluster';
    confidence = Math.max(0.5, Math.min(0.79, score));
  } else if (weakCount >= 1) {
    proposedOutcome = 'distinct';
    confidence = Math.max(0.7, score);
  } else {
    proposedOutcome = 'unresolved';
    confidence = 0;
  }

  return {
    leftObservationId: left.subject.observationId,
    rightObservationId: right.subject.observationId,
    contributions,
    contradictoryEvidenceRefs,
    score,
    proposedOutcome,
    confidence,
  };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (
    typeof a === 'string' ||
    typeof a === 'number' ||
    typeof a === 'boolean' ||
    typeof a === 'bigint'
  ) {
    return a === b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keysA = Object.keys(objA).sort();
    const keysB = Object.keys(objB).sort();
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k, i) => k === keysB[i] && valuesEqual(objA[k], objB[keysB[i]]));
  }
  return false;
}
