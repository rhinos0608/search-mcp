import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createJobsStore } from '../../src/jobs/persistence/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const tmpDirs: string[] = [];

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-hydration-test-'));
  tmpDirs.push(dir);
  const db = new Database(join(dir, 'jobs.sqlite'));
  db.pragma('foreign_keys = ON');
  return createJobsStore(db);
}

function makePosting(overrides?: Record<string, unknown>) {
  return {
    postingId: 'posting-hyd',
    schemaVersion: 'posting/1',
    canonicalRevision: 0,
    title: 'Software Engineer',
    normalizedTitle: 'software engineer',
    organisation: 'Acme Corp',
    roleFamilies: [{ family: 'engineering', confidence: 0.8, evidenceRefs: [] }],
    locations: [{ city: 'Melbourne', country: 'AU' }],
    workMode: 'hybrid',
    employmentType: 'full_time',
    salaries: [],
    classifications: [],
    listingUrls: ['https://example.com/job/1'],
    description: 'Build things.',
    responsibilities: [],
    requirements: [],
    desirableCriteria: [],
    applicationRequirements: [],
    selectionQuestions: [],
    licencesChecksRegistration: [],
    flags: [],
    confidence: 0.9,
    caveats: [],
    evidenceRefs: [],
    sourceListingIds: ['listing-1'],
    observationIds: ['obs-1'],
    identityDecisionRevision: 'dec-1',
    verificationState: 'unverified',
    lifecycleState: 'active',
    ...overrides,
  } as Any;
}

test('contact metadata persists as bounded nullable JSON and replacement clears it', () => {
  const store = freshStore();
  assert.equal(store.schemaVersion, 2);
  store.putPostingProjection(makePosting({ contactMetadata: {} }));
  assert.deepEqual((store.getPosting('posting-hyd') as Any).contactMetadata, {});
  store.putPostingProjection(makePosting({ contactMetadata: { email: 'jobs@example.test' } }));
  assert.deepEqual((store.getPosting('posting-hyd') as Any).contactMetadata, {
    email: 'jobs@example.test',
  });
  store.putPostingProjection(makePosting());
  assert.equal((store.getPosting('posting-hyd') as Any).contactMetadata, undefined);
});

test('malformed contact metadata fails with sanitized schema error', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting());
  store.db
    .prepare('UPDATE postings SET contact_metadata = ? WHERE posting_id = ?')
    .run('{bad', 'posting-hyd');
  assert.throws(
    () => store.getPosting('posting-hyd'),
    (error: Any) =>
      error.code === 'SCHEMA_INCOMPATIBLE' && error.message === 'invalid contact metadata',
  );
});

test('RED: posting locations survive put/get round-trip', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting());
  store.putLocations('posting-hyd', [{ city: 'Melbourne', country: 'AU' }]);
  const got = store.getPosting('posting-hyd') as Any;
  assert.ok(got, 'posting must exist');
  assert.deepEqual(
    got.locations,
    [{ city: 'Melbourne', country: 'AU' }],
    'locations must hydrate from locations table',
  );
});

test('putRequirements failure leaves prior rows intact (atomic replace)', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting({ postingId: 'posting-atomic' }));
  store.putRequirements('posting-atomic', [
    {
      rawText: 'Must know TypeScript',
      category: 'skill',
      force: 'mandatory',
      evidenceRefs: [],
      confidence: 0.9,
      interpretationProvenance: 'test',
    },
  ]);
  assert.throws(
    () =>
      store.putRequirements('posting-atomic', [
        {
          rawText: 'Good row',
          category: 'skill',
          force: 'mandatory',
          evidenceRefs: [],
          confidence: 0.9,
          interpretationProvenance: 'test',
        } as Any,
        // missing rawText violates NOT NULL -> whole replace rolls back
        { category: 'skill', force: 'mandatory', evidenceRefs: [], confidence: 0.9 } as Any,
      ]),
    /NOT NULL constraint failed: requirements\.raw_text/,
  );
  const got = store.getPosting('posting-atomic') as Any;
  assert.equal(got.requirements.length, 1);
  assert.equal(got.requirements[0].rawText, 'Must know TypeScript');
});

test('RED: posting requirements survive put/get round-trip', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting({ postingId: 'posting-req' }));
  store.putRequirements('posting-req', [
    {
      rawText: 'Must know TypeScript',
      category: 'skill',
      force: 'mandatory',
      evidenceRefs: [],
      confidence: 0.9,
      interpretationProvenance: 'test',
    },
  ]);
  const got = store.getPosting('posting-req') as Any;
  assert.ok(got, 'posting must exist');
  assert.equal(got.requirements.length, 1, 'requirements must hydrate from requirements table');
  assert.equal(got.requirements[0].rawText, 'Must know TypeScript');
});

test('posting membership and evidence provenance survive put/get round-trip', () => {
  const store = freshStore();
  store.upsertListing({
    sourceListingId: 'listing-1',
    adapterId: 'adapter-a',
    firstSeenAt: '2025-01-01T00:00:00+00:00',
    lastSeenAt: '2025-01-01T00:00:00+00:00',
    currentObservationId: 'obs-1',
  } as Any);
  store.insertObservation({
    observationId: 'obs-1',
    sourceListingId: 'listing-1',
    fetchedAt: '2025-01-01T00:00:00+00:00',
    contentHash: 'hash-abc',
    evidenceRefs: [],
    extractionVersion: 'extraction/1',
    adapterVersion: 'adapter/1',
    fetchOutcome: 'success',
    sourceConfidence: { source: 0.9 },
    immutable: true,
  } as Any);
  store.putPostingProjection(makePosting({ postingId: 'posting-links' }));
  store.putEvidence([
    {
      evidenceId: 'ev-1',
      subjectType: 'posting',
      subjectId: 'posting-links',
      fieldPath: 'title',
      kind: 'structured_field',
      observationId: 'obs-1',
      capturedAt: '2025-01-01T00:00:00+00:00',
      confidence: 0.9,
      retentionClass: 'short',
    } as Any,
  ]);
  store.db
    .prepare(
      'INSERT INTO posting_field_evidence (posting_id, field_path, evidence_id) VALUES (?, ?, ?)',
    )
    .run('posting-links', 'title', 'ev-1');
  store.appendIdentityDecision({
    decisionId: 'dec-links',
    subjectObservationIds: ['obs-1'],
    subjectListingIds: ['listing-1'],
    outcome: 'same_posting',
    confidence: 0.9,
    featureContributions: [{ feature: 'canonical_url', contribution: 1, evidenceRefs: [] }],
    contradictoryEvidenceRefs: [],
    resolverVersion: 'identity-resolver/1.0.0',
    createdAt: '2025-01-01T00:00:00+00:00',
  } as Any);
  store.setMemberships('posting-links', ['listing-1'], 'dec-links');
  const got = store.getPosting('posting-links') as Any;
  assert.deepEqual(got.sourceListingIds, ['listing-1']);
  assert.deepEqual(got.observationIds, ['obs-1']);
  assert.deepEqual(got.evidenceRefs, ['ev-1']);
});

test('RED: identity decision relations survive append/list round-trip', () => {
  const store = freshStore();
  store.upsertListing({
    sourceListingId: 'listing-1',
    adapterId: 'adapter-a',
    firstSeenAt: '2025-01-01T00:00:00+00:00',
    lastSeenAt: '2025-01-01T00:00:00+00:00',
    currentObservationId: 'obs-1',
  } as Any);
  store.insertObservation({
    observationId: 'obs-1',
    sourceListingId: 'listing-1',
    fetchedAt: '2025-01-01T00:00:00+00:00',
    contentHash: 'hash-abc',
    evidenceRefs: [],
    extractionVersion: 'extraction/1',
    adapterVersion: 'adapter/1',
    fetchOutcome: 'success',
    sourceConfidence: { source: 0.9 },
    immutable: true,
  } as Any);
  store.appendIdentityDecision({
    decisionId: 'dec-hyd',
    subjectObservationIds: ['obs-1'],
    subjectListingIds: ['listing-1'],
    outcome: 'same_posting',
    confidence: 0.9,
    featureContributions: [{ feature: 'canonical_url', contribution: 1, evidenceRefs: [] }],
    contradictoryEvidenceRefs: [],
    resolverVersion: 'identity-resolver/1.0.0',
    createdAt: '2025-01-01T00:00:00+00:00',
  } as Any);
  const active = store.listActiveIdentityDecisions() as Any[];
  assert.equal(active.length, 1);
  assert.deepEqual(active[0].subjectObservationIds, ['obs-1']);
  assert.deepEqual(active[0].subjectListingIds, ['listing-1']);
  assert.equal(active[0].featureContributions.length, 1);
});

process.on('exit', () => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
