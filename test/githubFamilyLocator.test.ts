/**
 * Tests for GitHub family tool schema validation with repository locators
 * (owner/repo strings, GitHub URLs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

interface RegisteredToolEntry {
  description?: string;
  inputSchema?: unknown;
}

function getRegisteredTool(
  server: ReturnType<typeof createServer>['server'],
  name: string,
): RegisteredToolEntry {
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, RegisteredToolEntry>;
    }
  )._registeredTools;
  const entry = tools[name];
  assert.ok(entry !== undefined, `tool ${name} should be registered`);
  return entry;
}

// ── github.repo ────────────────────────────────────────────────────────────

test('github.repo accepts owner/repo in repository field', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');
  assert.ok(entry.inputSchema !== undefined);

  const parsed = (entry.inputSchema as { parse: (v: unknown) => unknown }).parse({
    action: 'repo',
    repository: 'owner/repo',
  }) as { action: string; repository: string };

  assert.equal(parsed.action, 'repo');
  assert.equal(parsed.repository, 'owner/repo');
});

test('github.repo accepts GitHub URL in repository field', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  // The repository field no longer has strict owner/repo regex, so any string is accepted
  // at the merged-schema level. The per-action handler resolves the URL at runtime.
  const parsed = (entry.inputSchema as { parse: (v: unknown) => unknown }).parse({
    action: 'repo',
    repository: 'https://github.com/owner/repo',
  }) as { action: string; repository: string };

  assert.equal(parsed.action, 'repo');
  assert.equal(parsed.repository, 'https://github.com/owner/repo');
});

test('github.repo accepts owner+repo separate fields', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const parsed = (entry.inputSchema as { parse: (v: unknown) => unknown }).parse({
    action: 'repo',
    owner: 'my-org',
    repo: 'my-repo',
  }) as { action: string; owner: string; repo: string };

  assert.equal(parsed.owner, 'my-org');
  assert.equal(parsed.repo, 'my-repo');
});

// ── github.file ────────────────────────────────────────────────────────────

test('github.file accepts owner+repo separate fields', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const parsed = (entry.inputSchema as { parse: (v: unknown) => unknown }).parse({
    action: 'file',
    owner: 'my-org',
    repo: 'my-repo',
    path: 'README.md',
  }) as { action: string; owner: string; repo: string; path: string };

  assert.equal(parsed.owner, 'my-org');
  assert.equal(parsed.path, 'README.md');
});

test('github.file accepts repository URL field', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  // The repository field is optional at merged-schema level;
  // validation passes at schema level, handler resolves later.
  const parsed = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
  ).safeParse({
    action: 'file',
    repository: 'https://github.com/owner/repo',
    path: 'README.md',
  });

  // Should pass schema validation (repository is optional, owner+repo optional too)
  assert.equal(parsed.success, true);
});

// ── github.tree ────────────────────────────────────────────────────────────

test('github.tree accepts repository URL field', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const parsed = (entry.inputSchema as { parse: (v: unknown) => unknown }).parse({
    action: 'tree',
    repository: 'github.com/owner/repo',
  }) as { action: string; repository: string };

  assert.equal(parsed.action, 'tree');
  assert.equal(parsed.repository, 'github.com/owner/repo');
});

// ── github.code_search ────────────────────────────────────────────────────

test('github.code_search accepts owner/repo in repo field', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const parsed = (entry.inputSchema as { parse: (v: unknown) => unknown }).parse({
    action: 'code_search',
    query: 'function foo',
    repo: 'owner/repo',
  }) as { action: string; repo: string };

  assert.equal(parsed.repo, 'owner/repo');
});

test('github.code_search accepts GitHub URL in repo field (transformed at per-action validate)', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  // The merged schema uses safeParse in superRefine with the per-action schema
  // which transforms URLs via the preprocessor. The outer safeParse succeeds.
  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
  ).safeParse({
    action: 'code_search',
    query: 'function foo',
    repo: 'https://github.com/owner/repo',
  });

  assert.equal(result.success, true);
});

test('github.code_search rejects malformed repo', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
  ).safeParse({
    action: 'code_search',
    query: 'function foo',
    repo: 'invalid-repo-string',
  });

  assert.equal(result.success, false);
});

test('github.code_search accepts path, extensions, and excludeExtensions', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
  ).safeParse({
    action: 'code_search',
    query: 'authentication middleware',
    repo: 'owner/repo',
    path: 'src/server',
    extensions: ['ts', 'tsx'],
    excludeExtensions: ['test.ts', '.d.ts'],
    fileFilter: ['*auth*'],
    topK: 10,
  });

  assert.equal(result.success, true);
  const data = result.data as Record<string, unknown>;
  assert.equal(data.path, 'src/server');
  assert.deepEqual(data.extensions, ['ts', 'tsx']);
  assert.deepEqual(data.excludeExtensions, ['test.ts', '.d.ts']);
});

test('github.code_search rejects simultaneous language and extensions', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
  ).safeParse({
    action: 'code_search',
    query: 'function foo',
    repo: 'owner/repo',
    language: 'typescript',
    extensions: ['ts'],
  });

  assert.equal(result.success, false);
});

test('github.code_search rejects path with double dots', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
  ).safeParse({
    action: 'code_search',
    query: 'function foo',
    repo: 'owner/repo',
    path: '../etc/passwd',
  });

  assert.equal(result.success, false);
});

test('github.code_search rejects path with backslashes', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
  ).safeParse({
    action: 'code_search',
    query: 'function foo',
    repo: 'owner/repo',
    path: 'src\\server',
  });

  assert.equal(result.success, false);
});

test('github.code_search rejects extensions with glob characters', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
  ).safeParse({
    action: 'code_search',
    query: 'function foo',
    repo: 'owner/repo',
    extensions: ['*.ts'],
  });

  assert.equal(result.success, false);
});

// Finding 7: reject empty or '.' extensions

test('github.code_search rejects empty string extensions', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
  ).safeParse({
    action: 'code_search',
    query: 'function foo',
    repo: 'owner/repo',
    extensions: [''],
  });

  assert.equal(result.success, false);
});

test('github.code_search rejects single dot extension', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
  ).safeParse({
    action: 'code_search',
    query: 'function foo',
    repo: 'owner/repo',
    extensions: ['.'],
  });

  assert.equal(result.success, false);
});

// Finding 8: path traversal rejects exact '..' segments only, allows foo..bar

test('github.code_search allows path containing foo..bar', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
  ).safeParse({
    action: 'code_search',
    query: 'function foo',
    repo: 'owner/repo',
    path: 'foo..bar/src',
  });

  assert.equal(result.success, true);
});

// ── github.commits / github.refs ───────────────────────────────────────────

test('github.commits accepts repository URL and ref alias', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
  ).safeParse({
    action: 'commits',
    repository: 'https://github.com/owner/repo',
    ref: 'abc123def456',
    path: 'src/index.ts',
    limit: 10,
  });

  assert.equal(result.success, true);
  const parsed = result.data as Record<string, unknown>;
  assert.equal(parsed.ref, 'abc123def456');
});

test('github.refs accepts tag filters', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
  ).safeParse({
    action: 'refs',
    repository: 'owner/repo',
    type: 'tags',
    filter: 'v1',
    limit: 25,
  });

  assert.equal(result.success, true);
  const parsed = result.data as Record<string, unknown>;
  assert.equal(parsed.type, 'tags');
  assert.equal(parsed.filter, 'v1');
});

test('github.file accepts ref alias for commit-specific reads', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
  ).safeParse({
    action: 'file',
    repository: 'owner/repo',
    path: 'README.md',
    ref: 'abc123def456',
  });

  assert.equal(result.success, true);
  const parsed = result.data as Record<string, unknown>;
  assert.equal(parsed.ref, 'abc123def456');
});

test('github.file accepts lineOffset and lineLimit aliases', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
  ).safeParse({
    action: 'file',
    repository: 'owner/repo',
    path: 'README.md',
    lineOffset: 1450,
    lineLimit: 110,
  });

  assert.equal(result.success, true);
  const parsed = result.data as Record<string, unknown>;
  assert.equal(parsed.lineOffset, 1450);
  assert.equal(parsed.lineLimit, 110);
});

test('github.file rejects conflicting line range aliases', () => {
  const { server } = createServer(loadConfig());
  const entry = getRegisteredTool(server, 'github');

  const result = (
    entry.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
  ).safeParse({
    action: 'file',
    repository: 'owner/repo',
    path: 'README.md',
    offset: 10,
    lineOffset: 11,
  });

  assert.equal(result.success, false);
});
