/**
 * GitHub repository file content via the GitHub API.
 *
 * Strategy:
 * - GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
 * - Decode base64 content, detect binary, truncate at 50 KB limit
 * - Follow symlinks by re-fetching the target path
 * - Reject directories and submodules
 */

import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson, TRUNCATED_MARKER } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import {
  rateLimitError,
  notFoundError,
  unavailableError,
  timeoutError,
  validationError,
} from '../errors.js';
import type { GitHubFileResult } from '../types.js';

const GITHUB_API = 'https://api.github.com';

// ── HTTP helpers (mirrors githubRepoTree.ts) ────────────────────────────────

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

function getNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === 'number' ? v : 0;
}

function getStringOrNull(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

// ── Binary detection ────────────────────────────────────────────────────────

/**
 * Heuristic extension list that strongly indicates binary content.
 * These are checked after null-byte scanning as a secondary check.
 */
const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'webp',
  'svg', // images
  'pdf',
  'psd',
  'ai',
  'eps', // document/image formats
  'zip',
  'tar',
  'gz',
  'bz2',
  'xz',
  '7z',
  'rar', // archives
  'exe',
  'dll',
  'so',
  'dylib',
  'a',
  'o',
  'obj', // binaries
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot', // fonts
  'mp3',
  'mp4',
  'avi',
  'mov',
  'mkv',
  'flac',
  'wav', // audio/video
  'class',
  'jar',
  'war', // compiled java
  'pyc',
  'pyo', // compiled python
  'node',
  'wasm', // compiled binaries
]);

/**
 * Detect whether decoded content is binary.
 * Strategy:
 * - Scan for null bytes (\x00) — definitive binary indicator
 * - Check file extension as secondary heuristic for formats with no null bytes
 *   (e.g., PNG starts with \x89PNG, JPEG starts with \xff\xd8)
 */
function isBinaryContent(content: string, filePath: string): boolean {
  // Scan for null bytes — most reliable binary indicator
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0) {
      return true;
    }
  }

  // Check extension heuristic
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_EXTENSIONS.has(ext);
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getGitHubRepoFile(
  owner: string,
  repo: string,
  path: string,
  branch?: string,
  raw = true,
): Promise<GitHubFileResult> {
  logger.info({ owner, repo, path, branch, raw }, 'getGitHubRepoFile');

  await assertRateLimitOk('github');

  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const encodedPath = '/' + path.split('/').map(encodeURIComponent).join('/');

  const encodedBranch = branch ? encodeURIComponent(branch) : '';
  const contentsUrl = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/contents${encodedPath}${
    encodedBranch ? `?ref=${encodedBranch}` : ''
  }`;

  logger.debug({ contentsUrl }, 'Fetching file content');

  const { response, body } = await githubFetch(contentsUrl);

  if (!response.ok) {
    if (response.status === 403) {
      // githubFetch already consumed the body. Re-fetch the error body
      // to distinguish large-file 403 from rate-limit 403.
      let errorText: string | undefined;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort();
        }, 10_000);
        const rawResp = await fetch(contentsUrl, {
          headers: buildHeaders(),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        errorText = await rawResp.text();
      } catch {
        // Could not re-fetch — fall through to rate limit below
      }
      if (
        errorText &&
        (errorText.includes('too large') ||
          errorText.includes('file is too large') ||
          errorText.includes('lfs') ||
          errorText.includes('LFS'))
      ) {
        const rawUrl = branch
          ? `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}${encodedPath}`
          : `https://raw.githubusercontent.com/${owner}/${repo}/HEAD${encodedPath}`;
        throw validationError(
          `GitHub returned 403 for "${path}" — file may be over 1 MB. ` +
            `Try fetching directly from: ${rawUrl}`,
          { statusCode: 403, backend: 'github' },
        );
      }
      getTracker('github').recordLimitHit();
      throw rateLimitError('GitHub API rate limit exceeded. Try again later.', {
        statusCode: 403,
        backend: 'github',
      });
    }
    handleGitHubError(response.status, response.statusText, `${owner}/${repo}/${path}`);
  }

  // GitHub returns an array for directories; a dict for files
  if (Array.isArray(body)) {
    throw validationError(
      `Path is a directory, not a file. Use github_repo_tree to list directories.`,
      { statusCode: 400, backend: 'github' },
    );
  }

  if (!isRecord(body)) {
    throw unavailableError(
      `Unexpected GitHub contents API response shape for ${owner}/${repo}/${path}`,
      {
        backend: 'github',
      },
    );
  }

  // Check type field — reject submodules
  const rawType = getString(body, 'type');
  if (rawType === 'submodule') {
    throw validationError(`Path is a submodule. File content is not available for submodules.`, {
      statusCode: 400,
      backend: 'github',
    });
  }

  // Normalize entry data
  const name = getString(body, 'name');
  const sha = getString(body, 'sha');
  const size = getNumber(body, 'size');

  // Build HTML URL
  const branchPart = branch ?? 'main';
  const htmlUrl = `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(branchPart)}${encodedPath}`;
  const apiUrl = getStringOrNull(body, 'url') ?? '';

  // Handle symlinks: type === 'symlink' and content contains the target path
  if (rawType === 'symlink') {
    logger.debug({ path, name }, 'Following symlink');
    const linkContent = getString(body, 'content');
    // linkContent is base64-encoded target path
    const targetPath = Buffer.from(linkContent, 'base64').toString('utf-8').trim();
    // Re-fetch the target file
    return getGitHubRepoFile(owner, repo, targetPath, branch, raw);
  }

  // Regular file — extract content
  const encoding = getString(body, 'encoding');
  const contentB64 = getString(body, 'content');

  if (encoding !== 'base64' || !contentB64) {
    throw unavailableError(`Unexpected encoding "${encoding}" for file ${owner}/${repo}/${path}`, {
      backend: 'github',
    });
  }

  // Decode base64
  const decoded = Buffer.from(contentB64, 'base64').toString('utf-8');

  // Detect binary
  const binary = isBinaryContent(decoded, path);

  // 50 KB size limit (same as README cap)
  const MAX_FILE_LENGTH = 50_000;
  let truncated = false;
  let finalContent: string;

  if (decoded.length > MAX_FILE_LENGTH) {
    truncated = true;
    finalContent = decoded.slice(0, MAX_FILE_LENGTH) + TRUNCATED_MARKER;
  } else {
    finalContent = decoded;
  }

  // Determine output encoding and content
  let outputEncoding: 'utf-8' | 'base64';

  if (binary) {
    // Always return base64 for binary files regardless of raw flag
    outputEncoding = 'base64';
    finalContent = contentB64; // use original base64 to preserve binary fidelity
  } else if (raw) {
    outputEncoding = 'utf-8';
    // truncated is already set above; no-op assignment was a no-op
  } else {
    outputEncoding = 'base64';
    finalContent = contentB64; // return raw base64 when raw=false
  }

  return {
    name,
    path,
    size,
    sha,
    content: finalContent,
    encoding: outputEncoding,
    htmlUrl,
    apiUrl,
    truncated,
    isBinary: binary,
  };
}
