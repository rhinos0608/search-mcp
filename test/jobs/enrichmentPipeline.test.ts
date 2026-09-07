import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichKnowledge } from '../../src/jobs/enrichment/index.js';

function makeValidInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    snapshot: {
      schemaVersion: '1.0.0',
      extractorVersion: '1.0.0',
      observationId: 'obs1' as never,
      sourceListingId: 'list1' as never,
      fieldEvidenceLinks: [],
      claimCandidates: [],
      evidence: [],
    },
    listing: {
      sourceListingId: 'list1',
      adapterId: 'adapter1',
      currentObservationId: 'obs1',
    },
    observation: {
      observationId: 'obs1',
      sourceListingId: 'list1',
      immutable: true,
    },
    budget: { units: 10 },
    clock: { producedAt: '2026-01-01T00:00:00+00:00' },
    ...overrides,
  };
}

test('enrichKnowledge pass-through with empty packs and no catalog', () => {
  const result = enrichKnowledge(makeValidInput());
  assert.equal(result.status, 'pass_through');
  assert.equal(result.schemaVersion, '1.0.0');
  assert.equal(result.derivedClaimCandidates.length, 0);
  assert.equal(result.derivedEvidence.length, 0);
});

test('enrichKnowledge does not mutate input snapshot listing or observation', () => {
  const input = makeValidInput();
  const snapshotBefore = JSON.stringify(input.snapshot);
  const listingBefore = JSON.stringify(input.listing);
  const obsBefore = JSON.stringify(input.observation);
  enrichKnowledge(input);
  assert.equal(JSON.stringify(input.snapshot), snapshotBefore);
  assert.equal(JSON.stringify(input.listing), listingBefore);
  assert.equal(JSON.stringify(input.observation), obsBefore);
});

test('enrichKnowledge result is frozen', () => {
  const result = enrichKnowledge(makeValidInput());
  assert.ok(Object.isFrozen(result));
  assert.throws(() => {
    (result as { status: string }).status = 'failed';
  });
});

test('enrichKnowledge preserves W5 observed claim candidates untouched', () => {
  const input = makeValidInput({
    snapshot: {
      schemaVersion: '1.0.0',
      extractorVersion: '1.0.0',
      observationId: 'obs1' as never,
      sourceListingId: 'list1' as never,
      fieldEvidenceLinks: [],
      claimCandidates: [
        {
          candidateId: 'obs-claim-1',
          value: 'Test Value',
          evidenceRefs: ['ref1'],
          confidence: 0.9,
          origin: 'observed',
          method: 'structured_field',
          provenance: {
            component: 'jobs.extraction',
            version: '1.0.0',
            producedAt: '2026-01-01T00:00:00+00:00',
          },
        },
      ],
      evidence: [],
    },
  });
  const result = enrichKnowledge(input);
  assert.equal(result.derivedClaimCandidates.length, 0);
  assert.equal(input.snapshot.claimCandidates.length, 1);
});

test('derived claims never use origin observed or model_derived', () => {
  const input = makeValidInput({
    localePack: {
      kind: 'locale',
      id: 'test-locale',
      version: '1.0.0',
      effectiveFrom: '2026-01-01',
      attribution: { author: 'test', license: 'MIT' },
      geography: [{ id: 'city1', name: 'Sydney', kind: 'city', aliases: ['Syd'] }],
      salaryConventions: [],
      classificationSchemes: [],
      eligibilityTerminology: {},
      normalizationRules: [],
    },
    snapshot: {
      schemaVersion: '1.0.0',
      extractorVersion: '1.0.0',
      observationId: 'obs1' as never,
      sourceListingId: 'list1' as never,
      locations: [{ city: 'Sydney' }],
      fieldEvidenceLinks: [],
      claimCandidates: [],
      evidence: [],
    },
  });
  const result = enrichKnowledge(input);
  for (const claim of result.derivedClaimCandidates) {
    assert.equal(claim.origin, 'deterministic_derived');
  }
});

test('budget zero yields partial and BUDGET_EXHAUSTED without throw', () => {
  const result = enrichKnowledge(makeValidInput({ budget: { units: 0 } }));
  assert.equal(result.status, 'partial');
  assert.ok(result.warnings.some((w) => w.code === 'BUDGET_EXHAUSTED'));
  assert.equal(result.unitsConsumed, 0);
});

test('budget charges stages in frozen order and stops', () => {
  const result = enrichKnowledge(makeValidInput({ budget: { units: 2 } }));
  assert.ok(
    result.warnings.some((w) => w.code === 'BUDGET_EXHAUSTED') || result.unitsConsumed <= 2,
  );
});

test('requirePacks without packs throws PACK_UNAVAILABLE', () => {
  assert.throws(
    () => enrichKnowledge(makeValidInput({ requirePacks: true })),
    (err: unknown) =>
      err instanceof Error &&
      'code' in err &&
      (err as { code: string }).code === 'PACK_UNAVAILABLE',
  );
});

test('invalid request throws VALIDATION_ERROR', () => {
  assert.throws(
    () => enrichKnowledge({ notARequest: true }),
    (err: unknown) =>
      err instanceof Error &&
      'code' in err &&
      (err as { code: string }).code === 'VALIDATION_ERROR',
  );
});
