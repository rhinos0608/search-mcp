import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { rateLimitError, notFoundError, unavailableError, timeoutError } from '../errors.js';
import type { GitHubRef, GitHubRefsResult } from '../types.js';
import { getUserAgent } from '../version.js';

const GITHUB_API = 'https://api.github.com';

type GitHubRefType = 'branches' | 'tags' | 'all';

export interface GitHubRefsOptions {
  type?: GitHubRefType;
  filter?: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function namespaceFor(type: GitHubRefType): string {
  if (type === 'branches') return 'heads';
  if (type === 'tags') return 'tags';
  return '';
}

function trimRefPrefix(value: string): string {
  return value.replace(/^refs\//u, '').replace(/^\/+|\/+$/gu, '');
}

function refName(ref: string): string {
  return trimRefPrefix(ref).replace(/^(heads|tags)\//u, '');
}

function htmlUrlFor(owner: string, repo: string, ref: string): string {
  const name = refName(ref);
  const base = `https://github.com/${owner}/${repo}`;
  if (ref.startsWith('refs/tags/')) return `${base}/releases/tag/${encodeURIComponent(name)}`;
  return `${base}/tree/${encodeURIComponent(name)}`;
}

function normalizeRef(
  item: Record<string, unknown>,
  owner: string,
  repo: string,
): GitHubRef | null {
  const object = item.object;
  if (!isRecord(object)) return null;

  const ref = getString(item, 'ref');
  if (ref.length === 0) return null;

  return {
    ref,
    name: refName(ref),
    nodeId: getString(item, 'node_id'),
    url: getString(item, 'url'),
    htmlUrl: htmlUrlFor(owner, repo, ref),
    object: {
      sha: getString(object, 'sha'),
      type: getString(object, 'type'),
      url: getString(object, 'url'),
    },
  };
}

async function fetchRefPrefix(
  owner: string,
  repo: string,
  safeOwner: string,
  safeRepo: string,
  refPrefix: string,
): Promise<Record<string, unknown>[]> {
  const url = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/git/matching-refs/${refPrefix}`;
  const { response, body } = await githubFetch(url);

  if (!response.ok) {
    handleGitHubError(response.status, response.statusText, `${owner}/${repo} refs`);
  }
  if (!Array.isArray(body)) {
    throw unavailableError(`Unexpected GitHub refs API response shape for ${owner}/${repo}`, {
      backend: 'github',
    });
  }

  return body.filter(isRecord);
}

function refPrefixes(type: GitHubRefType, filter: string | undefined): string[] {
  const normalizedFilter = filter ? trimRefPrefix(filter) : '';
  if (type === 'all' && normalizedFilter.length === 0) return ['heads', 'tags'];

  const namespace = namespaceFor(type);
  const prefix = [namespace, normalizedFilter].filter((part) => part.length > 0).join('/');
  return [prefix];
}

export async function getGitHubRefs(
  owner: string,
  repo: string,
  options: GitHubRefsOptions = {},
): Promise<GitHubRefsResult> {
  const type = options.type ?? 'branches';
  const limit = options.limit ?? 100;
  logger.info({ owner, repo, type, filter: options.filter, limit }, 'Fetching GitHub refs');

  await assertRateLimitOk('github');

  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const prefixes = refPrefixes(type, options.filter);
  const batches = await Promise.all(
    prefixes.map((prefix) => fetchRefPrefix(owner, repo, safeOwner, safeRepo, prefix)),
  );
  const rawRefs = batches.flat();
  const refs = rawRefs
    .map((item) => normalizeRef(item, owner, repo))
    .filter((item) => item !== null);
  const limitedRefs = refs.slice(0, limit);

  return {
    repository: `${owner}/${repo}`,
    type,
    filter: options.filter ?? null,
    refs: limitedRefs,
    truncated: refs.length > limitedRefs.length,
  };
}
