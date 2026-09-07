import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceListingSchema, createSourceObservation } from '../../src/jobs/domain/source.js';
import { IdentityDecisionSchema } from '../../src/jobs/domain/identity.js';
import { JobPostingSchema } from '../../src/jobs/domain/posting.js';
import type { SourceListing, SourceObservation } from '../../src/jobs/domain/source.js';
import type { JobPosting } from '../../src/jobs/domain/posting.js';
import {
  IDENTITY_CONTRACT_VERSION,
  IDENTITY_RESOLVER_VERSION,
  type IdentitySubject,
} from '../../src/jobs/identity/contracts.js';
import { extractIdentityFeatures } from '../../src/jobs/identity/features.js';
import { scoreIdentityPair } from '../../src/jobs/identity/score.js';
import {
  clusterFromActiveDecisions,
  supersedeDecision,
  mergeSubjects,
  splitSubjects,
  activeDecisions,
  decisionLineage,
} from '../../src/jobs/identity/resolve.js';
import type { IdentityDecision } from '../../src/jobs/domain/identity.js';
import type { IdentityDecisionId, SourceObservationId } from '../../src/jobs/domain/ids.js';

const instant = '2026-01-01T00:00:00+00:00';

// Use parse to get branded types from schemas
function makeListing(overrides: Record<string, unknown> = {}): SourceListing {
  return SourceListingSchema.parse({
    sourceListingId: overrides.sourceListingId ?? 'listing-1',
    adapterId: overrides.adapterId ?? 'adapter-1',
    externalId: overrides.externalId,
    canonicalUrl: overrides.canonicalUrl,
    firstSeenAt: overrides.firstSeenAt ?? instant,
    lastSeenAt: overrides.lastSeenAt ?? instant,
    currentObservationId: overrides.currentObservationId ?? 'obs-1',
  });
}

function makeObservation(overrides: Record<string, unknown> = {}): SourceObservation {
  return createSourceObservation({
    observationId: overrides.observationId ?? 'obs-1',
    sourceListingId: overrides.sourceListingId ?? 'listing-1',
    fetchedAt: overrides.fetchedAt ?? instant,
    contentHash: overrides.contentHash ?? 'hash-1',
    evidenceRefs: overrides.evidenceRefs ?? ['ev-1'],
    extractionVersion: overrides.extractionVersion ?? '1',
    adapterVersion: overrides.adapterVersion ?? '1',
    fetchOutcome: overrides.fetchOutcome ?? 'success',
    sourceConfidence: overrides.sourceConfidence ?? {},
    immutable: true,
  });
}

function makePosting(overrides: Record<string, unknown> = {}): JobPosting {
  return JobPostingSchema.parse({
    postingId: overrides.postingId ?? 'post-1',
    schemaVersion: overrides.schemaVersion ?? '1',
    canonicalRevision: overrides.canonicalRevision ?? 1,
    title: overrides.title ?? 'Software Engineer',
    normalizedTitle: overrides.normalizedTitle ?? 'software engineer',
    organisation: overrides.organisation ?? 'Acme Corp',
    roleFamilies: overrides.roleFamilies ?? [],
    locations: overrides.locations ?? [{ country: 'AU', city: 'Sydney' }],
    workMode: overrides.workMode ?? 'hybrid',
    employmentType: overrides.employmentType ?? 'full_time',
    salaries: overrides.salaries ?? [],
    classifications: overrides.classifications ?? [],
    listingUrls: overrides.listingUrls ?? ['https://example.test/jobs/1'],
    description: overrides.description ?? 'Build software.',
    responsibilities: overrides.responsibilities ?? [],
    requirements: overrides.requirements ?? [],
    desirableCriteria: overrides.desirableCriteria ?? [],
    applicationRequirements: overrides.applicationRequirements ?? [],
    selectionQuestions: overrides.selectionQuestions ?? [],
    licencesChecksRegistration: overrides.licencesChecksRegistration ?? [],
    verificationState: overrides.verificationState ?? 'unverified',
    lifecycleState: overrides.lifecycleState ?? 'discovered',
    flags: overrides.flags ?? [],
    confidence: overrides.confidence ?? 0.8,
    caveats: overrides.caveats ?? [],
    evidenceRefs: overrides.evidenceRefs ?? [],
    sourceListingIds: overrides.sourceListingIds ?? ['listing-1'],
    observationIds: overrides.observationIds ?? ['obs-1'],
    identityDecisionRevision: overrides.identityDecisionRevision ?? '1',
  });
}

function makeSubject(
  listingId: string,
  obsId: string,
  posting?: Record<string, unknown>,
): IdentitySubject {
  return {
    listing: makeListing({ sourceListingId: listingId, currentObservationId: obsId }),
    observation: makeObservation({
      observationId: obsId,
      sourceListingId: listingId,
      contentHash: `hash-${listingId}`,
    }),
    postingProjection: posting ? makePosting(posting) : makePosting(),
  };
}

function makeDecision(
  id: string,
  outcome: 'same_posting' | 'probable_cluster' | 'distinct' | 'unresolved' | 'split',
  opts: {
    obsIds?: string[];
    listingIds?: string[];
    supersededBy?: string;
  } = {},
): IdentityDecision {
  const fields: Record<string, unknown> = {
    decisionId: id,
    subjectObservationIds: opts.obsIds ?? ['o1', 'o2'],
    subjectListingIds: opts.listingIds ?? ['l1', 'l2'],
    outcome,
    confidence: 0.9,
    featureContributions: [],
    contradictoryEvidenceRefs: [],
    resolverVersion: IDENTITY_RESOLVER_VERSION,
    createdAt: instant,
  };
  if (opts.supersededBy !== undefined) {
    fields.supersededBy = opts.supersededBy;
  }
  return IdentityDecisionSchema.parse(fields);
}

// ─── Tests from Oracle A.7 ────────────────────────────────────────────────

test('company+title only → not same_posting and not probable_cluster', () => {
  const left = makeSubject('l1', 'o1', {
    organisation: 'Acme',
    normalizedTitle: 'engineer',
    locations: [{ country: 'AU', city: 'Sydney' }],
    salaries: [],
    description: 'A',
  });
  const right = makeSubject('l2', 'o2', {
    organisation: 'Acme',
    normalizedTitle: 'engineer',
    locations: [{ country: 'NZ', city: 'Wellington' }],
    salaries: [],
    description: 'B',
  });
  const lv = extractIdentityFeatures(left);
  const rv = extractIdentityFeatures(right);
  const score = scoreIdentityPair(lv, rv);
  assert.notEqual(score.proposedOutcome, 'same_posting');
  assert.notEqual(score.proposedOutcome, 'probable_cluster');
  assert.ok(
    score.proposedOutcome === 'distinct' || score.proposedOutcome === 'unresolved',
    `expected distinct or unresolved, got ${score.proposedOutcome}`,
  );
});

test('same adapter+externalId → same_posting', () => {
  const left = makeSubject('l1', 'o1', {
    organisation: 'Acme',
    normalizedTitle: 'engineer',
  });
  // Set adapter/external via parse to get branded types
  left.listing = SourceListingSchema.parse({
    sourceListingId: 'l1',
    adapterId: 'seek',
    externalId: 'ext-123',
    firstSeenAt: instant,
    lastSeenAt: instant,
    currentObservationId: 'o1',
  });
  const right = makeSubject('l2', 'o2', {
    organisation: 'Acme',
    normalizedTitle: 'engineer',
  });
  right.listing = SourceListingSchema.parse({
    sourceListingId: 'l2',
    adapterId: 'seek',
    externalId: 'ext-123',
    firstSeenAt: instant,
    lastSeenAt: instant,
    currentObservationId: 'o2',
  });
  const lv = extractIdentityFeatures(left);
  const rv = extractIdentityFeatures(right);
  const score = scoreIdentityPair(lv, rv);
  assert.equal(score.proposedOutcome, 'same_posting');
});

test('same content_hash success observations → same_posting', () => {
  const left = makeSubject('l1', 'o1', { organisation: 'X', normalizedTitle: 'y' });
  left.observation = makeObservation({ contentHash: 'hash-same', fetchOutcome: 'success' });
  const right = makeSubject('l2', 'o2', { organisation: 'X', normalizedTitle: 'y' });
  right.observation = makeObservation({
    observationId: 'o2',
    sourceListingId: 'l2',
    contentHash: 'hash-same',
    fetchOutcome: 'success',
  });
  const lv = extractIdentityFeatures(left);
  const rv = extractIdentityFeatures(right);
  const score = scoreIdentityPair(lv, rv);
  assert.equal(score.proposedOutcome, 'same_posting');
});

test('contradictory employer → not merge', () => {
  const left = makeSubject('l1', 'o1', {
    organisation: 'Acme',
    normalizedTitle: 'engineer',
    locations: [{ country: 'NZ', city: 'Wellington' }],
    salaries: [],
    description: 'A',
    claimResolutions: {
      employer: {
        state: 'conflicting',
        selected: {
          candidateId: 'c1',
          value: 'Acme',
          evidenceRefs: ['e1'],
          confidence: 0.8,
          origin: 'observed',
          method: 'test',
          provenance: { component: 'test', version: '1', producedAt: instant },
        },
        alternatives: [],
      },
    },
  });
  const right = makeSubject('l2', 'o2', {
    organisation: 'Acme',
    normalizedTitle: 'engineer',
    locations: [{ country: 'NZ', city: 'Wellington' }],
    salaries: [],
    description: 'B',
    claimResolutions: {
      employer: {
        state: 'conflicting',
        selected: {
          candidateId: 'c2',
          value: 'Acme',
          evidenceRefs: ['e2'],
          confidence: 0.8,
          origin: 'observed',
          method: 'test',
          provenance: { component: 'test', version: '1', producedAt: instant },
        },
        alternatives: [],
      },
    },
  });
  const lv = extractIdentityFeatures(left);
  const rv = extractIdentityFeatures(right);
  const score = scoreIdentityPair(lv, rv);
  assert.notEqual(score.proposedOutcome, 'same_posting');
});

test('merge then split restores two clusters; both observations remain in history', () => {
  const mergeDecision = makeDecision('d1', 'same_posting', {
    obsIds: ['o1', 'o2'],
    listingIds: ['l1', 'l2'],
  });
  const splitDecision = makeDecision('d2', 'split', {
    obsIds: ['o1', 'o2'],
    listingIds: ['l1', 'l2'],
  });
  const { prior: priorSuperseded } = supersedeDecision(mergeDecision, splitDecision);

  const group1 = makeDecision('d3', 'same_posting', { obsIds: ['o1'], listingIds: ['l1'] });
  const group2 = makeDecision('d4', 'same_posting', { obsIds: ['o2'], listingIds: ['l2'] });

  const history = [priorSuperseded, splitDecision, group1, group2];
  const clusters = clusterFromActiveDecisions(history);

  const samePostingClusters = clusters.filter((c) => c.kind === 'same_posting');
  assert.equal(samePostingClusters.length, 2);

  const allObsInHistory = history.flatMap((d) => d.subjectObservationIds);
  assert.ok(allObsInHistory.includes('o1' as SourceObservationId));
  assert.ok(allObsInHistory.includes('o2' as SourceObservationId));
});

test('missing location does not penalize (neutral prior, omitted feature)', () => {
  const left = makeSubject('l1', 'o1', { organisation: 'Acme', normalizedTitle: 'eng' });
  left.postingProjection = { ...makePosting(), locations: [] };
  const right = makeSubject('l2', 'o2', { organisation: 'Acme', normalizedTitle: 'eng' });
  right.postingProjection = {
    ...makePosting(),
    locations: [],
  };
  const lv = extractIdentityFeatures(left);
  const rv = extractIdentityFeatures(right);
  assert.ok(!('location_overlap' in lv.features));
  assert.ok(!('location_overlap' in rv.features));
  const score = scoreIdentityPair(lv, rv);
  assert.ok(score.confidence >= 0);
});

test('clusterFromActiveDecisions ignores superseded decisions', () => {
  const active = makeDecision('d1', 'same_posting', { obsIds: ['o1', 'o2'] });
  const superseded = makeDecision('d2', 'same_posting', {
    obsIds: ['o3', 'o4'],
    supersededBy: 'd3',
  });
  const clusters = clusterFromActiveDecisions([active, superseded]);
  const obsInClusters = clusters.flatMap((c) => c.memberObservationIds);
  assert.ok(obsInClusters.includes('o1' as SourceObservationId));
  assert.ok(obsInClusters.includes('o2' as SourceObservationId));
  assert.ok(!obsInClusters.includes('o3' as SourceObservationId));
  assert.ok(!obsInClusters.includes('o4' as SourceObservationId));
});

test('probable_cluster does not collapse posting ids', () => {
  const d = makeDecision('d1', 'probable_cluster', { obsIds: ['o1', 'o2'] });
  const clusters = clusterFromActiveDecisions([d]);
  assert.equal(clusters.length, 1);
  const first = clusters[0];
  assert.ok(first);
  assert.equal(first.kind, 'probable_cluster');
  assert.equal(first.memberObservationIds.length, 2);
});

// ─── Additional contract tests ─────────────────────────────────────────────

test('extractIdentityFeatures omits missing keys (ADR-007)', () => {
  const subject = makeSubject('l1', 'o1');
  subject.postingProjection = undefined as unknown as NonNullable<
    IdentitySubject['postingProjection']
  >;
  const fv = extractIdentityFeatures(subject);
  assert.ok('source_listing_id' in fv.features);
  assert.ok(!('apply_url' in fv.features));
  assert.ok(!('description_fingerprint' in fv.features));
  assert.ok(!('posted_at_proximity' in fv.features));
  assert.ok(!('location_overlap' in fv.features));
  assert.ok(!('salary_overlap' in fv.features));
  assert.ok(!('organisation_normalized' in fv.features));
  assert.ok(!('title_normalized' in fv.features));
});

test('scoreIdentityPair veto produces distinct or unresolved', () => {
  const left = makeSubject('l1', 'o1', {
    organisation: 'Acme',
    normalizedTitle: 'eng',
    locations: [{ country: 'NZ', city: 'Wellington' }],
    salaries: [],
    description: 'A',
    claimResolutions: {
      employer: {
        state: 'conflicting',
        selected: {
          candidateId: 'c1',
          value: 'A',
          evidenceRefs: ['e1'],
          confidence: 0.8,
          origin: 'observed',
          method: 'test',
          provenance: { component: 'test', version: '1', producedAt: instant },
        },
        alternatives: [],
      },
    },
  });
  const right = makeSubject('l2', 'o2', {
    organisation: 'Acme',
    normalizedTitle: 'eng',
    locations: [{ country: 'NZ', city: 'Wellington' }],
    salaries: [],
    description: 'B',
    claimResolutions: {
      employer: {
        state: 'conflicting',
        selected: {
          candidateId: 'c2',
          value: 'B',
          evidenceRefs: ['e2'],
          confidence: 0.8,
          origin: 'observed',
          method: 'test',
          provenance: { component: 'test', version: '1', producedAt: instant },
        },
        alternatives: [],
      },
    },
  });
  const lv = extractIdentityFeatures(left);
  const rv = extractIdentityFeatures(right);
  const score = scoreIdentityPair(lv, rv);
  assert.ok(
    score.proposedOutcome === 'distinct' || score.proposedOutcome === 'unresolved',
    `expected distinct/unresolved, got ${score.proposedOutcome}`,
  );
  assert.ok(score.confidence <= 0.95);
});

test('mergeSubjects refuses when only org+title fire', () => {
  const subjects = [
    makeSubject('l1', 'o1', { organisation: 'Acme', normalizedTitle: 'eng' }),
    makeSubject('l2', 'o2', { organisation: 'Acme', normalizedTitle: 'eng' }),
  ];
  assert.throws(
    () =>
      mergeSubjects(subjects, {
        now: instant,
        decisionId: 'd-test' as IdentityDecisionId,
        confidence: 0.5,
        contributions: [
          { feature: 'organisation_normalized', contribution: 0.05, evidenceRefs: [] },
          { feature: 'title_normalized', contribution: 0.05, evidenceRefs: [] },
        ],
        contradictoryEvidenceRefs: [],
      }),
    /MERGE_FORBIDDEN/,
  );
});

test('mergeSubjects refuses when veto contribution present', () => {
  const subjects = [
    makeSubject('l1', 'o1', { organisation: 'Acme', normalizedTitle: 'eng' }),
    makeSubject('l2', 'o2', { organisation: 'Acme', normalizedTitle: 'eng' }),
  ];
  assert.throws(
    () =>
      mergeSubjects(subjects, {
        now: instant,
        decisionId: 'd-test' as IdentityDecisionId,
        confidence: 0.5,
        contributions: [
          { feature: 'source_listing_id', contribution: 0.35, evidenceRefs: [] },
          { feature: 'contradictory_employer', contribution: -1.0, evidenceRefs: [] },
        ],
        contradictoryEvidenceRefs: [],
      }),
    /MERGE_FORBIDDEN/,
  );
});

test('mergeSubjects accepts when strong feature present and no veto', () => {
  const subjects = [
    makeSubject('l1', 'o1', { organisation: 'Acme', normalizedTitle: 'eng' }),
    makeSubject('l2', 'o2', { organisation: 'Acme', normalizedTitle: 'eng' }),
  ];
  const decision = mergeSubjects(subjects, {
    now: instant,
    decisionId: 'd-test' as IdentityDecisionId,
    confidence: 0.9,
    contributions: [{ feature: 'source_listing_id', contribution: 0.35, evidenceRefs: [] }],
    contradictoryEvidenceRefs: [],
  });
  assert.equal(decision.outcome, 'same_posting');
  assert.equal(decision.decisionId, 'd-test');
});

test('supersedeDecision sets prior.supersededBy', () => {
  const prior = makeDecision('d1', 'same_posting');
  const next = makeDecision('d2', 'split');
  const result = supersedeDecision(prior, next);
  assert.equal(result.prior.supersededBy, 'd2');
  assert.equal(result.next.supersededBy, undefined);
});

test('splitSubjects preserves prior subject set', () => {
  const prior = makeDecision('d1', 'same_posting', {
    obsIds: ['o1', 'o2'],
    listingIds: ['l1', 'l2'],
  });
  const split = splitSubjects(
    prior,
    [['o1' as SourceObservationId], ['o2' as SourceObservationId]],
    {
      now: instant,
      decisionId: 'd-split' as IdentityDecisionId,
    },
  );
  assert.equal(split.outcome, 'split');
  assert.deepEqual([...split.subjectObservationIds], ['o1', 'o2']);
});

test('activeDecisions filters superseded', () => {
  const d1 = makeDecision('d1', 'same_posting');
  const d2 = makeDecision('d2', 'split', { supersededBy: 'd3' });
  const d3 = makeDecision('d3', 'distinct');
  const active = activeDecisions([d1, d2, d3]);
  assert.equal(active.length, 2);
  assert.ok(active.some((d) => d.decisionId === 'd1'));
  assert.ok(active.some((d) => d.decisionId === 'd3'));
});

test('decisionLineage follows supersession chain', () => {
  const d1 = makeDecision('d1', 'same_posting');
  const d2 = makeDecision('d2', 'split');
  const { prior: d1Superseded } = supersedeDecision(d1, d2);
  const d3 = makeDecision('d3', 'same_posting');
  const { prior: d2Superseded } = supersedeDecision(d2, d3);

  const lineage = decisionLineage([d1Superseded, d2Superseded, d3], 'd3' as IdentityDecisionId);
  assert.equal(lineage.length, 3);
  const l0 = lineage[0];
  const l1 = lineage[1];
  const l2 = lineage[2];
  assert.ok(l0 && l1 && l2);
  assert.equal(l0.decisionId, 'd1');
  assert.equal(l1.decisionId, 'd2');
  assert.equal(l2.decisionId, 'd3');
});

test('clusterFromActiveDecisions same_posting merges via union-find', () => {
  const d1 = makeDecision('d1', 'same_posting', { obsIds: ['o1', 'o2'] });
  const d2 = makeDecision('d2', 'same_posting', { obsIds: ['o2', 'o3'] });
  const clusters = clusterFromActiveDecisions([d1, d2]);
  const samePosting = clusters.filter((c) => c.kind === 'same_posting');
  assert.equal(samePosting.length, 1);
  const sp = samePosting[0];
  assert.ok(sp);
  const obs = sp.memberObservationIds.sort();
  assert.deepEqual(obs, ['o1', 'o2', 'o3'] as SourceObservationId[]);
});

test('resolverVersion on new decisions is IDENTITY_RESOLVER_VERSION', () => {
  const subjects = [makeSubject('l1', 'o1'), makeSubject('l2', 'o2')];
  const decision = mergeSubjects(subjects, {
    now: instant,
    decisionId: 'd-test' as IdentityDecisionId,
    confidence: 0.9,
    contributions: [{ feature: 'source_listing_id', contribution: 0.35, evidenceRefs: [] }],
    contradictoryEvidenceRefs: [],
  });
  assert.equal(decision.resolverVersion, IDENTITY_RESOLVER_VERSION);
});

test('contract versions are frozen', () => {
  assert.equal(IDENTITY_CONTRACT_VERSION, '1.0.0');
  assert.equal(IDENTITY_RESOLVER_VERSION, 'identity-resolver/1.0.0');
});
