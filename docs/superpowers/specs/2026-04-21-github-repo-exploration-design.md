# GitHub Repo Exploration Design

2026-04-21

## Goal

Extend the search-mcp GitHub tooling so clients can browse full repository trees, read specific files, and search code across repositories — going beyond the current metadata + README surface.

## Background

The current `github_repo` tool returns metadata (stars, forks, license, latest release) and an optional README. The `github_trending` tool scrapes the GitHub Trending page. Neither lets clients navigate into the repository or inspect code.

## Approach

Three new, single-purpose tools (Approach A — approved).

## New Tools

### 1. `github_repo_tree`

List the directory structure of a repository.

**Parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `owner` | `string` | Yes | — | GitHub user or organisation name |
| `repo` | `string` | Yes | — | Repository name |
| `path` | `string` | No | `""` | Directory path within the repo |
| `branch` | `string` | No | default branch | Git ref (branch, tag, or commit SHA) |
| `recursive` | `boolean` | No | `false` | If true, return the full recursive tree |
| `limit` | `number` | No | `100` | Max items to return (1–500) |

**Return shape**

```ts
interface GitHubTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size?: number;          // present for files
  sha: string;
  url: string;
}

interface GitHubTreeResult {
  entries: GitHubTreeEntry[];
  truncated: boolean;     // true when GitHub truncated the recursive tree
}
```

**API strategy**
- `recursive=false` → `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}`
- `recursive=true` → `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`
  - Falls back to non-recursive `contents` API if the ref is not a valid tree SHA.
- Truncate `entries` to `limit` on the server side and set a warning in `meta.warnings` if truncation occurred.

### 2. `github_repo_file`

Read the raw content of a specific file.

**Parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `owner` | `string` | Yes | — | GitHub user or organisation name |
| `repo` | `string` | Yes | — | Repository name |
| `path` | `string` | Yes | — | File path within the repo |
| `branch` | `string` | No | default branch | Git ref |
| `raw` | `boolean` | No | `true` | `true` = decoded UTF-8 text; `false` = base64 |

**Return shape**

```ts
interface GitHubFileResult {
  name: string;
  path: string;
  size: number;
  sha: string;
  content: string;      // decoded text when raw=true, base64 when raw=false
  encoding: 'utf-8' | 'base64';
  url: string;
  htmlUrl: string;
  truncated: boolean;     // true when content exceeded our size guard
}
```

**API strategy**
- `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}`
- GitHub returns base64. Decode with `Buffer.from(content, 'base64').toString('utf-8')`.
- Guard against oversized files: max decoded size 500 KB. If larger, return `truncated: true` + first 500 KB + `TRUNCATED_MARKER`.
- If the path points to a directory, return a clear error: `"Path is a directory, not a file. Use github_repo_tree to list directories."`.

### 3. `github_repo_search`

Search code across GitHub (scoped to a repo, org, or globally).

**Parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `query` | `string` | Yes | — | Search term (follows GitHub code-search syntax) |
| `owner` | `string` | No | — | Narrow to a specific user or org |
| `repo` | `string` | No | — | Narrow to a specific repo (requires `owner`) |
| `language` | `string` | No | — | Filter by language (e.g. `"typescript"`) |
| `path` | `string` | No | — | Filter to files under this path |
| `limit` | `number` | No | `30` | Max results (1–100) |

**Return shape**

```ts
interface GitHubCodeResult {
  url: string;
  htmlUrl: string;
  repo: string;           // "owner/repo"
  path: string;
  name: string;           // filename
  score: number;
  textMatches?: {         // code snippets with highlight positions
    fragment: string;
    matches: { text: string; indices: [number, number][] }[];
  }[];
}

interface GitHubCodeSearchResult {
  totalCount: number;
  results: GitHubCodeResult[];
}
```

**API strategy**
- `GET /search/code?q={constructed_query}`
- Construct the query string by appending qualifiers: `repo:owner/repo`, `language:`, `path:`, etc.
- GitHub Search API returns max 100 results per page. If `limit > 100`, fetch additional pages.
- Search API has a separate, stricter rate limit (10 req/min unauthenticated, 30 req/min authenticated). Use the existing `rateLimitError` pattern and surface `rateLimit` in `ToolResult.meta`.
- No client-side caching; results change frequently.

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/tools/githubRepoTree.ts` | `getGitHubRepoTree` handler |
| `src/tools/githubRepoFile.ts` | `getGitHubRepoFile` handler |
| `src/tools/githubRepoSearch.ts` | `getGitHubRepoSearch` handler |

### Reused infrastructure

All three tools reuse the existing patterns established in `githubRepo.ts`:
- `assertSafeUrl` + `safeResponseJson` from `src/httpGuards.ts`
- `retryWithBackoff` from `src/retry.ts`
- `assertRateLimitOk` + per-tool rate-limit tracker from `src/rateLimit.ts`
- `ToolCache` from `src/cache.ts` (only for tree/listing; files and search are not cached)
- `notFoundError`, `rateLimitError`, `unavailableError` from `src/errors.ts`
- `buildHeaders` helper (reads `GITHUB_TOKEN` env var for authenticated requests)

### Registration

Each tool is registered in `src/server.ts` alongside the existing tools, following the same `registerTool` pattern with Zod input schemas and `makeResult` / `successResponse` / `errorResponse` wrappers.

### Types

Add new interfaces to `src/types.ts`:
- `GitHubTreeEntry`
- `GitHubTreeResult`
- `GitHubFileResult`
- `GitHubCodeResult`
- `GitHubCodeSearchResult`

## Error Handling

All tools follow the existing error-response contract:
- 404 → `notFoundError` with the resource name
- 403 / 429 → `rateLimitError` with `backend: 'github'`
- Network / timeout → `unavailableError` with `backend: 'github'`
- `isError: true` in the MCP response with a sanitized message (no stack traces)

## Security

- `assertSafeUrl` is called before every `fetch`.
- All user-provided strings (`owner`, `repo`, `path`, `branch`, `query`) are passed through `encodeURIComponent` when interpolating into URLs.
- File-content size is capped at 500 KB decoded to prevent huge base64 payloads.
- Search API results are capped at 100 per page and total `limit` is clamped server-side.

## Testing

- Unit tests for each new tool (happy path, 404, rate limit, oversized file truncation, recursive tree truncation).
- Type-check via `npm run typecheck`.
- Lint via `npm run lint`.
- Manual end-to-end test via MCP client (e.g. Claude Desktop or CLI) against a known public repo.

## Out of Scope

- GitHub Actions / CI data
- Issues / PRs / discussions
- Commit history / blame
- Raw git operations (cloning, diffing)
- GraphQL API migration (REST is sufficient for these three use cases)
