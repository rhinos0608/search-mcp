/**
 * GitHub repository file content via the GitHub API.
 *
 * Strategy:
 * - GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
 * - Decode base64 content, detect binary, truncate at 50 KB limit
 * - Follow symlinks by re-fetching the target path
 * - Reject directories and submodules
 * - Supports line-range slicing (offset + limit) and byte-range slicing
 *   (byteOffset + byteLimit) via raw.githubusercontent.com with Range header
 */

import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
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

// ── Raw content fetch (raw.githubusercontent.com) ───────────────────────────

interface RawFetchResult {
  content: string;
  status: number;
  totalBytes: number | null;
  rangeStart: number | null;
  rangeEnd: number | null;
}

/**
 * Fetch file content from raw.githubusercontent.com.
 * Supports HTTP Range headers for byte-level slicing.
 */
async function fetchRawContent(
  owner: string,
  repo: string,
  path: string,
  branch?: string,
  byteOffset?: number,
  byteLimit?: number,
): Promise<RawFetchResult> {
  const encodedPath = '/' + path.split('/').map(encodeURIComponent).join('/');
  const url = branch
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}${encodedPath}`
    : `https://raw.githubusercontent.com/${owner}/${repo}/HEAD${encodedPath}`;

  assertSafeUrl(url);

  const headers: Record<string, string> = {
    'User-Agent': 'search-mcp/1.0',
  };
  const token = loadConfig().github.token;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (byteOffset !== undefined && byteLimit !== undefined) {
    const end = byteOffset + byteLimit - 1;
    headers.Range = `bytes=${String(byteOffset)}-${String(end)}`;
  } else if (byteOffset !== undefined) {
    headers.Range = `bytes=${String(byteOffset)}-`;
  }

  return retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const t = setTimeout(() => {
        controller.abort();
      }, 30_000);

      try {
        const response = await fetch(url, { headers, signal: controller.signal });
        const text = await response.text();

        // Parse Content-Range for total file size
        let totalBytes: number | null = null;
        const contentRange = response.headers.get('content-range');
        if (contentRange) {
          const match = /bytes \d+-\d+\/(\d+)/.exec(contentRange);
          if (match?.[1]) {
            totalBytes = parseInt(match[1], 10);
          }
        }

        let rangeStart: number | null = null;
        let rangeEnd: number | null = null;
        if (contentRange) {
          const match = /bytes (\d+)-(\d+)\//.exec(contentRange);
          if (match) {
            const [, startStr, endStr] = match;
            rangeStart = parseInt(startStr ?? '0', 10);
            rangeEnd = parseInt(endStr ?? '0', 10);
          }
        }

        if (response.status === 404) {
          throw notFoundError(`GitHub file "${path}" not found`, { statusCode: 404, backend: 'github' });
        }
        if (!response.ok && response.status !== 206) {
          throw unavailableError(
            `raw.githubusercontent.com returned HTTP ${String(response.status)} for "${path}"`,
            { statusCode: response.status, backend: 'github' },
          );
        }

        return { content: text, status: response.status, totalBytes, rangeStart, rangeEnd };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError(`raw.githubusercontent.com request timed out after 30 seconds`, {
            backend: 'github',
            cause: err,
          });
        }
        throw err;
      } finally {
        clearTimeout(t);
      }
    },
    { label: 'github-raw', maxAttempts: 3 },
  );
}

// ── Line-range helpers ──────────────────────────────────────────────────────

/** Split text into lines (handles both \n and \r\n, strips trailing empty). */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  // Remove trailing empty string caused by trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Apply line offset/limit and return sliced text + metadata. */
function applyLineRange(
  text: string,
  offset: number,
  limit: number | undefined,
): { text: string; totalLines: number; hasMore: boolean } {
  const lines = splitLines(text);
  const totalLines = lines.length;
  const start = Math.max(0, offset);
  const end = limit !== undefined ? Math.min(totalLines, start + limit) : totalLines;
  const sliced = lines.slice(start, end);
  return { text: sliced.join('\n'), totalLines, hasMore: end < totalLines };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Maximum symlink-follow depth to prevent cycles. */
const MAX_SYMLINK_DEPTH = 5;

/** Text output limit per chunk (bytes/chars). */
const MAX_FILE_LENGTH = 50_000;

export async function getGitHubRepoFile(
  owner: string,
  repo: string,
  path: string,
  branch?: string,
  raw = true,
  offset?: number,
  limit?: number,
  byteOffset?: number,
  byteLimit?: number,
  /** Internal: tracks symlink-follow depth to detect cycles. */
  _depth = 0,
): Promise<GitHubFileResult> {
  logger.info({ owner, repo, path, branch, raw, offset, limit, byteOffset, byteLimit }, 'getGitHubRepoFile');

  // ── Parameter validation ────────────────────────────────────────────────

  const hasLineRange = offset !== undefined || limit !== undefined;
  const hasByteRange = byteOffset !== undefined || byteLimit !== undefined;

  if (hasLineRange && hasByteRange) {
    throw validationError(
      `Cannot specify both line ranges (offset/limit) and byte ranges (byteOffset/byteLimit). Use one or the other.`,
      { statusCode: 400, backend: 'github' },
    );
  }

  if (hasLineRange && !raw) {
    throw validationError(
      `Line ranges (offset/limit) require raw=true (UTF-8 text). Base64 output cannot be line-sliced.`,
      { statusCode: 400, backend: 'github' },
    );
  }

  if (hasByteRange && !raw) {
    throw validationError(
      `Byte ranges (byteOffset/byteLimit) require raw=true (UTF-8 text). Base64 output cannot be byte-sliced.`,
      { statusCode: 400, backend: 'github' },
    );
  }

  if (offset !== undefined && offset < 0) {
    throw validationError(`offset must be >= 0`, { statusCode: 400, backend: 'github' });
  }
  if (limit !== undefined && limit < 1) {
    throw validationError(`limit must be >= 1`, { statusCode: 400, backend: 'github' });
  }
  if (byteOffset !== undefined && byteOffset < 0) {
    throw validationError(`byteOffset must be >= 0`, { statusCode: 400, backend: 'github' });
  }
  if (byteLimit !== undefined && byteLimit < 1) {
    throw validationError(`byteLimit must be >= 1`, { statusCode: 400, backend: 'github' });
  }

  await assertRateLimitOk('github');

  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const encodedPath = '/' + path.split('/').map(encodeURIComponent).join('/');

  const encodedBranch = branch ? encodeURIComponent(branch) : '';
  const contentsUrl = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/contents${encodedPath}${
    encodedBranch ? `?ref=${encodedBranch}` : ''
  }`;

  logger.debug({ contentsUrl }, 'Fetching file metadata');

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
        // File too large for GitHub API — fall back to raw.githubusercontent.com
        // if line ranges or byte ranges are requested, otherwise keep the existing error
        if (hasLineRange || hasByteRange) {
          logger.debug({ path, size: 'large' }, 'Falling back to raw.githubusercontent.com for range request');
          return fetchRawAndNormalize(owner, repo, path, branch, raw, offset, limit, byteOffset, byteLimit);
        }
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
    if (_depth >= MAX_SYMLINK_DEPTH) {
      throw validationError(
        `Symlink chain exceeds ${String(MAX_SYMLINK_DEPTH)} levels — possible cycle or circular symlink.`,
        { statusCode: 400, backend: 'github' },
      );
    }
    logger.debug({ path, name }, 'Following symlink');
    const linkContent = getString(body, 'content');
    // linkContent is base64-encoded target path
    const targetPath = Buffer.from(linkContent, 'base64').toString('utf-8').trim();
    // Re-fetch the target file with depth guard
    // Note: if target is a directory or submodule, getGitHubRepoFile will throw
    return getGitHubRepoFile(
      owner,
      repo,
      targetPath,
      branch,
      raw,
      offset,
      limit,
      byteOffset,
      byteLimit,
      _depth + 1,
    );
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
  const bytes = Buffer.from(contentB64, 'base64');

  // Detect binary
  const binary = isBinaryContent(bytes.toString('utf-8'), path);

  if (binary) {
    if (hasLineRange || hasByteRange) {
      throw validationError(
        `Line ranges and byte ranges are not supported for binary files.`,
        { statusCode: 400, backend: 'github' },
      );
    }
    return normalizeBinaryContent(name, path, size, sha, bytes, htmlUrl, apiUrl);
  }

  // Text file
  const decoded = bytes.toString('utf-8');

  // Apply line ranges
  if (hasLineRange) {
    const effectiveOffset = offset ?? 0;
    const { text: sliced, totalLines, hasMore } = applyLineRange(decoded, effectiveOffset, limit);

    let finalContent = sliced;
    let truncated = false;

    // Apply max length after line slicing
    if (finalContent.length > MAX_FILE_LENGTH) {
      truncated = true;
      finalContent = finalContent.slice(0, MAX_FILE_LENGTH) + TRUNCATED_MARKER;
    }

    return {
      name,
      path,
      size,
      sha,
      content: finalContent,
      encoding: 'utf-8',
      htmlUrl,
      apiUrl,
      truncated,
      isBinary: false,
      totalLines,
      lineOffset: effectiveOffset,
      lineLimit: limit ?? null,
      hasMore,
      byteOffset: null,
      byteLimit: null,
    };
  }

  // Apply byte ranges (fallback to raw.githubusercontent.com even for API-sized files
  // because GitHub API doesn't support byte ranges)
  if (hasByteRange) {
    return fetchRawAndNormalize(owner, repo, path, branch, raw, offset, limit, byteOffset, byteLimit);
  }

  // Default path: no ranges specified
  let truncated = false;
  let finalContent: string;
  let outputEncoding: 'utf-8' | 'base64';

  if (decoded.length > MAX_FILE_LENGTH) {
    truncated = true;
    finalContent = decoded.slice(0, MAX_FILE_LENGTH) + TRUNCATED_MARKER;
  } else {
    finalContent = decoded;
  }

  if (raw) {
    outputEncoding = 'utf-8';
  } else {
    outputEncoding = 'base64';
    finalContent = Buffer.from(finalContent).toString('base64');
  }

  const totalLines = splitLines(decoded).length;

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
    isBinary: false,
    totalLines,
    lineOffset: 0,
    lineLimit: null,
    hasMore: truncated,
    byteOffset: null,
    byteLimit: null,
  };
}

// ── Helpers for content normalization ───────────────────────────────────────

function normalizeBinaryContent(
  name: string,
  path: string,
  size: number,
  sha: string,
  bytes: Buffer,
  htmlUrl: string,
  apiUrl: string,
): GitHubFileResult {
  // Truncate at buffer level (base64-safe: multiple of 3 bytes)
  const truncLen = MAX_FILE_LENGTH - (MAX_FILE_LENGTH % 3);
  const truncated = bytes.length > MAX_FILE_LENGTH;
  const finalContent = truncated
    ? bytes.subarray(0, truncLen).toString('base64') + TRUNCATED_MARKER
    : bytes.toString('base64');

  return {
    name,
    path,
    size,
    sha,
    content: finalContent,
    encoding: 'base64',
    htmlUrl,
    apiUrl,
    truncated,
    isBinary: true,
    totalLines: 0,
    lineOffset: 0,
    lineLimit: null,
    hasMore: truncated,
    byteOffset: null,
    byteLimit: null,
  };
}

/**
 * Fetch from raw.githubusercontent.com and normalize.
 * Used for:
 * - Byte-range requests (GitHub API doesn't support HTTP Range)
 * - Line-range requests on files >1MB (GitHub API returns 403)
 */
async function fetchRawAndNormalize(
  owner: string,
  repo: string,
  path: string,
  branch?: string,
  raw = true,
  offset?: number,
  limit?: number,
  byteOffset?: number,
  byteLimit?: number,
): Promise<GitHubFileResult> {
  const hasLineRange = offset !== undefined || limit !== undefined;

  const { content, totalBytes, rangeEnd } = await fetchRawContent(
    owner,
    repo,
    path,
    branch,
    byteOffset,
    byteLimit,
  );

  // Detect binary
  const binary = isBinaryContent(content, path);

  if (binary) {
    throw validationError(
      `Line ranges and byte ranges are not supported for binary files.`,
      { statusCode: 400, backend: 'github' },
    );
  }

  // For byte ranges, count total lines in the fetched chunk
  const lines = splitLines(content);
  const totalLines = lines.length;

  let finalContent: string;
  let truncated = false;

  const encodedPath = '/' + path.split('/').map(encodeURIComponent).join('/');
  const htmlUrl = branch
    ? `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(branch)}${encodedPath}`
    : `https://github.com/${owner}/${repo}/blob/HEAD${encodedPath}`;

  if (hasLineRange) {
    const effectiveOffset = offset ?? 0;
    const { text: sliced, totalLines: fileTotalLines, hasMore } = applyLineRange(content, effectiveOffset, limit);

    let text = sliced;
    if (text.length > MAX_FILE_LENGTH) {
      truncated = true;
      text = text.slice(0, MAX_FILE_LENGTH) + TRUNCATED_MARKER;
    }

    finalContent = text;

    return {
      name: path.split('/').pop() ?? path,
      path,
      size: totalBytes ?? Buffer.byteLength(content, 'utf-8'),
      sha: '',
      content: finalContent,
      encoding: 'utf-8',
      htmlUrl,
      apiUrl: '',
      truncated,
      isBinary: false,
      totalLines: fileTotalLines,
      lineOffset: effectiveOffset,
      lineLimit: limit ?? null,
      hasMore,
      byteOffset: null,
      byteLimit: null,
    };
  }

  // Byte range path
  if (content.length > MAX_FILE_LENGTH) {
    truncated = true;
    finalContent = content.slice(0, MAX_FILE_LENGTH) + TRUNCATED_MARKER;
  } else {
    finalContent = content;
  }

  const hasMore = totalBytes !== null && rangeEnd !== null ? rangeEnd < totalBytes - 1 : false;

  return {
    name: path.split('/').pop() ?? path,
    path,
    size: totalBytes ?? Buffer.byteLength(content, 'utf-8'),
    sha: '',
    content: raw ? finalContent : Buffer.from(finalContent).toString('base64'),
    encoding: raw ? 'utf-8' : 'base64',
    htmlUrl,
    apiUrl: '',
    truncated,
    isBinary: false,
    totalLines,
    lineOffset: 0,
    lineLimit: null,
    hasMore,
    byteOffset: byteOffset ?? null,
    byteLimit: byteLimit ?? null,
  };
}
