import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchGitHubCorpus,
  getGitHubCorpusWarnings,
  parseGitIgnoreRules,
  prioritizeBroadGitHubCorpus,
  shouldIncludeFile,
  shouldIncludeFileWithIgnoreRules,
} from '../src/utils/githubCorpus.js';
import type { GitHubTreeEntry } from '../src/types.js';

function entry(path: string, size = 1000): GitHubTreeEntry {
  return {
    name: path.split('/').at(-1) ?? path,
    path,
    type: 'file',
    htmlUrl: `https://github.com/o/r/blob/main/${path}`,
    apiUrl: `https://api.github.com/repos/o/r/contents/${path}`,
    size,
  };
}

test('getGitHubCorpusWarnings warns when a repo crawl is broad and example-heavy', () => {
  const warnings = getGitHubCorpusWarnings({
    repo: 'owner/repo',
    query: undefined,
    maxFiles: 100,
    candidateCount: 500,
    selectedPaths: ['examples/demo.ts', 'src/index.ts', 'dist/generated.js'],
  });

  assert.ok(warnings.some((warning) => /broad|example|generated/i.test(warning)));
});

test('parseGitIgnoreRules excludes generated files and keeps negated source paths', () => {
  const rules = parseGitIgnoreRules(`
# generated artifacts
vendor/
*.generated.ts
!important.generated.ts
/cache
`);

  assert.ok(!shouldIncludeFileWithIgnoreRules(entry('vendor/pkg/client.ts'), ['.ts'], rules));
  assert.ok(!shouldIncludeFileWithIgnoreRules(entry('src/foo.generated.ts'), ['.ts'], rules));
  assert.ok(shouldIncludeFileWithIgnoreRules(entry('src/important.generated.ts'), ['.ts'], rules));
  assert.ok(!shouldIncludeFileWithIgnoreRules(entry('cache/index.ts'), ['.ts'], rules));
  assert.ok(shouldIncludeFileWithIgnoreRules(entry('src/index.ts'), ['.ts'], rules));
});

test('query-scoped prioritization keeps source files ahead of examples', () => {
  const ordered = prioritizeBroadGitHubCorpus([
    entry('examples/renderLabel.ts'),
    entry('tests/renderLabel.test.ts'),
    entry('src/renderLabel.ts'),
    entry('packages/core/renderLabel.ts'),
  ]);

  assert.deepEqual(
    ordered.slice(0, 2).map((candidate) => candidate.path),
    ['src/renderLabel.ts', 'packages/core/renderLabel.ts'],
  );
});

test('shouldIncludeFile remains deterministic after ignore filtering', () => {
  const rules = parseGitIgnoreRules('dist/\nbuild/\n');
  const selected = [entry('src/a.ts'), entry('dist/a.ts'), entry('build/b.ts'), entry('src/b.ts')]
    .filter((candidate) => shouldIncludeFile(candidate, ['.ts']))
    .filter((candidate) => shouldIncludeFileWithIgnoreRules(candidate, ['.ts'], rules))
    .map((candidate) => candidate.path);

  assert.deepEqual(selected, ['src/a.ts', 'src/b.ts']);
});

test('fetchGitHubCorpus forwards a configurable maxFileBytes limit', async () => {
  const treeEntry = entry('src/index.ts');
  const treeCalls: unknown[][] = [];
  const fileCalls: unknown[][] = [];

  const docs = await fetchGitHubCorpus(
    {
      owner: 'owner',
      repo: 'repo',
      maxFiles: 1,
      maxFileBytes: 12_345,
    } as any,
    {
      getGitHubRepoTree: async (...args: any[]) => {
        treeCalls.push(args);
        return { entries: [treeEntry] } as any;
      },
      getGitHubRepoFile: async (...args: any[]) => {
        fileCalls.push(args);
        return {
          isBinary: false,
          content: 'export const ok = 1;\n',
          htmlUrl: treeEntry.htmlUrl,
        } as any;
      },
      getGitHubRepoSearch: async () => {
        throw new Error('search should not be used');
      },
    },
  );

  assert.equal(treeCalls.length, 1);
  assert.equal(fileCalls.length, 1);
  assert.equal(fileCalls[0]?.[8], 12_345);
  assert.equal(docs[0]?.path, 'src/index.ts');
});
