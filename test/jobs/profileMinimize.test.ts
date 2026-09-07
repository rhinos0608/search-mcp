import assert from 'node:assert/strict';
import test from 'node:test';
import { minimizeProfile } from '../../src/jobs/profile/minimize.js';

const term = { kind: 'role' as const, packId: 'jobs', packVersion: '1.0.0', termId: 'engineer' };
const options = {
  allowedTermRefs: new Set(['["role","jobs","1.0.0","engineer"]']),
  createEvidenceId: () => 'profile-evidence:00000000-0000-4000-8000-000000000000',
};

test('minimizes allowlisted terms and preserves false preferences', () => {
  const result = minimizeProfile(
    {
      kind: 'structured_profile',
      profile: {
        roleHints: [term, term],
        preferences: [{ kind: 'work_mode', value: 'remote', desired: false, explicit: true }],
      },
    },
    options,
  );
  assert.equal(result.status, 'minimized');
  if (result.status !== 'minimized') return;
  assert.deepEqual(result.draft.roleHints[0]?.term, term);
  assert.deepEqual(
    result.draft.roleHints[0]?.evidenceRefs,
    result.evidence.map((e) => e.evidenceId),
  );
  if (result.draft.preferences[0]?.kind === 'work_mode')
    assert.equal(result.draft.preferences[0].desired, false);
  assert.deepEqual(result.draft.observedCandidateFacts, []);
  assert.deepEqual(
    result.draft.preferences[0]?.evidenceRefs,
    result.evidence.map((e) => e.evidenceId),
  );
});

test('rejects unapproved terms without echoing input', () => {
  const result = minimizeProfile(
    { kind: 'structured_profile', profile: { roleHints: [{ ...term, termId: 'secret-name' }] } },
    options,
  );
  assert.equal(result.status, 'rejected');
  assert.equal(JSON.stringify(result).includes('secret-name'), false);
});

test('rejects colliding allowlist keys and standalone URI text', () => {
  const collision = {
    kind: 'structured_profile' as const,
    profile: {
      roleHints: [{ kind: 'role' as const, packId: 'a', packVersion: '1.0.0', termId: '2.0.0:x' }],
    },
  };
  assert.equal(
    minimizeProfile(collision, {
      allowedTermRefs: new Set(['role:a:1.0.0:2.0.0:x']),
      createEvidenceId: options.createEvidenceId,
    }).status,
    'rejected',
  );
  for (const text of ['ftp://example.com', 'file:///tmp/resume.txt', 'custom+scheme:value']) {
    assert.equal(minimizeProfile({ kind: 'inline_text', text }, options).status, 'rejected');
  }
  assert.equal(
    minimizeProfile({ kind: 'inline_text', text: 'See https://example.com' }, options).status,
    'requires_extractor',
  );
});

test('inline and trusted files truthfully require extractor', () => {
  for (const input of [
    { kind: 'inline_text', text: 'Jane Doe jane@example.com' },
    {
      kind: 'trusted_root_file',
      path: '/trusted/resume.txt',
      contentType: 'text/plain',
      sizeBytes: 10,
    },
  ] as const) {
    const result = minimizeProfile(input, options);
    assert.equal(result.status, 'requires_extractor');
    assert.equal(JSON.stringify(result).includes('resume.txt'), false);
  }
});

test('random default evidence IDs differ and malformed injected IDs reject', () => {
  const input = { kind: 'structured_profile' as const, profile: { roleHints: [term] } };
  const first = minimizeProfile(input, { allowedTermRefs: options.allowedTermRefs });
  const second = minimizeProfile(input, { allowedTermRefs: options.allowedTermRefs });
  assert.notDeepEqual(first, second);
  assert.equal(
    minimizeProfile(input, { ...options, createEvidenceId: () => 'not-an-id' }).status,
    'rejected',
  );
});
