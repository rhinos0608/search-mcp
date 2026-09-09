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
  assert.match(`${result.stdout}\n${result.stderr}`, /fail\s+0/);
  assert.match(`${result.stdout}\n${result.stderr}`, /pass\s+[1-9]\d*/);
});
