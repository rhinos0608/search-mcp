import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getGitHubRepo } from '../src/tools/githubRepo.js';
import { resetTrackers } from '../src/rateLimit.js';
import { TRUNCATED_MARKER } from '../src/httpGuards.js';

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
      ...(init?.headers ?? {}),
    },
  });
}

function btoa(str: string): string {
  return Buffer.from(str, 'utf-8').toString('base64');
}

const REPO_BODY = {
  name: 'test-repo',
  full_name: 'owner/test-repo',
  description: 'A test repo',
  stargazers_count: 100,
  forks_count: 10,
  language: 'TypeScript',
  license: { spdx_id: 'MIT' },
  topics: ['test'],
  default_branch: 'main',
  homepage: null,
  pushed_at: '2024-01-01T00:00:00Z',
  created_at: '2023-01-01T00:00:00Z',
};

test('getGitHubRepo returns repo info with README when available', async () => {
  const readmeContent = 'This is a readme.';
  globalThis.fetch = async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (u.includes('/readme')) {
      return buildMockResponse({
        encoding: 'base64',
        content: btoa(readmeContent),
      });
    }
    if (u.includes('/releases/latest')) {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    }
    return buildMockResponse(REPO_BODY);
  };

  const result = await getGitHubRepo('owner', 'test-repo-a', true);
  assert.equal(result.name, 'test-repo');
  assert.equal(result.readme, readmeContent);
  assert.equal(result.readmeOverflowArtifact, undefined);
});

test('getGitHubRepo includes readmeOverflowArtifact when README truncated', async () => {
  // README > 50000 chars triggers truncation
  const bigReadme = 'A'.repeat(60_000);
  globalThis.fetch = async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (u.includes('/readme')) {
      return buildMockResponse({
        encoding: 'base64',
        content: btoa(bigReadme),
      });
    }
    if (u.includes('/releases/latest')) {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    }
    return buildMockResponse(REPO_BODY);
  };

  const result = await getGitHubRepo('owner', 'test-repo-b', true);
  assert.ok(result.readme?.endsWith(TRUNCATED_MARKER));
  assert.ok(result.readmeOverflowArtifact);
  assert.equal(result.readmeOverflowArtifact!.available, true);
  assert.ok(result.readmeOverflowArtifact!.path);
  assert.equal(result.readmeOverflowArtifact!.complete, false);
  assert.ok(result.readmeOverflowArtifact!.sourceBytes > 50_000);
});

test('getGitHubRepo omits readmeOverflowArtifact when README fits', async () => {
  const smallReadme = 'Short readme.';
  globalThis.fetch = async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (u.includes('/readme')) {
      return buildMockResponse({
        encoding: 'base64',
        content: btoa(smallReadme),
      });
    }
    if (u.includes('/releases/latest')) {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    }
    return buildMockResponse(REPO_BODY);
  };

  const result = await getGitHubRepo('owner', 'test-repo-c', true);
  assert.equal(result.readme, smallReadme);
  assert.equal(result.readmeOverflowArtifact, undefined);
});
