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
  const dir = mkdtempSync(join(tmpdir(), 'jobs-claim-hyd-'));
  tmpDirs.push(dir);
  const db = new Database(join(dir, 'jobs.sqlite'));
  db.pragma('foreign_keys = ON');
  return createJobsStore(db);
}

function makePosting(postingId: string) {
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
  } as Any;
}

function candidate(id: string, value: unknown) {
  return {
    candidateId: id,
    value,
    evidenceRefs: ['ev-1'],
    confidence: 0.9,
    origin: 'observed',
    method: 'structured_field',
    provenance: { component: 'test', version: '1', producedAt: '2025-01-01T00:00:00+00:00' },
  } as Any;
}

test('RED: claim candidates survive put/get round-trip', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting('posting-cl'));
  store.putEvidence([
    {
      evidenceId: 'ev-1',
      subjectType: 'posting',
      subjectId: 'posting-cl',
      kind: 'structured_field',
      capturedAt: '2025-01-01T00:00:00+00:00',
      confidence: 0.9,
      retentionClass: 'short',
    } as Any,
  ]);
  store.putClaimCandidates('posting-cl', 'title', [candidate('cc-1', 'Software Engineer')]);
  const got = store.getPosting('posting-cl') as Any;
  assert.ok(got.claimCandidates, 'claimCandidates must hydrate');
  assert.equal(got.claimCandidates.length, 1);
  assert.equal(got.claimCandidates[0].candidateId, 'cc-1');
  assert.equal(got.claimCandidates[0].value, 'Software Engineer');
  assert.deepEqual(got.claimCandidates[0].evidenceRefs, ['ev-1']);
});

test('putClaimResolution is idempotent across retries (no PK failure)', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting('posting-retry'));
  store.putEvidence([
    {
      evidenceId: 'ev-1',
      subjectType: 'posting',
      subjectId: 'posting-retry',
      kind: 'structured_field',
      capturedAt: '2025-01-01T00:00:00+00:00',
      confidence: 0.9,
      retentionClass: 'short',
    } as Any,
  ]);
  const selected = candidate('cc-s', 'Software Engineer');
  const alt = candidate('cc-a', 'Software Eng');
  const resolution = {
    state: 'resolved',
    selected,
    alternatives: [selected, alt],
  } as Any;
  store.putClaimResolution('posting-retry', 'title', resolution);
  store.putClaimResolution('posting-retry', 'title', resolution);
  const got = store.getPosting('posting-retry') as Any;
  assert.equal(got.claimResolutions.title.state, 'resolved');
});

test('RED: claim resolutions survive put/get round-trip', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting('posting-cr'));
  store.putEvidence([
    {
      evidenceId: 'ev-1',
      subjectType: 'posting',
      subjectId: 'posting-cr',
      kind: 'structured_field',
      capturedAt: '2025-01-01T00:00:00+00:00',
      confidence: 0.9,
      retentionClass: 'short',
    } as Any,
  ]);
  const selected = candidate('cc-s', 'Software Engineer');
  const alt = candidate('cc-a', 'Software Eng');
  store.putClaimResolution('posting-cr', 'title', {
    state: 'resolved',
    selected,
    alternatives: [selected, alt],
  } as Any);
  const got = store.getPosting('posting-cr') as Any;
  assert.ok(got.claimResolutions, 'claimResolutions must hydrate');
  assert.equal(got.claimResolutions.title.state, 'resolved');
  assert.equal(got.claimResolutions.title.selected.candidateId, 'cc-s');
  assert.equal(got.claimResolutions.title.alternatives.length, 2);
});

test('model_derived cannot overwrite observed value even via reused candidate_id', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting('posting-obs'));
  store.putEvidence([
    {
      evidenceId: 'ev-1',
      subjectType: 'posting',
      subjectId: 'posting-obs',
      kind: 'structured_field',
      capturedAt: '2025-01-01T00:00:00+00:00',
      confidence: 0.9,
      retentionClass: 'short',
    } as Any,
  ]);
  // Observed claim first.
  store.putClaimResolution('posting-obs', 'title', {
    state: 'resolved',
    selected: candidate('cc-obs', 'Software Engineer'),
    alternatives: [],
  } as Any);
  // Model selection reuses the observed candidate_id with a different value:
  // id-based comparison would let this overwrite observed provenance.
  assert.throws(
    () =>
      store.putClaimResolution('posting-obs', 'title', {
        state: 'resolved',
        selected: { ...candidate('cc-obs', 'Senior Engineer'), origin: 'model_derived' },
        alternatives: [],
      } as Any),
    /model_derived cannot overwrite observed claim/,
  );
  // Observed value is intact.
  const got = store.getPosting('posting-obs') as Any;
  assert.equal(got.claimResolutions.title.selected.value, 'Software Engineer');
});

test('model_derived alternatives cannot overwrite observed values', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting('posting-alt'));
  store.putEvidence([
    {
      evidenceId: 'ev-1',
      subjectType: 'posting',
      subjectId: 'posting-alt',
      kind: 'structured_field',
      capturedAt: '2025-01-01T00:00:00+00:00',
      confidence: 0.9,
      retentionClass: 'short',
    } as Any,
  ]);
  store.putClaimResolution('posting-alt', 'title', {
    state: 'resolved',
    selected: candidate('cc-obs', 'Software Engineer'),
    alternatives: [],
  } as Any);
  assert.throws(
    () =>
      store.putClaimResolution('posting-alt', 'title', {
        state: 'resolved',
        selected: { ...candidate('cc-new', 'Software Engineer'), origin: 'model_derived' },
        alternatives: [{ ...candidate('cc-obs', 'Contradicting Value'), origin: 'model_derived' }],
      } as Any),
    /model_derived cannot overwrite observed claim/,
  );
});

test('model_derived selection agreeing with observed value is accepted', () => {
  const store = freshStore();
  store.putPostingProjection(makePosting('posting-agree'));
  store.putEvidence([
    {
      evidenceId: 'ev-1',
      subjectType: 'posting',
      subjectId: 'posting-agree',
      kind: 'structured_field',
      capturedAt: '2025-01-01T00:00:00+00:00',
      confidence: 0.9,
      retentionClass: 'short',
    } as Any,
  ]);
  store.putClaimResolution('posting-agree', 'title', {
    state: 'resolved',
    selected: candidate('cc-obs', 'Software Engineer'),
    alternatives: [],
  } as Any);
  // Same value under a different candidate_id is agreement, not overwrite.
  store.putClaimResolution('posting-agree', 'title', {
    state: 'resolved',
    selected: { ...candidate('cc-model', 'Software Engineer'), origin: 'model_derived' },
    alternatives: [],
  } as Any);
  const got = store.getPosting('posting-agree') as Any;
  assert.equal(got.claimResolutions.title.selected.value, 'Software Engineer');
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
