import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SYDNEY_BASELINE_CASES,
  validateCaseSet,
  type SydneyBaselineCase,
} from './sydneyBaselineCases.js';
import {
  MAX_PERSISTED_WARNINGS,
  captureRecordingForCase,
  runSydneyBaselineHarness,
  verifyBundleIntegrity,
  verifyCodeIdentity,
  computeCodeIdentity,
  cloneBoundaryResponse,
  projectWarnings,
  replayCaseRun,
} from './sydneyBaselineHarness.js';

// The harness report is computed once for the whole file; every test below
// inspects the same deterministic run. No live network: all provider boundary
// calls are synthetic fixtures served by injectable ports.
const harness = await runSydneyBaselineHarness();

function caseById(caseId: string): SydneyBaselineCase {
  const found = SYDNEY_BASELINE_CASES.find((c) => c.caseId === caseId);
  assert.ok(found !== undefined, `expected case ${caseId} to exist`);
  return found;
}

// ---------------------------------------------------------------------------
// 36-case fixture set integrity
// ---------------------------------------------------------------------------

test('baseline case set is complete: 36 cases, 6 per cohort, unique ids', () => {
  assert.equal(SYDNEY_BASELINE_CASES.length, 36);
  assert.doesNotThrow(() => validateCaseSet(SYDNEY_BASELINE_CASES));
  for (const c of SYDNEY_BASELINE_CASES) {
    assert.ok(c.query.length > 0, `${c.caseId} must carry a query`);
    assert.ok(c.expectedBehavior.length > 0, `${c.caseId} must declare expected behavior`);
    // No relevance labels: expectations are behavioral strings only.
    // Structural contract: an array of non-empty behavior strings.
    assert.ok(Array.isArray(c.expectedBehavior), `${c.caseId} expectations must be an array`);
    for (const line of c.expectedBehavior) {
      assert.equal(typeof line, 'string', `${c.caseId} expectation must be a string`);
      assert.ok(line.length > 0, `${c.caseId} expectation must be non-empty`);
    }
    const joined = c.expectedBehavior.join(' ');
    assert.ok(
      !/relevant|relevance grade|graded/i.test(joined),
      `${c.caseId} expectations must not assert relevance labels`,
    );
    // Numeric score tokens are labels by another name (e.g. "score 4",
    // "grade: 3", "2/5") — never in behavioral expectations.
    assert.ok(
      !/(score|grade)\s*[:=]?\s*\d|\b\d\s*\/\s*\d/i.test(joined),
      `${c.caseId} expectations must not assert numeric score labels`,
    );
    // Optional synthetic profile evidence only; never real resume data.
    assert.equal(c.syntheticProfileEvidence, null);
  }
});

test('incomplete case set is rejected', () => {
  assert.throws(() => validateCaseSet(SYDNEY_BASELINE_CASES.slice(1)), /CASE_SET_INCOMPLETE/);
});

// ---------------------------------------------------------------------------
// Deterministic re-execution (record → replay, compare actual outputs)
// ---------------------------------------------------------------------------

test('harness executes all 36 cases with explicit per-case outcomes', () => {
  assert.equal(harness.bundle.cases.length, 36);
  const completed = harness.bundle.cases.filter((c) => c.outcome === 'completed').length;
  const failed = harness.bundle.cases.filter((c) => c.outcome === 'failed').length;
  assert.equal(completed + failed, 36);
  // Fixture scenarios: exactly one unavailable-provider case and one
  // empty-success case exercise the failure/empty distinction.
  assert.equal(
    harness.bundle.cases.filter((c) => c.providerScenario === 'unavailable').length,
    1,
  );
  assert.equal(harness.bundle.cases.filter((c) => c.providerScenario === 'ok_empty').length, 1);
});

test('deterministic re-execution: record and replay normalized outputs match', () => {
  // runSydneyBaselineHarness throws DETERMINISM_MISMATCH unless every case's
  // record run and replay run produce identical normalized outputs; reaching
  // here proves the comparison ran against two independent executions.
  assert.ok(harness.bundle.contentHash.length === 64);
});

test('recording preserves acquisition request identity across replay', () => {
  for (const c of harness.bundle.cases) {
    assert.ok(c.boundaryCalls.length >= 1, `${c.caseId} must record boundary calls`);
    for (const call of c.boundaryCalls) {
      assert.match(call.argsHash, /^[0-9a-f]{64}$/u);
      assert.equal(call.consumedInReplay, true, `${c.caseId} replay must consume every call`);
    }
  }
});

test('missing or mismatched replay provider calls are rejected', async () => {
  const c = caseById('pub-01');
  // Mismatched argsHash → replay cannot find the recorded call.
  const tampered = await captureRecordingForCase(c);
  assert.ok(tampered.recording.calls.length >= 1);
  tampered.recording.calls[0]!.argsHash = '0'.repeat(64);
  await assert.rejects(
    () => replayCaseRun(c, tampered.recording),
    /REPLAY_(MISMATCH|INCOMPLETE)/,
  );
  // Missing recorded call → replay cannot satisfy the request.
  const missing = await captureRecordingForCase(c);
  missing.recording.calls = [];
  await assert.rejects(
    () => replayCaseRun(c, missing.recording),
    /REPLAY_(MISMATCH|INCOMPLETE)/,
  );
});

// ---------------------------------------------------------------------------
// Explicit failure outcomes vs successful empty outputs
// ---------------------------------------------------------------------------

test('unavailable provider yields explicit failure, never an empty success', () => {
  const failed = harness.bundle.cases.find((c) => c.providerScenario === 'unavailable');
  assert.ok(failed !== undefined);
  assert.equal(failed.outcome, 'failed');
  assert.ok(failed.errorCode !== undefined);
  assert.equal(failed.boundaryFailureCount, 1);
  assert.equal(failed.boundaryEmptySuccessCount, 0);
});

test('empty provider success is reported distinctly from provider failure', () => {
  const empty = harness.bundle.cases.find((c) => c.providerScenario === 'ok_empty');
  assert.ok(empty !== undefined);
  // Boundary succeeded with zero results; pipeline then reports the explicit
  // NO_CANDIDATES failure. The harness must not conflate the two outcomes.
  assert.equal(empty.boundaryEmptySuccessCount, 1);
  assert.equal(empty.boundaryFailureCount, 0);
  assert.equal(empty.outcome, 'failed');
  assert.equal(empty.errorCode, 'NO_CANDIDATES');
});

// ---------------------------------------------------------------------------
// Privacy: sanitization precedes persistence
// ---------------------------------------------------------------------------

test('persisted warnings use bounded safe projection with omission accounting', () => {
  const completed = harness.bundle.cases.find((c) => c.scrubbedResult !== undefined);
  assert.ok(completed?.scrubbedResult);
  const warnings = (completed.scrubbedResult as { warnings: unknown }).warnings;
  assert.deepEqual(warnings, { retained: [], omittedCount: 0, truncated: false });
});

test('projectWarnings omits unsafe tokens with accurate omission accounting', () => {
  const out = projectWarnings(['ok:1', 'HAS SPACE', 'UPPER', 'has space', 'a'.repeat(200)]);
  assert.deepEqual(out.retained, ['ok:1']);
  assert.equal(out.omittedCount, 4);
  assert.equal(out.truncated, false);
});

test('projectWarnings retains only the allowed safe warnings past the cap', () => {
  const warnings = Array.from({ length: MAX_PERSISTED_WARNINGS + 5 }, (_, i) => `w:${i}`);
  const out = projectWarnings(warnings);
  assert.equal(out.retained.length, MAX_PERSISTED_WARNINGS);
  assert.deepEqual(out.retained, warnings.slice(0, MAX_PERSISTED_WARNINGS));
  assert.equal(out.omittedCount, 5);
  assert.equal(out.truncated, true);
});

test('persisted artifact contains only allowlisted fields (no PII, no config)', () => {
  const raw = harness.artifactJson;
  const forbidden = [
    'title',
    'organisation',
    'description',
    'listingurl',
    'applyurl',
    'salarytext',
    'salary',
    'location',
    'email',
    'phone',
    'token',
    'apikey',
    'api_key',
    'password',
    'config',
    'env',
  ];
  const walk = (node: unknown, keyPath: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, keyPath);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const lower = k.toLowerCase();
      assert.ok(
        !forbidden.some((f) => lower === f || lower.endsWith(f)),
        `forbidden key '${keyPath}.${k}' in persisted artifact`,
      );
      walk(v, `${keyPath}.${k}`);
    }
  };
  walk(raw, '$');
});

// ---------------------------------------------------------------------------
// Integrity: tamper + code drift rejection
// ---------------------------------------------------------------------------

test('evidence bundle tampering is rejected', () => {
  assert.doesNotThrow(() => verifyBundleIntegrity(harness.bundle));
  const tampered = structuredClone(harness.bundle);
  const firstCase = tampered.cases[0];
  assert.ok(firstCase !== undefined);
  firstCase.outcome = firstCase.outcome === 'completed' ? 'failed' : 'completed';
  assert.throws(() => verifyBundleIntegrity(tampered), /EVIDENCE_TAMPER/);
});

test('boundary response clones isolate record and replay mutations', () => {
  const original = [{ title: 'synthetic', url: 'https://fixtures.test/1' } as never];
  const clone = cloneBoundaryResponse(original);
  assert.notEqual(clone, original);
  const originalItem = original[0];
  const cloneItem = clone[0];
  assert.ok(originalItem);
  assert.ok(cloneItem);
  assert.notEqual(cloneItem, originalItem);
  (cloneItem as { title: string }).title = 'mutated';
  assert.equal((originalItem as { title: string }).title, 'synthetic');
});

test('dirty-to-dirty source drift changes fingerprint in synthetic repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-identity-'));
  fs.mkdirSync(path.join(root, 'src/jobs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/jobs/pipeline.ts'), 'export const pipeline = 1;\n');
  fs.writeFileSync(path.join(root, 'src/config.ts'), 'export const config = 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"synthetic"}\n');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'synthetic@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Synthetic'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  fs.writeFileSync(path.join(root, 'src/jobs/pipeline.ts'), 'export const pipeline = 2;\n');
  const before = computeCodeIdentity([], root);
  fs.writeFileSync(path.join(root, 'src/jobs/pipeline.ts'), 'export const pipeline = 3;\n');
  const after = computeCodeIdentity([], root);
  assert.equal(before.gitDirty, true);
  assert.equal(after.gitDirty, true);
  assert.notEqual(before.contentFingerprint, after.contentFingerprint);
});

test('code drift between capture and replay is rejected', () => {
  assert.doesNotThrow(() => verifyCodeIdentity(harness.bundle.metadata));
  const drifted = structuredClone(harness.bundle.metadata);
  drifted.contentFingerprint = 'f'.repeat(64);
  assert.throws(() => verifyCodeIdentity(drifted), /CODE_DRIFT/);
  const otherCommit = structuredClone(harness.bundle.metadata);
  otherCommit.gitCommit = 'deadbeef';
  assert.throws(() => verifyCodeIdentity(otherCommit), /CODE_DRIFT/);
});

// ---------------------------------------------------------------------------
// Stage 0 gate honesty: synthetic fixtures never satisfy the baseline gate
// ---------------------------------------------------------------------------

test('synthetic harness run does NOT satisfy the stage-0 baseline gate', () => {
  assert.equal(harness.bundle.gate.passed, false);
  assert.equal(harness.bundle.gate.syntheticOnly, true);
  assert.match(harness.bundle.gate.reason, /synthetic/i);
  assert.match(harness.bundle.gate.reason, /live capture/i);
});
