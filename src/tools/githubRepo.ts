import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { assertSafeUrl, safeResponseJson, TRUNCATED_MARKER } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { rateLimitError, notFoundError, unavailableError, timeoutError } from '../errors.js';
import type { GitHubRepo, GitHubRelease } from '../types.js';
import { safeExtractFromMarkdown } from '../utils/elementHelpers.js';

const GITHUB_API = 'https://api.github.com';

const cache = new ToolCache<GitHubRepo>({ maxSize: 100, ttlMs: 60 * 60 * 1000 });

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'search-mcp/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = loadConfig().github.token;
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

function getStringOrNull(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

export async function getGitHubRepo(
  owner: string,
  repo: string,
  includeReadme = true,
): Promise<GitHubRepo> {
  logger.info({ owner, repo, includeReadme }, 'Fetching GitHub repo');

  const key = cacheKey('github', owner, repo, String(includeReadme));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'GitHub repo cache hit');
    return cached;
  }

  await assertRateLimitOk('github');

  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const repoUrl = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}`;
  const releaseUrl = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/releases/latest`;
  const readmeUrl = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/readme`;

  const [repoSettled, releaseSettled, readmeSettled] = await Promise.allSettled([
    githubFetch(repoUrl),
    githubFetch(releaseUrl),
    includeReadme ? githubFetch(readmeUrl) : Promise.resolve(null),
  ]);

  // Repo fetch is required
  if (repoSettled.status === 'rejected') {
    throw repoSettled.reason instanceof Error
      ? repoSettled.reason
      : new Error(String(repoSettled.reason));
  }
  const { response: repoResponse, body: repoBody } = repoSettled.value;

  if (!repoResponse.ok) {
    handleGitHubError(repoResponse.status, repoResponse.statusText, `${owner}/${repo}`);
  }

  const repo_ = isRecord(repoBody) ? repoBody : null;
  if (!repo_) {
    throw unavailableError(`Unexpected GitHub API response shape for ${owner}/${repo}`, {
      backend: 'github',
    });
  }

  // Release is optional
  let latestRelease: GitHubRelease | null = null;
  if (releaseSettled.status === 'fulfilled') {
    const { response: releaseResponse, body: releaseBody } = releaseSettled.value;
    const rel = isRecord(releaseBody) ? releaseBody : null;
    if (releaseResponse.ok && rel) {
      latestRelease = {
        tagName: getString(rel, 'tag_name'),
        name: getStringOrNull(rel, 'name'),
        body: getStringOrNull(rel, 'body'),
        publishedAt: getString(rel, 'published_at'),
      };
    } else if (releaseResponse.status !== 404) {
      logger.warn(
        { status: releaseResponse.status, owner, repo },
        'Failed to fetch latest release (non-404)',
      );
    }
  } else {
    logger.warn({ err: releaseSettled.reason, owner, repo }, 'Release fetch failed — skipping');
  }

  // README is optional — surface errors instead of swallowing them
  let readme: string | null = null;
  let readmeError: string | null = null;
  if (readmeSettled.status === 'fulfilled' && readmeSettled.value !== null) {
    const { response: readmeResponse, body: readmeBody } = readmeSettled.value;
    const rm = isRecord(readmeBody) ? readmeBody : null;
    if (readmeResponse.ok && rm) {
      const encoding = getString(rm, 'encoding');
      const content = getString(rm, 'content');
      if (encoding === 'base64' && content.length > 0) {
        // Guard against huge base64 payloads before decoding
        const MAX_BASE64_LENGTH = 200_000; // ~150 KB decoded
        const safeSrc =
          content.length > MAX_BASE64_LENGTH ? content.slice(0, MAX_BASE64_LENGTH) : content;
        const MAX_README_LENGTH = 50_000;
        const decoded = Buffer.from(safeSrc, 'base64').toString('utf-8');
        readme =
          decoded.length > MAX_README_LENGTH
            ? decoded.slice(0, MAX_README_LENGTH) + TRUNCATED_MARKER
            : decoded;
      } else if (encoding.length > 0 && encoding !== 'base64') {
        readmeError = `Unexpected README encoding: ${encoding}`;
        logger.warn({ encoding, owner, repo }, 'Unexpected README encoding — skipping');
      }
    } else if (readmeResponse.status === 404) {
      // No README in the repo — not an error
      readme = null;
    } else if (readmeResponse.status === 403 || readmeResponse.status === 429) {
      readmeError =
        'GitHub API rate limit exceeded — could not fetch README. Set GITHUB_TOKEN env var to increase limit.';
      logger.warn({ status: readmeResponse.status, owner, repo }, readmeError);
    } else {
      readmeError = `GitHub API returned ${String(readmeResponse.status)} when fetching README`;
      logger.warn({ status: readmeResponse.status, owner, repo }, readmeError);
    }
  } else if (readmeSettled.status === 'rejected') {
    const reason =
      readmeSettled.reason instanceof Error
        ? readmeSettled.reason.message
        : String(readmeSettled.reason);
    readmeError = `README fetch failed: ${reason}`;
    logger.warn({ err: readmeSettled.reason, owner, repo }, 'README fetch failed — skipping');
  }

  const licenseVal = repo_.license;
  const license = isRecord(licenseVal) ? getStringOrNull(licenseVal, 'spdx_id') : null;

  const rawTopics = repo_.topics;
  const topics = Array.isArray(rawTopics)
    ? rawTopics.filter((t): t is string => typeof t === 'string')
    : [];

  const readmeElements = safeExtractFromMarkdown(readme);

  const result: GitHubRepo = {
    name: getString(repo_, 'name'),
    fullName: getString(repo_, 'full_name'),
    description: getStringOrNull(repo_, 'description'),
    stars: getNumber(repo_, 'stargazers_count'),
    forks: getNumber(repo_, 'forks_count'),
    language: getStringOrNull(repo_, 'language'),
    license,
    topics,
    defaultBranch: getString(repo_, 'default_branch'),
    homepage: getStringOrNull(repo_, 'homepage'),
    pushedAt: getString(repo_, 'pushed_at'),
    createdAt: getString(repo_, 'created_at'),
    latestRelease,
    readme,
    readmeError,
    ...(readmeElements.length > 0 && { elements: readmeElements }),
  };

  cache.set(key, result);
  return result;
}
