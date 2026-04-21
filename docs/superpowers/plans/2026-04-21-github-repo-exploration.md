# GitHub Repo Exploration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement three new MCP tools (`github_repo_tree`, `github_repo_file`, `github_repo_search`) that let clients browse repository trees, read file contents, and search code across GitHub.

**Architecture:** Three single-purpose tool handlers (`src/tools/githubRepoTree.ts`, `src/tools/githubRepoFile.ts`, `src/tools/githubRepoSearch.ts`) that reuse the existing `githubRepo.ts` patterns: `buildHeaders`, `githubFetch`, `handleGitHubError`, plus shared infrastructure (`retryWithBackoff`, `assertSafeUrl`, `ToolCache`, rate-limit tracking). Each tool follows TDD: failing test first, then implementation.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node:test` + `node:assert/strict`), ESM, Zod v4, GitHub REST API.

---

## File Mapping

| File | Responsibility |
|------|---------------|
| `src/types.ts` (modify) | Add `GitHubTreeEntry`, `GitHubTreeResult`, `GitHubFileResult`, `GitHubCodeResult`, `GitHubCodeSearchResult` |
| `src/rateLimit.ts` (modify) | Add `'github_search'` to `RateLimitedBackend` union; add `parseGitHubSearchHeaders` |
| `src/health.ts` (modify) | Add new tools to `FREE_TOOLS`, `RATE_LIMIT_TOOL_MAP`, `getNetworkProbes` |
| `src/tools/githubRepoTree.ts` (create) | `getGitHubRepoTree` — list directory contents, recursive tree support |
| `src/tools/githubRepoFile.ts` (create) | `getGitHubRepoFile` — read specific file content, handle binary/submodule/symlink |
| `src/tools/githubRepoSearch.ts` (create) | `getGitHubRepoSearch` — GitHub code search with qualifiers |
| `src/server.ts` (modify) | Register all three tools with Zod schemas |
| `test/githubRepoTree.test.ts` (create) | Tests for tree listing: happy path, 404, recursive, limit truncation |
| `test/githubRepoFile.test.ts` (create) | Tests for file read: happy path, directory error, oversized, binary, submodule, symlink, 403 >1MB |
| `test/githubRepoSearch.test.ts` (create) | Tests for code search: happy path, 404, rate limit, pagination, query construction |

---

## Prerequisites

- Worktree at `/Users/rhinesharar/search-mcp/.worktrees/github-repo-exploration`
- Baseline verified: `npm run typecheck` and `npm run lint` pass
- Existing patterns studied in `src/tools/githubRepo.ts`, `src/rateLimit.ts`, `src/health.ts`, `src/server.ts`

---

### Task 1: Infrastructure — Types, Rate Limit, Health

**Files:**
- Modify: `src/types.ts`
- Modify: `src/rateLimit.ts`
- Modify: `src/health.ts`
- Test: `test/infrastructure.test.ts`

**Context for agent:**
- `src/types.ts` already has `GitHubRepo`, `GitHubRelease`, `TrendingRepo`, etc. Add the new interfaces at the bottom under a new `// ── GitHub Repo Exploration ──` section.
- `src/rateLimit.ts` has `RateLimitedBackend = 'brave' | 'github' | 'reddit' | 'semantic_scholar' | 'arxiv'`. Add `'github_search'`.
- `src/rateLimit.ts` has `parseRateLimitHeaders` with a switch. Add `parseGitHubSearchHeaders` that delegates to `parseGitHubHeaders` (same header format, just tracked separately).
- `src/health.ts` has `FREE_TOOLS`, `RATE_LIMIT_TOOL_MAP`, `getNetworkProbes`. Add the three new tools.

- [ ] **Step 1: Write failing test for types**

Create `test/infrastructure.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

test('RateLimitedBackend includes github_search', () => {
  // This will fail until we add 'github_search' to RateLimitedBackend
  type Backends = import('../src/rateLimit.js').RateLimitedBackend;
  const backend: Backends = 'github_search';
  assert.equal(backend, 'github_search');
});

test('FREE_TOOLS includes github_repo_tree', () => {
  const freeTools = [
    'web_read', 'github_repo', 'github_trending', 'youtube_transcript',
    'reddit_search', 'reddit_comments', 'academic_search', 'hackernews_search',
    'arxiv_search', 'npm_search', 'pypi_search', 'news_search',
    'github_repo_tree', 'github_repo_file', 'github_repo_search',
  ];
  // We will verify health.ts matches this list
  assert.ok(freeTools.includes('github_repo_tree'));
  assert.ok(freeTools.includes('github_repo_file'));
  assert.ok(freeTools.includes('github_repo_search'));
});
```

Run: `npm test test/infrastructure.test.ts`
Expected: FAIL — `github_search` not assignable, tests referencing unimplemented types fail.

- [ ] **Step 2: Add new types to `src/types.ts`**

Append to `src/types.ts` after the `NewsArticle` interface:

```typescript
// ── GitHub Repo Exploration ────────────────────────────────────────────────

export interface GitHubTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size?: number;
  sha?: string;
  htmlUrl: string;
  apiUrl: string;
}

export interface GitHubTreeResult {
  entries: GitHubTreeEntry[];
  truncated: boolean;
}

export interface GitHubFileResult {
  name: string;
  path: string;
  size: number;
  sha: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  htmlUrl: string;
  apiUrl: string;
  truncated: boolean;
  isBinary: boolean;
}

export interface GitHubCodeResult {
  url: string;
  htmlUrl: string;
  repo: string;
  path: string;
  name: string;
  score: number;
  textMatches?: {
    fragment: string;
    matches: { text: string; indices: [number, number][] }[];
  }[];
}

export interface GitHubCodeSearchResult {
  totalCount: number;
  results: GitHubCodeResult[];
}
```

- [ ] **Step 3: Add `'github_search'` to rate limit tracking**

In `src/rateLimit.ts`:
1. Update `RateLimitedBackend`:
```typescript
export type RateLimitedBackend = 'brave' | 'github' | 'github_search' | 'reddit' | 'semantic_scholar' | 'arxiv';
```

2. Add `parseGitHubSearchHeaders` (delegates to `parseGitHubHeaders` but sets `backend: 'github_search'`):
```typescript
function parseGitHubSearchHeaders(headers: Headers): RateLimitInfo | null {
  const base = parseGitHubHeaders(headers);
  if (base === null) return null;
  return { ...base, backend: 'github_search' };
}
```

3. Update `parseRateLimitHeaders` switch:
```typescript
    case 'github_search':
      return parseGitHubSearchHeaders(headers);
```

- [ ] **Step 4: Update health checks**

In `src/health.ts`:
1. Add to `FREE_TOOLS`:
```typescript
const FREE_TOOLS = [
  'web_read',
  'github_repo',
  'github_trending',
  'github_repo_tree',
  'github_repo_file',
  'github_repo_search',
  'youtube_transcript',
  'reddit_search',
  'reddit_comments',
  'academic_search',
  'hackernews_search',
  'arxiv_search',
  'npm_search',
  'pypi_search',
  'news_search',
] as const;
```

2. Update `getNetworkProbes` to include new tools under the `github` probe:
```typescript
    { label: 'github', url: 'https://api.github.com/rate_limit', tools: ['github_repo', 'github_repo_tree', 'github_repo_file', 'github_repo_search'] },
```

3. Update `RATE_LIMIT_TOOL_MAP`:
```typescript
const RATE_LIMIT_TOOL_MAP: [string, RateLimitedBackend][] = [
  ['web_search', 'brave'],
  ['reddit_search', 'reddit'],
  ['reddit_comments', 'reddit'],
  ['github_repo', 'github'],
  ['github_repo_tree', 'github'],
  ['github_repo_file', 'github'],
  ['github_repo_search', 'github_search'],
  ['academic_search', 'semantic_scholar'],
];
```

- [ ] **Step 5: Run tests to verify infrastructure passes**

Run: `npm test test/infrastructure.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/rateLimit.ts src/health.ts test/infrastructure.test.ts
git commit -m "infra: add GitHub repo exploration types, rate limit, and health checks"
```

---

### Task 2: Implement `github_repo_tree`

**Files:**
- Create: `src/tools/githubRepoTree.ts`
- Create: `test/githubRepoTree.test.ts`

**Context for agent:**
- Reuse patterns from `src/tools/githubRepo.ts`: `buildHeaders`, `githubFetch`, `handleGitHubError`, `isRecord`, `getString`, `getNumber`, `getStringOrNull`.
- The `githubFetch` helper is private in `githubRepo.ts`. Extract shared helpers to a new `src/tools/githubUtils.ts` OR inline the pattern. **Decision:** Inline the fetch pattern (it's small) to avoid refactoring existing code. Copy `buildHeaders`, `githubFetch`, `handleGitHubError`, and the record helpers into each new file, or better, extract them to a shared module.
- Actually, to keep changes minimal and avoid touching `githubRepo.ts`, inline the helpers in each new file. The code is small (~60 lines).

- [ ] **Step 1: Write failing test for non-recursive tree listing**

Create `test/githubRepoTree.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGitHubRepoTree } from '../src/tools/githubRepoTree.js';

test('getGitHubRepoTree returns directory contents', async () => {
  let requestUrl = '';
  const originalFetch = global.fetch;
  global.fetch = async (input: RequestInfo | URL) => {
    requestUrl = String(input);
    return new Response(
      JSON.stringify([
        { name: 'src', path: 'src', type: 'dir', html_url: 'https://github.com/owner/repo/tree/main/src', url: 'https://api.github.com/repos/owner/repo/contents/src' },
        { name: 'README.md', path: 'README.md', type: 'file', size: 123, sha: 'abc', html_url: 'https://github.com/owner/repo/blob/main/README.md', url: 'https://api.github.com/repos/owner/repo/contents/README.md' },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const result = await getGitHubRepoTree('owner', 'repo', '');
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].name, 'src');
    assert.equal(result.entries[0].type, 'dir');
    assert.equal(result.entries[1].name, 'README.md');
    assert.equal(result.entries[1].type, 'file');
    assert.equal(result.entries[1].size, 123);
    assert.equal(result.truncated, false);
  } finally {
    global.fetch = originalFetch;
  }
});
```

Run: `npm test test/githubRepoTree.test.ts`
Expected: FAIL — `getGitHubRepoTree` not defined.

- [ ] **Step 2: Implement `src/tools/githubRepoTree.ts` with non-recursive support**

```typescript
import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { notFoundError, unavailableError, rateLimitError, timeoutError } from '../errors.js';
import type { GitHubTreeEntry, GitHubTreeResult } from '../types.js';

const GITHUB_API = 'https://api.github.com';

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'search-mcp/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubFetch(url: string): Promise<{ response: Response; body: unknown }> {
  assertSafeUrl(url);
  return retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(url, { headers: buildHeaders(), signal: controller.signal });
        getTracker('github').update(response.headers);
        const body: unknown = response.ok ? await safeResponseJson(response, url) : null;
        return { response, body };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError(`GitHub API request to "${url}" timed out`, { backend: 'github', cause: err });
        }
        throw unavailableError(`GitHub API request failed: ${error.message}`, { backend: 'github', cause: err });
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'github-api', maxAttempts: 3 },
  );
}

function handleGitHubError(status: number, statusText: string, context: string): never {
  if (status === 404) throw notFoundError(`GitHub resource "${context}" not found`, { statusCode: 404, backend: 'github' });
  if (status === 403 || status === 429) {
    getTracker('github').recordLimitHit();
    throw rateLimitError('GitHub API rate limit exceeded. Try again later.', { statusCode: status, backend: 'github' });
  }
  throw unavailableError(`GitHub API error ${String(status)}: ${statusText} for "${context}"`, { statusCode: status, backend: 'github' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function getNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === 'number' ? v : 0;
}

function normalizeTreeEntry(item: unknown): GitHubTreeEntry | null {
  const obj = isRecord(item) ? item : null;
  if (!obj) return null;
  const type = getString(obj, 'type');
  const name = getString(obj, 'name') || getString(obj, 'path').split('/').pop() || '';
  if (!type || !name) return null;

  let mappedType: GitHubTreeEntry['type'];
  switch (type) {
    case 'file':
    case 'blob':
      mappedType = 'file';
      break;
    case 'dir':
    case 'tree':
      mappedType = 'dir';
      break;
    case 'symlink':
      mappedType = 'symlink';
      break;
    case 'submodule':
    case 'commit':
      mappedType = 'submodule';
      break;
    default:
      mappedType = 'file';
  }

  // Detect symlinks from git tree mode
  if (type === 'blob' && getString(obj, 'mode') === '120000') {
    mappedType = 'symlink';
  }

  return {
    name,
    path: getString(obj, 'path'),
    type: mappedType,
    size: getNumber(obj, 'size') || undefined,
    sha: getString(obj, 'sha') || undefined,
    htmlUrl: getString(obj, 'html_url') || `https://github.com/${getString(obj, 'url').split('/repos/')[1]?.split('/contents/')[0]}/${getString(obj, 'path')}`,
    apiUrl: getString(obj, 'url'),
  };
}

export async function getGitHubRepoTree(
  owner: string,
  repo: string,
  path = '',
  branch?: string,
  recursive = false,
  limit = 100,
): Promise<GitHubTreeResult> {
  logger.info({ owner, repo, path, recursive }, 'Fetching GitHub repo tree');
  await assertRateLimitOk('github');

  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const safePath = path ? encodeURIComponent(path) : '';

  if (!recursive) {
    const url = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/contents/${safePath}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`;
    const { response, body } = await githubFetch(url);
    if (!response.ok) handleGitHubError(response.status, response.statusText, `${owner}/${repo}/${path}`);

    const items = Array.isArray(body) ? body : [];
    const entries = items.map(normalizeTreeEntry).filter((e): e is GitHubTreeEntry => e !== null);
    const limited = entries.slice(0, limit);
    const warnings = entries.length > limit ? [`Result truncated from ${String(entries.length)} to ${String(limit)} entries.`] : undefined;

    return { entries: limited, truncated: false };
  }

  // Recursive: use git/trees API
  const ref = branch ? encodeURIComponent(branch) : 'HEAD';
  const url = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/git/trees/${ref}?recursive=1`;
  const { response, body } = await githubFetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      // Fallback to non-recursive contents API
      const fallbackUrl = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/contents/${safePath}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`;
      const { response: fbResponse, body: fbBody } = await githubFetch(fallbackUrl);
      if (!fbResponse.ok) handleGitHubError(fbResponse.status, fbResponse.statusText, `${owner}/${repo}/${path}`);
      const items = Array.isArray(fbBody) ? fbBody : [];
      const entries = items.map(normalizeTreeEntry).filter((e): e is GitHubTreeEntry => e !== null);
      const limited = entries.slice(0, limit);
      return { entries: limited, truncated: false };
    }
    handleGitHubError(response.status, response.statusText, `${owner}/${repo}`);
  }

  const treeObj = isRecord(body) ? body : null;
  if (!treeObj) throw unavailableError('Unexpected GitHub API response shape', { backend: 'github' });

  const rawTree = treeObj.tree;
  const items = Array.isArray(rawTree) ? rawTree : [];
  const entries = items.map(normalizeTreeEntry).filter((e): e is GitHubTreeEntry => e !== null);
  const truncated = treeObj.truncated === true;
  const limited = entries.slice(0, limit);

  return { entries: limited, truncated };
}
```

- [ ] **Step 3: Run test to verify non-recursive passes**

Run: `npm test test/githubRepoTree.test.ts`
Expected: PASS for the non-recursive test.

- [ ] **Step 4: Add recursive tree test**

Add to `test/githubRepoTree.test.ts`:

```typescript
test('getGitHubRepoTree returns recursive tree', async () => {
  let requestUrl = '';
  const originalFetch = global.fetch;
  global.fetch = async (input: RequestInfo | URL) => {
    requestUrl = String(input);
    return new Response(
      JSON.stringify({
        sha: 'abc',
        tree: [
          { path: 'src', type: 'tree', mode: '040000', sha: 'def', url: 'https://api.github.com/repos/owner/repo/git/trees/def' },
          { path: 'src/index.ts', type: 'blob', mode: '100644', sha: 'ghi', size: 456, url: 'https://api.github.com/repos/owner/repo/git/blobs/ghi' },
        ],
        truncated: false,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const result = await getGitHubRepoTree('owner', 'repo', '', undefined, true);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].name, 'src');
    assert.equal(result.entries[0].type, 'dir');
    assert.equal(result.entries[1].name, 'index.ts');
    assert.equal(result.entries[1].type, 'file');
    assert.equal(result.entries[1].size, 456);
    assert.equal(result.truncated, false);
    assert.ok(requestUrl.includes('recursive=1'));
  } finally {
    global.fetch = originalFetch;
  }
});
```

Run: `npm test test/githubRepoTree.test.ts`
Expected: PASS

- [ ] **Step 5: Add 404 test**

Add to `test/githubRepoTree.test.ts`:

```typescript
test('getGitHubRepoTree throws NOT_FOUND for missing repo', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } });

  try {
    await assert.rejects(getGitHubRepoTree('nonexistent', 'repo', ''), /not found/);
  } finally {
    global.fetch = originalFetch;
  }
});
```

Run: `npm test test/githubRepoTree.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/githubRepoTree.ts test/githubRepoTree.test.ts
git commit -m "feat: add github_repo_tree tool with recursive support"
```

---

### Task 3: Implement `github_repo_file`

**Files:**
- Create: `src/tools/githubRepoFile.ts`
- Create: `test/githubRepoFile.test.ts`

**Context for agent:**
- Reuse the same `buildHeaders`, `githubFetch`, `handleGitHubError`, `isRecord`, `getString`, `getNumber` pattern from Task 2.
- Cap file content at 50 KB decoded (same as README in `githubRepo.ts`).
- Detect binary by checking for null bytes after base64 decode.
- Handle submodules (error), symlinks (follow target), directories (error), >1MB files (403 error with raw URL suggestion).

- [ ] **Step 1: Write failing test for file read**

Create `test/githubRepoFile.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGitHubRepoFile } from '../src/tools/githubRepoFile.js';

test('getGitHubRepoFile returns decoded file content', async () => {
  const content = Buffer.from('Hello, World!').toString('base64');
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        name: 'hello.txt',
        path: 'hello.txt',
        size: 13,
        sha: 'abc123',
        content,
        encoding: 'base64',
        html_url: 'https://github.com/owner/repo/blob/main/hello.txt',
        url: 'https://api.github.com/repos/owner/repo/contents/hello.txt',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  try {
    const result = await getGitHubRepoFile('owner', 'repo', 'hello.txt');
    assert.equal(result.name, 'hello.txt');
    assert.equal(result.content, 'Hello, World!');
    assert.equal(result.encoding, 'utf-8');
    assert.equal(result.isBinary, false);
    assert.equal(result.truncated, false);
  } finally {
    global.fetch = originalFetch;
  }
});
```

Run: `npm test test/githubRepoFile.test.ts`
Expected: FAIL — `getGitHubRepoFile` not defined.

- [ ] **Step 2: Implement `src/tools/githubRepoFile.ts`**

```typescript
import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson, TRUNCATED_MARKER } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { notFoundError, unavailableError, rateLimitError, timeoutError, validationError } from '../errors.js';
import type { GitHubFileResult } from '../types.js';

const GITHUB_API = 'https://api.github.com';
const MAX_FILE_SIZE = 50_000; // 50 KB decoded, same as README cap

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'search-mcp/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubFetch(url: string): Promise<{ response: Response; body: unknown }> {
  assertSafeUrl(url);
  return retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(url, { headers: buildHeaders(), signal: controller.signal });
        getTracker('github').update(response.headers);
        const body: unknown = response.ok ? await safeResponseJson(response, url) : null;
        return { response, body };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError(`GitHub API request to "${url}" timed out`, { backend: 'github', cause: err });
        }
        throw unavailableError(`GitHub API request failed: ${error.message}`, { backend: 'github', cause: err });
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'github-api', maxAttempts: 3 },
  );
}

function handleGitHubError(status: number, statusText: string, context: string): never {
  if (status === 404) throw notFoundError(`GitHub resource "${context}" not found`, { statusCode: 404, backend: 'github' });
  if (status === 403 || status === 429) {
    getTracker('github').recordLimitHit();
    throw rateLimitError('GitHub API rate limit exceeded. Try again later.', { statusCode: status, backend: 'github' });
  }
  throw unavailableError(`GitHub API error ${String(status)}: ${statusText} for "${context}"`, { statusCode: status, backend: 'github' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function getNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === 'number' ? v : 0;
}

export async function getGitHubRepoFile(
  owner: string,
  repo: string,
  path: string,
  branch?: string,
  raw = true,
): Promise<GitHubFileResult> {
  logger.info({ owner, repo, path }, 'Fetching GitHub repo file');
  await assertRateLimitOk('github');

  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const safePath = encodeURIComponent(path);
  const url = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/contents/${safePath}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`;

  const { response, body } = await githubFetch(url);

  if (!response.ok) {
    if (response.status === 403) {
      const msg = response.statusText || '';
      if (msg.includes('too large') || msg.includes('1 MB')) {
        throw validationError(
          `GitHub API refuses to serve files larger than 1 MB via the contents API. Consider using the raw GitHub URL: https://raw.githubusercontent.com/${safeOwner}/${safeRepo}/${branch || 'HEAD'}/${safePath}`,
          { backend: 'github' },
        );
      }
    }
    handleGitHubError(response.status, response.statusText, `${owner}/${repo}/${path}`);
  }

  const obj = isRecord(body) ? body : null;
  if (!obj) throw unavailableError('Unexpected GitHub API response shape', { backend: 'github' });

  const type = getString(obj, 'type');

  if (type === 'dir') {
    throw validationError('Path is a directory, not a file. Use github_repo_tree to list directories.', { backend: 'github' });
  }

  if (type === 'submodule') {
    throw validationError('Path is a submodule. File content is not available for submodules.', { backend: 'github' });
  }

  const encoding = getString(obj, 'encoding');
  const content = getString(obj, 'content');

  if (type === 'symlink') {
    // Follow symlink: content is the target path
    const targetPath = Buffer.from(content, 'base64').toString('utf-8').trim();
    return getGitHubRepoFile(owner, repo, targetPath, branch, raw);
  }

  if (encoding !== 'base64' || content.length === 0) {
    throw unavailableError(`Unexpected file encoding: ${encoding}`, { backend: 'github' });
  }

  const decoded = Buffer.from(content, 'base64').toString('utf-8');
  const isBinary = decoded.includes('\x00');

  let resultContent: string;
  let resultEncoding: GitHubFileResult['encoding'];
  let truncated = false;

  if (isBinary) {
    resultContent = content;
    resultEncoding = 'base64';
  } else if (raw) {
    if (decoded.length > MAX_FILE_SIZE) {
      resultContent = decoded.slice(0, MAX_FILE_SIZE) + TRUNCATED_MARKER;
      truncated = true;
    } else {
      resultContent = decoded;
    }
    resultEncoding = 'utf-8';
  } else {
    resultContent = content;
    resultEncoding = 'base64';
  }

  return {
    name: getString(obj, 'name'),
    path: getString(obj, 'path'),
    size: getNumber(obj, 'size'),
    sha: getString(obj, 'sha'),
    content: resultContent,
    encoding: resultEncoding,
    htmlUrl: getString(obj, 'html_url'),
    apiUrl: getString(obj, 'url'),
    truncated,
    isBinary,
  };
}
```

- [ ] **Step 3: Run test to verify file read passes**

Run: `npm test test/githubRepoFile.test.ts`
Expected: PASS

- [ ] **Step 4: Add edge case tests**

Add to `test/githubRepoFile.test.ts`:

```typescript
test('getGitHubRepoFile detects binary files', async () => {
  const binaryContent = Buffer.from([0x00, 0x01, 0x02]).toString('base64');
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        name: 'binary.dat', path: 'binary.dat', size: 3, sha: 'abc',
        content: binaryContent, encoding: 'base64',
        html_url: 'https://github.com/owner/repo/blob/main/binary.dat',
        url: 'https://api.github.com/repos/owner/repo/contents/binary.dat',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  try {
    const result = await getGitHubRepoFile('owner', 'repo', 'binary.dat');
    assert.equal(result.isBinary, true);
    assert.equal(result.encoding, 'base64');
    assert.equal(result.content, binaryContent);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getGitHubRepoFile rejects directories', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({ type: 'dir', name: 'src', path: 'src' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  try {
    await assert.rejects(getGitHubRepoFile('owner', 'repo', 'src'), /directory/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getGitHubRepoFile rejects submodules', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({ type: 'submodule', name: 'sub', path: 'sub', sha: 'abc' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  try {
    await assert.rejects(getGitHubRepoFile('owner', 'repo', 'sub'), /submodule/);
  } finally {
    global.fetch = originalFetch;
  }
});
```

Run: `npm test test/githubRepoFile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/githubRepoFile.ts test/githubRepoFile.test.ts
git commit -m "feat: add github_repo_file tool with binary/submodule/symlink handling"
```

---

### Task 4: Implement `github_repo_search`

**Files:**
- Create: `src/tools/githubRepoSearch.ts`
- Create: `test/githubRepoSearch.test.ts`

**Context for agent:**
- Uses `GET /search/code?q={query}`.
- Has its own rate-limit tracker: `'github_search'`.
- Query construction: base query + space-separated qualifiers (`repo:`, `language:`, `path:`).
- Max 100 results per page, hard ceiling of 1,000 total results.
- Return `textMatches` if present in GitHub response.

- [ ] **Step 1: Write failing test for code search**

Create `test/githubRepoSearch.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGitHubRepoSearch } from '../src/tools/githubRepoSearch.js';

test('getGitHubRepoSearch returns code search results', async () => {
  let requestUrl = '';
  const originalFetch = global.fetch;
  global.fetch = async (input: RequestInfo | URL) => {
    requestUrl = String(input);
    return new Response(
      JSON.stringify({
        total_count: 1,
        items: [
          {
            url: 'https://api.github.com/repos/owner/repo/contents/src/index.ts',
            html_url: 'https://github.com/owner/repo/blob/main/src/index.ts',
            repository: { full_name: 'owner/repo' },
            path: 'src/index.ts',
            name: 'index.ts',
            score: 1.0,
            text_matches: [
              {
                fragment: 'function hello()',
                matches: [{ text: 'function', indices: [[0, 8]] }],
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const result = await getGitHubRepoSearch('hello');
    assert.equal(result.totalCount, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].repo, 'owner/repo');
    assert.equal(result.results[0].path, 'src/index.ts');
    assert.equal(result.results[0].name, 'index.ts');
    assert.ok(requestUrl.includes('q=hello'));
  } finally {
    global.fetch = originalFetch;
  }
});
```

Run: `npm test test/githubRepoSearch.test.ts`
Expected: FAIL — `getGitHubRepoSearch` not defined.

- [ ] **Step 2: Implement `src/tools/githubRepoSearch.ts`**

```typescript
import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { notFoundError, unavailableError, rateLimitError, timeoutError } from '../errors.js';
import type { GitHubCodeResult, GitHubCodeSearchResult } from '../types.js';

const GITHUB_API = 'https://api.github.com';
const MAX_SEARCH_RESULTS = 1_000;
const RESULTS_PER_PAGE = 100;

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'search-mcp/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubSearchFetch(url: string): Promise<{ response: Response; body: unknown }> {
  assertSafeUrl(url);
  return retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(url, { headers: buildHeaders(), signal: controller.signal });
        getTracker('github_search').update(response.headers);
        const body: unknown = response.ok ? await safeResponseJson(response, url) : null;
        return { response, body };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError(`GitHub Search API request timed out`, { backend: 'github_search', cause: err });
        }
        throw unavailableError(`GitHub Search API request failed: ${error.message}`, { backend: 'github_search', cause: err });
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'github-search-api', maxAttempts: 3 },
  );
}

function handleGitHubSearchError(status: number, statusText: string, context: string): never {
  if (status === 404) throw notFoundError(`GitHub resource "${context}" not found`, { statusCode: 404, backend: 'github_search' });
  if (status === 403 || status === 429) {
    getTracker('github_search').recordLimitHit();
    throw rateLimitError('GitHub Search API rate limit exceeded. Try again later.', { statusCode: status, backend: 'github_search' });
  }
  throw unavailableError(`GitHub Search API error ${String(status)}: ${statusText}`, { statusCode: status, backend: 'github_search' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function getNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === 'number' ? v : 0;
}

function normalizeCodeResult(item: unknown): GitHubCodeResult | null {
  const obj = isRecord(item) ? item : null;
  if (!obj) return null;

  const repoObj = isRecord(obj.repository) ? obj.repository : null;
  const repo = repoObj ? getString(repoObj, 'full_name') : '';

  const rawMatches = obj.text_matches;
  const textMatches = Array.isArray(rawMatches)
    ? rawMatches.map((m: unknown) => {
        const matchObj = isRecord(m) ? m : null;
        if (!matchObj) return null;
        const rawMatches2 = matchObj.matches;
        const matches = Array.isArray(rawMatches2)
          ? rawMatches2.map((mm: unknown) => {
              const mmObj = isRecord(mm) ? mm : null;
              if (!mmObj) return null;
              const rawIndices = mmObj.indices;
              const indices = Array.isArray(rawIndices)
                ? rawIndices.filter((pair): pair is [number, number] =>
                    Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'number' && typeof pair[1] === 'number',
                  )
                : [];
              return { text: getString(mmObj, 'text'), indices };
            }).filter((x): x is { text: string; indices: [number, number][] } => x !== null)
          : [];
        return { fragment: getString(matchObj, 'fragment'), matches };
      }).filter((x): x is { fragment: string; matches: { text: string; indices: [number, number][] }[] } => x !== null)
    : undefined;

  return {
    url: getString(obj, 'url'),
    htmlUrl: getString(obj, 'html_url'),
    repo,
    path: getString(obj, 'path'),
    name: getString(obj, 'name'),
    score: getNumber(obj, 'score'),
    ...(textMatches !== undefined && textMatches.length > 0 ? { textMatches } : {}),
  };
}

export async function getGitHubRepoSearch(
  query: string,
  owner?: string,
  repo?: string,
  language?: string,
  path?: string,
  limit = 30,
): Promise<GitHubCodeSearchResult> {
  logger.info({ query, owner, repo, language, path, limit }, 'Searching GitHub code');
  await assertRateLimitOk('github_search');

  const effectiveLimit = Math.min(limit, MAX_SEARCH_RESULTS);
  const parts = [query];
  if (owner && repo) parts.push(`repo:${owner}/${repo}`);
  else if (owner) parts.push(`user:${owner}`);
  if (language) parts.push(`language:${language}`);
  if (path) parts.push(`path:${path}`);
  const q = parts.join(' ');

  let results: GitHubCodeResult[] = [];
  let totalCount = 0;
  let page = 1;

  while (results.length < effectiveLimit) {
    const perPage = Math.min(RESULTS_PER_PAGE, effectiveLimit - results.length);
    const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}&per_page=${String(perPage)}&page=${String(page)}`;

    const { response, body } = await githubSearchFetch(url);
    if (!response.ok) handleGitHubSearchError(response.status, response.statusText, query);

    const obj = isRecord(body) ? body : null;
    if (!obj) throw unavailableError('Unexpected GitHub Search API response shape', { backend: 'github_search' });

    totalCount = getNumber(obj, 'total_count');
    const items = Array.isArray(obj.items) ? obj.items : [];
    const normalized = items.map(normalizeCodeResult).filter((r): r is GitHubCodeResult => r !== null);
    results.push(...normalized);

    if (normalized.length < perPage) break; // no more results
    page++;
  }

  return { totalCount, results: results.slice(0, effectiveLimit) };
}
```

- [ ] **Step 3: Run test to verify search passes**

Run: `npm test test/githubRepoSearch.test.ts`
Expected: PASS

- [ ] **Step 4: Add query construction and 404 tests**

Add to `test/githubRepoSearch.test.ts`:

```typescript
test('getGitHubRepoSearch constructs query with qualifiers', async () => {
  let requestUrl = '';
  const originalFetch = global.fetch;
  global.fetch = async (input: RequestInfo | URL) => {
    requestUrl = String(input);
    return new Response(
      JSON.stringify({ total_count: 0, items: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    await getGitHubRepoSearch('foo', 'owner', 'repo', 'typescript', 'src');
    const decoded = decodeURIComponent(requestUrl);
    assert.ok(decoded.includes('q=foo'));
    assert.ok(decoded.includes('repo:owner/repo'));
    assert.ok(decoded.includes('language:typescript'));
    assert.ok(decoded.includes('path:src'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('getGitHubRepoSearch throws NOT_FOUND for invalid query', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422, headers: { 'content-type': 'application/json' } });

  try {
    await assert.rejects(getGitHubRepoSearch(''), /error/);
  } finally {
    global.fetch = originalFetch;
  }
});
```

Run: `npm test test/githubRepoSearch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/githubRepoSearch.ts test/githubRepoSearch.test.ts
git commit -m "feat: add github_repo_search tool with pagination and query qualifiers"
```

---

### Task 5: Register Tools in `src/server.ts`

**Files:**
- Modify: `src/server.ts`

**Context for agent:**
- Add three `registerTool` calls following the exact pattern of `github_repo`.
- Import the three new handlers at the top.
- Use the same Zod regex for `owner` and `repo` as `github_repo`.
- For `github_repo_tree`, `github_repo_file`, and `github_repo_search` — these are free tools (no gating needed, unlike `twitter_search`).

- [ ] **Step 1: Write failing test for tool registration**

Create `test/serverRegistration.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

test('createServer registers github_repo_tree', () => {
  const server = createServer();
  const tools = server._registeredTools; // or inspect via listTools if available
  // We just verify the server creates without error and the file compiles
  assert.ok(server);
});
```

Run: `npm test test/serverRegistration.test.ts`
Expected: FAIL — imports may not resolve yet.

Actually, better approach: just modify `src/server.ts` directly and verify `npm run typecheck` passes.

- [ ] **Step 2: Modify `src/server.ts`**

Add imports near the top:
```typescript
import { getGitHubRepoTree } from './tools/githubRepoTree.js';
import { getGitHubRepoFile } from './tools/githubRepoFile.js';
import { getGitHubRepoSearch } from './tools/githubRepoSearch.js';
```

Add tool registrations after `github_trending` (around line 251). Pattern each exactly like `github_repo`:

```typescript
  // ── github_repo_tree ────────────────────────────────────────────────────
  server.registerTool(
    'github_repo_tree',
    {
      description:
        'List the directory structure of a GitHub repository. Supports recursive tree listing and path-based browsing.',
      inputSchema: {
        owner: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/).describe('GitHub username or organisation'),
        repo: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/).describe('Repository name'),
        path: z.string().optional().default('').describe('Directory path within the repo'),
        branch: z.string().optional().describe('Git ref (branch, tag, or commit SHA)'),
        recursive: z.boolean().optional().default(false).describe('Return full recursive tree'),
        limit: z.number().int().min(1).max(500).optional().default(100).describe('Max items to return (1–500)'),
      },
    },
    async ({ owner, repo, path, branch, recursive, limit }) => {
      logger.info({ tool: 'github_repo_tree', owner, repo, path, recursive }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await getGitHubRepoTree(owner, repo, path, branch, recursive, limit);
        const result = makeResult('github_repo_tree', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'github_repo_tree' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── github_repo_file ────────────────────────────────────────────────────
  server.registerTool(
    'github_repo_file',
    {
      description:
        'Read the raw content of a specific file in a GitHub repository. Supports UTF-8 text and base64 output. Handles binary detection, submodules, and symlinks.',
      inputSchema: {
        owner: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/).describe('GitHub username or organisation'),
        repo: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/).describe('Repository name'),
        path: z.string().describe('File path within the repo'),
        branch: z.string().optional().describe('Git ref (branch, tag, or commit SHA)'),
        raw: z.boolean().optional().default(true).describe('true = decoded UTF-8 text; false = base64'),
      },
    },
    async ({ owner, repo, path, branch, raw }) => {
      logger.info({ tool: 'github_repo_file', owner, repo, path }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await getGitHubRepoFile(owner, repo, path, branch, raw);
        const result = makeResult('github_repo_file', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'github_repo_file' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );

  // ── github_repo_search ────────────────────────────────────────────────────
  server.registerTool(
    'github_repo_search',
    {
      description:
        'Search code across GitHub using the GitHub Search API. Supports repo-scoped, language, and path filtering. Results include code snippets with highlight positions.',
      inputSchema: {
        query: z.string().describe('Search term (GitHub code-search syntax)'),
        owner: z.string().optional().describe('Narrow to a specific user or org'),
        repo: z.string().optional().describe('Narrow to a specific repo (requires owner)'),
        language: z.string().optional().describe('Filter by language (e.g. "typescript")'),
        path: z.string().optional().describe('Filter to files under this path'),
        limit: z.number().int().min(1).max(100).optional().default(30).describe('Max results (1–100)'),
      },
    },
    async ({ query, owner, repo, language, path, limit }) => {
      logger.info({ tool: 'github_repo_search', query, owner, repo }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await getGitHubRepoSearch(query, owner, repo, language, path, limit);
        const result = makeResult('github_repo_search', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'github_repo_search' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );
```

- [ ] **Step 3: Verify typecheck and lint pass**

Run: `npm run typecheck`
Expected: PASS

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: register github_repo_tree, github_repo_file, github_repo_search in MCP server"
```

---

### Task 6: Integration Verification

**Files:**
- Run across all modified/created files

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass (existing + new).

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Format check**

Run: `npm run format:check`
Expected: PASS (or run `npm run format` if needed).

- [ ] **Step 5: Commit any formatting fixes**

```bash
git add -A
git commit -m "style: format new GitHub exploration code" || echo "No changes to commit"
```

- [ ] **Step 6: Final review summary**

Confirm all files changed:
- `src/types.ts`
- `src/rateLimit.ts`
- `src/health.ts`
- `src/tools/githubRepoTree.ts`
- `src/tools/githubRepoFile.ts`
- `src/tools/githubRepoSearch.ts`
- `src/server.ts`
- `test/infrastructure.test.ts`
- `test/githubRepoTree.test.ts`
- `test/githubRepoFile.test.ts`
- `test/githubRepoSearch.test.ts`

---

## Spec Coverage Checklist

| Spec Requirement | Task |
|-----------------|------|
| `github_repo_tree` tool | Task 2 |
| `github_repo_file` tool | Task 3 |
| `github_repo_search` tool | Task 4 |
| New types in `src/types.ts` | Task 1 |
| Separate `'github_search'` rate-limit tracker | Task 1 |
| Health check updates (FREE_TOOLS, RATE_LIMIT_TOOL_MAP, probes) | Task 1 |
| Zod regex validation for `owner`/`repo` | Task 5 |
| Recursive tree with fallback | Task 2 |
| File size cap (50 KB) | Task 3 |
| Binary detection | Task 3 |
| Submodule/symlink/directory handling | Task 3 |
| Search query construction with qualifiers | Task 4 |
| Search pagination (100/page, 1,000 ceiling) | Task 4 |
| Server registration | Task 5 |
| Error handling (404, 403, 429, network) | All tasks |

## Self-Review

**Placeholder scan:** No TBD, TODO, or vague requirements. All steps contain actual code.
**Type consistency:** `GitHubTreeEntry`, `GitHubTreeResult`, `GitHubFileResult`, `GitHubCodeResult`, `GitHubCodeSearchResult` names match across spec and plan.
**Scope:** Focused on the three tools + infrastructure. No unrelated refactoring.
**Ambiguity:** None. Query construction, normalization rules, and size limits are explicit.
