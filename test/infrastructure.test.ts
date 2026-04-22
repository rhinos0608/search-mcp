import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as types from '../src/types.js';
import { getTracker, resetTrackers, parseRateLimitHeaders } from '../src/rateLimit.js';
import { FREE_TOOLS, RATE_LIMIT_TOOL_MAP, getNetworkProbes, configHealth } from '../src/health.js';
import { loadConfig, resetConfig } from '../src/config.js';

// ── Test isolation ─────────────────────────────────────────────────────────

beforeEach(() => {
  resetConfig();
  resetTrackers();
});

afterEach(() => {
  resetConfig();
  resetTrackers();
});

// ── Types ───────────────────────────────────────────────────────────────────

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
    totalLines: 1,
    lineOffset: 0,
    lineLimit: null,
    hasMore: false,
    byteOffset: null,
    byteLimit: null,
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

// ── RateLimit: behavioral test for independent trackers ─────────────────────

test('github_search tracker is independent from github tracker', () => {
  const searchTracker = getTracker('github_search');
  const githubTracker = getTracker('github');

  // Initially both have no info
  assert.equal(searchTracker.getInfo(), null);
  assert.equal(githubTracker.getInfo(), null);

  // Recording a limit hit on one should not affect the other
  searchTracker.recordLimitHit();
  assert.equal(searchTracker.canProceed(), false);
  assert.equal(githubTracker.canProceed(), true);
});

// ── RateLimit: parseGitHubSearchHeaders behavioral test ────────────────────

test('parseGitHubSearchHeaders returns RateLimitInfo with backend github_search', () => {
  const headers = new Headers({
    'x-ratelimit-remaining': '42',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-reset': '1735689600',
  });

  const result = parseRateLimitHeaders('github_search', headers);

  assert.ok(result !== null, 'parseGitHubSearchHeaders should return non-null for valid headers');
  assert.equal(result!.backend, 'github_search', 'backend should be github_search');
  assert.equal(result!.remaining, 42);
  assert.equal(result!.limit, 5000);
  // resetAt = resetEpochSec * 1000 + clockSkewMs (may have small clock skew)
  assert.ok(result!.resetAt >= 1735689600000, 'resetAt should be >= 1735689600000, got: ' + result!.resetAt);
});

// ── Health: FREE_TOOLS includes new GitHub tools ────────────────────────────

test('FREE_TOOLS includes github_repo_tree, github_repo_file, github_repo_search', () => {
  const expected = ['github_repo_tree', 'github_repo_file', 'github_repo_search'] as const;
  for (const tool of expected) {
    assert.ok(
      (FREE_TOOLS as readonly string[]).includes(tool),
      tool + ' should be in FREE_TOOLS',
    );
  }
});

// ── Health: RATE_LIMIT_TOOL_MAP includes GitHub tools ───────────────────────

test('RATE_LIMIT_TOOL_MAP includes github_repo_tree and github_repo_file mapping to github', () => {
  const treeEntry = RATE_LIMIT_TOOL_MAP.find(([tool]) => tool === 'github_repo_tree');
  assert.ok(treeEntry, 'RATE_LIMIT_TOOL_MAP should have an entry for github_repo_tree');
  assert.equal(treeEntry[1], 'github', 'github_repo_tree should map to github backend');

  const fileEntry = RATE_LIMIT_TOOL_MAP.find(([tool]) => tool === 'github_repo_file');
  assert.ok(fileEntry, 'RATE_LIMIT_TOOL_MAP should have an entry for github_repo_file');
  assert.equal(fileEntry[1], 'github', 'github_repo_file should map to github backend');
});

test('RATE_LIMIT_TOOL_MAP includes github_repo_search to github_search', () => {
  const entry = RATE_LIMIT_TOOL_MAP.find(([tool]) => tool === 'github_repo_search');
  assert.ok(entry, 'RATE_LIMIT_TOOL_MAP should have an entry for github_repo_search');
  assert.equal(entry[1], 'github_search', 'github_repo_search should map to github_search backend');
});

// ── Health: configHealth returns healthy for free GitHub tools ───────────────

test('configHealth returns healthy status for github_repo_tree, github_repo_file, github_repo_search', () => {
  const cfg = loadConfig();
  const health = configHealth(cfg);

  assert.equal(health['github_repo_tree']?.status, 'healthy', 'github_repo_tree should be healthy');
  assert.equal(health['github_repo_file']?.status, 'healthy', 'github_repo_file should be healthy');
  assert.equal(health['github_repo_search']?.status, 'healthy', 'github_repo_search should be healthy');
});

// ── Health: getNetworkProbes returns probe for github tools ─────────────────

test('getNetworkProbes returns probes for all github tools', () => {
  const cfg = loadConfig();
  const probes = getNetworkProbes(cfg);
  const githubProbe = probes.find((p) => p.tools.includes('github_repo'));
  assert.ok(githubProbe, 'getNetworkProbes should return a probe for github_repo');

  // Verify all GitHub tools are in the probe
  const githubTools = ['github_repo', 'github_repo_tree', 'github_repo_file', 'github_repo_search'];
  for (const tool of githubTools) {
    assert.ok(
      githubProbe.tools.includes(tool),
      'probe should include ' + tool,
    );
  }
  assert.ok(githubProbe.url.includes('api.github.com'), 'probe URL should use GitHub API');
});
