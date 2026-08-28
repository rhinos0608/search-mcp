import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getGitHubCommitHistory } from '../src/tools/githubCommits.js';
import { resetTrackers } from '../src/rateLimit.js';

beforeEach(() => {
  resetTrackers();
});

afterEach(() => {
  resetTrackers();
});

function buildMockResponse(
  body: unknown,
  init?: { status?: number; statusText?: string; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      ...init?.headers,
    },
  });
}

test('getGitHubCommitHistory returns normalized commits', async () => {
  globalThis.fetch = async () =>
    buildMockResponse(
      [
        {
          sha: 'abc123',
          url: 'https://api.github.com/repos/o/r/commits/abc123',
          html_url: 'https://github.com/o/r/commit/abc123',
          comments_url: 'https://api.github.com/repos/o/r/commits/abc123/comments',
          commit: {
            message: 'fix: repair parser',
            author: { name: 'Ada', email: 'ada@example.com', date: '2026-01-01T00:00:00Z' },
            committer: { name: 'Grace', email: 'grace@example.com', date: '2026-01-01T00:01:00Z' },
          },
          author: { login: 'ada' },
          committer: { login: 'grace' },
          parents: [
            {
              sha: 'parent1',
              url: 'https://api.github.com/repos/o/r/commits/parent1',
              html_url: 'https://github.com/o/r/commit/parent1',
            },
          ],
        },
      ],
      {
        headers: {
          link: '<https://api.github.com/repos/o/r/commits?page=2>; rel="next"',
        },
      },
    );

  const result = await getGitHubCommitHistory('o', 'r', { sha: 'main', page: 1, limit: 10 });

  assert.equal(result.repository, 'o/r');
  assert.equal(result.ref, 'main');
  assert.equal(result.limit, 10);
  assert.equal(result.hasNextPage, true);
  assert.equal(result.commits.length, 1);
  assert.equal(result.commits[0]!.sha, 'abc123');
  assert.equal(result.commits[0]!.message, 'fix: repair parser');
  assert.equal(result.commits[0]!.authorLogin, 'ada');
  assert.equal(result.commits[0]!.parents[0]!.sha, 'parent1');
  // pageInfo from Link header
  assert.equal(result.pageInfo.order, 'newest_first');
  assert.equal(result.pageInfo.currentPage, 1);
  assert.equal(result.pageInfo.perPage, 10);
  assert.equal(result.pageInfo.nextPage, 2);
  assert.equal(result.pageInfo.previousPage, null);
  assert.equal(result.pageInfo.lastPage, null);
  // walk metadata
  assert.equal(result.walk.oldestReturnedSha, 'abc123');
  assert.deepEqual(result.walk.parentShas, ['parent1']);
  assert.equal(result.walk.firstParentSha, 'parent1');
  assert.equal(result.walk.reachedInitialCommit, false);
  assert.equal(result.walk.initialCommitSha, null);
});

test('getGitHubCommitHistory detects initial commit in walk', async () => {
  globalThis.fetch = async () =>
    buildMockResponse(
      [
        {
          sha: 'root123',
          url: 'https://api.github.com/repos/o/r/commits/root123',
          html_url: 'https://github.com/o/r/commit/root123',
          comments_url: 'https://api.github.com/repos/o/r/commits/root123/comments',
          commit: {
            message: 'initial commit',
            author: { name: 'Ada', email: 'ada@example.com', date: '2026-01-01T00:00:00Z' },
            committer: { name: 'Ada', email: 'ada@example.com', date: '2026-01-01T00:00:00Z' },
          },
          author: { login: 'ada' },
          committer: { login: 'ada' },
          parents: [],
        },
      ],
      {
        headers: {
          link: '<https://api.github.com/repos/o/r/commits?page=1>; rel="last"',
        },
      },
    );

  const result = await getGitHubCommitHistory('o', 'r', { page: 1, limit: 10 });

  assert.equal(result.walk.reachedInitialCommit, true);
  assert.equal(result.walk.initialCommitSha, 'root123');
  assert.equal(result.pageInfo.lastPage, 1);
  assert.equal(result.pageInfo.previousPage, null);
});

test('getGitHubCommitHistory handles malformed Link header gracefully', async () => {
  globalThis.fetch = async () =>
    buildMockResponse(
      [
        {
          sha: 'abc123',
          url: 'https://api.github.com/repos/o/r/commits/abc123',
          html_url: 'https://github.com/o/r/commit/abc123',
          comments_url: 'https://api.github.com/repos/o/r/commits/abc123/comments',
          commit: {
            message: 'test',
            author: { name: 'A', email: 'a@b.com', date: '2026-01-01T00:00:00Z' },
            committer: { name: 'A', email: 'a@b.com', date: '2026-01-01T00:00:00Z' },
          },
          parents: [],
        },
      ],
      {
        headers: {
          link: 'garbage',
        },
      },
    );

  const result = await getGitHubCommitHistory('o', 'r');

  assert.equal(result.hasNextPage, false);
  assert.equal(result.pageInfo.nextPage, null);
  assert.equal(result.pageInfo.lastPage, null);
});

test('getGitHubCommitHistory builds commit query filters', async () => {
  let capturedUrl = '';
  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse([]);
  };

  await getGitHubCommitHistory('owner', 'repo', {
    sha: 'release/1',
    path: 'src/index.ts',
    author: 'octocat',
    since: '2026-01-01T00:00:00Z',
    until: '2026-02-01T00:00:00Z',
    page: 3,
    limit: 50,
  });

  const parsed = new URL(capturedUrl);
  assert.equal(parsed.pathname, '/repos/owner/repo/commits');
  assert.equal(parsed.searchParams.get('sha'), 'release/1');
  assert.equal(parsed.searchParams.get('path'), 'src/index.ts');
  assert.equal(parsed.searchParams.get('author'), 'octocat');
  assert.equal(parsed.searchParams.get('since'), '2026-01-01T00:00:00Z');
  assert.equal(parsed.searchParams.get('until'), '2026-02-01T00:00:00Z');
  assert.equal(parsed.searchParams.get('page'), '3');
  assert.equal(parsed.searchParams.get('per_page'), '50');
});

test('getGitHubCommitHistory surfaces rate limits', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({ message: 'rate limited' }, { status: 403, statusText: 'Forbidden' });

  await assert.rejects(
    async () => getGitHubCommitHistory('o', 'r'),
    (err: unknown) => err instanceof Error && /rate limit/i.test(err.message),
  );
});
