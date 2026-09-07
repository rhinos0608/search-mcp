import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MinimizedProfileDraftSchema,
  ProfileCapabilityReportSchema,
  ProfileMinimizationResultSchema,
  ProfileInputSchema,
  ProfileTermRefSchema,
  PROFILE_CONTRACT_VERSION,
} from '../../src/jobs/profile/contracts.js';

const term = { kind: 'role' as const, packId: 'jobs', packVersion: '1.0.0', termId: 'engineer' };
const evidence = 'profile-evidence:00000000-0000-4000-8000-000000000000';

test('uses versioned pack-backed strict terms', () => {
  assert.equal(PROFILE_CONTRACT_VERSION, '1.0.0');
  assert.deepEqual(ProfileTermRefSchema.parse(term), term);
  assert.throws(() => ProfileTermRefSchema.parse({ ...term, kind: 'bad' }));
  assert.throws(() => ProfileTermRefSchema.parse({ ...term, packVersion: 'latest' }));
});

test('validates SemVer prerelease and build identifiers', () => {
  for (const packVersion of [
    '1.0.0-0',
    '1.0.0-rc.1',
    '1.0.0-01a',
    '1.0.0+build.01',
    '1.0.0-rc+build.01',
  ]) {
    assert.doesNotThrow(() => ProfileTermRefSchema.parse({ ...term, packVersion }));
  }
  for (const packVersion of ['1.0.0-01', '1.0.0-rc.01', '1.0.0-']) {
    assert.throws(() => ProfileTermRefSchema.parse({ ...term, packVersion }));
  }
});

test('constrains term preference dimensions to matching term kinds', () => {
  assert.throws(() =>
    ProfileInputSchema.parse({
      kind: 'structured_profile',
      profile: {
        preferences: [
          {
            kind: 'term',
            dimension: 'role',
            value: { ...term, kind: 'capability' },
            desired: true,
            explicit: true,
          },
        ],
      },
    }),
  );
  assert.throws(() =>
    ProfileInputSchema.parse({
      kind: 'structured_profile',
      profile: {
        preferences: [
          {
            kind: 'term',
            dimension: 'location',
            value: { ...term, kind: 'role' },
            desired: true,
            explicit: true,
          },
        ],
      },
    }),
  );
});

test('accepts typed input and rejects arbitrary legacy values', () => {
  assert.equal(
    ProfileInputSchema.parse({
      kind: 'structured_profile',
      profile: {
        roleHints: [term],
        preferences: [{ kind: 'work_mode', value: 'remote', desired: false, explicit: true }],
      },
    }).kind,
    'structured_profile',
  );
  assert.throws(() =>
    ProfileInputSchema.parse({ kind: 'structured_profile', profile: { roleHints: ['engineer'] } }),
  );
  assert.throws(() =>
    ProfileInputSchema.parse({
      kind: 'structured_profile',
      profile: { preferences: [{ field: 'remote', value: false }] },
    }),
  );
});

test('requires evidence on emitted facts and preferences', () => {
  assert.throws(() =>
    MinimizedProfileDraftSchema.parse({
      roleHints: [
        { term, origin: 'user_supplied', dataClass: 'job_fact', evidenceRefs: [evidence] },
      ],
      capabilities: [],
      qualifications: [],
      licences: [],
      clearances: [],
      registrations: [],
      preferences: [{ kind: 'work_mode', value: 'remote', desired: false, explicit: true }],
      observedCandidateFacts: [],
      requestedEligibility: [],
      evidenceRefs: [evidence],
    }),
  );
  const parsed = MinimizedProfileDraftSchema.parse({
    roleHints: [],
    capabilities: [],
    qualifications: [],
    licences: [],
    clearances: [],
    registrations: [],
    preferences: [
      {
        kind: 'work_mode',
        value: 'remote',
        desired: false,
        explicit: true,
        evidenceRefs: [evidence],
      },
    ],
    observedCandidateFacts: [
      { term, origin: 'observed', dataClass: 'job_fact', evidenceRefs: [evidence] },
    ],
    requestedEligibility: [],
    evidenceRefs: [evidence],
  });
  assert.equal(parsed.preferences[0]?.kind, 'work_mode');
  if (parsed.preferences[0]?.kind === 'work_mode')
    assert.equal(parsed.preferences[0].desired, false);
});

test('rejects orphan evidence references and requires all capability states', () => {
  assert.throws(() =>
    ProfileMinimizationResultSchema.parse({
      status: 'minimized',
      draft: {
        roleHints: [],
        capabilities: [],
        qualifications: [],
        licences: [],
        clearances: [],
        registrations: [],
        preferences: [],
        observedCandidateFacts: [],
        requestedEligibility: [],
        evidenceRefs: [evidence],
      },
      evidence: [],
      warnings: [],
    }),
  );
  assert.throws(() =>
    ProfileCapabilityReportSchema.parse({
      capabilities: [
        { inputKind: 'inline_text', ingestion: 'unsupported', minimization: 'supported' },
      ],
      zeroPersistence: true,
      reusableHandle: false,
      binaryFiles: false,
      urlIngestion: false,
    }),
  );
});

test('capability report separates ingestion and minimization', () => {
  const report = ProfileCapabilityReportSchema.parse({
    capabilities: [
      { inputKind: 'structured_profile', ingestion: 'supported', minimization: 'supported' },
      {
        inputKind: 'inline_text',
        ingestion: 'supported',
        minimization: 'requires_vetted_extractor',
      },
      {
        inputKind: 'trusted_root_file',
        ingestion: 'supported',
        minimization: 'requires_vetted_extractor',
      },
    ],
    zeroPersistence: true,
    reusableHandle: false,
    binaryFiles: false,
    urlIngestion: false,
  });
  assert.equal(report.capabilities[1]?.minimization, 'requires_vetted_extractor');
});
