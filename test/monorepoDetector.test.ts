import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectMonorepoFromEntries,
  buildMonorepoOverview,
} from '../src/utils/monorepoDetector.js';
import type { GitHubTreeEntry, MonorepoDetectResult } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function entry(name: string, type: GitHubTreeEntry['type'] = 'dir'): GitHubTreeEntry {
  return {
    name,
    path: name,
    type,
    htmlUrl: `https://github.com/o/r/tree/main/${name}`,
    apiUrl: `https://api.github.com/repos/o/r/contents/${name}?ref=main`,
  };
}

// ── Detection tests ─────────────────────────────────────────────────────────

test('detectMonorepoFromEntries returns not detected for empty entries', () => {
  const result = detectMonorepoFromEntries([]);
  assert.equal(result.detected, false);
  assert.equal(result.type, 'unknown');
  assert.deepEqual(result.configFiles, []);
  assert.deepEqual(result.workspacePatterns, []);
  assert.deepEqual(result.packages, []);
  assert.equal(result.hasPackageJsonRoot, false);
});

test('detectMonorepoFromEntries returns not detected for simple repo', () => {
  const entries = [
    entry('README.md', 'file'),
    entry('src', 'dir'),
    entry('package.json', 'file'),
  ];
  const result = detectMonorepoFromEntries(entries);
  assert.equal(result.detected, false);
  assert.equal(result.type, 'unknown');
});

test('detectMonorepoFromEntries detects pnpm monorepo from pnpm-workspace.yaml', () => {
  const entries = [
    entry('pnpm-workspace.yaml', 'file'),
    entry('package.json', 'file'),
    entry('packages', 'dir'),
    entry('apps', 'dir'),
  ];
  const result = detectMonorepoFromEntries(entries);
  assert.equal(result.detected, true);
  assert.equal(result.type, 'pnpm');
  assert.ok(result.configFiles.includes('pnpm-workspace.yaml'));
  assert.ok(result.workspacePatterns.includes('packages/*'));
  assert.ok(result.workspacePatterns.includes('apps/*'));
});

test('detectMonorepoFromEntries detects lerna monorepo', () => {
  const entries = [
    entry('lerna.json', 'file'),
    entry('package.json', 'file'),
    entry('packages', 'dir'),
  ];
  const result = detectMonorepoFromEntries(entries);
  assert.equal(result.detected, true);
  assert.equal(result.type, 'lerna');
  assert.ok(result.configFiles.includes('lerna.json'));
});

test('detectMonorepoFromEntries detects turborepo', () => {
  const entries = [
    entry('turbo.json', 'file'),
    entry('package.json', 'file'),
    entry('apps', 'dir'),
  ];
  const result = detectMonorepoFromEntries(entries);
  assert.equal(result.detected, true);
  assert.equal(result.type, 'turborepo');
  assert.ok(result.configFiles.includes('turbo.json'));
});

test('detectMonorepoFromEntries detects Nx monorepo', () => {
  const entries = [
    entry('nx.json', 'file'),
    entry('package.json', 'file'),
    entry('libs', 'dir'),
  ];
  const result = detectMonorepoFromEntries(entries);
  assert.equal(result.detected, true);
  assert.equal(result.type, 'nx');
  assert.ok(result.configFiles.includes('nx.json'));
});

test('detectMonorepoFromEntries detects monorepo from workspace dirs alone', () => {
  const entries = [
    entry('package.json', 'file'),
    entry('packages', 'dir'),
    entry('apps', 'dir'),
    entry('services', 'dir'),
  ];
  const result = detectMonorepoFromEntries(entries);
  assert.equal(result.detected, true);
  assert.equal(result.type, 'yarn'); // fallback type
  assert.deepEqual(result.configFiles, []);
  assert.deepEqual(result.workspacePatterns, ['packages/*', 'apps/*', 'services/*']);
});

test('detectMonorepoFromEntries detects monorepo from modules and servers dirs', () => {
  const entries = [
    entry('modules', 'dir'),
    entry('servers', 'dir'),
    entry('clients', 'dir'),
  ];
  const result = detectMonorepoFromEntries(entries);
  assert.equal(result.detected, true);
  assert.ok(result.workspacePatterns.includes('modules/*'));
  assert.ok(result.workspacePatterns.includes('servers/*'));
  assert.ok(result.workspacePatterns.includes('clients/*'));
});

test('detectMonorepoFromEntries finds multiple config files', () => {
  const entries = [
    entry('pnpm-workspace.yaml', 'file'),
    entry('turbo.json', 'file'),
    entry('lerna.json', 'file'),
    entry('package.json', 'file'),
    entry('packages', 'dir'),
  ];
  const result = detectMonorepoFromEntries(entries);
  assert.equal(result.detected, true);
  assert.equal(result.configFiles.length, 3);
  // pnpm takes precedence
  assert.equal(result.type, 'pnpm');
});

test('detectMonorepoFromEntries handles rush monorepo', () => {
  const entries = [
    entry('rush.json', 'file'),
    entry('package.json', 'file'),
    entry('packages', 'dir'),
  ];
  const result = detectMonorepoFromEntries(entries);
  assert.equal(result.detected, true);
  assert.ok(result.configFiles.includes('rush.json'));
});

// ── buildMonorepoOverview tests ────────────────────────────────────────────

test('buildMonorepoOverview returns empty for undetected', () => {
  const result: MonorepoDetectResult = {
    detected: false,
    type: 'unknown',
    packageManager: null,
    configFiles: [],
    workspacePatterns: [],
    packages: [],
    hasPackageJsonRoot: false,
  };
  assert.equal(buildMonorepoOverview(result), '');
});

test('buildMonorepoOverview includes type and config', () => {
  const result: MonorepoDetectResult = {
    detected: true,
    type: 'pnpm',
    packageManager: 'pnpm',
    configFiles: ['pnpm-workspace.yaml', 'turbo.json'],
    workspacePatterns: ['packages/*', 'apps/*'],
    packages: [
      { name: '@scope/foo', path: 'packages/foo', description: 'Foo package', version: '1.0.0' },
      { name: '@scope/bar', path: 'apps/bar', description: 'Bar app', version: '2.0.0' },
    ],
    hasPackageJsonRoot: true,
  };

  const overview = buildMonorepoOverview(result);
  assert.ok(overview.includes('Monorepo detected'));
  assert.ok(overview.includes('pnpm'));
  assert.ok(overview.includes('pnpm-workspace.yaml'));
  assert.ok(overview.includes('turbo.json'));
  assert.ok(overview.includes('packages/*'));
  assert.ok(overview.includes('apps/*'));
  assert.ok(overview.includes('@scope/foo'));
  assert.ok(overview.includes('Foo package'));
  assert.ok(overview.includes('@scope/bar'));
  assert.ok(overview.includes('2.0.0'));
});

test('buildMonorepoOverview handles packages with minimal info', () => {
  const result: MonorepoDetectResult = {
    detected: true,
    type: 'turborepo',
    packageManager: 'pnpm_or_yarn',
    configFiles: ['turbo.json'],
    workspacePatterns: ['packages/*'],
    packages: [
      { name: 'pkg-a', path: 'packages/a', description: null, version: null },
    ],
    hasPackageJsonRoot: true,
  };

  const overview = buildMonorepoOverview(result);
  assert.ok(overview.includes('pkg-a'));
  assert.ok(!overview.includes('v'));
  assert.ok(!overview.includes(' — '));
});

// ── Integration with getGitHubRepoTree: monorepo detection on root ────────

test('getGitHubRepoTree returns monorepo info for root with pnpm markers', async () => {
  const { getGitHubRepoTree } = await import('../src/tools/githubRepoTree.js');

  const mockContents = [
    {
      name: 'pnpm-workspace.yaml',
      path: 'pnpm-workspace.yaml',
      type: 'file',
      size: 50,
      sha: 'sha-pnpm',
      html_url: 'https://github.com/o/r/blob/main/pnpm-workspace.yaml',
      url: 'https://api.github.com/repos/o/r/contents/pnpm-workspace.yaml?ref=main',
    },
    {
      name: 'package.json',
      path: 'package.json',
      type: 'file',
      size: 200,
      sha: 'sha-pj',
      html_url: 'https://github.com/o/r/blob/main/package.json',
      url: 'https://api.github.com/repos/o/r/contents/package.json?ref=main',
    },
    {
      name: 'packages',
      path: 'packages',
      type: 'dir',
      sha: 'sha-pkgs',
      html_url: 'https://github.com/o/r/tree/main/packages',
      url: 'https://api.github.com/repos/o/r/contents/packages?ref=main',
    },
    {
      name: 'turbo.json',
      path: 'turbo.json',
      type: 'file',
      size: 100,
      sha: 'sha-turbo',
      html_url: 'https://github.com/o/r/blob/main/turbo.json',
      url: 'https://api.github.com/repos/o/r/contents/turbo.json?ref=main',
    },
    {
      name: 'README.md',
      path: 'README.md',
      type: 'file',
      size: 500,
      sha: 'sha-rm',
      html_url: 'https://github.com/o/r/blob/main/README.md',
      url: 'https://api.github.com/repos/o/r/contents/README.md?ref=main',
    },
  ];

  globalThis.fetch = async () => new Response(JSON.stringify(mockContents), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  });

  const result = await getGitHubRepoTree('o', 'r', undefined, 'main', false, 100);

  // Should detect monorepo at root
  assert.ok(result.monorepo, 'Expected monorepo field to be present');
  assert.equal(result.monorepo!.detected, true);
  assert.ok(result.monorepo!.configFiles.includes('pnpm-workspace.yaml'));
  assert.ok(result.monorepo!.configFiles.includes('turbo.json'));

  // Workspace patterns from directory listing
  assert.ok(result.monorepo!.workspacePatterns.includes('packages/*'));

  // Regular entries still present
  assert.ok(result.entries.some((e) => e.name === 'README.md'));
  assert.ok(result.entries.some((e) => e.name === 'packages'));
});

test('getGitHubRepoTree does not include monorepo when includeMonorepo=false', async () => {
  const { getGitHubRepoTree } = await import('../src/tools/githubRepoTree.js');

  const mockContents = [
    {
      name: 'pnpm-workspace.yaml',
      path: 'pnpm-workspace.yaml',
      type: 'file',
      size: 50,
      sha: 'sha-pnpm',
      html_url: 'https://github.com/o/r/blob/main/pnpm-workspace.yaml',
      url: 'https://api.github.com/repos/o/r/contents/pnpm-workspace.yaml?ref=main',
    },
    {
      name: 'packages',
      path: 'packages',
      type: 'dir',
      sha: 'sha-pkgs',
      html_url: 'https://github.com/o/r/tree/main/packages',
      url: 'https://api.github.com/repos/o/r/contents/packages?ref=main',
    },
  ];

  globalThis.fetch = async () => new Response(JSON.stringify(mockContents), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  });

  const result = await getGitHubRepoTree('o', 'r', undefined, 'main', false, 100, false);
  assert.equal(result.monorepo, undefined, 'Expected no monorepo field when includeMonorepo=false');
});

test('getGitHubRepoTree does not detect monorepo for non-root paths', async () => {
  const { getGitHubRepoTree } = await import('../src/tools/githubRepoTree.js');

  const mockContents = [
    {
      name: 'index.ts',
      path: 'src/index.ts',
      type: 'file',
      size: 100,
      sha: 'sha-ts',
      html_url: 'https://github.com/o/r/blob/main/src/index.ts',
      url: 'https://api.github.com/repos/o/r/contents/src/index.ts?ref=main',
    },
  ];

  globalThis.fetch = async () => new Response(JSON.stringify(mockContents), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  });

  const result = await getGitHubRepoTree('o', 'r', 'src', 'main', false, 100);
  assert.equal(result.monorepo, undefined, 'Expected no monorepo for subdirectory path');
});

test('getGitHubRepoTree recursive with monorepo detection at root', async () => {
  const { getGitHubRepoTree } = await import('../src/tools/githubRepoTree.js');

  const mockTree = {
    tree: [
      { path: 'pnpm-workspace.yaml', type: 'blob', mode: '100644', sha: 's1', size: 50, url: 'u1' },
      { path: 'package.json', type: 'blob', mode: '100644', sha: 's2', size: 200, url: 'u2' },
      { path: 'packages', type: 'tree', mode: '040000', sha: 's3', url: 'u3' },
      { path: 'packages/foo/index.ts', type: 'blob', mode: '100644', sha: 's4', size: 100, url: 'u4' },
      { path: 'packages/bar/index.ts', type: 'blob', mode: '100644', sha: 's5', size: 200, url: 'u5' },
      { path: 'turbo.json', type: 'blob', mode: '100644', sha: 's6', size: 100, url: 'u6' },
    ],
    truncated: false,
  };

  globalThis.fetch = async () => new Response(JSON.stringify(mockTree), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  });

  const result = await getGitHubRepoTree('o', 'r', undefined, 'main', true, 100);

  // Should detect monorepo from root entries extracted from recursive tree
  assert.ok(result.monorepo, 'Expected monorepo field for recursive root scan');
  assert.equal(result.monorepo!.detected, true);
  assert.ok(result.monorepo!.configFiles.includes('pnpm-workspace.yaml'));
  assert.ok(result.monorepo!.configFiles.includes('turbo.json'));

  // Regular recursive entries still present
  assert.ok(result.entries.some((e) => e.path === 'packages/foo/index.ts'));
});
