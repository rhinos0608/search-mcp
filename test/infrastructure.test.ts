import test from 'node:test';
import assert from 'node:assert/strict';

import * as types from '../src/types.js';
import { RateLimitedBackend } from '../src/rateLimit.js';
import { FREE_TOOLS, RATE_LIMIT_TOOL_MAP, getNetworkProbes } from '../src/health.js';
import { loadConfig } from '../src/config.js';

// ── Types ────────────────────────────────────────────────────────────────────

test('GitHubTreeEntry is a valid interface with required fields', () => {
  const entry: types.GitHubTreeEntry = {
    name: 'src',
    path: 'packages/search-mcp/src',
    type: 'dir',
    htmlUrl: 'https://github.com/example/repo/tree/main/src',
    apiUrl: 'https://api.github.com/repos/example/repo/contents/src',
  };
  assert.equal(entry.name, 'src');
  assert.equal(entry.type, 'dir');
});

test('GitHubTreeEntry supports all type variants', () => {
  const variants: types.GitHubTreeEntry['type'][] = ['file', 'dir', 'symlink', 'submodule'];
  for (const t of variants) {
    const entry: types.GitHubTreeEntry = {
      name: 'test',
      path: 'test',
      type: t,
      htmlUrl: 'https://github.com/example/repo/blob/main/test',
      apiUrl: 'https://api.github.com/repos/example/repo/contents/test',
    };
    assert.equal(entry.type, t);
  }
});

test('GitHubTreeResult has entries array and truncated flag', () => {
  const result: types.GitHubTreeResult = {
    entries: [],
    truncated: false,
  };
  assert.ok(Array.isArray(result.entries));
  assert.equal(result.truncated, false);
});

test('GitHubFileResult has required fields including isBinary', () => {
  const file: types.GitHubFileResult = {
    name: 'README.md',
    path: 'README.md',
    size: 1234,
    sha: 'abc123',
    content: 'Hello world',
    encoding: 'utf-8',
    htmlUrl: 'https://github.com/example/repo/blob/main/README.md',
    apiUrl: 'https://api.github.com/repos/example/repo/contents/README.md',
    truncated: false,
    isBinary: false,
  };
  assert.equal(file.name, 'README.md');
  assert.equal(file.encoding, 'utf-8');
  assert.equal(file.isBinary, false);
});

test('GitHubCodeResult has textMatches with match indices', () => {
  const result: types.GitHubCodeResult = {
    url: 'https://api.github.com/search/code?q=example',
    htmlUrl: 'https://github.com/example/repo/search?q=example',
    repo: 'example/repo',
    path: 'src/index.ts',
    name: 'index.ts',
    score: 100,
    textMatches: [
      {
        fragment: 'function example()',
        matches: [{ text: 'example', indices: [[9, 16]] as [number, number][] }],
      },
    ],
  };
  assert.equal(result.score, 100);
  assert.ok(result.textMatches);
  assert.equal(result.textMatches[0]!.fragment, 'function example()');
});

test('GitHubCodeSearchResult has totalCount and results array', () => {
  const searchResult: types.GitHubCodeSearchResult = {
    totalCount: 42,
    results: [],
  };
  assert.equal(searchResult.totalCount, 42);
  assert.ok(Array.isArray(searchResult.results));
});

// ── RateLimit: github_search backend ─────────────────────────────────────────

test('RateLimitedBackend includes github_search', () => {
  const backends: RateLimitedBackend[] = [
    'brave',
    'github',
    'github_search',
    'reddit',
    'semantic_scholar',
    'arxiv',
  ];
  // Verify all six are assignable — any unknown value would fail TypeScript
  void backends;
});

// ── Health: FREE_TOOLS includes new GitHub tools ────────────────────────────

test('FREE_TOOLS includes github_tree, github_file, github_code_search', () => {
  const expected = ['github_tree', 'github_file', 'github_code_search'] as const;
  for (const tool of expected) {
    assert.ok(
      (FREE_TOOLS as readonly string[]).includes(tool),
      `${tool} should be in FREE_TOOLS`,
    );
  }
});

// ── Health: RATE_LIMIT_TOOL_MAP includes GitHub search mapping ───────────────

test('RATE_LIMIT_TOOL_MAP includes github_code_search → github_search', () => {
  const entry = RATE_LIMIT_TOOL_MAP.find(([tool]) => tool === 'github_code_search');
  assert.ok(entry, 'RATE_LIMIT_TOOL_MAP should have an entry for github_code_search');
  assert.equal(entry[1], 'github_search', 'github_code_search should map to github_search backend');
});

// ── Health: getNetworkProbes returns probe for github_search ─────────────────

test('getNetworkProbes returns a probe for github_code_search', () => {
  const cfg = loadConfig();
  const probes = getNetworkProbes(cfg);
  const githubProbe = probes.find((p: { tools: readonly string[] }) => p.tools.includes('github_code_search'));
  assert.ok(githubProbe, 'getNetworkProbes should return a probe for github_code_search');
  assert.ok(githubProbe.url.includes('api.github.com'), 'probe URL should use GitHub API');
});