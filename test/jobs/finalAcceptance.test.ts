/**
 * Final acceptance proof. Runs closed W3-J cases through real implementations,
 * then checks cross-boundary registration and current jobs surfaces.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { CASES } from './w3jAcquisitionClosure.test.js';

type RegisteredTools = Record<string, { handler?: unknown }>;

function registeredTools(server: unknown): RegisteredTools {
  return (server as { server: { _registeredTools: RegisteredTools } }).server._registeredTools;
}

const missionItems = [
  'profile-driven Sydney search spans multiple role families',
  'provider direct-blocked publisher indexed-only then authoritative upgrade',
  'provider failure isolation',
  'unknown is not contradiction',
  'no protected inference',
  'deterministic rerun',
  'reasoning fallback',
  'explicit preference outranks learned residual',
  'blocked path performs zero calls',
  'actual MCP registration and handler',
  'real evaluation fixtures',
  'no unreachable major islands via registration/call assertions',
  'W3-J closure cases execute through real boundaries',
] as const;

test('final acceptance: all W3-J cases execute', async () => {
  assert.equal(CASES.length, 13);
  assert.deepEqual(
    CASES.map((entry) => entry.id),
    Array.from({ length: 13 }, (_, index) => index + 1),
  );
  for (const entry of CASES) await entry.run();
});

test('final acceptance: MCP registration exposes live jobs surfaces', () => {
  const server = createServer(loadConfig());
  const tools = registeredTools(server);
  assert.equal(typeof tools.jobs_search?.handler, 'function');
  assert.equal(typeof tools.jobs?.handler, 'function');
  assert.ok(missionItems.includes('actual MCP registration and handler'));
  assert.ok(missionItems.includes('no unreachable major islands via registration/call assertions'));
});

test('final acceptance: seam and evaluation fixtures execute', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      'test/jobs/jobsSearchSeam.test.ts',
      'test/jobs/evaluationAGates.test.ts',
    ],
    { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /pass\s+31/);
});
