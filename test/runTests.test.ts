import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const runnerModule = require(path.join(process.cwd(), 'scripts', 'run-tests.cjs')) as {
  buildNodeTestArgs?: (args: string[], outDir: string) => string[];
};

const { buildNodeTestArgs } = runnerModule;

test('buildNodeTestArgs keeps flag values separate from explicit test targets', () => {
  assert.equal(typeof buildNodeTestArgs, 'function');

  const outDir = '/tmp/search-mcp-test-out';
  const args = buildNodeTestArgs!(['--test-name-pattern', 'redditSearch'], outDir);

  // With no explicit target and a non-existent test dir, no test files are added.
  // Flag values remain correctly separated from the --test flag.
  assert.deepEqual(args.slice(0, 4), [
    '--import',
    path.join(outDir, 'test', 'setup.js'),
    '--test',
    '--test-name-pattern',
  ]);
  assert.equal(args[4], 'redditSearch');
  // No glob pattern — files are resolved explicitly via findTestFiles
  assert.equal(args.length, 5);
});

test('buildNodeTestArgs preserves specific test file targets alongside flags with separate values', () => {
  assert.equal(typeof buildNodeTestArgs, 'function');

  const outDir = '/tmp/search-mcp-test-out';
  const args = buildNodeTestArgs!(
    ['--test-name-pattern', 'redditSearch', 'test/redditSearchCompatibility.test.ts'],
    outDir,
  );

  assert.deepEqual(args, [
    '--import',
    path.join(outDir, 'test', 'setup.js'),
    '--test',
    '--test-name-pattern',
    'redditSearch',
    path.join(outDir, 'test', 'redditSearchCompatibility.test.js'),
  ]);
});
