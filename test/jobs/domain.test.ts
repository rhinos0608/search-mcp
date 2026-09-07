import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ClaimCandidateSchema,
  ResolvedClaimSchema,
  resolveClaim,
} from '../../src/jobs/domain/claims.js';
import {
  createSourceObservation,
  SourceListingSchema,
  SourceObservationSchema,
} from '../../src/jobs/domain/source.js';
import { IdentityDecisionSchema } from '../../src/jobs/domain/identity.js';
import { JobPostingSchema } from '../../src/jobs/domain/posting.js';
import { LifecycleEventSchema, transitionLifecycle } from '../../src/jobs/domain/lifecycle.js';

const instant = '2026-01-01T00:00:00Z';
const candidate = (value: unknown, origin: 'observed' | 'model_derived', id: string) =>
  ClaimCandidateSchema.parse({
    candidateId: id,
    value,
    evidenceRefs: origin === 'observed' ? [`evidence-${id}`] : [],
    confidence: 0.8,
    origin,
    method: 'test',
    provenance: { component: 'test', version: '1', producedAt: instant },
  });

test('claims preserve explicit false and represent missing as unresolved', () => {
  const resolved = resolveClaim([candidate(false, 'observed', 'c1')]);
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.selected?.value, false);
  assert.equal(resolveClaim([]).state, 'unresolved');
});

test('observed claims without evidence are rejected', () => {
  assert.throws(() =>
    ClaimCandidateSchema.parse({
      ...candidate('source', 'model_derived', 'c0'),
      origin: 'observed',
      evidenceRefs: [],
    }),
  );
});

test('resolved claims enforce selected and unresolved invariants', () => {
  const selected = candidate('source', 'observed', 'c1');
  assert.equal(
    ResolvedClaimSchema.safeParse({ state: 'resolved', alternatives: [] }).success,
    false,
  );
  assert.equal(
    ResolvedClaimSchema.safeParse({ state: 'unresolved', alternatives: [], selected }).success,
    false,
  );
  assert.equal(
    ResolvedClaimSchema.safeParse({ state: 'resolved', selected, alternatives: [selected] })
      .success,
    true,
  );
});

test('claim equality ignores object key insertion order', () => {
  const resolved = resolveClaim([
    candidate({ x: 1, y: 2 }, 'observed', 'c1'),
    candidate({ y: 2, x: 1 }, 'model_derived', 'c2'),
  ]);
  assert.equal(resolved.state, 'resolved');
});

test('claim equality distinguishes Date, Map, and Set values', () => {
  const date = resolveClaim([
    candidate(new Date('2026-01-01T00:00:00Z'), 'observed', 'date-1'),
    candidate(new Date('2026-01-02T00:00:00Z'), 'model_derived', 'date-2'),
  ]);
  assert.equal(date.state, 'conflicting');

  const map = resolveClaim([
    candidate(new Map([['key', 1]]), 'observed', 'map-1'),
    candidate(new Map([['key', 2]]), 'model_derived', 'map-2'),
  ]);
  assert.equal(map.state, 'conflicting');

  const set = resolveClaim([
    candidate(new Set(['one']), 'observed', 'set-1'),
    candidate(new Set(['two']), 'model_derived', 'set-2'),
  ]);
  assert.equal(set.state, 'conflicting');
});

test('conflicting alternatives stay visible and observed value wins model proposal', () => {
  const resolved = resolveClaim([
    candidate('source', 'observed', 'c1'),
    candidate('guess', 'model_derived', 'c2'),
  ]);
  assert.equal(resolved.state, 'conflicting');
  assert.equal(resolved.selected?.value, 'source');
  assert.equal(resolved.alternatives.length, 2);
});

test('listing lifecycle is mutable while observation schema excludes lifecycle timestamps', () => {
  const listing = SourceListingSchema.parse({
    sourceListingId: 'listing-1',
    adapterId: 'adapter-1',
    firstSeenAt: instant,
    lastSeenAt: instant,
    currentObservationId: 'obs-1',
  });
  assert.equal(listing.lastSeenAt, instant);
  assert.throws(() =>
    SourceObservationSchema.parse({
      observationId: 'obs-1',
      sourceListingId: 'listing-1',
      fetchedAt: instant,
      contentHash: 'hash',
      evidenceRefs: [],
      extractionVersion: '1',
      adapterVersion: '1',
      fetchOutcome: 'success',
      sourceConfidence: {},
      immutable: false,
    }),
  );
  assert.throws(() =>
    SourceObservationSchema.parse({
      observationId: 'obs-1',
      sourceListingId: 'listing-1',
      fetchedAt: instant,
      firstSeenAt: instant,
      contentHash: 'hash',
      evidenceRefs: [],
      extractionVersion: '1',
      adapterVersion: '1',
      fetchOutcome: 'success',
      sourceConfidence: {},
      immutable: true,
    }),
  );
});

test('requirement years rejects unknown keys', () => {
  assert.equal(
    JobPostingSchema.safeParse({
      postingId: 'post-1',
      schemaVersion: '1',
      canonicalRevision: 1,
      title: 'Analyst',
      normalizedTitle: 'analyst',
      organisation: 'Example',
      roleFamilies: [],
      locations: [{ country: 'NZ' }],
      workMode: 'hybrid',
      employmentType: 'full_time',
      salaries: [],
      classifications: [],
      listingUrls: ['https://example.test/jobs/1'],
      description: 'Description',
      responsibilities: [],
      requirements: [
        {
          rawText: 'Two years',
          category: 'experience',
          force: 'mandatory',
          years: { min: 2, unit: 'year', unexpected: true },
          evidenceRefs: [],
          confidence: 0.8,
          interpretationProvenance: 'test',
        },
      ],
      desirableCriteria: [],
      applicationRequirements: [],
      selectionQuestions: [],
      licencesChecksRegistration: [],
      verificationState: 'unverified',
      lifecycleState: 'discovered',
      flags: [],
      confidence: 0.5,
      caveats: [],
      evidenceRefs: [],
      sourceListingIds: ['listing-1'],
      observationIds: ['obs-1'],
      identityDecisionRevision: '1',
    }).success,
    false,
  );
});

test('canonical posting supports multiple locations and salary intervals without locale assumptions', () => {
  const posting = JobPostingSchema.parse({
    postingId: 'post-1',
    schemaVersion: '1',
    canonicalRevision: 1,
    title: 'Analyst',
    normalizedTitle: 'analyst',
    organisation: 'Example',
    roleFamilies: [],
    locations: [
      { country: 'NZ', city: 'Wellington' },
      { country: 'CA', city: 'Toronto' },
    ],
    workMode: 'hybrid',
    employmentType: 'full_time',
    salaries: [
      { min: 10, max: 20, currency: 'CAD', unit: 'hour', raw: '$10-$20' },
      { min: 50000, currency: 'NZD', unit: 'year', raw: '$50k' },
    ],
    classifications: [],
    listingUrls: ['https://example.test/jobs/1'],
    description: 'Description',
    responsibilities: [],
    requirements: [],
    desirableCriteria: [],
    applicationRequirements: [],
    selectionQuestions: [],
    licencesChecksRegistration: [],
    verificationState: 'unverified',
    lifecycleState: 'discovered',
    flags: [],
    confidence: 0.5,
    caveats: [],
    evidenceRefs: [],
    fieldEvidenceLinks: [{ fieldPath: 'title', evidenceRefs: ['e-title'] }],
    claimResolutions: {
      title: {
        state: 'resolved',
        selected: candidate('Analyst', 'observed', 'c-title'),
        alternatives: [],
      },
    },
    sourceListingIds: ['listing-1'],
    observationIds: ['obs-1'],
    identityDecisionRevision: '1',
  });
  assert.equal(posting.locations.length, 2);
  assert.equal(posting.salaries.length, 2);
});

test('observation parse freezes runtime data', () => {
  const observation = SourceObservationSchema.parse({
    observationId: 'obs-frozen',
    sourceListingId: 'listing-1',
    fetchedAt: instant,
    contentHash: 'hash',
    evidenceRefs: ['e1'],
    extractionVersion: '1',
    adapterVersion: '1',
    fetchOutcome: 'success',
    sourceConfidence: { overall: 0.8 },
    immutable: true,
  });
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.evidenceRefs), true);
  assert.throws(() => ((observation as { immutable: boolean }).immutable = false));
  assert.throws(() =>
    observation.evidenceRefs.push('e2' as (typeof observation.evidenceRefs)[number]),
  );
});

test('lifecycle transition guard rejects impossible closure and accepts repost', () => {
  assert.equal(transitionLifecycle('discovered', 'active'), 'active');
  assert.throws(() => transitionLifecycle('active', 'confirmed_closed'));
  const event = {
    eventId: 'e1',
    postingId: 'post-1',
    type: 'observed' as const,
    occurredAt: instant,
    evidenceRefs: [],
    source: 'test',
  };
  assert.equal(LifecycleEventSchema.safeParse({ ...event, toState: 'active' }).success, true);
  assert.equal(LifecycleEventSchema.safeParse({ ...event, toState: 'discovered' }).success, false);
  assert.throws(() =>
    LifecycleEventSchema.parse({
      eventId: 'e1',
      postingId: 'post-1',
      type: 'observed',
      occurredAt: instant,
      fromState: 'discovered',
      toState: 'confirmed_closed',
      evidenceRefs: [],
      source: 'test',
    }),
  );
  assert.equal(
    LifecycleEventSchema.safeParse({
      eventId: 'e2',
      postingId: 'post-1',
      type: 'disappeared',
      occurredAt: instant,
      fromState: 'probably_closed',
      toState: 'confirmed_closed',
      evidenceRefs: ['e-closure'],
      source: 'test',
    }).success,
    false,
  );
  assert.equal(
    LifecycleEventSchema.safeParse({
      eventId: 'e3',
      postingId: 'post-1',
      type: 'verified',
      occurredAt: instant,
      fromState: 'probably_closed',
      toState: 'confirmed_closed',
      evidenceRefs: ['e-closure'],
      source: 'test',
    }).success,
    true,
  );
});

test('identity decisions represent reversible merge/split through supersession', () => {
  const first = IdentityDecisionSchema.parse({
    decisionId: 'd1',
    subjectObservationIds: ['o1', 'o2'],
    subjectListingIds: ['l1', 'l2'],
    outcome: 'same_posting',
    confidence: 0.9,
    featureContributions: [],
    contradictoryEvidenceRefs: [],
    resolverVersion: '1',
    createdAt: instant,
    supersededBy: 'd2',
  });
  const second = IdentityDecisionSchema.parse({
    decisionId: 'd2',
    subjectObservationIds: ['o1', 'o2'],
    subjectListingIds: ['l1', 'l2'],
    outcome: 'split',
    confidence: 0.95,
    featureContributions: [],
    contradictoryEvidenceRefs: [],
    resolverVersion: '2',
    createdAt: instant,
  });
  assert.equal(first.supersededBy, second.decisionId);
  assert.equal(second.outcome, 'split');
});

function hostile33(): { arr: string[]; accessed: { value: boolean } } {
  const arr = Array.from({ length: 33 }, (_, i) => `ev-${i}`) as string[];
  const accessed = { value: false };
  Object.defineProperty(arr, '0', {
    configurable: true,
    enumerable: true,
    get() {
      accessed.value = true;
      throw new Error('trap access');
    },
  });
  return { arr, accessed };
}

function baseObservation(overrides: Record<string, unknown> = {}) {
  return {
    observationId: 'obs-1',
    sourceListingId: 'listing-1',
    fetchedAt: instant,
    contentHash: 'hash-1',
    evidenceRefs: ['ev-1'],
    extractionVersion: '1',
    adapterVersion: '1',
    fetchOutcome: 'success' as const,
    sourceConfidence: {},
    immutable: true as const,
    ...overrides,
  };
}

test('SourceObservationSchema safeParse short-circuits hostile >32 evidenceRefs without traversing', () => {
  const { arr, accessed } = hostile33();
  const res = SourceObservationSchema.safeParse(baseObservation({ evidenceRefs: arr }));
  assert.equal(res.success, false);
  assert.equal(accessed.value, false);
});

test('SourceObservationSchema parse throws ZodError without raw trap and without traversing hostile', () => {
  const { arr, accessed } = hostile33();
  assert.throws(
    () => SourceObservationSchema.parse(baseObservation({ evidenceRefs: arr })),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal((e as Error).message.includes('trap'), false);
      return true;
    },
  );
  assert.equal(accessed.value, false);
});

test('createSourceObservation delegates to parse and short-circuits hostile', () => {
  const { arr, accessed } = hostile33();
  assert.throws(() => createSourceObservation(baseObservation({ evidenceRefs: arr })));
  assert.equal(accessed.value, false);
});

test('canonical branded ids preserve whitespace and enforce max256 without trimming', () => {
  const withSpaces = baseObservation({ observationId: ' obs-1 ', sourceListingId: ' listing-1 ' });
  const parsed = SourceObservationSchema.parse(withSpaces);
  assert.equal(parsed.observationId, ' obs-1 ');
  assert.equal(parsed.sourceListingId, ' listing-1 ');
  const tooLong = 'x'.repeat(257);
  assert.equal(
    SourceObservationSchema.safeParse(baseObservation({ observationId: tooLong })).success,
    false,
  );
  assert.equal(
    SourceObservationSchema.safeParse(baseObservation({ evidenceRefs: ['x'.repeat(257)] })).success,
    false,
  );
});

test('externalId/payload/versions keep max bounds without new trim', () => {
  const parsedListing = SourceListingSchema.parse({
    sourceListingId: ' listing-1 ',
    adapterId: ' adapter-1 ',
    externalId: ' ext-1 ',
    firstSeenAt: instant,
    lastSeenAt: instant,
    currentObservationId: ' obs-1 ',
  });
  assert.equal(parsedListing.sourceListingId, ' listing-1 ');
  assert.equal(parsedListing.externalId, ' ext-1 ');
  assert.equal(
    SourceListingSchema.safeParse({ ...parsedListing, externalId: 'x'.repeat(257) }).success,
    false,
  );
  assert.equal(
    SourceObservationSchema.safeParse(baseObservation({ payloadRef: 'x'.repeat(8193) })).success,
    false,
  );
  assert.equal(
    SourceObservationSchema.safeParse(baseObservation({ extractionVersion: 'x'.repeat(257) }))
      .success,
    false,
  );
});

function hostileEvidenceRefsWithTrap(length: number): string[] {
  const arr = Array.from({ length }, (_, i) => `ev-${i}`) as string[];
  Object.defineProperty(arr, '0', {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error('trap access');
    },
  });
  return arr;
}

test('SourceObservationSchema safeParse never throws for hostile length-1 evidenceRefs getter', () => {
  const hostile = hostileEvidenceRefsWithTrap(1);
  let threw = false;
  let res: ReturnType<typeof SourceObservationSchema.safeParse> | undefined;
  try {
    res = SourceObservationSchema.safeParse(
      baseObservation({ evidenceRefs: hostile as unknown as string[] }),
    );
  } catch (e) {
    threw = true;
    assert.equal((e as Error).message.includes('trap'), false);
  }
  assert.equal(threw, false);
  assert.equal(res?.success, false);
  if (res && !res.success) {
    const msg = JSON.stringify(res.error.issues);
    assert.equal(msg.includes('trap'), false);
  }
});

test('SourceObservationSchema parse throws ZodError not attacker error for hostile length-1', () => {
  const hostile = hostileEvidenceRefsWithTrap(1);
  assert.throws(
    () =>
      SourceObservationSchema.parse(
        baseObservation({ evidenceRefs: hostile as unknown as string[] }),
      ),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.constructor.name, 'ZodError');
      assert.equal((e as Error).message.includes('trap'), false);
      return true;
    },
  );
});

test('SourceObservationSchema safeParse never throws for hostile sourceConfidence getter', () => {
  const sc = {} as Record<string, number>;
  Object.defineProperty(sc, 'k0', {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error('trap sc');
    },
  });
  // also trap via proxy has trap on evidenceRefs length? Use proxy for sourceConfidence property access
  const obs: Record<string, unknown> = {
    ...baseObservation(),
    sourceConfidence: new Proxy(sc, {
      get(target, prop, receiver) {
        if (prop === 'test') throw new Error('trap proxy');
        return Reflect.get(target, prop, receiver);
      },
      ownKeys() {
        throw new Error('trap ownKeys');
      },
    }),
  };
  let threw = false;
  let res: ReturnType<typeof SourceObservationSchema.safeParse> | undefined;
  try {
    res = SourceObservationSchema.safeParse(obs);
  } catch (_e) {
    threw = true;
  }
  assert.equal(threw, false);
  assert.equal(res?.success, false);
  if (res && !res.success) assert.equal(JSON.stringify(res.error.issues).includes('trap'), false);
});

test('SourceObservationSchema safeParse never throws for hostile sourceConfidence getter/proxy direct', () => {
  const scProxy = new Proxy({ a: 0.5 } as Record<string, unknown>, {
    get(_t, p) {
      if (p === 'a') throw new Error('trap get');
      return undefined;
    },
    ownKeys() {
      throw new Error('trap ownKeys 2');
    },
  });
  const obs = baseObservation({ sourceConfidence: scProxy as unknown as Record<string, number> });
  let threw = false;
  let res: ReturnType<typeof SourceObservationSchema.safeParse> | undefined;
  try {
    res = SourceObservationSchema.safeParse(obs as unknown as object);
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  assert.equal(res?.success, false);
  if (res && !res.success) assert.equal(JSON.stringify(res.error.issues).includes('trap'), false);
});

test('SourceObservationSchema preserves >32 short circuit without traversing getter', () => {
  const hostile = hostileEvidenceRefsWithTrap(33);
  let accessed = false;
  // override getter to track
  Object.defineProperty(hostile, '0', {
    configurable: true,
    enumerable: true,
    get() {
      accessed = true;
      throw new Error('trap');
    },
  });
  const res = SourceObservationSchema.safeParse(
    baseObservation({ evidenceRefs: hostile as unknown as string[] }),
  );
  assert.equal(res.success, false);
  assert.equal(accessed, false);
  if (!res.success) assert.equal(JSON.stringify(res.error.issues).includes('trap'), false);
});
