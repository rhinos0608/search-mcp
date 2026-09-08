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
  const dir = mkdtempSync(join(tmpdir(), 'jobs-txn-atomic-'));
  tmpDirs.push(dir);
  const db = new Database(join(dir, 'jobs.sqlite'));
  db.pragma('foreign_keys = ON');
  return createJobsStore(db);
}

function makePosting(postingId: string, overrides: Record<string, unknown> = {}) {
  return {
    postingId,
    schemaVersion: 'posting/1',
    canonicalRevision: 0,
    title: 'Software Engineer',
    normalizedTitle: 'software engineer',
    organisation: 'Acme Corp',
    roleFamilies: [],
    locations: [],
    workMode: 'hybrid',
    employmentType: 'full_time',
    salaries: [],
    classifications: [],
    listingUrls: [],
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
    sourceListingIds: [],
    observationIds: [],
    identityDecisionRevision: 'dec-1',
    verificationState: 'unverified',
    lifecycleState: 'active',
    ...overrides,
  } as Any;
}

function seedListingObservation(store: ReturnType<typeof freshStore>) {
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
}

function decision(id: string, overrides: Record<string, unknown> = {}) {
  return {
    decisionId: id,
    subjectObservationIds: ['obs-1'],
    subjectListingIds: ['listing-1'],
    outcome: 'same_posting',
    confidence: 0.9,
    featureContributions: [{ feature: 'canonical_url', contribution: 1, evidenceRefs: [] }],
    contradictoryEvidenceRefs: [],
    resolverVersion: 'identity-resolver/1.0.0',
    createdAt: '2025-01-01T00:00:00+00:00',
    ...overrides,
  } as Any;
}

// --- Oracle: membership rollback ---

test('setMemberships failure rolls back prior membership rows', () => {
  const store = freshStore();
  seedListingObservation(store);
  store.putPostingProjection(makePosting('posting-m'));
  store.appendIdentityDecision(decision('dec-1'));
  store.setMemberships('posting-m', ['listing-1'], 'dec-1');
  // listing-2 violates FK -> whole replace fails, prior row survives
  assert.throws(() => store.setMemberships('posting-m', ['listing-1', 'listing-missing'], 'dec-1'));
  const got = store.getPosting('posting-m') as Any;
  assert.deepEqual(got.sourceListingIds, ['listing-1']);
});

// --- Oracle: lifecycle late rollback ---

test('appendLifecycleEvent late duplicate failure rolls back (no strand, no state move)', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting('posting-lc'));
  store.putEvidence([
    {
      evidenceId: 'ev-1',
      subjectType: 'posting',
      subjectId: 'posting-lc',
      kind: 'structured_field',
      capturedAt: '2025-01-01T00:00:00+00:00',
      confidence: 0.9,
      retentionClass: 'short',
    } as Any,
  ]);
  store.appendLifecycleEvent({
    eventId: 'lc-good',
    postingId: 'posting-lc',
    type: 'observed',
    occurredAt: '2025-01-01T00:00:00+00:00',
    fromState: 'active',
    toState: 'probably_closed',
    evidenceRefs: ['ev-1'],
    source: 'test',
  } as Any);
  // Late failure AFTER event row + evidence links are staged: duplicate
  // event_id PK aborts after the INSERT, so the state flip must roll back too.
  assert.throws(() =>
    store.appendLifecycleEvent({
      eventId: 'lc-good',
      postingId: 'posting-lc',
      type: 'observed',
      occurredAt: '2025-01-02T00:00:00+00:00',
      fromState: 'probably_closed',
      toState: 'confirmed_closed',
      evidenceRefs: [],
      source: 'test',
    } as Any),
  );
  const history = store.getLifecycleHistory('posting-lc') as Any[];
  assert.equal(history.length, 1, 'duplicate event_id must not add a second row');
  assert.equal(history[0].eventId, 'lc-good');
  const got = store.getPosting('posting-lc') as Any;
  assert.equal(got.lifecycleState, 'probably_closed', 'failed duplicate must not move state');
});

// --- Oracle: cluster rebuild rollback ---

test('putIdentityClusterProjection failure keeps prior projection', () => {
  const store = freshStore();
  store.putIdentityClusterProjection([
    {
      clusterId: 'c1',
      kind: 'same_posting',
      revision: 'r1',
      postingId: null,
      members: [],
      decisionIds: [],
    } as Any,
  ]);
  assert.throws(() =>
    store.putIdentityClusterProjection([
      // bad kind violates CHECK after the wipe -> whole rebuild rolls back
      { clusterId: 'c2', kind: 'bogus-kind', revision: 'r2', members: [], decisionIds: [] } as Any,
    ]),
  );
  const rows = store.db.prepare('SELECT cluster_id FROM identity_clusters').all() as {
    cluster_id: string;
  }[];
  assert.deepEqual(
    rows.map((r) => r.cluster_id),
    ['c1'],
  );
});

// --- Oracle: supersession rollback + missing/already-superseded ---

test('supersede failure rolls back next-row insert', () => {
  const store = freshStore();
  seedListingObservation(store);
  store.appendIdentityDecision(decision('dec-1'));
  // prior-missing: conditional UPDATE hits 0 rows -> next row must roll back
  assert.throws(() => store.supersedeIdentityDecision('dec-missing', decision('dec-2')));
  const ids = (store.listActiveIdentityDecisions() as Any[]).map((d) => d.decisionId);
  assert.deepEqual(ids, ['dec-1'], 'failed supersession must not persist next row');
});

test('supersede missing prior throws validation error', () => {
  const store = freshStore();
  seedListingObservation(store);
  store.appendIdentityDecision(decision('dec-1'));
  assert.throws(
    () => store.supersedeIdentityDecision('dec-missing', decision('dec-2')),
    (err: Error) => {
      assert.equal((err as Any).code, 'VALIDATION_ERROR');
      return true;
    },
  );
});

test('supersede already-superseded prior throws validation error', () => {
  const store = freshStore();
  seedListingObservation(store);
  store.appendIdentityDecision(decision('dec-1'));
  store.supersedeIdentityDecision('dec-1', decision('dec-2'));
  assert.throws(
    () => store.supersedeIdentityDecision('dec-1', decision('dec-3')),
    (err: Error) => {
      assert.equal((err as Any).code, 'VALIDATION_ERROR');
      return true;
    },
  );
  const ids = (store.listActiveIdentityDecisions() as Any[]).map((d) => d.decisionId);
  assert.deepEqual(ids, ['dec-2']);
});

// --- P1: observation row + evidence refs atomic, retry possible ---

test('insertObservation ref failure rolls back row and retry succeeds', () => {
  const store = freshStore();
  seedListingObservation(store);
  const bad = {
    observationId: 'obs-retry',
    sourceListingId: 'listing-1',
    fetchedAt: '2025-01-01T00:00:00+00:00',
    contentHash: 'hash-retry',
    // NULL evidence_id violates NOT NULL -> ref insert fails after row insert
    evidenceRefs: [null],
    extractionVersion: 'extraction/1',
    adapterVersion: 'adapter/1',
    fetchOutcome: 'success',
    sourceConfidence: { source: 0.9 },
    immutable: true,
  } as Any;
  assert.throws(() => store.insertObservation(bad));
  assert.equal(
    store.getObservation('obs-retry'),
    undefined,
    'failed ref insert must not strand the observation row',
  );
  // Retry with fixed refs must not hit OBSERVATION_IMMUTABLE
  store.insertObservation({ ...bad, evidenceRefs: [] } as Any);
  const got = store.getObservation('obs-retry') as Any;
  assert.ok(got);
  assert.equal(got.observationId, 'obs-retry');
  assert.deepEqual(got.evidenceRefs, []);
});

// --- Oracle: nested transaction / savepoint compatibility ---

test('nested native transactions share outer scope (no SQLITE_BUSY, atomic)', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting('posting-n'));
  // putPostingProjection internally runs runImmediate; nesting it inside a
  // native outer transaction must reuse the outer txn via savepoints.
  const native = (store.db as Any).transaction as
    | ((fn: () => void) => { immediate: () => void })
    | undefined;
  assert.ok(native, 'better-sqlite3 native transaction required');
  assert.throws(() =>
    native
      .call(store.db, () => {
        store.putPostingProjection(makePosting('posting-n', { title: 'Changed' }));
        throw new Error('outer-boom');
      })
      .immediate(),
  );
  const got = store.getPosting('posting-n') as Any;
  assert.equal(got.title, 'Software Engineer', 'nested work must roll back with outer');
});

test('manual SAVEPOINT inside native transaction survives', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting('posting-s'));
  const native = (store.db as Any).transaction as (fn: () => void) => () => void;
  native.call(store.db, () => {
    store.db.exec('SAVEPOINT s1');
    store.putLocations('posting-s', [{ city: 'Melbourne', country: 'AU' }]);
    store.db.exec('RELEASE s1');
  })();
  const got = store.getPosting('posting-s') as Any;
  assert.deepEqual(got.locations, [{ city: 'Melbourne', country: 'AU' }]);
});

test('fallback path works when native transaction absent', () => {
  const store = freshStore();
  const db = store.db as Any;
  const native = db.transaction;
  db.transaction = undefined;
  try {
    store.putPostingProjection(makePosting('posting-f'));
    store.putLocations('posting-f', [{ city: 'Sydney' }]);
    assert.throws(() =>
      store.putRequirements('posting-f', [
        {
          rawText: 'ok',
          category: 'skill',
          force: 'mandatory',
          evidenceRefs: [],
          confidence: 0.9,
          interpretationProvenance: 'test',
        } as Any,
        { category: 'skill' } as Any,
      ]),
    );
    const got = store.getPosting('posting-f') as Any;
    assert.deepEqual(got.locations, [{ city: 'Sydney' }]);
    assert.deepEqual(got.requirements, []);
  } finally {
    db.transaction = native;
  }
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
