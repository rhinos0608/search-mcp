import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prioritizeBroadGitHubCorpus, shouldIncludeFile } from '../src/utils/githubCorpus.js';
import type { GitHubTreeEntry } from '../src/types.js';

describe('shouldIncludeFile', () => {
  it('includes markdown files', () => {
    const entry: GitHubTreeEntry = {
      name: 'README.md',
      path: 'README.md',
      type: 'file',
      htmlUrl: 'https://github.com/o/r/blob/main/README.md',
      apiUrl: 'https://api.github.com/repos/o/r/contents/README.md',
      size: 1000,
    };
    assert.ok(shouldIncludeFile(entry, ['.md']));
  });

  it('excludes node_modules files', () => {
    const entry: GitHubTreeEntry = {
      name: 'index.js',
      path: 'node_modules/foo/index.js',
      type: 'file',
      htmlUrl: 'https://github.com/o/r/blob/main/node_modules/foo/index.js',
      apiUrl: 'https://api.github.com/repos/o/r/contents/node_modules/foo/index.js',
      size: 1000,
    };
    assert.ok(!shouldIncludeFile(entry, ['.js']));
  });

  it('excludes target directory files', () => {
    const entry: GitHubTreeEntry = {
      name: 'main.rs',
      path: 'target/debug/main.rs',
      type: 'file',
      htmlUrl: 'https://github.com/o/r/blob/main/target/debug/main.rs',
      apiUrl: 'https://api.github.com/repos/o/r/contents/target/debug/main.rs',
      size: 1000,
    };
    assert.ok(!shouldIncludeFile(entry, ['.rs']));
  });

  it('excludes oversized code files', () => {
    const entry: GitHubTreeEntry = {
      name: 'big.py',
      path: 'big.py',
      type: 'file',
      htmlUrl: 'https://github.com/o/r/blob/main/big.py',
      apiUrl: 'https://api.github.com/repos/o/r/contents/big.py',
      size: 200_000,
    };
    assert.ok(!shouldIncludeFile(entry, ['.py']));
  });

  it('allows oversized documentation files up to 500KB', () => {
    const entry: GitHubTreeEntry = {
      name: 'RFC.md',
      path: 'docs/RFC.md',
      type: 'file',
      htmlUrl: 'https://github.com/o/r/blob/main/docs/RFC.md',
      apiUrl: 'https://api.github.com/repos/o/r/contents/docs/RFC.md',
      size: 400_000,
    };
    assert.ok(shouldIncludeFile(entry, ['.md']));
  });

  it('excludes extensionless files', () => {
    const entry: GitHubTreeEntry = {
      name: 'LICENSE',
      path: 'LICENSE',
      type: 'file',
      htmlUrl: 'https://github.com/o/r/blob/main/LICENSE',
      apiUrl: 'https://api.github.com/repos/o/r/contents/LICENSE',
      size: 1000,
    };
    assert.ok(!shouldIncludeFile(entry, ['.md']));
  });

  it('excludes directories', () => {
    const entry: GitHubTreeEntry = {
      name: 'src',
      path: 'src',
      type: 'dir',
      htmlUrl: 'https://github.com/o/r/tree/main/src',
      apiUrl: 'https://api.github.com/repos/o/r/contents/src',
    };
    assert.ok(!shouldIncludeFile(entry, ['.md']));
  });

  it('prioritizes core files ahead of examples in broad crawls', () => {
    const ordered = prioritizeBroadGitHubCorpus([
      {
        name: 'README.md',
        path: 'examples/README.md',
        type: 'file',
        htmlUrl: 'https://github.com/o/r/blob/main/examples/README.md',
        apiUrl: 'https://api.github.com/repos/o/r/contents/examples/README.md',
        size: 1000,
      },
      {
        name: 'index.ts',
        path: 'src/index.ts',
        type: 'file',
        htmlUrl: 'https://github.com/o/r/blob/main/src/index.ts',
        apiUrl: 'https://api.github.com/repos/o/r/contents/src/index.ts',
        size: 1000,
      },
    ]);

    assert.equal(ordered[0]?.path, 'src/index.ts');
  });
});
