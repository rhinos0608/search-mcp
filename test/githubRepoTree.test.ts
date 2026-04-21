import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getGitHubRepoTree } from '../src/tools/githubRepoTree.js';
import { resetTrackers } from '../src/rateLimit.js';

// ── Test isolation ─────────────────────────────────────────────────────────

beforeEach(() => {
  resetTrackers();
});

afterEach(() => {
  resetTrackers();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a mock Response-like object for fetch with the given JSON body.
 */
function buildMockResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

// ── Non-recursive directory listing ──────────────────────────────────────────

test('getGitHubRepoTree non-recursive returns normalized entries', async () => {
  const mockContents = [
    {
      name: 'README.md',
      path: 'README.md',
      type: 'file',
      size: 1234,
      sha: 'abc123def456',
      html_url: 'https://github.com/o/r/blob/main/README.md',
      url: 'https://api.github.com/repos/o/r/contents/README.md?ref=main',
    },
    {
      name: 'src',
      path: 'src',
      type: 'dir',
      sha: 'def789ghi012',
      html_url: 'https://github.com/o/r/tree/main/src',
      url: 'https://api.github.com/repos/o/r/contents/src?ref=main',
    },
    {
      name: 'package.json',
      path: 'package.json',
      type: 'file',
      size: 567,
      sha: 'jkl345mno678',
      html_url: 'https://github.com/o/r/blob/main/package.json',
      url: 'https://api.github.com/repos/o/r/contents/package.json?ref=main',
    },
  ];

  globalThis.fetch = async () => buildMockResponse(mockContents);

  const result = await getGitHubRepoTree('o', 'r', undefined, 'main', false);

  assert.equal(result.entries.length, 3);
  assert.equal(result.truncated, false);

  // File entry
  const readme = result.entries.find((e) => e.path === 'README.md')!;
  assert.equal(readme.name, 'README.md');
  assert.equal(readme.type, 'file');
  assert.equal(readme.size, 1234);
  assert.equal(readme.sha, 'abc123def456');
  assert.equal(readme.htmlUrl, 'https://github.com/o/r/blob/main/README.md');
  assert.equal(readme.apiUrl, 'https://api.github.com/repos/o/r/contents/README.md?ref=main');

  // Dir entry (no size, no sha)
  const srcDir = result.entries.find((e) => e.path === 'src')!;
  assert.equal(srcDir.name, 'src');
  assert.equal(srcDir.type, 'dir');
  assert.equal(srcDir.htmlUrl, 'https://github.com/o/r/tree/main/src');
  assert.equal(srcDir.apiUrl, 'https://api.github.com/repos/o/r/contents/src?ref=main');
});

test('getGitHubRepoTree non-recursive with custom path', async () => {
  const mockContents = [
    {
      name: 'index.ts',
      path: 'src/index.ts',
      type: 'file',
      size: 999,
      sha: 'sha999',
      html_url: 'https://github.com/o/r/blob/feature-branch/src/index.ts',
      url: 'https://api.github.com/repos/o/r/contents/src/index.ts?ref=feature-branch',
    },
  ];

  globalThis.fetch = async () => buildMockResponse(mockContents);

  const result = await getGitHubRepoTree('o', 'r', 'src', 'feature-branch', false);

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.name, 'index.ts');
  assert.equal(result.entries[0]!.type, 'file');
  assert.equal(result.entries[0]!.size, 999);
});

test('getGitHubRepoTree non-recursive without branch param', async () => {
  const mockContents = [
    {
      name: 'foo.txt',
      path: 'docs/foo.txt',
      type: 'file',
      size: 42,
      sha: 'sha42',
      html_url: 'https://github.com/o/r/blob/main/docs/foo.txt',
      url: 'https://api.github.com/repos/o/r/contents/docs/foo.txt',
    },
  ];

  globalThis.fetch = async () => buildMockResponse(mockContents);

  const result = await getGitHubRepoTree('o', 'r', 'docs', undefined, false);

  assert.equal(result.entries.length, 1);
  // url should NOT include ?ref= when no branch is provided
  assert.equal(result.entries[0]!.apiUrl, 'https://api.github.com/repos/o/r/contents/docs/foo.txt');
});

// ── Recursive tree listing ─────────────────────────────────────────────────

test('getGitHubRepoTree recursive returns flattened tree with normalized types', async () => {
  const mockTree = {
    tree: [
      {
        path: 'README.md',
        type: 'blob',
        mode: '100644',
        sha: 'blob-sha-1',
        size: 100,
        url: 'https://api.github.com/repos/o/r/git/blobs/blob-sha-1',
      },
      {
        path: 'src/index.ts',
        type: 'blob',
        mode: '100644',
        sha: 'blob-sha-2',
        size: 200,
        url: 'https://api.github.com/repos/o/r/git/blobs/blob-sha-2',
      },
      {
        path: 'src/lib',
        type: 'tree',
        mode: '040000',
        sha: 'tree-sha-1',
        url: 'https://api.github.com/repos/o/r/git/trees/tree-sha-1',
      },
      {
        path: 'src/lib/util.ts',
        type: 'blob',
        mode: '100644',
        sha: 'blob-sha-3',
        size: 300,
        url: 'https://api.github.com/repos/o/r/git/blobs/blob-sha-3',
      },
      {
        path: 'symlink.sh',
        type: 'blob',
        mode: '120000',
        sha: 'symlink-sha',
        size: 20,
        url: 'https://api.github.com/repos/o/r/git/blobs/symlink-sha',
      },
      {
        path: 'subdir/submodule',
        type: 'commit',
        mode: '160000',
        sha: 'commit-sha',
        url: 'https://api.github.com/repos/o/r/git/commits/commit-sha',
      },
    ],
    truncated: false,
  };

  globalThis.fetch = async () => buildMockResponse(mockTree);

  const result = await getGitHubRepoTree('o', 'r', undefined, 'develop', true);

  assert.equal(result.entries.length, 6);
  assert.equal(result.truncated, false);

  const readme = result.entries.find((e) => e.path === 'README.md')!;
  assert.equal(readme.type, 'file');
  assert.equal(readme.name, 'README.md');
  assert.equal(readme.size, 100);
  assert.equal(readme.sha, 'blob-sha-1');
  assert.equal(readme.htmlUrl, 'https://github.com/o/r/blob/develop/README.md');

  const srcDir = result.entries.find((e) => e.path === 'src/lib')!;
  assert.equal(srcDir.type, 'dir');
  assert.equal(srcDir.name, 'lib');
  assert.equal(srcDir.sha, 'tree-sha-1');

  const utilFile = result.entries.find((e) => e.path === 'src/lib/util.ts')!;
  assert.equal(utilFile.type, 'file');
  assert.equal(utilFile.name, 'util.ts');
  assert.equal(utilFile.size, 300);

  const symlink = result.entries.find((e) => e.path === 'symlink.sh')!;
  assert.equal(symlink.type, 'symlink');
  assert.equal(symlink.name, 'symlink.sh');

  const submodule = result.entries.find((e) => e.path === 'subdir/submodule')!;
  assert.equal(submodule.type, 'submodule');
  assert.equal(submodule.name, 'submodule');
});

test('getGitHubRepoTree recursive with truncated flag from GitHub', async () => {
  const mockTree = {
    tree: [{ path: 'a.txt', type: 'blob', mode: '100644', sha: 's1', size: 1, url: 'url1' }],
    truncated: true,
  };

  globalThis.fetch = async () => buildMockResponse(mockTree);

  const result = await getGitHubRepoTree('o', 'r', undefined, 'main', true);

  assert.equal(result.truncated, true);
  assert.equal(result.entries.length, 1);
});

test('getGitHubRepoTree recursive falls back to non-recursive on 404', async () => {
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      // First call: recursive tree API returns 404
      return buildMockResponse({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });
    }
    // Second call: non-recursive contents API returns success
    return buildMockResponse([
      {
        name: 'fallback.txt',
        path: 'fallback.txt',
        type: 'file',
        size: 10,
        sha: 'fallback-sha',
        html_url: 'https://github.com/o/r/blob/main/fallback.txt',
        url: 'https://api.github.com/repos/o/r/contents/fallback.txt?ref=main',
      },
    ]);
  };

  const result = await getGitHubRepoTree('o', 'r', undefined, 'main', true);

  assert.equal(callCount, 2);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.name, 'fallback.txt');
});

// ── 404 handling ─────────────────────────────────────────────────────────────

test('getGitHubRepoTree throws notFoundError on 404 for non-recursive', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });

  await assert.rejects(
    async () => getGitHubRepoTree('o', 'nonexistent', undefined, 'main', false),
    (err: unknown) => {
      return (
        err instanceof Error && /not found/i.test(err.message)
      );
    },
  );
});

test('getGitHubRepoTree throws notFoundError when both recursive and fallback 404', async () => {
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount++;
    return buildMockResponse({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });
  };

  await assert.rejects(
    async () => getGitHubRepoTree('o', 'nonexistent', undefined, 'main', true),
    (err: unknown) => {
      return (
        err instanceof Error && /not found/i.test(err.message)
      );
    },
  );

  assert.equal(callCount, 2);
});

// ── Limit truncation ────────────────────────────────────────────────────────

test('getGitHubRepoTree applies limit to entries', async () => {
  const mockContents = [
    { name: 'a.txt', path: 'a.txt', type: 'file', size: 1, sha: 's1', html_url: 'u1', url: 'u1' },
    { name: 'b.txt', path: 'b.txt', type: 'file', size: 2, sha: 's2', html_url: 'u2', url: 'u2' },
    { name: 'c.txt', path: 'c.txt', type: 'file', size: 3, sha: 's3', html_url: 'u3', url: 'u3' },
    { name: 'd.txt', path: 'd.txt', type: 'file', size: 4, sha: 's4', html_url: 'u4', url: 'u4' },
    { name: 'e.txt', path: 'e.txt', type: 'file', size: 5, sha: 's5', html_url: 'u5', url: 'u5' },
  ];

  globalThis.fetch = async () => buildMockResponse(mockContents);

  const result = await getGitHubRepoTree('o', 'r', undefined, 'main', false, 3);

  assert.equal(result.entries.length, 3);
  assert.equal(result.entries[0]!.name, 'a.txt');
  assert.equal(result.entries[1]!.name, 'b.txt');
  assert.equal(result.entries[2]!.name, 'c.txt');
});

test('getGitHubRepoTree with limit greater than entry count returns all', async () => {
  const mockContents = [
    { name: 'x.txt', path: 'x.txt', type: 'file', size: 1, sha: 'sx', html_url: 'ux', url: 'ux' },
  ];

  globalThis.fetch = async () => buildMockResponse(mockContents);

  const result = await getGitHubRepoTree('o', 'r', undefined, 'main', false, 100);

  assert.equal(result.entries.length, 1);
});

test('getGitHubRepoTree recursive applies limit', async () => {
  const mockTree = {
    tree: [
      { path: 'a/a.txt', type: 'blob', mode: '100644', sha: 's1', size: 1, url: 'u1' },
      { path: 'b/b.txt', type: 'blob', mode: '100644', sha: 's2', size: 2, url: 'u2' },
      { path: 'c/c.txt', type: 'blob', mode: '100644', sha: 's3', size: 3, url: 'u3' },
    ],
    truncated: false,
  };

  globalThis.fetch = async () => buildMockResponse(mockTree);

  const result = await getGitHubRepoTree('o', 'r', undefined, 'main', true, 2);

  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0]!.path, 'a/a.txt');
  assert.equal(result.entries[1]!.path, 'b/b.txt');
});

// ── Rate limit handling ─────────────────────────────────────────────────────

test('getGitHubRepoTree throws rateLimitError on 429', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({ message: 'Rate limit exceeded' }, { status: 429, statusText: 'Too Many Requests' });

  await assert.rejects(
    async () => getGitHubRepoTree('o', 'r', undefined, 'main', false),
    (err: unknown) => {
      return err instanceof Error && /rate limit/i.test(err.message);
    },
  );
});

test('getGitHubRepoTree throws rateLimitError on 403', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({ message: 'Forbidden' }, { status: 403, statusText: 'Forbidden' });

  await assert.rejects(
    async () => getGitHubRepoTree('o', 'r', undefined, 'main', false),
    (err: unknown) => {
      return err instanceof Error && /rate limit/i.test(err.message);
    },
  );
});

// ── Type edge cases ─────────────────────────────────────────────────────────

test('getGitHubRepoTree handles symlink via mode 120000', async () => {
  const mockTree = {
    tree: [
      {
        path: 'link',
        type: 'blob',
        mode: '120000',
        sha: 'link-sha',
        size: 10,
        url: 'https://api.github.com/repos/o/r/git/blobs/link-sha',
      },
    ],
    truncated: false,
  };

  globalThis.fetch = async () => buildMockResponse(mockTree);

  const result = await getGitHubRepoTree('o', 'r', undefined, 'main', true);

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.type, 'symlink');
});

test('getGitHubRepoTree non-recursive maps submodule type', async () => {
  const mockContents = [
    {
      name: 'submodule',
      path: 'submodule',
      type: 'submodule',
      sha: 'sub-sha',
      html_url: 'https://github.com/o/r/tree/main/submodule',
      url: 'https://api.github.com/repos/o/r/contents/submodule?ref=main',
    },
  ];

  globalThis.fetch = async () => buildMockResponse(mockContents);

  const result = await getGitHubRepoTree('o', 'r', undefined, 'main', false);

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.type, 'submodule');
});
