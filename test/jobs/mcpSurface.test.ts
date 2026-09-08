import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// RED: MCP surface modules must exist with additive registration.
describe('checkpoint D MCP surface: RED first', () => {
  test('RED: jobsSearch standalone module exists', async () => {
    const mod = await import('../../src/tools/standalone/jobsSearch.js');
    assert.equal(typeof mod.registerJobsSearch, 'function');
  });

  test('RED: jobs family module exists', async () => {
    const mod = await import('../../src/tools/families/jobs.js');
    assert.equal(typeof mod.registerJobsTool, 'function');
  });
});
