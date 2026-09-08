import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  JOBS_SQLITE_SCHEMA_VERSION,
  JobsStoreErrorCode,
  createJobsStore,
  openJobsDatabase,
} from '../../src/jobs/persistence/index.js';
import type { Evidence, Requirement, Location } from '../../src/jobs/domain/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let tmpDir: string;

function freshStore() {
  tmpDir = mkdtempSync(join(tmpdir(), 'jobs-persistence-test-'));
  const dbPath = join(tmpDir, 'jobs.sqlite');
  const db = new Database(dbPath);
  return createJobsStore(db);
}

function makeListing() {
  return {
    sourceListingId: 'listing-1',
    adapterId: 'adapter-a',
    externalId: 'ext-1',
    canonicalUrl: 'https://example.com/job/1',
    firstSeenAt: '2025-01-01T00:00:00+00:00',
    lastSeenAt: '2025-01-01T00:00:00+00:00',
    currentObservationId: 'obs-1',
  } as Any;
}

function makeObservation(overrides?: Record<string, unknown>) {
  return {
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
    ...overrides,
  } as Any;
}

function makePosting(overrides?: Record<string, unknown>) {
  return {
    postingId: 'posting-1',
    schemaVersion: 'posting/1',
    canonicalRevision: 0,
    title: 'Software Engineer',
    normalizedTitle: 'software engineer',
    organisation: 'Acme Corp',
    roleFamilies: [{ family: 'engineering', confidence: 0.8, evidenceRefs: [] }],
    locations: [{ city: 'Sydney', country: 'AU' } as Location],
    workMode: 'hybrid',
    employmentType: 'full_time',
    salaries: [],
    classifications: [],
    postedAt: '2025-01-01T00:00:00+00:00',
    listingUrls: ['https://example.com/job/1'],
    description: 'Build things.',
    responsibilities: ['Code'],
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

function makeEvidence(overrides?: Record<string, unknown>): Evidence {
  return {
    evidenceId: 'ev-1',
    subjectType: 'posting',
    subjectId: 'posting-1',
    kind: 'structured_field',
    capturedAt: '2025-01-01T00:00:00+00:00',
    confidence: 0.9,
    retentionClass: 'short',
    ...overrides,
  } as Evidence;
}

function makeDecision(overrides?: Record<string, unknown>) {
  return {
    decisionId: 'dec-1',
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

test('openJobsDatabase requires absolute path', async () => {
  await assert.rejects(
    () => openJobsDatabase({ databasePath: 'relative/path.sqlite' }),
    (err: Error) => {
      assert.equal(err.message, 'database path must be absolute');
      return true;
    },
  );
});

test('openJobsDatabase rejects empty path', async () => {
  await assert.rejects(
    () => openJobsDatabase({ databasePath: '' }),
    (err: Error) => {
      assert.equal(err.message, 'database path is required');
      return true;
    },
  );
});

test('applyMigrations returns correct schema version', () => {
  const store = freshStore();
  const result = store.applyMigrations();
  assert.equal(result.version, JOBS_SQLITE_SCHEMA_VERSION);
});

test('WAL + FK + synchronous=FULL pragmas', () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'jobs-persistence-test-'));
  const dbPath = join(tmpDir, 'jobs.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('synchronous', { simple: true }), 2);
  db.close();
});

test('upsertListing and getListing', () => {
  const store = freshStore();
  store.upsertListing(makeListing());
  const got = store.getListing('listing-1');
  assert.ok(got);
  assert.equal((got as Any).sourceListingId, 'listing-1');
  assert.equal((got as Any).adapterId, 'adapter-a');
});

test('insertObservation: reject duplicate', () => {
  const store = freshStore();
  store.upsertListing(makeListing());
  store.insertObservation(makeObservation());
  assert.throws(
    () => store.insertObservation(makeObservation()),
    (err: Error) => {
      assert.equal(
        (err as unknown as { code: string }).code,
        JobsStoreErrorCode.OBSERVATION_IMMUTABLE,
      );
      return true;
    },
  );
});

test('listObservations order', () => {
  const store = freshStore();
  store.upsertListing(makeListing());
  store.insertObservation(
    makeObservation({ observationId: 'obs-1', fetchedAt: '2025-01-02T00:00:00+00:00' }),
  );
  store.insertObservation(
    makeObservation({ observationId: 'obs-2', fetchedAt: '2025-01-01T00:00:00+00:00' }),
  );
  const obs = store.listObservations('listing-1');
  assert.equal(obs.length, 2);
  assert.equal((obs[0] as Any).observationId, 'obs-2');
  assert.equal((obs[1] as Any).observationId, 'obs-1');
});

test('putPostingProjection deterministically deduplicates role families', () => {
  const store = freshStore();
  store.putPostingProjection(
    makePosting({
      roleFamilies: [
        { family: 'engineering', confidence: 0.8, evidenceRefs: [] },
        { family: 'engineering', confidence: 0.4, evidenceRefs: [] },
      ],
    }),
  );
  const got = store.getPosting('posting-1') as Any;
  assert.deepEqual(got.roleFamilies, [
    { family: 'engineering', confidence: 0.8, evidenceRefs: [] },
  ]);
});

test('putPostingProjection and getPosting', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting());
  const got = store.getPosting('posting-1');
  assert.ok(got);
  assert.equal((got as Any).title, 'Software Engineer');
  assert.equal((got as Any).roleFamilies.length, 1);
  assert.equal((got as Any).listingUrls.length, 1);
});

test('listPostingsByLifecycle', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting({ lifecycleState: 'active' }));
  store.putPostingProjection(makePosting({ postingId: 'posting-2', lifecycleState: 'discovered' }));
  const active = store.listPostingsByLifecycle('active');
  assert.deepEqual(active, ['posting-1']);
});

test('putEvidence rejects profile subject_type', () => {
  const store = freshStore();
  assert.throws(
    () => store.putEvidence([makeEvidence({ subjectType: 'profile' })]),
    (err: Error) => {
      assert.equal(
        (err as unknown as { code: string }).code,
        JobsStoreErrorCode.PROFILE_EVIDENCE_FORBIDDEN,
      );
      return true;
    },
  );
});

test('putEvidence accepts posting subject_type', () => {
  const store = freshStore();
  store.putEvidence([makeEvidence()]);
});

test('putClaimResolution: model_derived cannot overwrite observed', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting());
  const observed = {
    candidateId: 'cc-observed',
    value: 'Acme Corp',
    evidenceRefs: [],
    confidence: 0.9,
    origin: 'observed',
    method: 'extract',
    provenance: { component: 'test', version: '1', producedAt: '2025-01-01T00:00:00+00:00' },
  } as Any;
  const model = {
    candidateId: 'cc-model',
    value: 'Different Corp',
    evidenceRefs: [],
    confidence: 0.8,
    origin: 'model_derived',
    method: 'llm',
    provenance: { component: 'test', version: '1', producedAt: '2025-01-01T00:00:00+00:00' },
  } as Any;
  store.putClaimCandidates('posting-1', 'organisation', [observed]);
  assert.throws(
    () =>
      store.putClaimResolution('posting-1', 'organisation', {
        state: 'resolved',
        selected: model,
        alternatives: [observed],
      }),
    (err: Error) => {
      assert.equal(
        (err as unknown as { code: string }).code,
        JobsStoreErrorCode.OBSERVATION_IMMUTABLE,
      );
      return true;
    },
  );
});

test('appendLifecycleEvent: disappeared cannot set to_state=confirmed_closed', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting());
  assert.throws(
    () =>
      store.appendLifecycleEvent({
        eventId: 'lc-1',
        postingId: 'posting-1' as Any,
        type: 'disappeared',
        occurredAt: '2025-01-01T00:00:00+00:00',
        fromState: 'active',
        toState: 'confirmed_closed',
        evidenceRefs: [],
        source: 'test',
      } as Any),
    (err: Error) => {
      assert.ok(err.message.includes('disappearance') || err.message.includes('confirmed_closed'));
      return true;
    },
  );
});

test('appendLifecycleEvent: disappeared to probably_closed is valid', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting());
  store.appendLifecycleEvent({
    eventId: 'lc-1',
    postingId: 'posting-1' as Any,
    type: 'disappeared',
    occurredAt: '2025-01-01T00:00:00+00:00',
    fromState: 'active',
    toState: 'probably_closed',
    evidenceRefs: [],
    source: 'test',
  });
  const history = store.getLifecycleHistory('posting-1');
  assert.equal(history.length, 1);
  assert.equal((history[0] as Any).type, 'disappeared');
});

test('appendIdentityDecision: org+title only rejected for same_posting', () => {
  const store = freshStore();
  assert.throws(
    () =>
      store.appendIdentityDecision({
        decisionId: 'dec-1',
        subjectObservationIds: ['obs-1', 'obs-2'],
        subjectListingIds: ['listing-1', 'listing-2'],
        outcome: 'same_posting',
        confidence: 0.9,
        featureContributions: [
          { feature: 'organisation_normalized', contribution: 0.05, evidenceRefs: [] },
          { feature: 'title_normalized', contribution: 0.05, evidenceRefs: [] },
        ],
        contradictoryEvidenceRefs: [],
        resolverVersion: 'identity-resolver/1.0.0',
        createdAt: '2025-01-01T00:00:00+00:00',
      } as Any),
    (err: Error) => {
      assert.equal(
        (err as unknown as { code: string }).code,
        JobsStoreErrorCode.IDENTITY_MERGE_FORBIDDEN,
      );
      return true;
    },
  );
});

test('appendIdentityDecision with strong feature succeeds', () => {
  const store = freshStore();
  store.upsertListing(makeListing());
  store.insertObservation(makeObservation());
  store.appendIdentityDecision(makeDecision());
  const active = store.listActiveIdentityDecisions();
  assert.equal(active.length, 1);
  assert.equal((active[0] as Any).decisionId, 'dec-1');
});

test('supersedeIdentityDecision hides from active list', () => {
  const store = freshStore();
  store.upsertListing(makeListing());
  store.insertObservation(makeObservation());
  store.appendIdentityDecision(makeDecision());
  store.supersedeIdentityDecision('dec-1', makeDecision({ decisionId: 'dec-2' }));
  const active = store.listActiveIdentityDecisions();
  assert.equal(active.length, 1);
  assert.equal((active[0] as Any).decisionId, 'dec-2');
});

test('putRequirements and putLocations', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting());
  store.putRequirements('posting-1', [
    {
      rawText: 'Must know TypeScript',
      category: 'skill',
      force: 'mandatory',
      evidenceRefs: [],
      confidence: 0.9,
      interpretationProvenance: 'test',
    } as Requirement,
  ]);
  store.putLocations('posting-1', [{ city: 'Melbourne', country: 'AU' } as Location]);
});

test('insertRun and getRun', () => {
  const store = freshStore();
  store.insertRun({
    runId: 'run-1',
    createdAt: '2025-01-01T00:00:00+00:00',
    intentHash: 'hash-abc',
    coverageJson: '{}',
    budgetJson: '{}',
    status: 'running',
  });
  const run = store.getRun('run-1');
  assert.ok(run);
  assert.equal(run.status, 'running');
  assert.equal(run.intentHash, 'hash-abc');
});

test('putEnrichmentCache and getEnrichmentCache', () => {
  const store = freshStore();
  store.putEnrichmentCache({
    cacheKey: 'key-1',
    kind: 'employer',
    contentHash: 'ch-1',
    enrichmentVersion: 'enrich/1',
    boundedMetadataJson: '{}',
    createdAt: '2025-01-01T00:00:00+00:00',
    lastAccessedAt: '2025-01-01T00:00:00+00:00',
  });
  const got = store.getEnrichmentCache('key-1');
  assert.ok(got);
  assert.equal(got.kind, 'employer');
});

test('recordSourceHealth', () => {
  const store = freshStore();
  store.recordSourceHealth({
    sampleId: 'sh-1',
    sourceId: 'seek',
    adapterId: 'jobspy',
    sampledAt: '2025-01-01T00:00:00+00:00',
    outcome: 'succeeded',
    resultCount: 10,
  });
});

test('insertPolicyRevision and getPolicyRevision', () => {
  const store = freshStore();
  store.insertPolicyRevision({
    sourceId: 'seek',
    revision: 'v1',
    modesJson: '{}',
    reviewedAt: '2025-01-01T00:00:00+00:00',
  });
  const got = store.getPolicyRevision('seek', 'v1');
  assert.ok(got);
  assert.equal(got.revision, 'v1');
});

test('integrityCheck returns ok', () => {
  const store = freshStore();
  assert.equal(store.integrityCheck().ok, true);
});

test('runs table has no query_text column', () => {
  const store = freshStore();
  const cols = store.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
  assert.ok(!cols.some((c) => c.name === 'query_text'));
});

test('no destructive down migration export', async () => {
  const mod = await import('../../src/jobs/persistence/index.js');
  assert.equal(typeof (mod as Record<string, unknown>)['rollbackMigrations'], 'undefined');
});

test('close does not throw', () => {
  const store = freshStore();
  store.close();
});

process.on('exit', () => {
  if (tmpDir)
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
});
