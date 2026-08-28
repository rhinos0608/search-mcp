import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { rateLimitError, notFoundError, unavailableError, timeoutError } from '../errors.js';
import type { GitHubCommit, GitHubCommitHistoryResult } from '../types.js';
import { getUserAgent } from '../version.js';

const GITHUB_API = 'https://api.github.com';

export interface GitHubCommitHistoryOptions {
  sha?: string;
  path?: string;
  author?: string;
  since?: string;
  until?: string;
  page?: number;
  limit?: number;
}

interface GitHubFetchResult {
  response: Response;
  body: unknown;
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': getUserAgent(),
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = loadConfig().github.token;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
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

        const body: unknown = response.ok
          ? await safeResponseJson(response, url)
          : await safeResponseJson(response, url).catch(() => null);
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

function handleGitHubError(
  status: number,
  statusText: string,
  context: string,
  body?: unknown,
): never {
  if (status === 404) {
    throw notFoundError(`GitHub resource "${context}" not found`, {
      statusCode: 404,
      backend: 'github',
    });
  }
  if (status === 403 || status === 429) {
    // Check if this is actually a rate limit vs auth/permission error
    const msg =
      body && typeof body === 'object' && 'message' in body
        ? String((body as Record<string, unknown>).message)
        : statusText;
    const isRateLimit = /rate limit/i.test(msg) || /too many requests/i.test(msg) || status === 429;
    if (isRateLimit) {
      getTracker('github').recordLimitHit();
      throw rateLimitError('GitHub API rate limit exceeded. Try again later.', {
        statusCode: status,
        backend: 'github',
      });
    }
    throw unavailableError(`GitHub API error ${String(status)}: ${msg} for "${context}"`, {
      statusCode: status,
      backend: 'github',
    });
  }
  throw unavailableError(`GitHub API error ${String(status)}: ${statusText} for "${context}"`, {
    statusCode: status,
    backend: 'github',
  });
}

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

function hasNextPage(response: Response): boolean {
  return response.headers.get('link')?.includes('rel="next"') ?? false;
}

/** Parse page number from a GitHub Link header relation. Returns null on malformed/missing. */
function parseLinkPage(response: Response, rel: string): number | null {
  const linkHeader = response.headers.get('link');
  if (!linkHeader) return null;
  const pattern = new RegExp(`<[^>]*[?&]page=(\\d+)[^>]*>;\\s*rel="${rel}"`);
  const match = pattern.exec(linkHeader);
  const num = match?.[1] !== undefined ? Number(match[1]) : NaN;
  return Number.isFinite(num) && num >= 1 ? num : null;
}

function nestedRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = obj[key];
  return isRecord(value) ? value : null;
}

function normalizeCommit(item: Record<string, unknown>): GitHubCommit | null {
  const commit = nestedRecord(item, 'commit');
  if (commit === null) return null;

  const author = nestedRecord(commit, 'author');
  const committer = nestedRecord(commit, 'committer');
  const githubAuthor = nestedRecord(item, 'author');
  const githubCommitter = nestedRecord(item, 'committer');
  const rawParents = item.parents;
  const parents = Array.isArray(rawParents)
    ? rawParents.filter(isRecord).map((parent) => ({
        sha: getString(parent, 'sha'),
        url: getString(parent, 'url'),
        htmlUrl: getString(parent, 'html_url'),
      }))
    : [];

  const normalized: GitHubCommit = {
    sha: getString(item, 'sha'),
    message: getString(commit, 'message'),
    authorName: author ? getStringOrNull(author, 'name') : null,
    authorEmail: author ? getStringOrNull(author, 'email') : null,
    authoredAt: author ? getStringOrNull(author, 'date') : null,
    committerName: committer ? getStringOrNull(committer, 'name') : null,
    committerEmail: committer ? getStringOrNull(committer, 'email') : null,
    committedAt: committer ? getStringOrNull(committer, 'date') : null,
    authorLogin: githubAuthor ? getStringOrNull(githubAuthor, 'login') : null,
    committerLogin: githubCommitter ? getStringOrNull(githubCommitter, 'login') : null,
    htmlUrl: getString(item, 'html_url'),
    apiUrl: getString(item, 'url'),
    commentsUrl: getString(item, 'comments_url'),
    parents,
  };

  return normalized.sha.length > 0 ? normalized : null;
}

function appendOptionalParam(url: URL, key: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) {
    url.searchParams.set(key, value);
  }
}

export async function getGitHubCommitHistory(
  owner: string,
  repo: string,
  options: GitHubCommitHistoryOptions = {},
): Promise<GitHubCommitHistoryResult> {
  logger.info({ owner, repo, options }, 'Fetching GitHub commit history');

  await assertRateLimitOk('github');

  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const page = options.page ?? 1;
  const limit = options.limit ?? 30;
  const url = new URL(`${GITHUB_API}/repos/${safeOwner}/${safeRepo}/commits`);

  url.searchParams.set('per_page', String(limit));
  url.searchParams.set('page', String(page));
  appendOptionalParam(url, 'sha', options.sha);
  appendOptionalParam(url, 'path', options.path);
  appendOptionalParam(url, 'author', options.author);
  appendOptionalParam(url, 'since', options.since);
  appendOptionalParam(url, 'until', options.until);

  const { response, body } = await githubFetch(url.toString());

  if (!response.ok) {
    handleGitHubError(response.status, response.statusText, `${owner}/${repo} commits`, body);
  }
  if (!Array.isArray(body)) {
    throw unavailableError(`Unexpected GitHub commits API response shape for ${owner}/${repo}`, {
      backend: 'github',
    });
  }

  const commits = body
    .filter(isRecord)
    .map(normalizeCommit)
    .filter((item) => item !== null);

  // ── Link header → pageInfo ──
  const nextPage = parseLinkPage(response, 'next');
  const prevPage = parseLinkPage(response, 'prev');
  const lastPage = parseLinkPage(response, 'last');
  const firstPage = parseLinkPage(response, 'first');

  // ── walk metadata ──
  const oldestCommit = commits.length > 0 ? commits[commits.length - 1] : null;
  const oldestReturnedSha = oldestCommit?.sha ?? null;
  const parentShas = oldestCommit?.parents.map((p) => p.sha) ?? [];
  const firstParentSha = parentShas.length > 0 ? (parentShas[0] ?? null) : null;
  const reachedInitialCommit = commits.some((c) => c.parents.length === 0);
  const initialCommitSha = commits.find((c) => c.parents.length === 0)?.sha ?? null;

  return {
    repository: `${owner}/${repo}`,
    ref: options.sha ?? null,
    path: options.path ?? null,
    author: options.author ?? null,
    since: options.since ?? null,
    until: options.until ?? null,
    page,
    limit,
    hasNextPage: hasNextPage(response),
    commits,
    pageInfo: {
      order: 'newest_first' as const,
      currentPage: page,
      perPage: limit,
      firstPage: (firstPage ?? 1) as 1,
      previousPage: prevPage,
      nextPage,
      lastPage,
    },
    walk: {
      oldestReturnedSha,
      parentShas,
      firstParentSha,
      reachedInitialCommit,
      initialCommitSha,
    },
  };
}
