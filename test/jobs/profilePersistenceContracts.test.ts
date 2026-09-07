import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_PROFILE_ID,
  PROFILE_PERSISTENCE_CONTRACT_VERSION,
  ProfileStoreError,
  ProfileCorrectionInputSchema,
  SaveAdoptedProfileInputSchema,
  DeleteAdoptedProfileInputSchema,
  ResetProfileStoreInputSchema,
  factId,
  preferenceId,
  correctionId,
  revisionId,
  provenanceId,
  packetId,
  MIGRATION_VERSION,
} from '../../src/jobs/profile/persist/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('PROFILE_PERSISTENCE_CONTRACT_VERSION is 1.0.0', () => {
  assert.equal(PROFILE_PERSISTENCE_CONTRACT_VERSION, '1.0.0');
});

test('LOCAL_PROFILE_ID is profile:default', () => {
  assert.equal(LOCAL_PROFILE_ID, 'profile:default');
});

test('MIGRATION_VERSION is 1', () => {
  assert.equal(MIGRATION_VERSION, 1);
});

// ---------------------------------------------------------------------------
// Deterministic ID stability
// ---------------------------------------------------------------------------

test('factId is deterministic for same input', () => {
  const term = { kind: 'role', packId: 'jobs', packVersion: '1.0.0', termId: 'engineer' };
  const id1 = factId(term);
  const id2 = factId(term);
  assert.equal(id1, id2);
  assert.match(id1, /^profile-fact:[0-9a-f]{64}$/u);
});

test('factId differs for different terms', () => {
  const a = factId({ kind: 'role', packId: 'jobs', packVersion: '1.0.0', termId: 'engineer' });
  const b = factId({ kind: 'role', packId: 'jobs', packVersion: '1.0.0', termId: 'designer' });
  assert.notEqual(a, b);
});

test('preferenceId is deterministic for same input', () => {
  const p = { kind: 'work_mode', value: 'remote', desired: true, explicit: true };
  assert.equal(preferenceId(p), preferenceId(p));
});

test('preferenceId differs for different preferences', () => {
  const a = preferenceId({ kind: 'work_mode', value: 'remote', desired: true, explicit: true });
  const b = preferenceId({ kind: 'work_mode', value: 'onsite', desired: true, explicit: true });
  assert.notEqual(a, b);
});

test('correctionId is deterministic', () => {
  const c = correctionId('fact', 'profile-fact:aaaa', 'profile-fact:bbbb');
  assert.match(c, /^profile-correction:[0-9a-f]{64}$/u);
  assert.equal(c, correctionId('fact', 'profile-fact:aaaa', 'profile-fact:bbbb'));
});

test('correctionId differs for null vs non-null replacement', () => {
  const a = correctionId('fact', 'profile-fact:aaaa', null);
  const b = correctionId('fact', 'profile-fact:aaaa', 'profile-fact:bbbb');
  assert.notEqual(a, b);
});

test('revisionId sorts fact/preference/correction IDs before hashing', () => {
  const r1 = revisionId(['b', 'a'], ['d', 'c'], []);
  const r2 = revisionId(['a', 'b'], ['c', 'd'], []);
  assert.equal(r1, r2, 'revision IDs should be identical regardless of input order');
  assert.match(r1, /^profile-revision:[0-9a-f]{64}$/u);
});

test('provenanceId is deterministic', () => {
  const rev = revisionId(['a'], ['b'], []);
  const p1 = provenanceId(LOCAL_PROFILE_ID, rev);
  const p2 = provenanceId(LOCAL_PROFILE_ID, rev);
  assert.equal(p1, p2);
  assert.match(p1, /^profile-provenance:[0-9a-f]{64}$/u);
});

test('packetId is deterministic', () => {
  const rev = revisionId(['a'], ['b'], []);
  const p1 = packetId(LOCAL_PROFILE_ID, rev);
  const p2 = packetId(LOCAL_PROFILE_ID, rev);
  assert.equal(p1, p2);
  assert.match(p1, /^profile-packet:[0-9a-f]{64}$/u);
});

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

test('ProfileStoreError has valid code', () => {
  const err = new ProfileStoreError('KEY_MISSING', 'test');
  assert.equal(err.code, 'KEY_MISSING');
  assert.equal(err.name, 'ProfileStoreError');
  assert.ok(err instanceof Error);
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test('ProfileCorrectionInputSchema rejects unknown keys', () => {
  assert.throws(() => {
    ProfileCorrectionInputSchema.parse({
      kind: 'fact',
      prior: { kind: 'role', packId: 'x', packVersion: '1.0.0', termId: 'y' },
      extra: 'nope',
    });
  });
});

test('ProfileCorrectionInputSchema accepts valid correction', () => {
  const parsed = ProfileCorrectionInputSchema.parse({
    kind: 'preference',
    prior: { kind: 'work_mode', value: 'onsite', desired: true, explicit: true },
    replacement: { kind: 'work_mode', value: 'remote', desired: true, explicit: true },
  });
  assert.equal(parsed.kind, 'preference');
});

test('SaveAdoptedProfileInputSchema rejects non-true election', () => {
  assert.throws(() => {
    SaveAdoptedProfileInputSchema.parse({
      election: false,
      expectedRevision: null,
      result: { status: 'minimized' },
    });
  });
});

test('DeleteAdoptedProfileInputSchema rejects non-true election', () => {
  assert.throws(() => {
    DeleteAdoptedProfileInputSchema.parse({
      election: false,
      expectedRevision: 'profile-revision:0000',
    });
  });
});

test('ResetProfileStoreInputSchema rejects non-true election', () => {
  assert.throws(() => {
    ResetProfileStoreInputSchema.parse({ election: false });
  });
});
