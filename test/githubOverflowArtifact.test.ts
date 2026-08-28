import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  writeGitHubArtifact,
  writeGitHubListArtifact,
  githubArtifactDir,
  githubSweepOptions,
} from '../src/tools/githubOverflowArtifact.js';
import { ARTIFACT_MAX_BYTES } from '../src/tools/webSearchArtifact.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-artifact-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('writeGitHubArtifact writes content and returns available variant', () => {
  const content = 'hello world';
  const result = writeGitHubArtifact(content, 100, true, { baseDir: tmpDir });
  assert.equal(result.available, true);
  if (!result.available) throw new Error('expected available');
  assert.ok(result.path);
  assert.equal(result.sourceBytes, 100);
  assert.equal(result.storedBytes, Buffer.byteLength(content, 'utf8'));
  assert.equal(result.complete, true);
  assert.ok(result.expiresAt);
  assert.ok(fs.existsSync(result.path));
  assert.equal(fs.readFileSync(result.path, 'utf8'), content);
});

test('writeGitHubArtifact returns unavailable when write fails', () => {
  // Create a file at tmpDir, then try to write under tmpDir/file/subdir
  fs.writeFileSync(path.join(tmpDir, 'blocker'), 'x');
  const badDir = path.join(tmpDir, 'blocker', 'subdir');
  const result = writeGitHubArtifact('content', 100, true, { baseDir: badDir });
  assert.equal(result.available, false);
  assert.equal(result.path, null);
  assert.equal(result.storedBytes, 0);
});

test('writeGitHubArtifact reports complete=false when content exceeds 1 MiB cap', () => {
  const big = 'x'.repeat(ARTIFACT_MAX_BYTES + 100);
  const result = writeGitHubArtifact(big, big.length, true, { baseDir: tmpDir });
  assert.equal(result.available, true);
  if (!result.available) throw new Error('expected available');
  assert.equal(result.complete, false);
});

test('writeGitHubListArtifact writes JSON list as Markdown', () => {
  const entries = [{ name: 'a.ts' }, { name: 'b.ts' }];
  const result = writeGitHubListArtifact('Tree entries', entries, 200, true, { baseDir: tmpDir });
  assert.equal(result.available, true);
  if (!result.available) throw new Error('expected available');
  const written = fs.readFileSync(result.path!, 'utf8');
  assert.ok(written.includes('# Tree entries'));
  assert.ok(written.includes('"name": "a.ts"'));
  assert.ok(written.includes('"name": "b.ts"'));
});

test('githubArtifactDir returns absolute path under ~/.cache/search-mcp/github-artifacts', () => {
  const dir = githubArtifactDir();
  assert.ok(dir.includes('.cache'));
  assert.ok(dir.includes('github-artifacts'));
  assert.ok(path.isAbsolute(dir));
});

test('githubSweepOptions returns sensible defaults', () => {
  const opts = githubSweepOptions();
  assert.ok(String(opts.baseDir).includes('github-artifacts'));
  assert.equal(opts.ttlMs, 24 * 60 * 60 * 1000);
  assert.equal(opts.maxFiles, 200);
  assert.equal(opts.maxTotalBytes, 64 * 1024 * 1024);
});
