/**
 * GitHub repository code search via the GitHub Search API.
 *
 * Strategy:
 * - GET /search/code?q={constructed_query}&per_page=100&page={p}
 * - Query construction: base query + space-separated qualifiers
 *   - repo:owner/repo  (when both owner and repo provided)
 *   - user:owner       (when only owner provided)
 *   - language:{lang}  (when provided)
 *   - path:{path}      (when provided)
 * - Paginate when limit > 100, clamping to GitHub Search API max of 1,000
 * - Uses 'github_search' rate-limit tracker (separate from 'github')
 */

import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { rateLimitError, notFoundError, unavailableError, timeoutError } from '../errors.js';
import type { GitHubCodeResult, GitHubCodeSearchResult } from '../types.js';

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

async function githubSearchFetch(url: string): Promise<GitHubFetchResult> {
  assertSafeUrl(url);

  return retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 30_000);

      try {
        const response = await fetch(url, { headers: buildHeaders(), signal: controller.signal });

        getTracker('github_search').update(response.headers);

        const body: unknown = response.ok ? await safeResponseJson(response, url) : null;
        return { response, body };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError(`GitHub Search API request to "${url}" timed out after 30 seconds`, {
            backend: 'github_search',
            cause: err,
          });
        }
        throw unavailableError(`GitHub Search API request to "${url}" failed: ${error.message}`, {
          backend: 'github_search',
          cause: err,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'github-search-api', maxAttempts: 3 },
  );
}

function handleGitHubSearchError(status: number, statusText: string, context: string): never {
  if (status === 404) {
    throw notFoundError(`GitHub search resource "${context}" not found`, {
      statusCode: 404,
      backend: 'github_search',
    });
  }
  if (status === 403 || status === 429) {
    getTracker('github_search').recordLimitHit();
    throw rateLimitError('GitHub Search API rate limit exceeded. Try again later.', {
      statusCode: status,
      backend: 'github_search',
    });
  }
  throw unavailableError(
    `GitHub Search API error ${String(status)}: ${statusText} for "${context}"`,
    {
      statusCode: status,
      backend: 'github_search',
    },
  );
}

// ── Safe property accessors ───────────────────────────────────────────────────

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

// ── Normalization helpers ────────────────────────────────────────────────────

/**
 * Parse text_matches from GitHub API response.
 * GitHub returns an array where each item has:
 *   - fragment: string
 *   - matches: array of { text: string; indices: [start, end][] }
 * Filter out malformed items.
 */
function parseTextMatches(raw: unknown): GitHubCodeResult['textMatches'] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const fragments: GitHubCodeResult['textMatches'] = [];

  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (typeof item.fragment !== 'string') continue;

    const matchesRaw = item.matches;
    if (!Array.isArray(matchesRaw)) continue;

    const matches: { text: string; indices: [number, number][] }[] = [];

    for (const m of matchesRaw) {
      if (!isRecord(m)) continue;
      if (typeof m.text !== 'string') continue;
      if (!Array.isArray(m.indices)) continue;

      const indices: [number, number][] = [];
      let allIndicesValid = true;
      for (const idx of m.indices) {
        if (!Array.isArray(idx) || idx.length !== 2) {
          allIndicesValid = false;
          break;
        }
        const idx0 = idx[0] as number;
        const idx1 = idx[1] as number;
        if (
          typeof idx0 !== 'number' ||
          typeof idx1 !== 'number' ||
          !Number.isFinite(idx0) ||
          !Number.isFinite(idx1)
        ) {
          allIndicesValid = false;
          break;
        }
        indices.push([idx0, idx1]);
      }
      if (!allIndicesValid) continue;

      matches.push({ text: m.text, indices });
    }

    fragments.push({ fragment: item.fragment, matches });
  }

  return fragments.length > 0 ? fragments : undefined;
}

/**
 * Normalize a single item from the GitHub code search API response.
 */
function normalizeCodeResult(item: Record<string, unknown>): GitHubCodeResult | null {
  const repository = item.repository;
  if (!isRecord(repository)) return null;

  const repoFullName = getString(repository, 'full_name');

  const textMatches = parseTextMatches(item.text_matches);

  const result: GitHubCodeResult = {
    url: getString(item, 'url'),
    htmlUrl: getString(item, 'html_url'),
    repo: repoFullName,
    path: getString(item, 'path'),
    name: getString(item, 'name'),
    score: getNumber(item, 'score'),
  };

  if (textMatches !== undefined) {
    result.textMatches = textMatches;
  }

  return result;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Search for code within a GitHub repository (or across all of a user's repos).
 *
 * @param query       Base search query (e.g. "class Foo")
 * @param owner       GitHub username/organization to scope the search
 * @param repo        Optional specific repository name (requires owner)
 * @param language    Optional language filter (e.g. "typescript")
 * @param path        Optional path prefix filter (e.g. "src")
 * @param limit       Maximum results to return (clamped to 1000, paginated at 100/page)
 */
export async function getGitHubRepoSearch(
  query: string,
  owner?: string,
  repo?: string,
  language?: string,
  path?: string,
  limit = 30,
): Promise<GitHubCodeSearchResult> {
  logger.info({ query, owner, repo, language, path, limit }, 'getGitHubRepoSearch');

  // Build the search query with qualifiers
  const parts: string[] = [query.trim()];

  if (owner && repo) {
    parts.push(`repo:${owner}/${repo}`);
  } else if (owner) {
    parts.push(`user:${owner}`);
  }

  if (language) {
    parts.push(`language:${language}`);
  }

  if (path) {
    parts.push(`path:${path}`);
  }

  const searchQuery = parts.join(' ');
  const encodedQuery = encodeURIComponent(searchQuery);

  // Clamp limit to GitHub Search API's hard ceiling
  const clampedLimit = Math.min(limit, 1000);

  // Fetch all pages needed up to clampedLimit (100 results per page)
  const results: GitHubCodeResult[] = [];
  const pagesNeeded = Math.ceil(clampedLimit / 100);
  // Track the global total_count returned by GitHub (available after first page)
  let globalTotalCount = 0;

  for (let page = 1; page <= pagesNeeded && results.length < clampedLimit; page++) {
    await assertRateLimitOk('github_search');

    const pageSize = Math.min(100, clampedLimit - results.length);
    const searchUrl = `${GITHUB_API}/search/code?q=${encodedQuery}&per_page=${String(pageSize)}&page=${String(page)}`;

    logger.debug({ searchUrl }, 'Fetching code search page');

    const { response, body } = await githubSearchFetch(searchUrl);

    if (!response.ok) {
      handleGitHubSearchError(response.status, response.statusText, searchQuery);
    }

    if (!isRecord(body)) {
      throw unavailableError(
        `Unexpected GitHub code search API response shape for query "${searchQuery}"`,
        { backend: 'github_search' },
      );
    }

    const rawItems = body.items;
    if (!Array.isArray(rawItems)) {
      throw unavailableError(
        `GitHub code search API missing "items" array for query "${searchQuery}"`,
        { backend: 'github_search' },
      );
    }

    // Capture global total_count from the first page response
    if (page === 1 && typeof body.total_count === 'number') {
      globalTotalCount = body.total_count;
    }

    const normalized = rawItems
      .map((item) => (isRecord(item) ? normalizeCodeResult(item) : null))
      .filter((r): r is GitHubCodeResult => r !== null);

    results.push(...normalized);

    // If we got fewer raw results than requested for this page (last page), stop
    if (rawItems.length < pageSize) {
      break;
    }

    // If we have enough results, stop
    if (results.length >= clampedLimit) {
      break;
    }
  }

  return {
    // globalTotalCount is the total number of results GitHub found for the query
    // (capped at 1000 by GitHub, even if actual matches are higher)
    totalCount: globalTotalCount > 0 ? globalTotalCount : results.length,
    results,
  };
}
