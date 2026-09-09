import assert from 'node:assert/strict';
import test from 'node:test';

import { INDEXED_PROVIDER_DEFINITIONS } from '../../src/jobs/acquisition/providers/ports.js';
import { mockPort } from './seamFixtures.js';

test('mockPort builds a port from a known provider definition', () => {
  const def = INDEXED_PROVIDER_DEFINITIONS[0]!;
  const port = mockPort(def.providerId);
  assert.equal(port.providerId, def.providerId);
  assert.equal(port.adapterId, def.adapterId);
  assert.equal(port.maxDurationMs, def.maxDurationMs);
  assert.equal(port.governance, def.governance);
});

test('mockPort throws a clear RangeError for unknown providers before accessing definitions', () => {
  assert.throws(
    () => mockPort('search-provider:does-not-exist'),
    (err: unknown) => {
      assert.ok(err instanceof RangeError);
      const message = (err as Error).message;
      assert.match(message, /unknown indexed provider 'search-provider:does-not-exist'/u);
      // error must name the known providers, not leak undefined
      assert.match(message, /search-provider:brave/u);
      assert.doesNotMatch(message, /undefined/u);
      return true;
    },
  );
});
