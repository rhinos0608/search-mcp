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
| `owner` | `string` | Yes | — | GitHub user or organisation name. Regex: `/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/` |
| `repo` | `string` | Yes | — | Repository name. Regex: `/^[a-zA-Z0-9._-]{1,100}$/` |
| `path` | `string` | No | `""` | Directory path within the repo |
| `branch` | `string` | No | omitted | Git ref (branch, tag, or commit SHA). When omitted, `?ref` is not sent and GitHub uses the default branch. |
| `recursive` | `boolean` | No | `false` | If true, return the full recursive tree |
| `limit` | `number` | No | `100` | Max items to return (1–500) |

**Return shape**

```ts
interface GitHubTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size?: number;          // present for files, absent for directories
  sha?: string;           // present for files and recursive git/tree entries; absent for directory entries from contents API
  htmlUrl: string;        // browser URL
  apiUrl: string;         // GitHub REST API URL for this item
}

interface GitHubTreeResult {
  entries: GitHubTreeEntry[];
  truncated: boolean;     // true when GitHub's recursive git/trees response was truncated (not our limit truncation)
}
```

**API strategy**
- `recursive=false` → `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` (omit `ref` when `branch` is not provided)
  - Returns an array of items. Each item has `name`, `path`, `type` (`"file" | "dir" | "symlink" | "submodule"`), `size` (files only), `html_url`, `url`.
  - Normalize: use `html_url` as `htmlUrl`, `url` as `apiUrl`. `sha` is present for files but not directories.
- `recursive=true` → `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1` (omit `ref` when `branch` is not provided)
  - Returns `tree` array. Each item has `path`, `type` (`"blob" | "tree" | "commit"`), `mode`, `sha`, `size` (blob only), `url`.
  - Normalize:
    - Derive `name` from the last segment of `path`.
    - Map `type`: `"blob"` → `"file"`, `"tree"` → `"dir"`, `"commit"` → `"submodule"`.
    - Detect symlinks: if `mode === "120000"`, override `type` to `"symlink"`.
    - Build `htmlUrl` by combining the repo base HTML URL with `path`.
    - `apiUrl` = `url` from the API response.
  - GitHub may set `truncated: true` in the response when the tree is too large. Forward this as `truncated`.
  - If the `git/trees` call returns 404 (invalid ref), fall back to the non-recursive `contents` API with a warning.
- Server-side truncation: if the result set exceeds `limit`, slice `entries` to `limit` and add a warning to `meta.warnings`. Do **not** set `truncated` for this case.

### 2. `github_repo_file`

Read the raw content of a specific file.

**Parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `owner` | `string` | Yes | — | GitHub user or organisation name. Regex: `/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/` |
| `repo` | `string` | Yes | — | Repository name. Regex: `/^[a-zA-Z0-9._-]{1,100}$/` |
| `path` | `string` | Yes | — | File path within the repo |
| `branch` | `string` | No | omitted | Git ref. When omitted, `?ref` is not sent. |
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
  htmlUrl: string;
  apiUrl: string;
  truncated: boolean;     // true when content exceeded our size guard
  isBinary: boolean;      // true when the file appears to be binary
}
```

**API strategy**
- `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` (omit `ref` when `branch` is not provided)
- GitHub returns base64. Decode with `Buffer.from(content, 'base64').toString('utf-8')`.
- Guard against oversized files: max decoded size 50 KB (same cap as README). If larger, return `truncated: true` + first 50 KB + `TRUNCATED_MARKER`.
- If the path points to a directory, return a clear error: `"Path is a directory, not a file. Use github_repo_tree to list directories."`.
- If the path points to a submodule, return a clear error: `"Path is a submodule. File content is not available for submodules."`.
- If the path points to a symlink, follow it: extract the symlink target from the response, re-fetch the target path, and return that file's content. If the target does not exist, return a not-found error.
- If GitHub returns 403 for a file >1 MB, return a clear error: `"GitHub API refuses to serve files larger than 1 MB via the contents API. Consider using the raw GitHub URL: https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"`.
- **Binary detection:** after decoding, check for null bytes (`\x00`). If any are found, set `isBinary: true` and return the base64 representation regardless of the `raw` flag (with `encoding: 'base64'`). If `raw=true` and the file is not binary, return decoded UTF-8 text.

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
  url: string;            // GitHub API URL for the item
  htmlUrl: string;        // browser URL
  repo: string;           // "owner/repo"
  path: string;
  name: string;           // filename
  score: number;
  textMatches?: {         // code snippets with highlight positions (from GitHub's text-match metadata)
    fragment: string;
    matches: { text: string; indices: [number, number][] }[];
  }[];
}

interface GitHubCodeSearchResult {
  totalCount: number;     // total matching results (may exceed results.length)
  results: GitHubCodeResult[];
}
```

**API strategy**
- `GET /search/code?q={constructed_query}`
- Construct the query string by appending qualifiers separated by spaces:
  - Base: `query` value
  - `+repo:{owner}/{repo}` if both `owner` and `repo` are provided
  - `+language:{language}` if provided
  - `+path:{path}` if provided
  - Example: `"foo language:typescript repo:owner/repo"`
- URL-encode the final query string with `encodeURIComponent`.
- GitHub Search API returns max 100 results per page. If `limit > 100`, fetch additional pages.
- **Hard ceiling:** GitHub Search API has a global maximum of 1,000 results. Clamp `limit` to `min(limit, 1000)` and stop paging once 1,000 results are reached.
- Search API has a separate, stricter rate limit (10 req/min unauthenticated, 30 req/min authenticated). Use a **dedicated** rate-limit tracker (`'github_search'`) rather than sharing `'github'`. Surface `rateLimit` in `ToolResult.meta`.
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

### Rate limiting

- `github_repo_tree` and `github_repo_file` share the existing `'github'` tracker (general REST API limits).
- `github_repo_search` uses a **new** `'github_search'` tracker (separate Search API limits).
- Update `src/rateLimit.ts`: add `'github_search'` to `RateLimitedBackend`.
- Update `src/health.ts`:
  - Add all three new tools to `FREE_TOOLS`.
  - Map `github_repo_tree` and `github_repo_file` to `'github'` in `RATE_LIMIT_TOOL_MAP`.
  - Map `github_repo_search` to `'github_search'` in `RATE_LIMIT_TOOL_MAP`.
  - Extend the existing GitHub network probe to cover the new tools.

### Registration

Each tool is registered in `src/server.ts` alongside the existing tools, following the same `registerTool` pattern with Zod input schemas and `makeResult` / `successResponse` / `errorResponse` wrappers.

**Zod validation for `owner` and `repo`:**
Reuse the existing regex constraints from `github_repo` for consistency:
- `owner`: `z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/)`
- `repo`: `z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/)`

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
- 403 / 429 → `rateLimitError` with `backend: 'github'` or `'github_search'`
- Network / timeout → `unavailableError` with `backend: 'github'` or `'github_search'`
- `isError: true` in the MCP response with a sanitized message (no stack traces)

## Security

- `assertSafeUrl` is called before every `fetch`.
- All user-provided strings (`owner`, `repo`, `path`, `branch`, `query`) are passed through `encodeURIComponent` when interpolating into URLs.
- File-content size is capped at 50 KB decoded (same as README) to prevent huge payloads.
- Search API results are capped at 100 per page and total `limit` is clamped server-side to 1,000.

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
