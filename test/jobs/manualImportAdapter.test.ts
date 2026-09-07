import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

import {
  ACQUISITION_CONTRACT_VERSION,
  AcquisitionPolicyEdgeSchema,
  AcquisitionSliceResultSchema,
  AcquisitionSliceSchema,
} from '../../src/jobs/acquisition/contracts.js';
import {
  MANUAL_IMPORT_ADAPTER_ID,
  MANUAL_IMPORT_ADAPTER_VERSION,
  ManualImportRequestSchema,
  ManualImportResultSchema,
  runManualImport,
} from '../../src/jobs/acquisition/adapters/manualImport.js';
import {
  acquiredContentHash,
  deterministicAcquisitionId,
  normalizeHttpUrlMetadata,
} from '../../src/jobs/acquisition/adapterSupport.js';
import { isToolError } from '../../src/errors.js';

// helpers
function slice(overrides: Record<string, unknown> = {}) {
  return AcquisitionSliceSchema.parse({
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    ordinal: 0,
    queryVariantId: 'qv-1',
    query: 'test query',
    reason: 'test',
    adapterIds: ['manual'],
    localePackRefs: [],
    domainPackRefs: [],
    budget: {
      logicalRequests: 10,
      reservedAttempts: 10,
      candidates: 10,
      bytes: 100000,
      milliseconds: 60000,
    },
    ...overrides,
  });
}

function edge(overrides: Record<string, unknown> = {}) {
  return AcquisitionPolicyEdgeSchema.parse({
    edgeId: 'edge-1',
    schemaVersion: '1.0.0',
    actor: { kind: 'user', namespace: 'user', id: 'alice' },
    operation: 'manualImport',
    route: 'user_supplied',
    target: { kind: 'publisher', sourceId: 'acme' },
    state: 'permitted',
    effect: 'authorized_operation',
    revision: 'r1',
    evidenceRefs: [],
    reviewedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  });
}

function manualEdges(target: Record<string, unknown> = { kind: 'publisher', sourceId: 'acme' }) {
  const m = edge({ edgeId: 'manual-import', operation: 'manualImport', target });
  const c = edge({ edgeId: 'manual-content', operation: 'userSuppliedContent', target });
  return { m, c };
}

function fetchEdge(overrides: Record<string, unknown> = {}) {
  return AcquisitionPolicyEdgeSchema.parse({
    edgeId: 'fetch-edge',
    schemaVersion: '1.0.0',
    actor: { kind: 'user', namespace: 'user', id: 'alice' },
    operation: 'automatedFetch',
    route: 'direct',
    target: { kind: 'publisher', sourceId: 'acme', normalizedHost: 'example.test' },
    state: 'permitted',
    effect: 'authorized_operation',
    revision: 'r1',
    evidenceRefs: [],
    reviewedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  });
}

// constants
test('MANUAL_IMPORT_ADAPTER_ID is manual', () => {
  assert.equal(MANUAL_IMPORT_ADAPTER_ID, 'manual');
});

test('MANUAL_IMPORT_ADAPTER_VERSION is 1.0.0', () => {
  assert.equal(MANUAL_IMPORT_ADAPTER_VERSION, '1.0.0');
});

// static import allowlist and zero-network
test('manualImport static imports allowlist and zero network seam', () => {
  const p = path.resolve('src/jobs/acquisition/adapters/manualImport.ts');
  const src = fs.readFileSync(p, 'utf8');
  const staticImportRe = /import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g;
  const specifiers: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = staticImportRe.exec(src)) !== null) specifiers.push(m[1]!);
  const allow = new Set([
    'zod/v4',
    '../contracts.js',
    '../adapterSupport.js',
    '../../domain/ids.js',
    '../../../errors.js',
  ]);
  for (const s of specifiers) assert.ok(allow.has(s), `unexpected import ${s}`);
  assert.equal(/\bimport\s*\(/.test(src), false, 'no dynamic import');
  assert.equal(/\bsafeFetch\s*\(/.test(src), false, 'no safeFetch');
  // fetch as function call - allow fetchOutcome string but not fetch(
  // ensure no direct fetch( invocation
  const fetchCall = /\bfetch\s*\(/.test(src);
  // fetchOutcome contains fetch but not fetch(
  assert.equal(fetchCall, false, 'no fetch(');
  assert.equal(src.includes('fs.'), false, 'no fs');
  assert.equal(src.includes('readFile'), false, 'no readFile');
  assert.equal(src.includes('writeFile'), false, 'no writeFile');
  assert.equal(/\bconsole\./.test(src), false, 'no console');
});

test('runManualImport is synchronous with single param no deps', () => {
  assert.equal(typeof runManualImport, 'function');
  assert.equal(runManualImport.length, 1, 'single param no deps');
  const src = fs.readFileSync(
    path.resolve('src/jobs/acquisition/adapters/manualImport.ts'),
    'utf8',
  );
  assert.equal(src.includes('async runManualImport'), false, 'must be synchronous');
  assert.match(src, /export function runManualImport/);
});

test('ManualImportRequestSchema strict rejects extra fields file/path/binary', () => {
  const { m, c } = manualEdges();
  const base: Record<string, unknown> = {
    slice: slice(),
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'hello' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  };
  assert.equal(ManualImportRequestSchema.safeParse({ ...base, filePath: '/tmp/x' }).success, false);
  assert.equal(
    ManualImportRequestSchema.safeParse({ ...base, binary: Buffer.from('hi') }).success,
    false,
  );
  assert.equal(
    ManualImportRequestSchema.safeParse({ ...base, path: '/etc/passwd' }).success,
    false,
  );
});

test('inline_text imported produces valid manual slice', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const res = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'Hello world' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  assert.equal(res.status, 'imported');
  assert.deepEqual(res.caveats, ['unverified_manual_content']);
  assert.equal(res.sliceResult.candidates.length, 1);
  assert.equal(res.sliceResult.coverage.length, 1);
  assert.equal(res.sliceResult.coverage[0]!.adapterId, 'manual');
  assert.equal(res.sliceResult.coverage[0]!.state, 'succeeded');
  assert.equal(res.sliceResult.coverage[0]!.resultState, 'results');
  assert.equal(res.sliceResult.coverage[0]!.logicalRequestsUsed, 0);
  assert.equal(res.sliceResult.coverage[0]!.attemptsReserved, 0);
  assert.equal(res.sliceResult.policyEdges.length, 2);
  assert.equal(ManualImportResultSchema.safeParse(res).success, true);
  assert.equal(AcquisitionSliceResultSchema.safeParse(res.sliceResult).success, true);
  const cand = res.sliceResult.candidates[0]! as Record<string, unknown>;
  assert.equal(cand.state, 'manual_content');
  assert.equal((cand.policyEdgeRefs as string[]).length, 2);
  assert.ok((cand.policyEdgeRefs as string[]).includes('manual-import'));
  assert.ok((cand.policyEdgeRefs as string[]).includes('manual-content'));
  assert.equal((cand.evidenceRefs as string[]).length, 1);
  const ev = res.sliceResult.evidence[0]! as Record<string, unknown>;
  assert.equal(ev.kind, 'user_supplied_content');
  assert.equal(
    (ev as { submittedBy: { namespace: string; id: string } }).submittedBy.namespace,
    'user',
  );
  assert.equal(res.sliceResult.observations.length, 1);
  const env = res.sliceResult.observations[0]! as Record<string, unknown>;
  const acq = (env as { acquisition: Record<string, unknown> }).acquisition;
  assert.equal(acq.captureKind, 'manual_content');
  assert.equal((acq.policyEdgeRefs as string[]).length, 2);
});

test('structured_fields imported produces valid slice', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const res = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: {
      kind: 'structured_fields',
      title: 'Engineer',
      company: 'Acme',
      description: 'Build stuff',
      requirements: ['req1', 'req2'],
    },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  assert.equal(res.status, 'imported');
  assert.equal(AcquisitionSliceResultSchema.safeParse(res.sliceResult).success, true);
  assert.equal(res.sliceResult.candidates.length, 1);
});

test('publisher only from manual edge target not caller text', () => {
  const { m, c } = manualEdges({ kind: 'publisher', sourceId: 'acme' });
  const s = slice();
  const res = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'structured_fields', title: 'Evil', company: 'evil-corp' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  const cand = res.sliceResult.candidates[0]! as {
    provenance: { publisher?: { sourceId: string } };
  };
  assert.equal(cand.provenance.publisher!.sourceId, 'acme');
  // try to spoof via structured field company should not affect publisher
  assert.notEqual(cand.provenance.publisher!.sourceId, 'evil-corp');
});

test('publisher absent when adapter/manual target', () => {
  const { m, c } = manualEdges({ kind: 'adapter', sourceId: 'manual' });
  const s = slice();
  const res = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'hello' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  const cand = res.sliceResult.candidates[0]! as { provenance: { publisher?: unknown } };
  assert.equal(cand.provenance.publisher, undefined);
});

test('edges must be distinct refs', () => {
  const e = edge({ edgeId: 'same', operation: 'manualImport' });
  const e2 = edge({ edgeId: 'same', operation: 'userSuppliedContent' });
  const s = slice();
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'inline_text', text: 'hi' },
        manualImportEdge: e,
        userSuppliedContentEdge: e2,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('actor mismatch throws VALIDATION_ERROR', () => {
  const { m } = manualEdges();
  const bad = edge({
    edgeId: 'manual-content',
    operation: 'userSuppliedContent',
    actor: { kind: 'user', namespace: 'other', id: 'alice' },
  });
  const s = slice();
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'inline_text', text: 'hi' },
        manualImportEdge: m,
        userSuppliedContentEdge: bad,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('route mismatch throws', () => {
  const { m } = manualEdges();
  const bad = edge({ edgeId: 'manual-content', operation: 'userSuppliedContent', route: 'direct' });
  const s = slice();
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'inline_text', text: 'hi' },
        manualImportEdge: m,
        userSuppliedContentEdge: bad,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('effect mismatch throws', () => {
  const { m } = manualEdges();
  const bad = edge({
    edgeId: 'manual-content',
    operation: 'userSuppliedContent',
    effect: 'informational_capability',
  });
  const s = slice();
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'inline_text', text: 'hi' },
        manualImportEdge: m,
        userSuppliedContentEdge: bad,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('operation mismatch throws', () => {
  const { m } = manualEdges();
  const bad = edge({ edgeId: 'manual-content', operation: 'manualImport' as unknown as string });
  const s = slice();
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'inline_text', text: 'hi' },
        manualImportEdge: m,
        userSuppliedContentEdge: bad,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('target mismatch throws', () => {
  const m = edge({
    edgeId: 'manual-import',
    operation: 'manualImport',
    target: { kind: 'publisher', sourceId: 'acme' },
  });
  const c = edge({
    edgeId: 'manual-content',
    operation: 'userSuppliedContent',
    target: { kind: 'publisher', sourceId: 'other' },
  });
  const s = slice();
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'inline_text', text: 'hi' },
        manualImportEdge: m,
        userSuppliedContentEdge: c,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('non-permitted manual edges map to exact coverage', () => {
  const s = slice();
  const cases: Array<{ state: string; expected: string }> = [
    { state: 'blocked', expected: 'policy_blocked' },
    { state: 'requires_configuration', expected: 'disabled' },
    { state: 'requires_review', expected: 'disabled' },
    { state: 'not_supported', expected: 'not_supported' },
  ];
  for (const { state, expected } of cases) {
    const m = edge({ edgeId: 'manual-import', operation: 'manualImport', state });
    const c = edge({
      edgeId: 'manual-content',
      operation: 'userSuppliedContent',
      target: { kind: 'publisher', sourceId: 'acme' },
    });
    const res = runManualImport({
      slice: s,
      capturedAt: '2026-01-01T00:00:00Z',
      submittedBy: { namespace: 'user', id: 'alice' },
      content: { kind: 'inline_text', text: 'hi' },
      manualImportEdge: m,
      userSuppliedContentEdge: c,
    });
    assert.equal(res.status, 'not_executed');
    assert.equal(res.sliceResult.candidates.length, 0);
    assert.equal(res.sliceResult.evidence.length, 0);
    assert.equal(res.sliceResult.observations.length, 0);
    assert.equal(res.sliceResult.coverage[0]!.state, expected);
    assert.equal(res.sliceResult.coverage[0]!.resultState, 'unknown');
    assert.equal(res.sliceResult.coverage[0]!.candidatesProduced, 0);
    assert.equal(res.sliceResult.coverage[0]!.logicalRequestsUsed, 0);
    assert.equal(res.sliceResult.coverage[0]!.attemptsReserved, 0);
    assert.equal(res.sliceResult.coverage[0]!.bytesUsed, 0);
    assert.equal(ManualImportResultSchema.safeParse(res).success, true);
    assert.equal(AcquisitionSliceResultSchema.safeParse(res.sliceResult).success, true);
    // second edge blocked
    const m2 = edge({ edgeId: 'manual-import', operation: 'manualImport' });
    const c2 = edge({ edgeId: 'manual-content', operation: 'userSuppliedContent', state });
    const res2 = runManualImport({
      slice: s,
      capturedAt: '2026-01-01T00:00:00Z',
      submittedBy: { namespace: 'user', id: 'alice' },
      content: { kind: 'inline_text', text: 'hi' },
      manualImportEdge: m2,
      userSuppliedContentEdge: c2,
    });
    assert.equal(res2.status, 'not_executed');
    assert.equal((res2 as { reason: string }).reason, 'user_content_not_permitted');
  }
});

test('URL-only missing fetch returns content_required zero artifacts', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const res = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'url_only', destinationUrl: 'https://example.test/job/1' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  assert.equal(res.status, 'content_required');
  assert.deepEqual(res.caveats, ['content_required']);
  assert.equal(res.sliceResult.candidates.length, 0);
  assert.equal(res.sliceResult.evidence.length, 0);
  assert.equal(res.sliceResult.observations.length, 0);
  assert.equal(res.sliceResult.coverage[0]!.state, 'succeeded');
  assert.equal(res.sliceResult.coverage[0]!.resultState, 'no_results');
  assert.equal(res.sliceResult.coverage[0]!.errorCode, 'CONTENT_REQUIRED');
  assert.equal(ManualImportResultSchema.safeParse(res).success, true);
});

test('URL-only non-permitted fetch returns content_required', () => {
  const { m, c } = manualEdges();
  const s = slice();
  for (const state of [
    'blocked',
    'requires_configuration',
    'requires_review',
    'not_supported',
  ] as const) {
    const f = fetchEdge({ state });
    const res = runManualImport({
      slice: s,
      capturedAt: '2026-01-01T00:00:00Z',
      submittedBy: { namespace: 'user', id: 'alice' },
      content: { kind: 'url_only', destinationUrl: 'https://example.test/job/2' },
      manualImportEdge: m,
      userSuppliedContentEdge: c,
      destinationFetchEdge: f,
    });
    assert.equal(res.status, 'content_required');
    assert.equal(res.sliceResult.candidates.length, 0);
    assert.equal(res.sliceResult.evidence.length, 0);
    assert.equal(res.sliceResult.observations.length, 0);
    assert.equal(res.sliceResult.coverage[0]!.errorCode, 'CONTENT_REQUIRED');
  }
});

test('URL-only permitted fetch returns destination_fetch_required bounded', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const f = fetchEdge({ edgeId: 'fetch-edge', state: 'permitted' });
  const res = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'url_only', destinationUrl: 'https://example.test/job/3#frag' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
    destinationFetchEdge: f,
  });
  assert.equal(res.status, 'destination_fetch_required');
  if (res.status === 'destination_fetch_required') {
    assert.equal(res.caveats.length, 0);
    assert.equal(res.priorFetchEdgeRef, 'fetch-edge');
    assert.equal(res.policyRecheckRequired, true);
    assert.equal(res.destination.canonicalUrl, 'https://example.test/job/3');
    assert.equal(res.destination.normalizedHost, 'example.test');
    assert.ok(res.destination.rawUrl.includes('example.test'));
    assert.equal(res.sliceResult.candidates.length, 0);
    assert.equal(res.sliceResult.evidence.length, 0);
    assert.equal(res.sliceResult.observations.length, 0);
    assert.equal(res.sliceResult.coverage.length, 1);
    assert.equal(res.sliceResult.coverage[0]!.adapterId, 'manual');
    assert.equal(res.sliceResult.coverage[0]!.errorCode, 'DESTINATION_FETCH_REQUIRED');
    assert.equal(res.sliceResult.coverage[0]!.state, 'succeeded');
    assert.equal(res.sliceResult.coverage[0]!.resultState, 'no_results');
  }
  assert.equal(ManualImportResultSchema.safeParse(res).success, true);
  assert.equal(AcquisitionSliceResultSchema.safeParse(res.sliceResult).success, true);
});

test('unrelated-host edge returns content_required zero artifacts', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const f = fetchEdge({
    edgeId: 'fetch-unrelated',
    target: { kind: 'publisher', sourceId: 'other', normalizedHost: 'unrelated.test' },
  });
  const res = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'url_only', destinationUrl: 'https://example.test/job/9' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
    destinationFetchEdge: f,
  });
  assert.equal(res.status, 'content_required');
  assert.equal(res.sliceResult.candidates.length, 0);
  assert.equal(res.sliceResult.evidence.length, 0);
  assert.equal(res.sliceResult.observations.length, 0);
  assert.equal(res.sliceResult.coverage[0]!.errorCode, 'CONTENT_REQUIRED');
  assert.equal(ManualImportResultSchema.safeParse(res).success, true);
});

test('exact publisher-identity alternate edge still permitted despite host mismatch', () => {
  const { m, c } = manualEdges({ kind: 'publisher', sourceId: 'acme' });
  const s = slice();
  const f = fetchEdge({
    edgeId: 'fetch-alt',
    target: { kind: 'publisher', sourceId: 'acme', normalizedHost: 'other.test' },
  });
  const res = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'url_only', destinationUrl: 'https://example.test/job/10' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
    destinationFetchEdge: f,
  });
  assert.equal(res.status, 'destination_fetch_required');
  if (res.status === 'destination_fetch_required') {
    assert.equal(res.priorFetchEdgeRef, 'fetch-alt');
    assert.equal(res.policyRecheckRequired, true);
    assert.equal(res.sliceResult.candidates.length, 0);
    assert.equal(res.sliceResult.evidence.length, 0);
    assert.equal(res.sliceResult.observations.length, 0);
    assert.equal(res.sliceResult.coverage[0]!.errorCode, 'DESTINATION_FETCH_REQUIRED');
  }
  assert.equal(ManualImportResultSchema.safeParse(res).success, true);
});

test('inline URL metadata never fetches destination', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const res = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'hello', destinationUrl: 'https://example.test/a' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  assert.equal(res.status, 'imported');
  // no destination evidence added, only user evidence
  assert.equal(res.sliceResult.evidence[0]!.kind, 'user_supplied_content');
  // provenance destination present as metadata only
  const cand = res.sliceResult.candidates[0]! as {
    provenance: { destination?: { canonicalUrl: string } };
  };
  assert.equal(cand.provenance.destination!.canonicalUrl, 'https://example.test/a');
  // no fetch edge in candidate refs
  const ce = res.sliceResult.candidates[0]! as { policyEdgeRefs: string[] };
  assert.equal(ce.policyEdgeRefs.length, 2);
  assert.ok(!ce.policyEdgeRefs.includes('fetch-edge'));
});

test('oversized inline text rejects', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const big = 'a'.repeat(32769);
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'inline_text', text: big },
        manualImportEdge: m,
        userSuppliedContentEdge: c,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('empty inline text rejects', () => {
  const { m, c } = manualEdges();
  const s = slice();
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'inline_text', text: '   ' },
        manualImportEdge: m,
        userSuppliedContentEdge: c,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('structured empty rejects', () => {
  const { m, c } = manualEdges();
  const s = slice();
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'structured_fields' },
        manualImportEdge: m,
        userSuppliedContentEdge: c,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('requirements bounds enforced', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const many = Array.from({ length: 33 }, () => 'req');
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'structured_fields', title: 't', requirements: many },
        manualImportEdge: m,
        userSuppliedContentEdge: c,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
  const longReq = 'a'.repeat(1025);
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'structured_fields', title: 't', requirements: [longReq] },
        manualImportEdge: m,
        userSuppliedContentEdge: c,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('URL credential rejects', () => {
  const { m, c } = manualEdges();
  const s = slice();
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: {
          kind: 'inline_text',
          text: 'hi',
          destinationUrl: 'https://user:pass@example.test/a',
        },
        manualImportEdge: m,
        userSuppliedContentEdge: c,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'url_only', destinationUrl: 'https://user:pass@example.test/a' },
        manualImportEdge: m,
        userSuppliedContentEdge: c,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('slice candidate/byte budgets enforced', () => {
  const { m, c } = manualEdges();
  const smallBytes = slice({
    budget: {
      logicalRequests: 10,
      reservedAttempts: 10,
      candidates: 10,
      bytes: 1,
      milliseconds: 60000,
    },
  });
  assert.throws(
    () =>
      runManualImport({
        slice: smallBytes,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'inline_text', text: 'hello world' },
        manualImportEdge: m,
        userSuppliedContentEdge: c,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('deterministic IDs and hashes', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const r1 = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'deterministic text' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  const r2 = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'deterministic text' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  assert.equal(
    r1.sliceResult.candidates[0]!.candidateId,
    r2.sliceResult.candidates[0]!.candidateId,
  );
  assert.equal(r1.sliceResult.evidence[0]!.evidenceId, r2.sliceResult.evidence[0]!.evidenceId);
  assert.equal(
    r1.sliceResult.observations[0]!.envelopeId,
    r2.sliceResult.observations[0]!.envelopeId,
  );
  const ev1 = r1.sliceResult.evidence[0]! as { contentHash: string; boundedText: string };
  const expectedHash = acquiredContentHash('deterministic text');
  assert.equal(ev1.contentHash, expectedHash);
  // different text -> different ids
  const r3 = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'other text' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  assert.notEqual(
    r1.sliceResult.candidates[0]!.candidateId,
    r3.sliceResult.candidates[0]!.candidateId,
  );
});

test('manual candidate has only user evidence exactly two manual refs unverified caveat manual envelope deterministic hash no fetch', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const res = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'content' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  const cand = res.sliceResult.candidates[0]! as Record<string, unknown>;
  assert.deepEqual(cand.caveats, ['unverified_manual_content']);
  // only user evidence
  assert.equal(res.sliceResult.evidence.length, 1);
  assert.equal((res.sliceResult.evidence[0] as { kind: string }).kind, 'user_supplied_content');
  // no destination evidence
  assert.ok(
    !res.sliceResult.evidence.some((e) => (e as { kind: string }).kind === 'destination_content'),
  );
  // observation
  const env = res.sliceResult.observations[0]! as {
    acquisition: { captureKind: string; policyEdgeRefs: string[] };
    observation: {
      extractionVersion: string;
      adapterVersion: string;
      fetchOutcome: string;
      sourceConfidence: Record<string, number>;
    };
  };
  assert.equal(env.acquisition.captureKind, 'manual_content');
  assert.equal(env.acquisition.policyEdgeRefs.length, 2);
  assert.equal(env.observation.extractionVersion, 'manual-import-v1');
  assert.equal(env.observation.adapterVersion, '1.0.0');
  assert.equal(env.observation.fetchOutcome, 'success');
  assert.deepEqual(env.observation.sourceConfidence, { user_supplied: 1 });
  // hash matches
  const ev = res.sliceResult.evidence[0]! as { contentHash: string; boundedText: string };
  assert.equal(ev.contentHash, acquiredContentHash(ev.boundedText));
  // no fetch edge
  assert.equal((cand as { manualImportEdgeRef: string }).manualImportEdgeRef, 'manual-import');
  assert.equal(
    (cand as { userSuppliedContentEdgeRef: string }).userSuppliedContentEdgeRef,
    'manual-content',
  );
  assert.equal((cand as { policyEdgeRefs: string[] }).policyEdgeRefs.includes('fetch-edge'), false);
});

test('submittedBy namespace/id bounded', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const longNs = 'a'.repeat(129);
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: longNs, id: 'alice' },
        content: { kind: 'inline_text', text: 'hi' },
        manualImportEdge: m,
        userSuppliedContentEdge: c,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});

test('complete outcomes and slice pass schemas', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const imported = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'hi' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  assert.equal(ManualImportResultSchema.safeParse(imported).success, true);
  const blockedM = edge({ edgeId: 'manual-import', operation: 'manualImport', state: 'blocked' });
  const notExec = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'hi' },
    manualImportEdge: blockedM,
    userSuppliedContentEdge: c,
  });
  assert.equal(ManualImportResultSchema.safeParse(notExec).success, true);
  const urlOnly = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'url_only', destinationUrl: 'https://example.test/a' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  assert.equal(ManualImportResultSchema.safeParse(urlOnly).success, true);
  const f = fetchEdge();
  const fetchReq = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'url_only', destinationUrl: 'https://example.test/a' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
    destinationFetchEdge: f,
  });
  assert.equal(ManualImportResultSchema.safeParse(fetchReq).success, true);
});

test('always one manual coverage zero requests attempts', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const cases = [
    runManualImport({
      slice: s,
      capturedAt: '2026-01-01T00:00:00Z',
      submittedBy: { namespace: 'user', id: 'alice' },
      content: { kind: 'inline_text', text: 'hi' },
      manualImportEdge: m,
      userSuppliedContentEdge: c,
    }),
    runManualImport({
      slice: s,
      capturedAt: '2026-01-01T00:00:00Z',
      submittedBy: { namespace: 'user', id: 'alice' },
      content: { kind: 'url_only', destinationUrl: 'https://example.test/a' },
      manualImportEdge: m,
      userSuppliedContentEdge: c,
    }),
    runManualImport({
      slice: s,
      capturedAt: '2026-01-01T00:00:00Z',
      submittedBy: { namespace: 'user', id: 'alice' },
      content: { kind: 'url_only', destinationUrl: 'https://example.test/a' },
      manualImportEdge: m,
      userSuppliedContentEdge: c,
      destinationFetchEdge: fetchEdge(),
    }),
  ];
  for (const r of cases) {
    assert.equal(r.sliceResult.coverage.length, 1);
    assert.equal(r.sliceResult.coverage[0]!.adapterId, 'manual');
    assert.equal(r.sliceResult.coverage[0]!.logicalRequestsUsed, 0);
    assert.equal(r.sliceResult.coverage[0]!.attemptsReserved, 0);
  }
  const blocked = edge({ edgeId: 'manual-import', operation: 'manualImport', state: 'blocked' });
  const notExec = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'hi' },
    manualImportEdge: blocked,
    userSuppliedContentEdge: c,
  });
  assert.equal(notExec.sliceResult.coverage[0]!.logicalRequestsUsed, 0);
  assert.equal(notExec.sliceResult.coverage[0]!.attemptsReserved, 0);
});

test('zero-network by API inspection no fetch edge/evidence/publisher fact added', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const res = runManualImport({
    slice: s,
    capturedAt: '2026-01-01T00:00:00Z',
    submittedBy: { namespace: 'user', id: 'alice' },
    content: { kind: 'inline_text', text: 'hi', destinationUrl: 'https://example.test/a' },
    manualImportEdge: m,
    userSuppliedContentEdge: c,
  });
  // no fetch edge evidence publisher fact: evidence kind remains user_supplied_content only
  assert.ok(
    res.sliceResult.evidence.every((e) => (e as { kind: string }).kind === 'user_supplied_content'),
  );
  // no third manual edge
  assert.equal(res.sliceResult.candidates[0]!.policyEdgeRefs.length, 2);
  // no destination_content
  assert.equal(
    res.sliceResult.evidence.some((e) => (e as { kind: string }).kind === 'destination_content'),
    false,
  );
});

test('deterministicAcquisitionId uses contract version', () => {
  const id = deterministicAcquisitionId('candidate', ['test']);
  const expected = `candidate:${createHash('sha256')
    .update(JSON.stringify([ACQUISITION_CONTRACT_VERSION, 'test']), 'utf8')
    .digest('hex')}`;
  assert.equal(id, expected);
});

test('normalizeHttpUrlMetadata lowercases host and strips fragment', () => {
  const meta = normalizeHttpUrlMetadata('https://EXAMPLE.TEST/path#frag');
  assert.ok(meta);
  assert.equal(meta!.normalizedHost, 'example.test');
  assert.equal(meta!.canonicalUrl.includes('#'), false);
});

test('rendered structured max 32768 enforced', () => {
  const { m, c } = manualEdges();
  const s = slice();
  const bigDesc = 'a'.repeat(32769);
  assert.throws(
    () =>
      runManualImport({
        slice: s,
        capturedAt: '2026-01-01T00:00:00Z',
        submittedBy: { namespace: 'user', id: 'alice' },
        content: { kind: 'structured_fields', description: bigDesc },
        manualImportEdge: m,
        userSuppliedContentEdge: c,
      }),
    (err: unknown) => isToolError(err) && err.code === 'VALIDATION_ERROR',
  );
});
