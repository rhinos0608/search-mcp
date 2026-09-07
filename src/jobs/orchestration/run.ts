import { canonicalJson, sha256Hex } from '../evaluation/hashes.js';
import type { Instant } from '../evaluation/types.js';
import { ORCHESTRATION_CONTRACT_VERSION } from './types.js';
import type {
  JobBudgetConsumed,
  JobCandidate,
  JobCandidateId,
  JobCandidateState,
  JobResult,
  JobResultState,
  JobRun,
  JobRunBudget,
  JobRunId,
  JobRunState,
  JobSlice,
  JobSliceId,
  ObservabilitySnapshot,
  SliceState,
  PipelineStage,
} from './types.js';

// ---------------------------------------------------------------------------
// Zero budget helper
// ---------------------------------------------------------------------------

function zeroBudget(): JobBudgetConsumed {
  return {
    logicalRequests: 0,
    reservedAttempts: 0,
    candidates: 0,
    bytes: 0,
    milliseconds: 0,
    pages: 0,
    enrichment: 0,
    reasoning: 0,
  };
}

// ---------------------------------------------------------------------------
// Allowed transitions
// ---------------------------------------------------------------------------

const RUN_TRANSITIONS: ReadonlySet<string> = new Set([
  // from → to
  'created:acquiring',
  'created:aborted',
  'acquiring:extracting',
  'acquiring:completed',
  'acquiring:budget_exhausted',
  'acquiring:deadline_exceeded',
  'acquiring:aborted',
  'acquiring:failed',
  'extracting:resolving_identity',
  'extracting:budget_exhausted',
  'extracting:deadline_exceeded',
  'extracting:aborted',
  'extracting:failed',
  'resolving_identity:retrieving',
  'resolving_identity:budget_exhausted',
  'resolving_identity:deadline_exceeded',
  'resolving_identity:aborted',
  'resolving_identity:failed',
  'retrieving:assessing',
  'retrieving:budget_exhausted',
  'retrieving:deadline_exceeded',
  'retrieving:aborted',
  'retrieving:failed',
  'assessing:ranking',
  'assessing:budget_exhausted',
  'assessing:deadline_exceeded',
  'assessing:aborted',
  'assessing:failed',
  'ranking:finalizing',
  'ranking:budget_exhausted',
  'ranking:deadline_exceeded',
  'ranking:aborted',
  'ranking:failed',
  'finalizing:completed',
  'finalizing:aborted',
  'finalizing:failed',
]);

const TERMINAL_STATES: ReadonlySet<JobRunState> = new Set([
  'completed',
  'budget_exhausted',
  'deadline_exceeded',
  'aborted',
  'failed',
]);

const STATE_TO_STAGE: ReadonlyMap<JobRunState, PipelineStage> = new Map([
  ['acquiring', 'acquisition'],
  ['extracting', 'extraction'],
  ['resolving_identity', 'identity'],
  ['retrieving', 'retrieval'],
  ['assessing', 'assessment'],
  ['ranking', 'ranking'],
  ['finalizing', 'output'],
]);

// ---------------------------------------------------------------------------
// Slice transitions
// ---------------------------------------------------------------------------

const SLICE_TRANSITIONS: ReadonlySet<string> = new Set([
  'planned:reserved',
  'reserved:running',
  'running:completed',
  'running:failed_isolated',
  'planned:skipped_budget',
  'planned:skipped_deadline',
  'planned:skipped_aborted',
  'reserved:skipped_budget',
  'reserved:skipped_deadline',
  'reserved:skipped_aborted',
  'running:skipped_aborted',
]);

// ---------------------------------------------------------------------------
// Candidate transitions
// ---------------------------------------------------------------------------

const CANDIDATE_TRANSITIONS: ReadonlySet<string> = new Set([
  'discovered:extracted',
  'discovered:dropped_budget',
  'discovered:suppressed_duplicate',
  'discovered:dropped_policy',
  'extracted:identity_bound',
  'extracted:dropped_budget',
  'identity_bound:retrieved',
  'identity_bound:dropped_budget',
  'retrieved:assessed',
  'retrieved:dropped_budget',
  'assessed:ranked',
  'assessed:dropped_budget',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createJobRun(input: {
  runId: JobRunId;
  intent: unknown;
  budget: JobRunBudget;
  slices: Omit<JobSlice, 'state' | 'runId'>[];
  createdAt: Instant;
}): JobRun {
  const fingerprint = sha256Hex(canonicalJson(input.intent));

  const slices: JobSlice[] = input.slices.map((s) => ({
    ...s,
    runId: input.runId,
    state: 'planned' as const,
    schemaVersion: ORCHESTRATION_CONTRACT_VERSION,
  }));

  return {
    schemaVersion: ORCHESTRATION_CONTRACT_VERSION,
    runId: input.runId,
    state: 'created',
    stage: 'none',
    createdAt: input.createdAt,
    intentFingerprint: fingerprint,
    budget: input.budget,
    consumed: zeroBudget(),
    slices,
    candidates: [],
    results: [],
    coverage: [],
    warnings: [],
  };
}

export function isValidJobRunTransition(from: JobRunState, to: JobRunState): boolean {
  return RUN_TRANSITIONS.has(`${from}:${to}`);
}

export function transitionJobRun(run: JobRun, to: JobRunState): JobRun {
  if (!isValidJobRunTransition(run.state, to)) {
    throw new Error(`ORCHESTRATION_ILLEGAL_TRANSITION: ${run.state} -> ${to}`);
  }
  const next = { ...run, state: to };
  // Update stage mapping
  const mapped = STATE_TO_STAGE.get(to);
  if (mapped) {
    next.stage = mapped;
  }
  return next;
}

export function reserveSlice(run: JobRun, sliceId: JobSliceId): JobRun {
  if (TERMINAL_STATES.has(run.state)) {
    throw new Error('ORCHESTRATION_TERMINAL_RUN');
  }
  const idx = run.slices.findIndex((s) => s.sliceId === sliceId);
  if (idx === -1) {
    throw new Error('ORCHESTRATION_UNKNOWN_SLICE');
  }
  const slice = run.slices[idx];
  if (!slice) {
    throw new Error('ORCHESTRATION_UNKNOWN_SLICE');
  }
  if (!SLICE_TRANSITIONS.has(`${slice.state}:reserved`)) {
    throw new Error(`ORCHESTRATION_ILLEGAL_SLICE_TRANSITION: ${slice.state} -> reserved`);
  }
  // Check budget
  if (!canReserve(run, slice.budget)) {
    // Cannot reserve → skip slice
    const skipped = {
      ...run,
      slices: run.slices.map((s, i) =>
        i === idx ? { ...s, state: 'skipped_budget' as const } : s,
      ),
    };
    return maybeExhaustRun(skipped);
  }
  const updated = {
    ...run,
    slices: run.slices.map((s, i) => (i === idx ? { ...s, state: 'reserved' as const } : s)),
  };
  return updated;
}

export function startSlice(run: JobRun, sliceId: JobSliceId): JobRun {
  if (TERMINAL_STATES.has(run.state)) {
    throw new Error('ORCHESTRATION_TERMINAL_RUN');
  }
  const idx = run.slices.findIndex((s) => s.sliceId === sliceId);
  if (idx === -1) {
    throw new Error('ORCHESTRATION_UNKNOWN_SLICE');
  }
  const slice = run.slices[idx];
  if (!slice) {
    throw new Error('ORCHESTRATION_UNKNOWN_SLICE');
  }
  if (!SLICE_TRANSITIONS.has(`${slice.state}:running`)) {
    throw new Error(`ORCHESTRATION_ILLEGAL_SLICE_TRANSITION: ${slice.state} -> running`);
  }
  return {
    ...run,
    slices: run.slices.map((s, i) => (i === idx ? { ...s, state: 'running' as const } : s)),
  };
}

export function completeSlice(
  run: JobRun,
  sliceId: JobSliceId,
  consumedDelta: Partial<JobBudgetConsumed>,
): JobRun {
  if (TERMINAL_STATES.has(run.state)) {
    throw new Error('ORCHESTRATION_TERMINAL_RUN');
  }
  const idx = run.slices.findIndex((s) => s.sliceId === sliceId);
  if (idx === -1) {
    throw new Error('ORCHESTRATION_UNKNOWN_SLICE');
  }
  const slice = run.slices[idx];
  if (!slice) {
    throw new Error('ORCHESTRATION_UNKNOWN_SLICE');
  }
  if (!SLICE_TRANSITIONS.has(`${slice.state}:completed`)) {
    throw new Error(`ORCHESTRATION_ILLEGAL_SLICE_TRANSITION: ${slice.state} -> completed`);
  }
  const consumed = clampConsumed(run.consumed, consumedDelta, run.budget);
  return {
    ...run,
    consumed,
    slices: run.slices.map((s, i) => (i === idx ? { ...s, state: 'completed' as const } : s)),
  };
}

export function skipSlice(
  run: JobRun,
  sliceId: JobSliceId,
  reason: 'budget' | 'deadline' | 'aborted',
): JobRun {
  if (TERMINAL_STATES.has(run.state)) {
    throw new Error('ORCHESTRATION_TERMINAL_RUN');
  }
  const idx = run.slices.findIndex((s) => s.sliceId === sliceId);
  if (idx === -1) {
    throw new Error('ORCHESTRATION_UNKNOWN_SLICE');
  }
  const slice = run.slices[idx];
  if (!slice) {
    throw new Error('ORCHESTRATION_UNKNOWN_SLICE');
  }
  const targetState: SliceState =
    reason === 'budget'
      ? 'skipped_budget'
      : reason === 'deadline'
        ? 'skipped_deadline'
        : 'skipped_aborted';
  if (!SLICE_TRANSITIONS.has(`${slice.state}:${targetState}`)) {
    throw new Error(`ORCHESTRATION_ILLEGAL_SLICE_TRANSITION: ${slice.state} -> ${targetState}`);
  }
  const updated = {
    ...run,
    slices: run.slices.map((s, i) => (i === idx ? { ...s, state: targetState } : s)),
  };
  if (reason === 'budget') {
    return maybeExhaustRun(updated);
  }
  if (reason === 'deadline') {
    return maybeDeadlineRun(updated);
  }
  return updated;
}

export function upsertCandidate(run: JobRun, candidate: JobCandidate): JobRun {
  const idx = run.candidates.findIndex((c) => c.candidateId === candidate.candidateId);
  if (idx === -1) {
    return { ...run, candidates: [...run.candidates, candidate] };
  }
  return {
    ...run,
    candidates: run.candidates.map((c, i) => (i === idx ? candidate : c)),
  };
}

export function transitionCandidate(
  run: JobRun,
  candidateId: JobCandidateId,
  to: JobCandidateState,
): JobRun {
  const idx = run.candidates.findIndex((c) => c.candidateId === candidateId);
  if (idx === -1) {
    throw new Error('ORCHESTRATION_UNKNOWN_CANDIDATE');
  }
  const candidate = run.candidates[idx];
  if (!candidate) {
    throw new Error('ORCHESTRATION_UNKNOWN_CANDIDATE');
  }
  if (!CANDIDATE_TRANSITIONS.has(`${candidate.state}:${to}`)) {
    throw new Error('ORCHESTRATION_ILLEGAL_CANDIDATE_TRANSITION: ' + candidate.state + ' -> ' + to);
  }
  return {
    ...run,
    candidates: run.candidates.map((c, i) => (i === idx ? { ...c, state: to } : c)),
  };
}

export function emitResults(run: JobRun, ranked: readonly JobCandidate[]): JobRun {
  const results: JobResult[] = ranked.map((c, i) => ({
    schemaVersion: ORCHESTRATION_CONTRACT_VERSION,
    resultId: run.runId + ':result:' + String(i),
    runId: run.runId,
    candidateId: c.candidateId,
    state: 'emitted' as const,
    rank: i + 1,
    flags: [],
  }));
  return { ...run, results };
}

export function remainingBudget(run: JobRun): JobBudgetConsumed {
  return subtractBudget(run.budget, run.consumed);
}

export function canReserve(run: JobRun, need: Partial<JobBudgetConsumed>): boolean {
  const rem = remainingBudget(run);
  for (const key of Object.keys(need) as (keyof JobBudgetConsumed)[]) {
    const required = need[key];
    if (required !== undefined && rem[key] < required) {
      return false;
    }
  }
  return true;
}

export function observabilitySnapshot(
  run: JobRun,
  nowMs: number,
  startMs: number,
): ObservabilitySnapshot {
  const rem = remainingBudget(run);

  const sliceCounts: Record<SliceState, number> = {
    planned: 0,
    reserved: 0,
    running: 0,
    completed: 0,
    skipped_budget: 0,
    skipped_deadline: 0,
    skipped_aborted: 0,
    failed_isolated: 0,
  };
  for (const s of run.slices) {
    sliceCounts[s.state]++;
  }

  const candidateCounts: Record<JobCandidateState, number> = {
    discovered: 0,
    extracted: 0,
    identity_bound: 0,
    retrieved: 0,
    assessed: 0,
    ranked: 0,
    suppressed_duplicate: 0,
    dropped_budget: 0,
    dropped_policy: 0,
  };
  for (const c of run.candidates) {
    candidateCounts[c.state]++;
  }

  const resultCounts: Record<JobResultState, number> = {
    pending: 0,
    emitted: 0,
    withheld_coverage: 0,
    withheld_error: 0,
  };
  for (const r of run.results) {
    resultCounts[r.state]++;
  }

  const coverageStates: Record<string, number> = {};
  for (const cov of run.coverage) {
    const state = (cov as { state?: string }).state ?? 'unknown';
    coverageStates[state] = (coverageStates[state] ?? 0) + 1;
  }

  return {
    runId: run.runId,
    state: run.state,
    stage: run.stage,
    consumed: { ...run.consumed },
    remaining: rem,
    sliceCounts,
    candidateCounts,
    resultCounts,
    coverageStates,
    durationMs: Math.max(0, nowMs - startMs),
  };
}

// ---------------------------------------------------------------------------
// applyAcquisitionResult — maps W3 result into job run
// ---------------------------------------------------------------------------

export function applyAcquisitionResult(
  run: JobRun,
  result: {
    status: string;
    slices?: unknown[];
    skipped?: unknown[];
    budgetConsumed?: Partial<JobBudgetConsumed>;
    coverage?: unknown[];
    candidates?: unknown[];
    warnings?: string[];
  },
): JobRun {
  const consumed = { ...run.consumed };
  if (result.budgetConsumed) {
    const delta = result.budgetConsumed;
    return {
      ...run,
      consumed: clampConsumed(consumed, delta, run.budget),
      coverage: result.coverage ?? run.coverage,
      warnings: [...run.warnings, ...(result.warnings ?? [])].slice(0, 100),
    };
  }
  return {
    ...run,
    coverage: result.coverage ?? run.coverage,
    warnings: [...run.warnings, ...(result.warnings ?? [])].slice(0, 100),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function subtractBudget(budget: JobRunBudget, consumed: JobBudgetConsumed): JobBudgetConsumed {
  return {
    logicalRequests: Math.max(0, budget.logicalRequests - consumed.logicalRequests),
    reservedAttempts: Math.max(0, budget.reservedAttempts - consumed.reservedAttempts),
    candidates: Math.max(0, budget.candidates - consumed.candidates),
    bytes: Math.max(0, budget.bytes - consumed.bytes),
    milliseconds: Math.max(0, budget.milliseconds - consumed.milliseconds),
    pages: Math.max(0, budget.pages - consumed.pages),
    enrichment: Math.max(0, budget.enrichment - consumed.enrichment),
    reasoning: Math.max(0, budget.reasoning - consumed.reasoning),
  };
}

function clampConsumed(
  current: JobBudgetConsumed,
  delta: Partial<JobBudgetConsumed>,
  budget: JobRunBudget,
): JobBudgetConsumed {
  return {
    logicalRequests: Math.min(
      budget.logicalRequests,
      current.logicalRequests + (delta.logicalRequests ?? 0),
    ),
    reservedAttempts: Math.min(
      budget.reservedAttempts,
      current.reservedAttempts + (delta.reservedAttempts ?? 0),
    ),
    candidates: Math.min(budget.candidates, current.candidates + (delta.candidates ?? 0)),
    bytes: Math.min(budget.bytes, current.bytes + (delta.bytes ?? 0)),
    milliseconds: Math.min(budget.milliseconds, current.milliseconds + (delta.milliseconds ?? 0)),
    pages: Math.min(budget.pages, current.pages + (delta.pages ?? 0)),
    enrichment: Math.min(budget.enrichment, current.enrichment + (delta.enrichment ?? 0)),
    reasoning: Math.min(budget.reasoning, current.reasoning + (delta.reasoning ?? 0)),
  };
}

function maybeExhaustRun(run: JobRun): JobRun {
  const rem = remainingBudget(run);
  const allZero = Object.values(rem).every((v) => v === 0);
  if (allZero) {
    return { ...run, state: 'budget_exhausted' };
  }
  return run;
}

function maybeDeadlineRun(run: JobRun): JobRun {
  const rem = remainingBudget(run);
  if (rem.milliseconds === 0) {
    return { ...run, state: 'deadline_exceeded' };
  }
  return run;
}
