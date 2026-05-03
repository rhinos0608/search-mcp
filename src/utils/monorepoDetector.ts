/**
 * Monorepo detection for GitHub repositories.
 *
 * Detects monorepo config files and workspace patterns from a root-level
 * directory listing. Optionally fetches package.json files from workspace
 * directories to populate package names and descriptions.
 *
 * Strategy:
 * 1. Scan root entries for monorepo config files (pnpm-workspace.yaml,
 *    lerna.json, turbo.json, nx.json, rush.json, package.json with workspaces).
 * 2. Fetch root package.json to confirm workspace patterns.
 * 3. Resolve workspace patterns (e.g. "packages/*", "apps/*") to matching
 *    directories from the root listing.
 * 4. Optionally fetch each workspace dir's package.json for name/description.
 */

import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { getTracker } from '../rateLimit.js';
import { timeoutError, unavailableError } from '../errors.js';
import type { GitHubTreeEntry, MonorepoDetectResult, MonorepoPackage } from '../types.js';

const GITHUB_API = 'https://api.github.com';

// ── Constants ────────────────────────────────────────────────────────────────

/** Config files that strongly indicate a monorepo. */
const MONOREPO_CONFIG_FILES = new Set([
  'pnpm-workspace.yaml',
  'lerna.json',
  'turbo.json',
  'nx.json',
  'rush.json',
  'bazel-invocation-analyzer', // buck / bazel
]);

/** Directory names commonly used for monorepo workspaces. */
const WORKSPACE_DIR_NAMES = new Set(['packages', 'apps', 'libs', 'modules', 'services', 'servers', 'clients']);

/** Max workspace packages to fetch details for (avoids excessive API calls). */
const MAX_FETCH_PACKAGES = 20;

// ── HTTP helpers ─────────────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Monorepo detection ─────────────────────────────────────────────────────

/**
 * Detect monorepo markers from a set of root-level entries (from the contents API).
 *
 * Returns a detection result with config files found and inferred type.
 * Does NOT make any additional API calls.
 */
export function detectMonorepoFromEntries(entries: GitHubTreeEntry[]): MonorepoDetectResult {
  const configFiles: string[] = [];
  const workspaceDirEntries: GitHubTreeEntry[] = [];
  const rootEntriesByName = new Map<string, GitHubTreeEntry>();

  for (const entry of entries) {
    rootEntriesByName.set(entry.name, entry);
    if (entry.type === 'file' && MONOREPO_CONFIG_FILES.has(entry.name)) {
      configFiles.push(entry.name);
    }
    if (entry.type === 'dir' && WORKSPACE_DIR_NAMES.has(entry.name)) {
      workspaceDirEntries.push(entry);
    }
  }

  const hasPackageJson = rootEntriesByName.has('package.json');
  const workspacePatterns: string[] = [];

  // If pnpm-workspace.yaml exists → pnpm workspace
  const isPnpm = configFiles.includes('pnpm-workspace.yaml');
  // If lerna.json exists → likely lerna
  const isLerna = configFiles.includes('lerna.json');
  // If turbo.json exists → turborepo
  const isTurborepo = configFiles.includes('turbo.json');
  // If nx.json exists → Nx
  const isNx = configFiles.includes('nx.json');

  // Add known workspace dirs as inferred patterns
  for (const dirEntry of workspaceDirEntries) {
    workspacePatterns.push(`${dirEntry.name}/*`);
  }

  // Heuristic: if we have workspace dirs OR monorepo config files, it's likely a monorepo
  const hasWorkspaceDirs = workspaceDirEntries.length > 0;
  const hasConfigFiles = configFiles.length > 0;
  const detected = hasWorkspaceDirs || hasConfigFiles;

  // Derive type
  let type: MonorepoDetectResult['type'] = 'unknown';
  if (isPnpm) type = 'pnpm';
  else if (isLerna && isTurborepo) type = 'turborepo';
  else if (isLerna) type = 'lerna';
  else if (isTurborepo) type = 'turborepo';
  else if (isNx) type = 'nx';
  else if (hasWorkspaceDirs) type = 'yarn'; // assume yarn workspaces as default

  // package manager hint
  let packageManager: string | null = null;
  if (isPnpm) packageManager = 'pnpm';
  else if (isLerna) packageManager = 'lerna';
  else if (isTurborepo) packageManager = 'pnpm_or_yarn';
  else if (isNx) packageManager = 'pnpm_or_yarn';

  return {
    detected,
    type,
    packageManager,
    configFiles,
    workspacePatterns,
    packages: [], // populated on demand
    hasPackageJsonRoot: hasPackageJson,
  };
}

/**
 * Parse workspace patterns from a root package.json content.
 */
function extractWorkspacesFromPackageJson(
  content: Record<string, unknown>,
): string[] {
  const workspaces = content.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((w): w is string => typeof w === 'string');
  }
  // Check for pnpm-style workspaces
  if (isRecord(workspaces)) {
    const pkgs = workspaces.packages;
    if (Array.isArray(pkgs)) {
      return pkgs.filter((w): w is string => typeof w === 'string');
    }
  }
  return [];
}

/**
 * Resolve glob-like workspace patterns against root directory entries.
 * E.g. "packages/*" → matches the "packages" directory entry.
 * More complex globs (e.g. "packages/*" with sub-dirs) are simplified to
 * match the first directory segment.
 */
function resolveWorkspaceDirs(
  patterns: string[],
  rootEntriesMap: Map<string, GitHubTreeEntry>,
): GitHubTreeEntry[] {
  const matched: GitHubTreeEntry[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    // Extract the first path segment (e.g. "packages" from "packages/*")
    const firstSegment = pattern.split('/')[0];
    if (!firstSegment) continue;

    const entry = rootEntriesMap.get(firstSegment);
    if (entry?.type === 'dir' && !seen.has(firstSegment)) {
      matched.push(entry);
      seen.add(firstSegment);
    }
  }

  return matched;
}

/**
 * Fetch a single file from the GitHub API (contents endpoint).
 * Returns the JSON body on success, or null if 404.
 */
async function fetchContentsJson(
  owner: string,
  repo: string,
  path: string,
  branch?: string,
): Promise<Record<string, unknown> | null> {
  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const url = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/contents/${encodedPath}${ref}`;

  const { response, body } = await githubFetch(url);

  if (!response.ok) {
    if (response.status === 404) return null;
    if (response.status === 403 || response.status === 429) {
      getTracker('github').recordLimitHit();
    }
    logger.warn(
      { status: response.status, path, owner, repo },
      'fetchContentsJson: non-OK response',
    );
    return null;
  }

  if (!isRecord(body)) {
    logger.warn({ path, owner, repo }, 'fetchContentsJson: body is not a record');
    return null;
  }

  const encoding = getString(body, 'encoding');
  const content = getString(body, 'content');
  if (encoding !== 'base64' || content.length === 0) {
    logger.warn({ path, encoding, owner, repo }, 'fetchContentsJson: unexpected encoding or empty content');
    return null;
  }

  try {
    const decoded = Buffer.from(content, 'base64').toString('utf-8');
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    logger.warn({ path, owner, repo }, 'fetchContentsJson: failed to parse JSON');
    return null;
  }
}

/**
 * Fetch details for each workspace package (name, description, version)
 * from the package.json files in each workspace directory.
 *
 * Makes up to `maxPackages` concurrent API calls.
 */
async function fetchWorkspacePackages(
  owner: string,
  repo: string,
  workspaceDirs: GitHubTreeEntry[],
  branch?: string,
  maxPackages = MAX_FETCH_PACKAGES,
): Promise<MonorepoPackage[]> {
  const dirs = workspaceDirs.slice(0, maxPackages);

  const nested = await Promise.all(
    dirs.map(async (dir): Promise<MonorepoPackage[]> => {
      // For each workspace dir, try to fetch its package.json
      const packageJson = await fetchContentsJson(
        owner,
        repo,
        `${dir.path}/package.json`,
        branch,
      );

      if (packageJson) {
        const name = getStringOrNull(packageJson, 'name');
        const description = getStringOrNull(packageJson, 'description');
        const version = getStringOrNull(packageJson, 'version');
        return [{
          name: name ?? dir.name,
          path: dir.path,
          description,
          version,
        }];
      }

      // No package.json at dir root — it might contain sub-packages
      // (e.g. packages/* where * are the actual packages).
      // Try to list the directory contents to find sub-packages.
      return fetchWorkspaceSubPackages(owner, repo, dir, branch);
    }),
  );

  return nested.flat();
}

/**
 * For a workspace directory that doesn't have its own package.json,
 * try to list its contents and check for package.json files in sub-entries.
 */
async function fetchWorkspaceSubPackages(
  owner: string,
  repo: string,
  dir: GitHubTreeEntry,
  branch?: string,
): Promise<MonorepoPackage[]> {
  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);
  const encodedPath = dir.path.split('/').map(encodeURIComponent).join('/');
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const url = `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/contents/${encodedPath}${ref}`;

  const { response, body } = await githubFetch(url);

  if (!response.ok || !Array.isArray(body)) {
    // If we can't list the dir, try it as a package name
    return [{
      name: dir.name,
      path: dir.path,
      description: null,
      version: null,
    }];
  }

  // For each sub-entry that is a directory, try to fetch its package.json
  const subDirs = body
    .filter((item): item is Record<string, unknown> => isRecord(item) && getString(item, 'type') === 'dir')
    .map((item) => getString(item, 'path'));

  if (subDirs.length === 0) {
    // No sub-dirs — the dir itself might be the package
    return [{
      name: dir.name,
      path: dir.path,
      description: null,
      version: null,
    }];
  }

  // Fetch package.json for each sub-directory (limit to 20)
  const limitedSubDirs = subDirs.slice(0, 20);
  const packageResults: MonorepoPackage[] = await Promise.all(
    limitedSubDirs.map(async (subPath) => {
      const pj = await fetchContentsJson(owner, repo, `${subPath}/package.json`, branch);
      if (pj) {
        const name = getStringOrNull(pj, 'name');
        const description = getStringOrNull(pj, 'description');
        const version = getStringOrNull(pj, 'version');
        return {
          name: name ?? subPath.split('/').pop() ?? subPath,
          path: subPath,
          description,
          version,
        };
      }
      return {
        name: subPath.split('/').pop() ?? subPath,
        path: subPath,
        description: null,
        version: null,
      };
    }),
  );

  return packageResults;
}

/**
 * High-level API: detect monorepo from root entries, optionally fetch
 * root package.json for workspace config, and optionally fetch workspace
 * package details.
 *
 * @param owner - GitHub owner
 * @param repo - GitHub repo name
 * @param rootEntries - root-level directory entries
 * @param branch - optional ref (branch/tag/commit)
 * @param fetchDetails - if true, fetches package.json content for workspace packages
 * @returns Monorepo detection result
 */
export async function getMonorepoInfo(
  owner: string,
  repo: string,
  rootEntries: GitHubTreeEntry[],
  branch?: string,
  fetchDetails = false,
): Promise<MonorepoDetectResult> {
  const result = detectMonorepoFromEntries(rootEntries);

  if (!result.detected) {
    return result;
  }

  const rootEntriesMap = new Map(rootEntries.map((e) => [e.name, e]));

  // Try to get workspace patterns from root package.json
  const hasPackageJson = rootEntriesMap.has('package.json');
  if (hasPackageJson) {
    const pkgJson = await fetchContentsJson(owner, repo, 'package.json', branch);
    if (pkgJson) {
      const extracted = extractWorkspacesFromPackageJson(pkgJson);
      if (extracted.length > 0) {
        result.workspacePatterns = extracted;
      }
    }
  }

  // Resolve workspace patterns to directory entries
  const workspaceDirs = resolveWorkspaceDirs(result.workspacePatterns, rootEntriesMap);

  // Build package entries
  if (fetchDetails && workspaceDirs.length > 0) {
    try {
      const packages = await fetchWorkspacePackages(owner, repo, workspaceDirs, branch);
      result.packages = packages;
    } catch (err) {
      logger.warn({ err, owner, repo }, 'getMonorepoInfo: failed to fetch workspace package details');
      // Fallback: use directory names as package names
      result.packages = workspaceDirs.map((dir) => ({
        name: dir.name,
        path: dir.path,
        description: null,
        version: null,
      }));
    }
  } else if (workspaceDirs.length > 0) {
    result.packages = workspaceDirs.map((dir) => ({
      name: dir.name,
      path: dir.path,
      description: null,
      version: null,
    }));
  }

  return result;
}

/**
 * Given a monorepo detection result and a package name/path reference,
 * resolve the full path within the repo for fetching its tree.
 *
 * @param monorepo - detection result with packages
 * @param reference - package name (from package.json name) or bare path
 * @returns resolved path, or null if not found
 */
export function resolvePackagePath(
  monorepo: MonorepoDetectResult,
  reference: string,
): string | null {
  // Direct path match
  const direct = monorepo.packages.find((p) => p.path === reference || p.name === reference);
  if (direct) return direct.path;

  // Partial match on path (e.g. "packages/foo" matches packages/foo)
  const pathMatch = monorepo.packages.find((p) => p.path.endsWith(`/${reference}`) || p.path === reference);
  if (pathMatch) return pathMatch.path;

  return null;
}

/**
 * Build a compact textual overview of the monorepo structure.
 */
export function buildMonorepoOverview(monorepo: MonorepoDetectResult): string {
  if (!monorepo.detected) return '';

  const lines: string[] = [];
  lines.push(`📦 Monorepo detected (type: ${monorepo.type})`);

  if (monorepo.configFiles.length > 0) {
    lines.push(`   Config: ${monorepo.configFiles.join(', ')}`);
  }

  if (monorepo.workspacePatterns.length > 0) {
    lines.push(`   Workspace patterns: ${monorepo.workspacePatterns.join(', ')}`);
  }

  if (monorepo.packages.length > 0) {
    lines.push(`   Packages (${String(monorepo.packages.length)}):`);
    for (const pkg of monorepo.packages) {
      const desc = pkg.description ? ` — ${pkg.description}` : '';
      const ver = pkg.version ? ` v${pkg.version}` : '';
      lines.push(`     • ${pkg.name}${ver} @ ${pkg.path}${desc}`);
    }
  }

  return lines.join('\n');
}
