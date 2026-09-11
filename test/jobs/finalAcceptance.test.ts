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

// Each subprocess suite must run to completion with its full expected scope:
// exact per-file test count, exact pass count, zero failures. A shared assert
// on 'some tests passed' would let a silently truncated suite (e.g. a file
// failing to load) satisfy the acceptance gate.
const SUBPROCESS_SUITES = [
  { file: 'test/jobs/jobsSearchSeam.test.ts', expectedTests: 27 },
  { file: 'test/jobs/evaluationAGates.test.ts', expectedTests: 17 },
] as const;

test('final acceptance: seam and evaluation fixtures execute', () => {
  for (const suite of SUBPROCESS_SUITES) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', suite.file], {
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, new RegExp(`^(?:ℹ tests|# tests) ${suite.expectedTests}$`, 'm'), output);
    assert.match(output, new RegExp(`^(?:ℹ pass|# pass) ${suite.expectedTests}$`, 'm'), output);
    assert.match(output, /^(?:ℹ fail|# fail) 0$/m, output);
    assert.match(output, /^(?:ℹ cancelled|# cancelled) 0$/m, output);
  }
});
