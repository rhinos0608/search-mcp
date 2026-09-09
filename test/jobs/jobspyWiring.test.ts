import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, resetConfig } from '../../src/config.js';
import { buildJobsMcpDeps, jobspyUnconfigured } from '../../src/tools/jobs/jobsDeps.js';
import { buildPlan } from '../../src/tools/jobs/planBuilder.js';
import { JOBSPY_BOARDS } from '../../src/jobs/acquisition/adapters/jobspy.js';

// F1: operator-configured boards flow config → deps → policies → plan.
// TEMPORARY LOCAL DEFAULT: unset env+config enables all boards (dev
// convenience); revert to strict opt-in per ADR-011 before public release.
// Unknown board names are dropped with a warning, never silently enabled.

test('temporary local default: unset env and config enables all boards', () => {
  resetConfig();
  delete process.env.JOBSPY_BOARDS;
  delete process.env.JOBSPY_ENABLED;
  try {
    const cfg = loadConfig();
    assert.deepEqual([...cfg.jobsAcquisition.jobspyBoards], [...JOBSPY_BOARDS]);
  } finally {
    delete process.env.JOBSPY_BOARDS;
    resetConfig();
  }
});

test('JOBSPY_ENABLED=false opts out of jobspy entirely', () => {
  resetConfig();
  delete process.env.JOBSPY_BOARDS;
  process.env.JOBSPY_ENABLED = 'false';
  try {
    const cfg = loadConfig();
    assert.deepEqual(cfg.jobsAcquisition.jobspyBoards, []);
  } finally {
    delete process.env.JOBSPY_ENABLED;
    resetConfig();
  }
});

test('JOBSPY_BOARDS env is validated against the known board allowlist', () => {
  process.env.JOBSPY_BOARDS = 'linkedin, indeed, bogus_board, , linkedin';
  try {
    const cfg = loadConfig();
    // Unknown dropped, known deduped, case-normalized; allowlist unchanged.
    assert.deepEqual(cfg.jobsAcquisition.jobspyBoards, ['linkedin', 'indeed']);
    assert.ok((JOBSPY_BOARDS as readonly string[]).includes('linkedin'));
    assert.ok(!(JOBSPY_BOARDS as readonly string[]).includes('bogus_board'));
  } finally {
    delete process.env.JOBSPY_BOARDS;
  }
});

test('configured boards produce permitted board policies with non-empty evidence', async () => {
  const cfg = loadConfig();
  process.env.JOBSPY_BOARDS = 'linkedin';
  // loadConfig caches; rebuild config through a fresh import is overkill.
  // Instead exercise the deps builder directly with a configured shape.
  const configured = {
    ...cfg,
    jobsAcquisition: { ...cfg.jobsAcquisition, jobspyBoards: ['linkedin'] },
  } as typeof cfg;
  delete process.env.JOBSPY_BOARDS;
  const deps = buildJobsMcpDeps(configured);
  assert.deepEqual(deps.jobspyBoards, ['linkedin']);
  const decision = deps.policyRegistry.decideEdge(
    'board:linkedin',
    { kind: 'adapter', namespace: 'adapter', id: 'jobspy' },
    'automatedSearch',
    'direct',
    'board',
  );
  assert.equal(decision.state, 'permitted');
  assert.ok(decision.evidenceRefs.length > 0);
  // Board evidence cites ADR-011, never legal holdings, no invented hashes.
  const { boardPolicyEvidence } =
    await import('../../src/jobs/acquisition/sourceClass/evidence/livePolicyEvidence.js');
  const ev = boardPolicyEvidence('linkedin');
  assert.equal(ev.citationRef, 'docs/jobs/adr/ADR-011-source-policy.md');
  assert.equal(ev.conclusion, 'operator_configured_board_search');
  assert.equal(ev.contentHash, undefined);
});

test('empty boards: no board policies, zero scrape calls, jobspy_unconfigured flagged', () => {
  const cfg = loadConfig();
  const empty = {
    ...cfg,
    jobsAcquisition: { ...cfg.jobsAcquisition, jobspyBoards: [] },
  } as typeof cfg;
  const deps = buildJobsMcpDeps(empty);
  assert.equal(deps.jobspyBoards.length, 0);
  assert.equal(jobspyUnconfigured(deps, true), true);
  assert.equal(jobspyUnconfigured(deps, false), false);
  const decision = deps.policyRegistry.decideEdge(
    'board:linkedin',
    { kind: 'adapter', namespace: 'adapter', id: 'jobspy' },
    'automatedSearch',
    'direct',
    'board',
  );
  assert.equal(decision.state, 'not_supported');
});

test('plan emits one jobspy slice per configured board and carries fetchDescription', () => {
  const plan = buildPlan(
    { query: 'engineer', useJobSpy: true, jobspyFetchDescription: true },
    'run-1',
    [],
    ['linkedin', 'indeed'],
  );
  const jobspyItems = plan.filter((p) => (p as { kind?: string }).kind === 'jobspy');
  assert.deepEqual(jobspyItems.map((p) => (p as { board: string }).board).sort(), [
    'indeed',
    'linkedin',
  ]);
  for (const item of jobspyItems) {
    assert.equal((item as { fetchDescription?: boolean }).fetchDescription, true);
  }
  const planOff = buildPlan({ query: 'engineer' }, 'run-2', [], ['linkedin']);
  const offItems = planOff.filter((p) => (p as { kind?: string }).kind === 'jobspy');
  assert.equal(
    offItems.some((p) => (p as { fetchDescription?: boolean }).fetchDescription === true),
    false,
  );
});

test('useJobSpy:false plans zero jobspy slices even with boards configured', () => {
  const plan = buildPlan(
    { query: 'engineer', useJobSpy: false },
    'run-3',
    [],
    ['linkedin', 'indeed'],
  );
  assert.equal(plan.filter((p) => (p as { kind?: string }).kind === 'jobspy').length, 0);
});
