import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createJobsStore } from '../../src/jobs/persistence/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let tmpDir: string;

function freshStore() {
  tmpDir = mkdtempSync(join(tmpdir(), 'jobs-lifecycle-hyd-'));
  const db = new Database(join(tmpDir, 'jobs.sqlite'));
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
    lifecycleState: 'discovered',
  } as Any;
}

test('RED: lifecycle evidenceRefs survive append/get round-trip', () => {
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
    },
    {
      evidenceId: 'ev-2',
      subjectType: 'posting',
      subjectId: 'posting-lc',
      kind: 'structured_field',
      capturedAt: '2025-01-01T00:00:00+00:00',
      confidence: 0.9,
      retentionClass: 'short',
    },
  ] as Any);
  store.appendLifecycleEvent({
    eventId: 'lc-1',
    postingId: 'posting-lc',
    type: 'observed',
    occurredAt: '2025-01-01T00:00:00+00:00',
    fromState: 'discovered',
    toState: 'active',
    evidenceRefs: ['ev-1', 'ev-2'],
    source: 'test',
  } as Any);
  const history = store.getLifecycleHistory('posting-lc') as Any[];
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].evidenceRefs, ['ev-1', 'ev-2']);
});

process.on('exit', () => {
  if (tmpDir)
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
});
