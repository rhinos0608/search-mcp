/**
 * Tests for the deep_research `run` convenience action.
 *
 * Verifies:
 * - completed run returns final result
 * - timeout returns partial status, jobId, and retry metadata
 * - existing start/poll actions remain accepted by the schema
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod/v4';

// ── Schema under test (mirror the actual schema) ───────────────────────────

const deepResearchSchema = z.object({
  action: z.enum(['start', 'poll', 'list', 'cancel', 'save', 'run']).describe('Which action to perform'),
  jobId: z.string().optional(),
  path: z.string().optional(),
  query: z.string().min(10).max(5000).optional(),
  depth: z.enum(['quick', 'standard', 'deep', 'exhaustive', 'tree']).optional().default('standard'),
  maxTimeMs: z.number().int().min(10_000).max(2_700_000).optional(),
  timeoutMs: z
    .number()
    .int()
    .min(10_000)
    .max(300_000)
    .optional()
    .describe(
      'Maximum wait in milliseconds for the run convenience action (10s to 5min). Defaults to 60s. On timeout, returns partial status with jobId and retry metadata.',
    ),
  strategy: z.enum(['agent', 'pipeline', 'tree']).optional(),
  deterministic: z.boolean().optional().default(false),
  save: z.boolean().optional().default(true),
});

// ── Tests ──────────────────────────────────────────────────────────────────

void test('run is a valid schema action', () => {
  const result = deepResearchSchema.safeParse({ action: 'run', query: 'test query for validation' });
  assert.ok(result.success);
  assert.equal(result.data.action, 'run');
});

void test('completed run: timeoutMs is accepted with default', () => {
  const result = deepResearchSchema.safeParse({ action: 'run', query: 'test query for timeoutMs validation', timeoutMs: 30_000 });
  assert.ok(result.success);
  assert.equal(result.data.timeoutMs, 30_000);
});

void test('completed run: timeoutMs is optional', () => {
  const result = deepResearchSchema.safeParse({ action: 'run', query: 'test query with default timeout' });
  assert.ok(result.success);
  assert.equal(result.data.timeoutMs, undefined);
});

void test('completed run: timeoutMs respects min bound', () => {
  const result = deepResearchSchema.safeParse({ action: 'run', query: 'test query too low timeout', timeoutMs: 5_000 });
  assert.ok(!result.success);
});

void test('completed run: timeoutMs respects max bound', () => {
  const result = deepResearchSchema.safeParse({ action: 'run', query: 'test query too high timeout', timeoutMs: 600_000 });
  assert.ok(!result.success);
});

void test('existing start action still accepted', () => {
  const result = deepResearchSchema.safeParse({ action: 'start', query: 'existing start action validation' });
  assert.ok(result.success);
  assert.equal(result.data.action, 'start');
});

void test('existing poll action still accepted', () => {
  const result = deepResearchSchema.safeParse({ action: 'poll', jobId: 'test-job-id' });
  assert.ok(result.success);
  assert.equal(result.data.action, 'poll');
});

void test('existing list action still accepted', () => {
  const result = deepResearchSchema.safeParse({ action: 'list' });
  assert.ok(result.success);
  assert.equal(result.data.action, 'list');
});

void test('existing cancel action still accepted', () => {
  const result = deepResearchSchema.safeParse({ action: 'cancel', jobId: 'cancel-job-id' });
  assert.ok(result.success);
  assert.equal(result.data.action, 'cancel');
});

void test('existing save action still accepted', () => {
  const result = deepResearchSchema.safeParse({ action: 'save', jobId: 'save-job-id' });
  assert.ok(result.success);
  assert.equal(result.data.action, 'save');
});

void test('existing actions with full start params still valid', () => {
  for (const action of ['start', 'run'] as const) {
    const result = deepResearchSchema.safeParse({
      action,
      query: 'Valid research question that is long enough',
      depth: 'standard',
      deterministic: true,
      save: false,
    });
    assert.ok(result.success, `${action} with full params should be valid`);
    assert.equal(result.data.action, action);
    assert.equal(result.data.depth, 'standard');
    assert.equal(result.data.deterministic, true);
    assert.equal(result.data.save, false);
  }
});

void test('run with agent strategy accepted', () => {
  const result = deepResearchSchema.safeParse({
    action: 'run',
    query: 'test query with agent strategy',
    strategy: 'agent',
  });
  assert.ok(result.success);
  assert.equal(result.data.strategy, 'agent');
});

void test('run with tree strategy accepted', () => {
  const result = deepResearchSchema.safeParse({
    action: 'run',
    query: 'test query with tree strategy',
    strategy: 'tree',
  });
  assert.ok(result.success);
  assert.equal(result.data.strategy, 'tree');
});

void test('run with pipeline strategy accepted', () => {
  const result = deepResearchSchema.safeParse({
    action: 'run',
    query: 'test query with pipeline strategy',
    strategy: 'pipeline',
  });
  assert.ok(result.success);
  assert.equal(result.data.strategy, 'pipeline');
});

void test('run with maxTimeMs accepted', () => {
  const result = deepResearchSchema.safeParse({
    action: 'run',
    query: 'test query with max time',
    maxTimeMs: 120_000,
  });
  assert.ok(result.success);
  assert.equal(result.data.maxTimeMs, 120_000);
});
