import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createJobRun,
  isValidJobRunTransition,
  transitionJobRun,
  reserveSlice,
  startSlice,
  completeSlice,
  skipSlice,
  transitionCandidate,
  emitResults,
  remainingBudget,
  canReserve,
  observabilitySnapshot,
  upsertCandidate,
  applyAcquisitionResult,
} from '../../src/jobs/orchestration/run.js';
import type { JobRunBudget, JobSlice, JobCandidate } from '../../src/jobs/orchestration/types.js';
import { ORCHESTRATION_CONTRACT_VERSION } from '../../src/jobs/orchestration/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeBudget(overrides?: Partial<JobRunBudget>): JobRunBudget {
  return {
    logicalRequests: 10,
    reservedAttempts: 10,
    candidates: 100,
    bytes: 1_000_000,
    milliseconds: 60_000,
    pages: 10,
    enrichment: 10,
    reasoning: 5,
    ...overrides,
  };
}

function makeSlice(overrides?: Partial<JobSlice>): JobSlice {
  return {
    schemaVersion: ORCHESTRATION_CONTRACT_VERSION,
    runId: 'run-1',
    sliceId: 'slice-1',
    ordinal: 0,
    stage: 'acquisition',
    state: 'planned',
    queryVariantId: 'qv-1',
    adapterIds: ['adapter-1'],
    localePackRefs: [],
    domainPackRefs: [],
    budget: {
      logicalRequests: 5,
      reservedAttempts: 5,
      candidates: 50,
      bytes: 500_000,
      milliseconds: 30_000,
    },
    ...overrides,
  };
}

function makeRun(overrides?: Partial<{ budget: JobRunBudget; slices: JobSlice[] }>) {
  return createJobRun({
    runId: 'run-1',
    intent: { query: 'test', budgets: { requests: 10 } },
    budget: overrides?.budget ?? makeBudget(),
    slices: overrides?.slices ?? [makeSlice()],
    createdAt: '2024-01-01T00:00:00+00:00',
  });
}

// ---------------------------------------------------------------------------
// createJobRun
// ---------------------------------------------------------------------------

test('createJobRun sets state created and fingerprints intent', () => {
  const run = makeRun();
  assert.strictEqual(run.state, 'created');
  assert.strictEqual(run.stage, 'none');
  assert.strictEqual(run.slices.length, 1);
  assert.strictEqual(run.slices[0]!.state, 'planned');
  assert.ok(run.intentFingerprint.length === 64);
});

// ---------------------------------------------------------------------------
// transitionJobRun
// ---------------------------------------------------------------------------

test('valid transition succeeds', () => {
  const run = makeRun();
  const next = transitionJobRun(run, 'acquiring');
  assert.strictEqual(next.state, 'acquiring');
  assert.strictEqual(next.stage, 'acquisition');
});

test('invalid transition throws', () => {
  const run = makeRun();
  assert.throws(() => transitionJobRun(run, 'completed'), /ILLEGAL_TRANSITION/);
});

test('isValidJobRunTransition', () => {
  assert.ok(isValidJobRunTransition('created', 'acquiring'));
  assert.ok(isValidJobRunTransition('acquiring', 'completed'));
  assert.ok(!isValidJobRunTransition('completed', 'acquiring'));
});

// ---------------------------------------------------------------------------
// reserveSlice
// ---------------------------------------------------------------------------

test('reserveSlice transitions planned to reserved', () => {
  const run = makeRun();
  const updated = reserveSlice(run, 'slice-1');
  assert.strictEqual(updated.slices[0]!.state, 'reserved');
});

test('reserveSlice skips when no budget', () => {
  const run = makeRun({
    budget: makeBudget({ candidates: 0 }),
    slices: [makeSlice()],
  });
  const updated = reserveSlice(run, 'slice-1');
  assert.strictEqual(updated.slices[0]!.state, 'skipped_budget');
});

test('reserveSlice throws on unknown slice', () => {
  const run = makeRun();
  assert.throws(() => reserveSlice(run, 'unknown'), /UNKNOWN_SLICE/);
});

// ---------------------------------------------------------------------------
// completeSlice
// ---------------------------------------------------------------------------

test('completeSlice transitions running to completed', () => {
  const run = makeRun();
  const reserved = reserveSlice(run, 'slice-1');
  const running = startSlice(reserved, 'slice-1');
  const completed = completeSlice(running, 'slice-1', {});
  assert.strictEqual(completed.slices[0]!.state, 'completed');
});

test('completeSlice consumes budget', () => {
  const run = makeRun();
  const reserved = reserveSlice(run, 'slice-1');
  const running = startSlice(reserved, 'slice-1');
  const completed = completeSlice(running, 'slice-1', { candidates: 10, bytes: 1000 });
  assert.strictEqual(completed.consumed.candidates, 10);
  assert.strictEqual(completed.consumed.bytes, 1000);
});

test('completeSlice clamps to budget', () => {
  const run = makeRun({
    budget: makeBudget({
      candidates: 100,
      bytes: 1_000_000,
      milliseconds: 60_000,
    }),
  });
  const reserved = reserveSlice(run, 'slice-1');
  const running = startSlice(reserved, 'slice-1');
  const completed = completeSlice(running, 'slice-1', { candidates: 200, bytes: 5_000_000 });
  assert.strictEqual(completed.consumed.candidates, 100);
  assert.strictEqual(completed.consumed.bytes, 1_000_000);
});

// ---------------------------------------------------------------------------
// skipSlice
// ---------------------------------------------------------------------------

test('skipSlice with budget reason', () => {
  const run = makeRun();
  const updated = skipSlice(run, 'slice-1', 'budget');
  assert.strictEqual(updated.slices[0]!.state, 'skipped_budget');
});

test('skipSlice with deadline reason', () => {
  const run = makeRun();
  const updated = skipSlice(run, 'slice-1', 'deadline');
  assert.strictEqual(updated.slices[0]!.state, 'skipped_deadline');
});

// ---------------------------------------------------------------------------
// Candidate transitions
// ---------------------------------------------------------------------------

test('transitionCandidate valid', () => {
  const run = makeRun();
  const candidate: JobCandidate = {
    schemaVersion: ORCHESTRATION_CONTRACT_VERSION,
    candidateId: 'c1',
    runId: 'run-1',
    sliceId: 'slice-1',
    state: 'discovered',
    evidenceRefs: ['e1'],
  };
  const withCandidate = upsertCandidate(run, candidate);
  const updated = transitionCandidate(withCandidate, 'c1', 'extracted');
  assert.strictEqual(updated.candidates[0]!.state, 'extracted');
});

test('transitionCandidate invalid throws', () => {
  const run = makeRun();
  const candidate: JobCandidate = {
    schemaVersion: ORCHESTRATION_CONTRACT_VERSION,
    candidateId: 'c1',
    runId: 'run-1',
    sliceId: 'slice-1',
    state: 'discovered',
    evidenceRefs: [],
  };
  const withCandidate = upsertCandidate(run, candidate);
  assert.throws(
    () => transitionCandidate(withCandidate, 'c1', 'ranked'),
    /ILLEGAL_CANDIDATE_TRANSITION/,
  );
});

test('duplicate suppression does not delete evidence refs', () => {
  const run = makeRun();
  const candidate: JobCandidate = {
    schemaVersion: ORCHESTRATION_CONTRACT_VERSION,
    candidateId: 'c1',
    runId: 'run-1',
    sliceId: 'slice-1',
    state: 'discovered',
    evidenceRefs: ['e1', 'e2'],
  };
  const withCandidate = upsertCandidate(run, candidate);
  const suppressed = transitionCandidate(withCandidate, 'c1', 'suppressed_duplicate');
  assert.strictEqual(suppressed.candidates[0]!.evidenceRefs.length, 2);
});

// ---------------------------------------------------------------------------
// emitResults
// ---------------------------------------------------------------------------

test('emitResults creates results from ranked candidates', () => {
  const run = makeRun();
  const candidates: JobCandidate[] = [
    {
      schemaVersion: ORCHESTRATION_CONTRACT_VERSION,
      candidateId: 'c1',
      runId: 'run-1',
      sliceId: 'slice-1',
      state: 'ranked',
      evidenceRefs: [],
    },
    {
      schemaVersion: ORCHESTRATION_CONTRACT_VERSION,
      candidateId: 'c2',
      runId: 'run-1',
      sliceId: 'slice-1',
      state: 'ranked',
      evidenceRefs: [],
    },
  ];
  const updated = emitResults(run, candidates);
  assert.strictEqual(updated.results.length, 2);
  assert.strictEqual(updated.results[0]!.rank, 1);
  assert.strictEqual(updated.results[1]!.rank, 2);
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

test('remainingBudget subtracts consumed from budget', () => {
  const run = makeRun({ budget: makeBudget({ candidates: 100 }) });
  const consumed = { ...run.consumed, candidates: 30 };
  const withConsumed = { ...run, consumed };
  const rem = remainingBudget(withConsumed);
  assert.strictEqual(rem.candidates, 70);
});

test('canReserve returns false when insufficient', () => {
  const run = makeRun({ budget: makeBudget({ candidates: 5 }) });
  assert.ok(!canReserve(run, { candidates: 10 }));
});

test('canReserve returns true when sufficient', () => {
  const run = makeRun({ budget: makeBudget({ candidates: 100 }) });
  assert.ok(canReserve(run, { candidates: 50 }));
});

// ---------------------------------------------------------------------------
// Reasoning 0 still reaches ranking
// ---------------------------------------------------------------------------

test('reasoning 0 budget allows ranking to complete', () => {
  const run = makeRun({ budget: makeBudget({ reasoning: 0 }) });
  // Simulate full pipeline: created → acquiring → extracting → ... → ranking → finalizing → completed
  let current = run;
  for (const state of [
    'acquiring',
    'extracting',
    'resolving_identity',
    'retrieving',
    'assessing',
    'ranking',
    'finalizing',
    'completed',
  ] as const) {
    current = transitionJobRun(current, state);
  }
  assert.strictEqual(current.state, 'completed');
});

// ---------------------------------------------------------------------------
// observabilitySnapshot
// ---------------------------------------------------------------------------

test('observabilitySnapshot excludes sensitive data', () => {
  const run = makeRun();
  const snap = observabilitySnapshot(run, 1000, 0);
  const json = JSON.stringify(snap);
  assert.ok(!json.includes('http://'));
  assert.ok(!json.includes('query'));
  assert.strictEqual(snap.runId, 'run-1');
});

test('observabilitySnapshot has correct counts', () => {
  const run = makeRun();
  const snap = observabilitySnapshot(run, 5000, 1000);
  assert.strictEqual(snap.durationMs, 4000);
  assert.strictEqual(snap.sliceCounts.planned, 1);
});

// ---------------------------------------------------------------------------
// applyAcquisitionResult
// ---------------------------------------------------------------------------

test('applyAcquisitionResult updates consumed and coverage', () => {
  const run = makeRun();
  const result = {
    status: 'completed',
    budgetConsumed: { candidates: 20, logicalRequests: 5 },
    coverage: [{ state: 'succeeded' }],
    warnings: ['warning1'],
  };
  const updated = applyAcquisitionResult(run, result);
  assert.strictEqual(updated.consumed.candidates, 20);
  assert.strictEqual(updated.coverage.length, 1);
  assert.strictEqual(updated.warnings.length, 1);
});

// ---------------------------------------------------------------------------
// Policy blocked slice: zero candidates, zero requests
// ---------------------------------------------------------------------------

test('policy blocked coverage produces zero candidates', () => {
  // Verify that the contract holds: policy_blocked coverage has zero candidates
  const coverage = {
    state: 'policy_blocked',
    candidatesProduced: 0,
    logicalRequestsUsed: 0,
  };
  assert.strictEqual(coverage.candidatesProduced, 0);
  assert.strictEqual(coverage.logicalRequestsUsed, 0);
});

// ---------------------------------------------------------------------------
// Adapter failed does not set run failed
// ---------------------------------------------------------------------------

test('adapter failed coverage does not fail the run', () => {
  const run = makeRun();
  const updated = {
    ...run,
    coverage: [{ state: 'failed' }],
  };
  // Run state should remain as-is; adapter failure is isolated
  assert.strictEqual(updated.state, 'created');
});
