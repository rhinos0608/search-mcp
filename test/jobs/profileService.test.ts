import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PROFILE_CAPABILITY_REPORT,
  processProfileRequest,
} from '../../src/jobs/profile/service.js';

const term = { kind: 'role' as const, packId: 'jobs', packVersion: '1.0.0', termId: 'engineer' };
const allowedTermRefs = new Set(['[\"role\",\"jobs\",\"1.0.0\",\"engineer\"]']);

test('PROFILE_CAPABILITY_REPORT is deeply frozen', () => {
  assert.ok(Object.isFrozen(PROFILE_CAPABILITY_REPORT));
  assert.ok(Object.isFrozen(PROFILE_CAPABILITY_REPORT.capabilities));
  for (const cap of PROFILE_CAPABILITY_REPORT.capabilities) {
    assert.ok(Object.isFrozen(cap));
  }
  assert.throws(() => {
    (PROFILE_CAPABILITY_REPORT as unknown as Record<string, unknown>).zeroPersistence = false;
  });
});

test('capability report values are exact', () => {
  const map = new Map(PROFILE_CAPABILITY_REPORT.capabilities.map((c) => [c.inputKind, c]));
  const structured = map.get('structured_profile');
  assert.equal(structured?.ingestion, 'supported');
  assert.equal(structured?.minimization, 'supported');
  const inline = map.get('inline_text');
  assert.equal(inline?.ingestion, 'supported');
  assert.equal(inline?.minimization, 'requires_vetted_extractor');
  const file = map.get('trusted_root_file');
  assert.equal(file?.ingestion, 'supported');
  assert.equal(file?.minimization, 'requires_vetted_extractor');
  assert.equal(PROFILE_CAPABILITY_REPORT.zeroPersistence, true);
  assert.equal(PROFILE_CAPABILITY_REPORT.reusableHandle, false);
  assert.equal(PROFILE_CAPABILITY_REPORT.binaryFiles, false);
  assert.equal(PROFILE_CAPABILITY_REPORT.urlIngestion, false);
});

test('structured minimizes with allowlisted refs and random evidence', async () => {
  const input = { kind: 'structured_profile' as const, profile: { roleHints: [term] } };
  const first = await processProfileRequest(input, { allowedTermRefs });
  const second = await processProfileRequest(input, { allowedTermRefs });
  assert.equal(first.status, 'minimized');
  assert.equal(second.status, 'minimized');
  if (first.status === 'minimized' && second.status === 'minimized') {
    assert.notEqual(first.evidence[0]?.evidenceId, second.evidence[0]?.evidenceId);
  }
});

test('structured rejects unapproved term without echo', async () => {
  const result = await processProfileRequest(
    { kind: 'structured_profile', profile: { roleHints: [{ ...term, termId: 'bad' }] } },
    { allowedTermRefs },
  );
  assert.equal(result.status, 'rejected');
  assert.equal(JSON.stringify(result).includes('bad'), false);
});

test('inline returns requires_extractor without echo', async () => {
  const result = await processProfileRequest(
    { kind: 'inline_text', text: 'my secret email secret@example.com' },
    { allowedTermRefs },
  );
  assert.equal(result.status, 'requires_extractor');
  if (result.status === 'requires_extractor') {
    assert.equal(result.inputKind, 'inline_text');
    assert.equal(result.rawRetained, false);
  }
  assert.equal(JSON.stringify(result).includes('secret@example.com'), false);
});

test('trusted file validates and verifies metadata then requires extractor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-service-'));
  try {
    const content = 'hello world';
    await writeFile(join(root, 'profile.txt'), content, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    const result = await processProfileRequest(
      {
        kind: 'trusted_root_file',
        path: 'profile.txt',
        contentType: 'text/plain',
        sizeBytes: bytes,
      },
      { allowedTermRefs, trustedRoots: [root] },
    );
    assert.equal(result.status, 'requires_extractor');
    if (result.status === 'requires_extractor') {
      assert.equal(result.inputKind, 'trusted_root_file');
      assert.equal(result.rawRetained, false);
    }
    assert.equal(JSON.stringify(result).includes('hello'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted file size mismatch sanitizes to invalid_profile_input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-service-'));
  try {
    const content = 'hello';
    await writeFile(join(root, 'profile.txt'), content, 'utf8');
    const result = await processProfileRequest(
      { kind: 'trusted_root_file', path: 'profile.txt', contentType: 'text/plain', sizeBytes: 999 },
      { allowedTermRefs, trustedRoots: [root] },
    );
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') {
      assert.equal(result.code, 'INVALID_PROFILE_INPUT');
      assert.deepEqual(result.warnings, ['invalid_profile_input']);
    }
    assert.equal(JSON.stringify(result).includes('profile.txt'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted file contentType mismatch sanitizes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-service-'));
  try {
    await writeFile(join(root, 'data.json'), '{"a":1}', 'utf8');
    const bytes = Buffer.byteLength('{"a":1}', 'utf8');
    const result = await processProfileRequest(
      { kind: 'trusted_root_file', path: 'data.json', contentType: 'text/plain', sizeBytes: bytes },
      { allowedTermRefs, trustedRoots: [root] },
    );
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.code, 'INVALID_PROFILE_INPUT');
    assert.equal(JSON.stringify(result).includes('data.json'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted file read failure sanitizes without leaking path or fs error', async () => {
  const result = await processProfileRequest(
    { kind: 'trusted_root_file', path: 'missing.txt', contentType: 'text/plain', sizeBytes: 10 },
    {
      allowedTermRefs,
      trustedRoots: ['/tmp/missing-root-profile-service'],
      fileSystem: {
        lstat: async () => {
          throw new Error('ENOENT secret path /etc/passwd');
        },
        realpath: async (p: string) => p,
        open: async () => {
          throw new Error('open leaked');
        },
      },
    },
  );
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.equal(result.code, 'INVALID_PROFILE_INPUT');
    assert.deepEqual(result.warnings, ['invalid_profile_input']);
  }
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('/etc/passwd'), false);
  assert.equal(serialized.includes('ENOENT'), false);
  assert.equal(serialized.includes('missing.txt'), false);
});

test('invalid input sanitizes to rejected without echo', async () => {
  const result = await processProfileRequest(
    { kind: 'inline_text', text: '' },
    { allowedTermRefs },
  );
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') assert.equal(result.code, 'INVALID_PROFILE_INPUT');
});

test('does not expose createEvidenceId or extractor', async () => {
  const mod = await import('../../src/jobs/profile/service.js');
  assert.equal('createEvidenceId' in mod, false);
  assert.equal('extractor' in mod, false);
});

test('structured minimization succeeds with non-native readonly set-like has object', async () => {
  const readOnlySetLike: ReadonlySet<string> = {
    has(value: string) {
      return value === '["role","jobs","1.0.0","engineer"]';
    },
  } as unknown as ReadonlySet<string>;
  assert.equal(readOnlySetLike instanceof Set, false);
  const result = await processProfileRequest(
    { kind: 'structured_profile', profile: { roleHints: [term] } },
    { allowedTermRefs: readOnlySetLike },
  );
  assert.equal(result.status, 'minimized');
  if (result.status === 'minimized') {
    assert.equal(result.draft.roleHints.length, 1);
    assert.equal(result.evidence[0]?.rawRetained, false);
  }
  assert.equal(JSON.stringify(result).includes('engineer'), true);
});

test('invalid missing or throwing capability fails safely without raw leakage', async () => {
  const secret = 'leak-secret@example.com';
  const secretInput = { kind: 'structured_profile' as const, profile: { roleHints: [term] } };
  const cases: unknown[] = [
    { allowedTermRefs: undefined },
    { allowedTermRefs: null },
    { allowedTermRefs: {} },
    { allowedTermRefs: { has: 'not-a-function' } },
    {
      get allowedTermRefs(): unknown {
        throw new Error('getter leak ' + secret);
      },
    },
    {
      allowedTermRefs: {
        has() {
          throw new Error('has leak ' + secret);
        },
      },
    },
    null,
    undefined,
  ];
  for (const opts of cases) {
    const result = await processProfileRequest(
      secretInput,
      opts as unknown as { allowedTermRefs: ReadonlySet<string> },
    );
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') {
      assert.equal(result.code, 'INVALID_PROFILE_INPUT');
      assert.deepEqual(result.warnings, ['invalid_profile_input']);
    }
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('getter leak'), false);
    assert.equal(serialized.includes('has leak'), false);
  }
});
