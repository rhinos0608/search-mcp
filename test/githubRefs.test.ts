import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getGitHubRefs } from '../src/tools/githubRefs.js';
import { resetTrackers } from '../src/rateLimit.js';

beforeEach(() => {
  resetTrackers();
});

afterEach(() => {
  resetTrackers();
});

function buildMockResponse(
  body: unknown,
  init?: { status?: number; statusText?: string },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
}

test('getGitHubRefs returns branch refs with target SHAs', async () => {
  globalThis.fetch = async () =>
    buildMockResponse([
      {
        ref: 'refs/heads/main',
        node_id: 'node1',
        url: 'https://api.github.com/repos/o/r/git/refs/heads/main',
        object: {
          sha: 'abc123',
          type: 'commit',
          url: 'https://api.github.com/repos/o/r/git/commits/abc123',
        },
      },
    ]);

  const result = await getGitHubRefs('o', 'r', { type: 'branches' });

  assert.equal(result.repository, 'o/r');
  assert.equal(result.type, 'branches');
  assert.equal(result.truncated, false);
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0]!.ref, 'refs/heads/main');
  assert.equal(result.refs[0]!.name, 'main');
  assert.equal(result.refs[0]!.object.sha, 'abc123');
  assert.equal(result.refs[0]!.htmlUrl, 'https://github.com/o/r/tree/main');
});

test('getGitHubRefs builds matching refs URL and truncates results', async () => {
  let capturedUrl = '';
  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse([
      {
        ref: 'refs/tags/v1.0.0',
        node_id: 'n1',
        url: 'u1',
        object: { sha: 's1', type: 'commit', url: 'ou1' },
      },
      {
        ref: 'refs/tags/v1.1.0',
        node_id: 'n2',
        url: 'u2',
        object: { sha: 's2', type: 'commit', url: 'ou2' },
      },
    ]);
  };

  const result = await getGitHubRefs('owner', 'repo', { type: 'tags', filter: 'v1', limit: 1 });

  assert.equal(new URL(capturedUrl).pathname, '/repos/owner/repo/git/matching-refs/tags/v1');
  assert.equal(result.refs.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.refs[0]!.htmlUrl, 'https://github.com/owner/repo/releases/tag/v1.0.0');
});

test('getGitHubRefs pulls branches and tags for all refs', async () => {
  const capturedUrls: string[] = [];
  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrls.push(url.toString());
    if (url.toString().endsWith('/heads')) {
      return buildMockResponse([
        {
          ref: 'refs/heads/main',
          node_id: 'n1',
          url: 'u1',
          object: { sha: 's1', type: 'commit', url: 'ou1' },
        },
      ]);
    }
    return buildMockResponse([
      {
        ref: 'refs/tags/v1.0.0',
        node_id: 'n2',
        url: 'u2',
        object: { sha: 's2', type: 'commit', url: 'ou2' },
      },
    ]);
  };

  const result = await getGitHubRefs('owner', 'repo', { type: 'all' });

  assert.deepEqual(
    capturedUrls.map((url) => new URL(url).pathname),
    ['/repos/owner/repo/git/matching-refs/heads', '/repos/owner/repo/git/matching-refs/tags'],
  );
  assert.equal(result.refs.length, 2);
  assert.equal(result.refs[0]!.ref, 'refs/heads/main');
  assert.equal(result.refs[1]!.ref, 'refs/tags/v1.0.0');
});

test('getGitHubRefs surfaces not found errors', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({ message: 'not found' }, { status: 404, statusText: 'Not Found' });

  await assert.rejects(
    async () => getGitHubRefs('o', 'missing'),
    (err: unknown) => err instanceof Error && /not found/i.test(err.message),
  );
});
