/**
 * GitHub repository tree/file listing via the GitHub API.
 *
 * Strategy:
 * - recursive=false → GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
 * - recursive=true  → GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1
 *   (falls back to non-recursive contents API on 404)
 */

import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { rateLimitError, notFoundError, unavailableError, timeoutError } from '../errors.js';
import type { GitHubTreeEntry, GitHubTreeResult } from '../types.js';

const GITHUB_API = 'https://api.github.com';

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'search-mcp/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

interface GitHubFetchResult {
  response: Response;
  body: unknown;
}

async function githubFetch(url: string): Promise<GitHubFetchResult> {
  assertSafeUrl(url);

  return retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 30_000);

      try {
        const response = await fetch(url, { headers: buildHeaders(), signal: controller.signal });

        getTracker('github').update(response.headers);

        const body: unknown = response.ok ? await safeResponseJson(response, url) : null;
        return { response, body };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError(`GitHub API request to "${url}" timed out after 30 seconds`, {
            backend: 'github',
            cause: err,
          });
        }
        throw unavailableError(`GitHub API request to "${url}" failed: ${error.message}`, {
          backend: 'github',
          cause: err,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'github-api', maxAttempts: 3 },
  );
}

function handleGitHubError(status: number, statusText: string, context: string): never {
  if (status === 404) {
    throw notFoundError(`GitHub resource "${context}" not found`, {
      statusCode: 404,
      backend: 'github',
    });
  }
  if (status === 403 || status === 429) {
    getTracker('github').recordLimitHit();
    throw rateLimitError('GitHub API rate limit exceeded. Try again later.', {
      statusCode: status,
      backend: 'github',
    });
  }
  throw unavailableError(`GitHub API error ${String(status)}: ${statusText} for "${context}"`, {
    statusCode: status,
    backend: 'github',
  });
}

// ── Safe property accessors ───────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function getStringOrNull(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

function getNumberOrUndefined(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' ? v : undefined;
}

// ── Normalization helpers ────────────────────────────────────────────────────

/**
 * Normalize a single item from the non-recursive contents API.
 */
function normalizeContentsEntry(item: Record<string, unknown>): GitHubTreeEntry {
  const rawType = getString(item, 'type');
  let type: GitHubTreeEntry['type'] = 'file';
  if (rawType === 'dir') type = 'dir';
  else if (rawType === 'symlink') type = 'symlink';
  else if (rawType === 'submodule') type = 'submodule';
  // default: 'file'

  const entry: GitHubTreeEntry = {
    name: getString(item, 'name'),
    path: getString(item, 'path'),
    type,
    htmlUrl: getStringOrNull(item, 'html_url') ?? '',
    apiUrl: getStringOrNull(item, 'url') ?? '',
  };

  const sha = getStringOrNull(item, 'sha');
  if (sha !== null) {
    entry.sha = sha;
  }
  const size = getNumberOrUndefined(item, 'size');
  if (size !== undefined) {
    entry.size = size;
  }

  return entry;
}

/**
 * Normalize a single item from the recursive git/trees API.
 */
function normalizeTreeEntry(
  item: Record<string, unknown>,
  owner: string,
  repo: string,
  branch?: string,
): GitHubTreeEntry {
  const rawType = getString(item, 'type');
  const mode = getString(item, 'mode');

  let type: GitHubTreeEntry['type'] = 'file';
  // Symlinks arrive as "blob" with mode 120000
  if (mode === '120000') type = 'symlink';
  else if (rawType === 'tree') type = 'dir';
  else if (rawType === 'commit') type = 'submodule';
  // default: 'file' (includes 'blob' and any unknown)

  const path = getString(item, 'path');

  // name = last path segment
  const segments = path.split('/');
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : undefined;
  const name = lastSegment ?? path;

  const base = `https://github.com/${owner}/${repo}`;

  let htmlUrl: string;
  if (branch) {
    htmlUrl =
      type === 'dir'
        ? `${base}/tree/${encodeURIComponent(branch)}/${path}`
        : `${base}/blob/${encodeURIComponent(branch)}/${path}`;
  } else {
    htmlUrl =
      type === 'dir' ? `${base}/tree/main/${path}` : `${base}/blob/main/${path}`;
  }

  const entry: GitHubTreeEntry = {
    name,
    path,
    type,
    htmlUrl,
    apiUrl: getStringOrNull(item, 'url') ?? '',
  };

  const sha = getStringOrNull(item, 'sha');
  if (sha !== null) {
    entry.sha = sha;
  }
  const size = getNumberOrUndefined(item, 'size');
  if (size !== undefined) {
    entry.size = size;
  }

  return entry;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getGitHubRepoTree(
  owner: string,
  repo: string,
  path?: string,
  branch?: string,
  recursive?: boolean,
  limit = 100,
): Promise<GitHubTreeResult> {
  logger.info({ owner, repo, path, branch, recursive, limit }, 'getGitHubRepoTree');

  await assertRateLimitOk('github');

  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const encodedPath = path
    ? '/' + path.split('/').map(encodeURIComponent).join('/')
    : '';

  let truncated = false;

  if (recursive) {
    // ── Recursive path: git/trees/{ref}?recursive=1 ─────────────────────────
    const ref = branch ?? 'HEAD';
    const treeUrl = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;

    logger.debug({ treeUrl }, 'Fetching recursive tree');

    const { response, body } = await githubFetch(treeUrl);

    if (!response.ok) {
      if (response.status === 404) {
        logger.debug('Tree API 404 — falling back to non-recursive contents API');
        // Fall back to non-recursive contents API
        return getGitHubRepoTree(owner, repo, path, branch, false, limit);
      }
      handleGitHubError(response.status, response.statusText, `${owner}/${repo} tree at ${ref}`);
    }

    if (!isRecord(body)) {
      throw unavailableError(`Unexpected GitHub tree API response shape for ${owner}/${repo}`, {
        backend: 'github',
      });
    }

    const rawTree = body.tree;
    if (!Array.isArray(rawTree)) {
      throw unavailableError(`GitHub tree API missing array field "tree" for ${owner}/${repo}`, {
        backend: 'github',
      });
    }

    truncated = body.truncated === true;

    const entries: GitHubTreeEntry[] = rawTree
      .map((item) => (isRecord(item) ? normalizeTreeEntry(item, owner, repo, branch) : null))
      .filter((e): e is GitHubTreeEntry => e !== null);

    const sliced = limit > 0 ? entries.slice(0, limit) : entries;
    return { entries: sliced, truncated };
  }

  // ── Non-recursive path: /repos/{owner}/{repo}/contents/{path}?ref={branch} ─

  const encodedBranch = branch ? encodeURIComponent(branch) : '';
  const contentsUrl = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/contents${encodedPath}${
    encodedBranch ? `?ref=${encodedBranch}` : ''
  }`;

  logger.debug({ contentsUrl }, 'Fetching contents');

  const { response, body } = await githubFetch(contentsUrl);

  if (!response.ok) {
    handleGitHubError(response.status, response.statusText, `${owner}/${repo}/contents${encodedPath}`);
  }

  if (!Array.isArray(body)) {
    throw unavailableError(
      `Expected GitHub contents API to return an array for ${owner}/${repo}${encodedPath}`,
      { backend: 'github' },
    );
  }

  const entries: GitHubTreeEntry[] = (body as unknown[])
    .map((item) => (isRecord(item) ? normalizeContentsEntry(item) : null))
    .filter((e): e is GitHubTreeEntry => e !== null);

  const sliced = limit > 0 ? entries.slice(0, limit) : entries;
  return { entries: sliced, truncated };
}