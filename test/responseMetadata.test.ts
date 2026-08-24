import test from 'node:test';
import assert from 'node:assert/strict';
import { makeResult, wrapResponse } from '../src/tools/response.js';
import type { ToolResult } from '../src/types.js';

void test('makeResult includes provenance when provided', () => {
  const result = makeResult('web_search', { items: [] }, 42, {
    provenance: {
      usedBackend: 'brave',
      usedFallback: false,
    },
  });
  const meta = (result as ToolResult<unknown>).meta;
  assert.ok(meta.provenance !== undefined);
  assert.equal(meta.provenance!.usedBackend, 'brave');
  assert.equal(meta.provenance!.usedFallback, false);
  assert.equal(meta.provenance!.fallbackReason, undefined);
});

void test('makeResult includes retry when provided', () => {
  const result = makeResult('research', { jobId: 'abc' }, 150, {
    retry: {
      recommended: true,
      reason: 'Incomplete corpus — try with a broader query',
      minimalCall: { query: 'broader topic', depth: 'standard' },
    },
  });
  const meta = (result as ToolResult<unknown>).meta;
  assert.ok(meta.retry !== undefined);
  assert.equal(meta.retry!.recommended, true);
  assert.equal(typeof meta.retry!.reason, 'string');
  assert.deepEqual(meta.retry!.minimalCall, { query: 'broader topic', depth: 'standard' });
});

void test('makeResult includes normalized when provided', () => {
  const result = makeResult('github.file', { content: 'x' }, 10, {
    normalized: {
      aliases: { owner: 'rhinesharar' },
      defaults: { branch: 'main' },
      ignoredFields: ['limit'],
    },
  });
  const meta = (result as ToolResult<unknown>).meta;
  assert.ok(meta.normalized !== undefined);
  assert.deepEqual(meta.normalized!.aliases, { owner: 'rhinesharar' });
  assert.deepEqual(meta.normalized!.defaults, { branch: 'main' });
  assert.deepEqual(meta.normalized!.ignoredFields, ['limit']);
});

void test('makeResult includes partial when provided', () => {
  const result = makeResult('web_search', { items: [] }, 5, {
    partial: true,
  });
  const meta = (result as ToolResult<unknown>).meta;
  assert.equal(meta.partial, true);
});

void test('makeResult omits optional metadata when not provided', () => {
  const result = makeResult('health_check', { status: 'ok' }, 1);
  const meta = (result as ToolResult<unknown>).meta;
  assert.equal(meta.provenance, undefined);
  assert.equal(meta.retry, undefined);
  assert.equal(meta.normalized, undefined);
  assert.equal(meta.partial, undefined);
});

void test('makeResult merges multiple new fields with existing fields', () => {
  const result = makeResult('web_search', { items: [1, 2] }, 10, {
    warnings: ['slow backend'],
    provenance: { usedBackend: 'exa', usedFallback: true, fallbackReason: 'brave rate limited' },
    partial: true,
  });
  const meta = (result as ToolResult<unknown>).meta;
  assert.ok(Array.isArray(meta.warnings));
  assert.equal(meta.warnings![0], 'slow backend');
  assert.deepEqual(meta.provenance, {
    usedBackend: 'exa',
    usedFallback: true,
    fallbackReason: 'brave rate limited',
  });
  assert.equal(meta.partial, true);
});

void test('wrapResponse can carry provenance/retry/normalized/partial', () => {
  const wrapped = wrapResponse({ key: 'val' }, ['note'], {
    provenance: { usedBackend: 'tavily', usedFallback: false },
  });
  assert.equal(wrapped.kind, 'wrapped');
  assert.deepEqual(wrapped.data, { key: 'val' });
  assert.deepEqual(wrapped.warnings, ['note']);
  assert.deepEqual(wrapped.provenance, { usedBackend: 'tavily', usedFallback: false });
});

void test('wrapResponse omits extra when not provided', () => {
  const wrapped = wrapResponse({ x: 1 });
  assert.equal(wrapped.provenance, undefined);
  assert.equal(wrapped.retry, undefined);
  assert.equal(wrapped.normalized, undefined);
  assert.equal(wrapped.partial, undefined);
});

void test('makeResult provenance can show fallback reason', () => {
  const result = makeResult('web_search', { items: [] }, 20, {
    provenance: {
      usedBackend: 'searxng',
      usedFallback: true,
      fallbackReason: 'brave unavailable (degraded); duckduckgo circuit-tripped',
    },
  });
  assert.equal(
    result.meta.provenance!.fallbackReason,
    'brave unavailable (degraded); duckduckgo circuit-tripped',
  );
});

void test('makeResult retry with minimalCall omitted', () => {
  const result = makeResult('web_search', { items: [] }, 5, {
    retry: { recommended: false, reason: 'No further refinement possible' },
  });
  assert.equal(result.meta.retry!.recommended, false);
  assert.equal(result.meta.retry!.minimalCall, undefined);
});

void test('makeResult normalized empty objects', () => {
  const result = makeResult('web_search', { items: [] }, 3, {
    normalized: {},
  });
  assert.deepEqual(result.meta.normalized, {} as Record<string, unknown>);
});
