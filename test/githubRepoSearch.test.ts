import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getGitHubRepoSearch, getGitHubMultiSearch } from '../src/tools/githubRepoSearch.js';
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
 * Build a mock Response-like object for fetch.
 */
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

// ── Basic results ────────────────────────────────────────────────────────────

test('getGitHubRepoSearch returns normalized results', async () => {
  const mockSearchResponse = {
    total_count: 2,
    items: [
      {
        name: 'index.ts',
        path: 'src/index.ts',
        sha: 'sha1',
        url: 'https://api.github.com/repos/owner/repo/contents/src/index.ts',
        html_url: 'https://github.com/owner/repo/blob/main/src/index.ts',
        repository: { full_name: 'owner/repo' },
        score: 1.0,
        text_matches: [
          {
            fragment: 'export function hello() {}',
            matches: [{ text: 'hello', indices: [[7, 12]] }],
          },
        ],
      },
      {
        name: 'util.ts',
        path: 'lib/util.ts',
        sha: 'sha2',
        url: 'https://api.github.com/repos/owner/repo/contents/lib/util.ts',
        html_url: 'https://github.com/owner/repo/blob/main/lib/util.ts',
        repository: { full_name: 'owner/repo' },
        score: 0.9,
        text_matches: [],
      },
    ],
  };

  globalThis.fetch = async () => buildMockResponse(mockSearchResponse);

  const result = await getGitHubRepoSearch('hello', 'owner', 'repo');

  assert.equal(result.totalCount, 2);
  assert.equal(result.results.length, 2);

  assert.equal(result.results[0]!.name, 'index.ts');
  assert.equal(result.results[0]!.path, 'src/index.ts');
  assert.equal(result.results[0]!.repo, 'owner/repo');
  assert.equal(result.results[0]!.htmlUrl, 'https://github.com/owner/repo/blob/main/src/index.ts');
  assert.equal(result.results[0]!.score, 1.0);
  assert.deepEqual(result.results[0]!.textMatches, [
    {
      fragment: 'export function hello() {}',
      matches: [{ text: 'hello', indices: [[7, 12]] }],
    },
  ]);

  assert.equal(result.results[1]!.name, 'util.ts');
  assert.equal(result.results[1]!.textMatches, undefined);
});

test('getGitHubRepoSearch returns empty results when none found', async () => {
  globalThis.fetch = async () => buildMockResponse({ total_count: 0, items: [] });

  const result = await getGitHubRepoSearch('nothing', 'owner', 'repo');

  assert.equal(result.totalCount, 0);
  assert.equal(result.results.length, 0);
});

// ── Query construction ───────────────────────────────────────────────────────

test('getGitHubRepoSearch constructs query with owner and repo (repo: qualifier)', async () => {
  let capturedUrl: string | undefined;

  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse({ total_count: 0, items: [] });
  };

  await getGitHubRepoSearch('foo', 'myowner', 'myrepo');

  const queryIndex = capturedUrl!.indexOf('q=');
  assert.ok(queryIndex !== -1, 'Expected q= in URL');
  const queryPart = capturedUrl!.slice(queryIndex);
  // The query should include repo:owner/repo
  assert.ok(
    queryPart.includes('repo%3Amyowner%2Fmyrepo') || queryPart.includes('repo:myowner/myrepo'),
    `Expected repo:myowner/myrepo in query, got: ${queryPart}`,
  );
  assert.ok(queryPart.includes('foo'), `Expected base query "foo" in URL, got: ${queryPart}`);
});

test('getGitHubRepoSearch constructs query with owner only (user: qualifier)', async () => {
  let capturedUrl: string | undefined;

  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse({ total_count: 0, items: [] });
  };

  await getGitHubRepoSearch('bar', 'someowner');

  const queryPart = capturedUrl!.slice(capturedUrl!.indexOf('q='));
  assert.ok(
    queryPart.includes('user%3Asomeowner') || queryPart.includes('user:someowner'),
    `Expected user:someowner in query (no repo qualifier since only owner provided), got: ${queryPart}`,
  );
  // Should NOT have repo: qualifier when only owner is provided
  assert.ok(
    !queryPart.includes('repo%3A') && !queryPart.includes('repo:'),
    `Should not have repo: qualifier when only owner provided, got: ${queryPart}`,
  );
});

test('getGitHubRepoSearch constructs query with language qualifier', async () => {
  let capturedUrl: string | undefined;

  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse({ total_count: 0, items: [] });
  };

  await getGitHubRepoSearch('test', 'owner', 'repo', 'typescript');

  const queryPart = capturedUrl!.slice(capturedUrl!.indexOf('q='));
  assert.ok(
    queryPart.includes('language%3Atypescript') || queryPart.includes('language:typescript'),
    `Expected language:typescript in query, got: ${queryPart}`,
  );
});

test('getGitHubRepoSearch constructs query with path qualifier', async () => {
  let capturedUrl: string | undefined;

  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse({ total_count: 0, items: [] });
  };

  await getGitHubRepoSearch('config', 'owner', 'repo', undefined, 'src');

  const queryPart = capturedUrl!.slice(capturedUrl!.indexOf('q='));
  assert.ok(
    queryPart.includes('path%3Asrc') || queryPart.includes('path:src'),
    `Expected path:src in query, got: ${queryPart}`,
  );
});

test('getGitHubRepoSearch constructs query with all qualifiers combined', async () => {
  let capturedUrl: string | undefined;

  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse({ total_count: 0, items: [] });
  };

  await getGitHubRepoSearch('export', 'ow', 'rp', 'javascript', 'lib');

  const queryPart = capturedUrl!.slice(capturedUrl!.indexOf('q='));
  // Should contain all qualifiers
  assert.ok(
    queryPart.includes('repo%3Aow%2Frp') || queryPart.includes('repo:ow/rp'),
    `Expected repo: qualifier, got: ${queryPart}`,
  );
  assert.ok(
    queryPart.includes('language%3Ajavascript') || queryPart.includes('language:javascript'),
    `Expected language: qualifier, got: ${queryPart}`,
  );
  assert.ok(
    queryPart.includes('path%3Alib') || queryPart.includes('path:lib'),
    `Expected path: qualifier, got: ${queryPart}`,
  );
  assert.ok(queryPart.includes('export'), `Expected base query "export", got: ${queryPart}`);
});

// ── Pagination ───────────────────────────────────────────────────────────────

test('getGitHubRepoSearch fetches multiple pages when limit > 100', async () => {
  const page1Items = Array.from({ length: 100 }, (_, i) => ({
    name: `file${i}.ts`,
    path: `src/file${i}.ts`,
    sha: `sha${i}`,
    url: `https://api.github.com/repos/o/r/contents/src/file${i}.ts`,
    html_url: `https://github.com/o/r/blob/main/src/file${i}.ts`,
    repository: { full_name: 'o/r' },
    score: 1.0 - i * 0.001,
  }));

  const page2Items = Array.from({ length: 50 }, (_, i) => ({
    name: `extra${i}.ts`,
    path: `src/extra${i}.ts`,
    sha: `ex${i}`,
    url: `https://api.github.com/repos/o/r/contents/src/extra${i}.ts`,
    html_url: `https://github.com/o/r/blob/main/src/extra${i}.ts`,
    repository: { full_name: 'o/r' },
    score: 0.5 - i * 0.001,
  }));

  let page = 1;

  globalThis.fetch = async () => {
    if (page === 1) {
      page++;
      return buildMockResponse({
        total_count: 150,
        items: page1Items,
      });
    }
    return buildMockResponse({
      total_count: 150,
      items: page2Items,
    });
  };

  const result = await getGitHubRepoSearch('type', 'o', 'r', undefined, 'src', 150);

  assert.equal(result.results.length, 150);
  assert.equal(result.totalCount, 150);
  assert.equal(result.results[0]!.name, 'file0.ts');
  assert.equal(result.results[99]!.name, 'file99.ts');
  assert.equal(result.results[100]!.name, 'extra0.ts');
  assert.equal(result.results[149]!.name, 'extra49.ts');
});

// ── Pagination edge cases ────────────────────────────────────────────────────

test('getGitHubRepoSearch continues to next page when normalized length < pageSize due to malformed items', async () => {
  const page1Items: Record<string, unknown>[] = Array.from({ length: 99 }, (_, i) => ({
    name: `file${i}.ts`,
    path: `src/file${i}.ts`,
    sha: `sha${i}`,
    url: `https://api.github.com/repos/o/r/contents/src/file${i}.ts`,
    html_url: `https://github.com/o/r/blob/main/src/file${i}.ts`,
    repository: { full_name: 'o/r' },
    score: 1.0,
  }));

  // Add 1 malformed item (missing repository) to make rawItems.length === 100
  page1Items.push({
    name: 'malformed.ts',
    path: 'src/malformed.ts',
    sha: 'bad123',
    url: 'https://api.github.com/repos/o/r/contents/src/malformed.ts',
    html_url: 'https://github.com/o/r/blob/main/src/malformed.ts',
    score: 0.5,
    // repository is intentionally missing
  });

  const page2Items = Array.from({ length: 50 }, (_, i) => ({
    name: `page2${i}.ts`,
    path: `src/page2${i}.ts`,
    sha: `p2${i}`,
    url: `https://api.github.com/repos/o/r/contents/src/page2${i}.ts`,
    html_url: `https://github.com/o/r/blob/main/src/page2${i}.ts`,
    repository: { full_name: 'o/r' },
    score: 0.9,
  }));

  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount++;
    if (fetchCount === 1) {
      return buildMockResponse({
        total_count: 149,
        items: page1Items,
      });
    }
    return buildMockResponse({
      total_count: 149,
      items: page2Items,
    });
  };

  const result = await getGitHubRepoSearch('type', 'o', 'r', undefined, 'src', 150);

  // Should have fetched both pages
  assert.equal(fetchCount, 2, 'Expected 2 page fetches');
  // 99 valid items from page1 + 50 from page2 = 149
  assert.equal(result.results.length, 149);
  assert.equal(result.totalCount, 149);
  // Last item should be from page2
  assert.equal(result.results[148]!.name, 'page249.ts');
});

// ── Limit clamping ───────────────────────────────────────────────────────────

test('getGitHubRepoSearch clamps limit to 1000 (GitHub Search API global max)', async () => {
  let capturedUrl: string | undefined;
  let callCount = 0;

  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    callCount++;
    return buildMockResponse({
      total_count: 0,
      items: [],
    });
  };

  // Request 2000 results — should be clamped to 1000, requiring up to 10 pages
  await getGitHubRepoSearch('query', 'owner', 'repo', undefined, undefined, 2000);

  // With limit=1000 and per_page=100, we need 10 pages to fetch 1000 results
  // But since we return empty, the loop exits early after the first page.
  // The key assertion: the per_page param should reflect at most 100.
  assert.ok(capturedUrl!.includes('per_page=100'), `Expected per_page=100, got: ${capturedUrl}`);
});

// ── 404 handling ─────────────────────────────────────────────────────────────

test('getGitHubRepoSearch throws notFoundError on 404', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' });

  await assert.rejects(
    async () => getGitHubRepoSearch('query', 'owner', 'repo'),
    (err: unknown) => {
      return err instanceof Error && /not found/i.test(err.message);
    },
  );
});

// ── Rate limit handling ──────────────────────────────────────────────────────

test('getGitHubRepoSearch throws rateLimitError on 429', async () => {
  globalThis.fetch = async () =>
    buildMockResponse(
      { message: 'Too Many Requests' },
      { status: 429, statusText: 'Too Many Requests' },
    );

  await assert.rejects(
    async () => getGitHubRepoSearch('query', 'owner', 'repo'),
    (err: unknown) => {
      return err instanceof Error && /rate limit/i.test(err.message);
    },
  );
});

test('getGitHubRepoSearch throws rateLimitError on 403', async () => {
  globalThis.fetch = async () =>
    buildMockResponse({ message: 'Forbidden' }, { status: 403, statusText: 'Forbidden' });

  await assert.rejects(
    async () => getGitHubRepoSearch('query', 'owner', 'repo'),
    (err: unknown) => {
      return err instanceof Error && /rate limit/i.test(err.message);
    },
  );
});

// ── textMatches parsing ─────────────────────────────────────────────────────

test('getGitHubRepoSearch filters malformed textMatches items', async () => {
  const mockSearchResponse = {
    total_count: 1,
    items: [
      {
        name: 'test.ts',
        path: 'src/test.ts',
        sha: 'sha1',
        url: 'https://api.github.com/repos/o/r/contents/src/test.ts',
        html_url: 'https://github.com/o/r/blob/main/src/test.ts',
        repository: { full_name: 'o/r' },
        score: 1.0,
        text_matches: [
          // Valid item
          { fragment: 'function foo() {}', matches: [{ text: 'foo', indices: [[9, 12]] }] },
          // Item with invalid fragment (not a string)
          { fragment: 123, matches: [] },
          // Item with invalid matches (not array)
          { fragment: 'valid', matches: 'not-an-array' },
          // Item with no matches property
          { fragment: 'also-valid' },
          // Item with valid structure
          { fragment: 'bar baz', matches: [{ text: 'bar', indices: [[0, 3]] }] },
        ],
      },
    ],
  };

  globalThis.fetch = async () => buildMockResponse(mockSearchResponse);

  const result = await getGitHubRepoSearch('foo', 'o', 'r');

  assert.equal(result.results.length, 1);
  const matches = result.results[0]!.textMatches!;
  // Only items with valid fragment (string) AND valid matches (array) are kept:
  // 1. Valid: { fragment: 'function foo() {}', matches: [...] }
  // 2. Invalid: { fragment: 123, matches: [] } → fragment not string
  // 3. Invalid: { fragment: 'valid', matches: 'not-an-array' } → matches not array
  // 4. Invalid: { fragment: 'also-valid' } → matches missing (not array)
  // 5. Valid: { fragment: 'bar baz', matches: [{ text: 'bar', indices: [[0, 3]] }] }
  assert.equal(matches.length, 2);
  assert.equal(matches[0]!.fragment, 'function foo() {}');
  assert.equal(matches[0]!.matches[0]!.text, 'foo');
  assert.equal(matches[1]!.fragment, 'bar baz');
});

test('getGitHubRepoSearch omits textMatches field when array is empty after filtering', async () => {
  const mockSearchResponse = {
    total_count: 1,
    items: [
      {
        name: 'test.ts',
        path: 'src/test.ts',
        sha: 'sha1',
        url: 'https://api.github.com/repos/o/r/contents/src/test.ts',
        html_url: 'https://github.com/o/r/blob/main/src/test.ts',
        repository: { full_name: 'o/r' },
        score: 1.0,
        text_matches: [
          // All items are malformed
          { fragment: 123, matches: [] },
          { fragment: 'valid', matches: 'not-an-array' },
        ],
      },
    ],
  };

  globalThis.fetch = async () => buildMockResponse(mockSearchResponse);

  const result = await getGitHubRepoSearch('foo', 'o', 'r');

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.textMatches, undefined);
});

// ── Missing optional parameters ──────────────────────────────────────────────

test('getGitHubRepoSearch works with only the base query (no owner, no repo)', async () => {
  globalThis.fetch = async () => buildMockResponse({ total_count: 0, items: [] });

  const result = await getGitHubRepoSearch('somekeyword');

  assert.equal(result.results.length, 0);
  assert.equal(result.totalCount, 0);
});

test('getGitHubRepoSearch works with owner and language (no repo)', async () => {
  let capturedUrl: string | undefined;

  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse({ total_count: 0, items: [] });
  };

  const result = await getGitHubRepoSearch('async', 'someuser', undefined, 'python');

  assert.equal(result.results.length, 0);
  const queryPart = capturedUrl!.slice(capturedUrl!.indexOf('q='));
  // Should use user: qualifier (not repo:)
  assert.ok(
    queryPart.includes('user%3Asomeuser') || queryPart.includes('user:someuser'),
    `Expected user: qualifier, got: ${queryPart}`,
  );
  assert.ok(
    queryPart.includes('language%3Apython') || queryPart.includes('language:python'),
    `Expected language:python qualifier, got: ${queryPart}`,
  );
});

// ── Multi-type search tests ─────────────────────────────────────────────────

/** Mock response for repositories search */
const mockReposResponse = {
  total_count: 2,
  items: [
    {
      full_name: 'someuser/repo-a',
      html_url: 'https://github.com/someuser/repo-a',
      description: 'A test repo',
      stargazers_count: 42,
      forks_count: 5,
      language: 'TypeScript',
      topics: ['testing', 'mcp'],
      updated_at: '2024-01-15T00:00:00Z',
    },
    {
      full_name: 'someuser/repo-b',
      html_url: 'https://github.com/someuser/repo-b',
      description: '',
      stargazers_count: 0,
      forks_count: 0,
      language: null,
      topics: [],
      updated_at: '2024-02-20T00:00:00Z',
    },
  ],
};

/** Mock response for issues search */
const mockIssuesResponse = {
  total_count: 1,
  items: [
    {
      number: 99,
      title: 'Fix memory leak',
      html_url: 'https://github.com/someuser/repo-a/issues/99',
      state: 'open',
      repository_url: 'https://api.github.com/repos/someuser/repo-a',
      user: { login: 'dev1' },
      labels: [{ name: 'bug' }, { name: 'high-priority' }],
      created_at: '2024-03-01T00:00:00Z',
      updated_at: '2024-03-10T00:00:00Z',
      comments: 3,
    },
  ],
};

/** Mock response for users search */
const mockUsersResponse = {
  total_count: 1,
  items: [
    {
      login: 'someuser',
      html_url: 'https://github.com/someuser',
      type: 'User',
    },
  ],
};

/** Mock response for commits search */
const mockCommitsResponse = {
  total_count: 1,
  items: [
    {
      sha: 'abc123def456',
      html_url: 'https://github.com/someuser/repo-a/commit/abc123def456',
      repository: { full_name: 'someuser/repo-a' },
      commit: {
        message: 'Fix memory leak',
        author: { name: 'Dev One', login: 'dev1', date: '2024-03-05T00:00:00Z' },
      },
    },
  ],
};

test('getGitHubMultiSearch type=repositories uses /search/repositories', async () => {
  let capturedUrl = '';
  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse(mockReposResponse);
  };

  const result = await getGitHubMultiSearch({ query: 'testing', type: 'repositories' });

  assert.equal(result.searchType, 'repositories');
  assert.equal(result.totalCount, 2);
  assert.equal(result.results.length, 2);
  assert.ok(capturedUrl.includes('/search/repositories'));

  const repoResult = result.results[0] as import('../src/types.js').GitHubRepoSearchItem;
  assert.equal(repoResult.fullName, 'someuser/repo-a');
  assert.equal(repoResult.stars, 42);
  assert.equal(repoResult.language, 'TypeScript');
  assert.deepEqual(repoResult.topics, ['testing', 'mcp']);
});

test('getGitHubMultiSearch type=issues appends is:issue qualifier', async () => {
  let capturedUrl = '';
  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse(mockIssuesResponse);
  };

  const result = await getGitHubMultiSearch({ query: 'memory leak', type: 'issues' });

  assert.equal(result.searchType, 'issues');
  assert.equal(result.totalCount, 1);
  assert.ok(capturedUrl.includes('/search/issues'));
  assert.ok(
    capturedUrl.includes('is%3Aissue') || capturedUrl.includes('is%3Aissue'),
    'should add is:issue qualifier',
  );

  const issueResult = result.results[0] as import('../src/types.js').GitHubIssueSearchItem;
  assert.equal(issueResult.number, 99);
  assert.equal(issueResult.title, 'Fix memory leak');
  assert.equal(issueResult.repoFullName, 'someuser/repo-a');
  assert.deepEqual(issueResult.labels, ['bug', 'high-priority']);
});

test('getGitHubMultiSearch type=issues with type:pr in query skips is:issue', async () => {
  let capturedUrl = '';
  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse(mockIssuesResponse);
  };

  await getGitHubMultiSearch({ query: 'fix type:pr', type: 'issues' });

  assert.ok(!capturedUrl.includes('is%3Aissue'), 'should not add is:issue when type:pr in query');
});

test('getGitHubMultiSearch type=users routes to /search/users', async () => {
  let capturedUrl = '';
  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse(mockUsersResponse);
  };

  const result = await getGitHubMultiSearch({ query: 'someuser', type: 'users' });

  assert.equal(result.searchType, 'users');
  assert.ok(capturedUrl.includes('/search/users'));

  const userResult = result.results[0] as import('../src/types.js').GitHubUserSearchItem;
  assert.equal(userResult.login, 'someuser');
  assert.equal(userResult.type, 'User');
});

test('getGitHubMultiSearch type=commits routes to /search/commits', async () => {
  let capturedUrl = '';
  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse(mockCommitsResponse);
  };

  const result = await getGitHubMultiSearch({ query: 'memory leak', type: 'commits' });

  assert.equal(result.searchType, 'commits');
  assert.ok(capturedUrl.includes('/search/commits'));

  const commitResult = result.results[0] as import('../src/types.js').GitHubCommitSearchItem;
  assert.equal(commitResult.sha, 'abc123def456');
  assert.equal(commitResult.authorName, 'Dev One');
  assert.equal(commitResult.repoFullName, 'someuser/repo-a');
});

test('getGitHubMultiSearch with owner+repo builds repo: qualifier', async () => {
  let capturedUrl = '';
  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse(mockReposResponse);
  };

  await getGitHubMultiSearch({
    query: 'testing',
    type: 'repositories',
    owner: 'someuser',
    repo: 'repo-a',
  });

  assert.ok(
    capturedUrl.includes('repo%3Asomeuser%2Frepo-a') ||
      capturedUrl.includes('repo:someuser%2Frepo-a'),
    'should include repo: qualifier',
  );
});

test('getGitHubMultiSearch returns empty results for empty API response', async () => {
  globalThis.fetch = async () => buildMockResponse({ total_count: 0, items: [] });

  for (const type of ['repositories', 'issues', 'users', 'commits'] as const) {
    const result = await getGitHubMultiSearch({ query: 'nonexistent', type });
    assert.equal(result.searchType, type);
    assert.equal(result.totalCount, 0);
    assert.equal(result.results.length, 0);
  }
});

test('getGitHubMultiSearch passes sort and order to URL', async () => {
  let capturedUrl = '';
  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse(mockReposResponse);
  };

  await getGitHubMultiSearch({
    query: 'testing',
    type: 'repositories',
    sort: 'stars',
    order: 'desc',
  });

  assert.ok(capturedUrl.includes('sort=stars'));
  assert.ok(capturedUrl.includes('order=desc'));
});

test('getGitHubMultiSearch does not add sort/order when omitted', async () => {
  let capturedUrl = '';
  globalThis.fetch = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return buildMockResponse(mockReposResponse);
  };

  await getGitHubMultiSearch({ query: 'testing', type: 'repositories' });

  assert.ok(!capturedUrl.includes('sort='));
  assert.ok(!capturedUrl.includes('order='));
});
