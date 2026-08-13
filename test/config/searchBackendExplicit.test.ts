import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSearchBackendExplicit } from '../../src/config.js';

// Hermetic: exercises only the pure resolution helper. Never reads or mutates
// the repo's config.json / config.enc, and never touches process.env, so the
// migration rule is tested in isolation from any local root config.
test('legacy config: unflagged "searxng" (old built-in default) resolves non-explicit so Codex auto-use survives', () => {
  // Pre-flag config.enc / copied example config.json persisted the then-default
  // searxng with no explicit-selection marker.
  assert.equal(resolveSearchBackendExplicit(undefined, undefined, 'searxng'), false);
});

test('legacy config: unflagged non-default backends resolve explicit pins', () => {
  assert.equal(resolveSearchBackendExplicit(undefined, undefined, 'brave'), true);
  assert.equal(resolveSearchBackendExplicit(undefined, undefined, 'codex'), true);
  assert.equal(resolveSearchBackendExplicit(undefined, undefined, 'exa'), true);
});

test('stored explicit boolean always wins over legacy inference', () => {
  // Persisted true alongside the legacy default value → still explicit.
  assert.equal(resolveSearchBackendExplicit(undefined, true, 'searxng'), true);
  // Persisted false alongside a non-default value → still non-explicit.
  assert.equal(resolveSearchBackendExplicit(undefined, false, 'brave'), false);
});

test('env explicit always wins', () => {
  assert.equal(resolveSearchBackendExplicit(true, undefined, 'searxng'), true);
  assert.equal(resolveSearchBackendExplicit(true, false, undefined), true);
  assert.equal(resolveSearchBackendExplicit(true, undefined, undefined), true);
});

test('nothing stored anywhere resolves to the non-explicit default', () => {
  assert.equal(resolveSearchBackendExplicit(undefined, undefined, undefined), false);
});
