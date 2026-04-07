import { logger } from '../logger.js';
import {
  safeResponseJson,
  safeResponseText,
  assertSafeUrl,
  TRUNCATED_MARKER,
} from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, timeoutError } from '../errors.js';
import type { PypiPackage } from '../types.js';

const PYPI_JSON_URL = 'https://pypi.org/pypi';
const TOP_PACKAGES_URL =
  'https://hugovk.github.io/top-pypi-packages/top-pypi-packages-30-days.min.json';
const USER_AGENT = 'search-mcp/1.0';
const REQUEST_TIMEOUT_MS = 15_000;
const DESCRIPTION_MAX_LENGTH = 500;

const cache = new ToolCache<PypiPackage[]>({ maxSize: 100, ttlMs: 10 * 60 * 1000 });

// ── Top packages index (cached in memory) ────────────────────────────────────

interface TopPackageEntry {
  project: string;
  download_count: number;
}

let topPackagesCache: TopPackageEntry[] | null = null;
let topPackagesCacheTime = 0;
const TOP_PACKAGES_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function fetchTopPackages(): Promise<TopPackageEntry[]> {
  const now = Date.now();
  if (topPackagesCache !== null && now - topPackagesCacheTime < TOP_PACKAGES_TTL_MS) {
    return topPackagesCache;
  }

  const url = TOP_PACKAGES_URL;
  assertSafeUrl(url);

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });

        if (!res.ok) {
          throw unavailableError(
            `Top PyPI packages index returned ${String(res.status)}: ${res.statusText}`,
            { statusCode: res.status, backend: 'pypi' },
          );
        }

        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError('Top PyPI packages index request timed out', {
            backend: 'pypi',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'pypi-top-packages', maxAttempts: 2 },
  );

  const json: unknown = await safeResponseJson(response, url);

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Unexpected top packages response shape');
  }

  const body = json as Record<string, unknown>;
  const rows = body.rows;

  if (!Array.isArray(rows)) {
    throw new Error('Unexpected top packages response: missing rows array');
  }

  const entries: TopPackageEntry[] = (rows as unknown[])
    .filter(
      (r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r),
    )
    .filter((r) => typeof r.project === 'string' && typeof r.download_count === 'number')
    .map((r) => ({
      project: r.project as string,
      download_count: r.download_count as number,
    }));

  topPackagesCache = entries;
  topPackagesCacheTime = now;
  logger.debug({ count: entries.length }, 'Top PyPI packages index loaded');

  return entries;
}

// ── Search logic ─────────────────────────────────────────────────────────────

function searchTopPackages(query: string, packages: TopPackageEntry[], limit: number): string[] {
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/[\s\-_]+/).filter((t) => t.length > 0);

  // Score each package by relevance
  const scored: { name: string; score: number; downloads: number }[] = [];

  for (const pkg of packages) {
    const name = pkg.project.toLowerCase();
    let score = 0;

    // Exact match on full query (e.g. "anthropic-claude-sdk")
    if (
      name === queryLower ||
      name === queryLower.replace(/\s+/g, '-') ||
      name === queryLower.replace(/\s+/g, '_')
    ) {
      score = 1000;
    }
    // Package name exactly equals an individual query term
    // (e.g. "anthropic" for query "anthropic claude sdk")
    else if (queryTerms.length > 1 && queryTerms.some((term) => name === term)) {
      score = 800;
    }
    // Starts with query
    else if (name.startsWith(queryLower) || name.startsWith(queryLower.replace(/\s+/g, '-'))) {
      score = 500;
    }
    // Name contains the full query
    else if (
      name.includes(queryLower) ||
      name.includes(queryLower.replace(/\s+/g, '-')) ||
      name.includes(queryLower.replace(/\s+/g, '_'))
    ) {
      score = 100;
    }
    // All query terms appear in the name
    else if (queryTerms.length > 1 && queryTerms.every((term) => name.includes(term))) {
      score = 50;
    }
    // Any query term appears in the name (partial match)
    else if (queryTerms.some((term) => term.length >= 3 && name.includes(term))) {
      score = 10;
    }

    if (score > 0) {
      // Boost by download popularity (log scale)
      const popularityBoost = Math.log10(Math.max(pkg.download_count, 1));
      scored.push({
        name: pkg.project,
        score: score + popularityBoost,
        downloads: pkg.download_count,
      });
    }
  }

  // Sort by score descending, then downloads descending
  scored.sort((a, b) => b.score - a.score || b.downloads - a.downloads);

  return scored.slice(0, limit).map((s) => s.name);
}

// ── JSON API enrichment ──────────────────────────────────────────────────────

async function fetchPackageMetadata(name: string): Promise<PypiPackage | null> {
  const url = `${PYPI_JSON_URL}/${encodeURIComponent(name)}/json`;
  assertSafeUrl(url);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 8_000);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) return null;

    const text = await safeResponseText(res, url);
    const data = JSON.parse(text) as Record<string, unknown>;
    const info =
      typeof data.info === 'object' && data.info !== null
        ? (data.info as Record<string, unknown>)
        : null;

    if (!info) return null;

    const pkgName = typeof info.name === 'string' ? info.name : name;
    const version = typeof info.version === 'string' ? info.version : '';
    const rawDescription = typeof info.summary === 'string' ? info.summary : '';
    const description =
      rawDescription.length > DESCRIPTION_MAX_LENGTH
        ? rawDescription.slice(0, DESCRIPTION_MAX_LENGTH) + TRUNCATED_MARKER
        : rawDescription;

    let author: string | null = null;
    if (typeof info.author === 'string' && info.author.length > 0) {
      author = info.author;
    } else if (typeof info.author_email === 'string' && info.author_email.length > 0) {
      author = info.author_email;
    } else if (typeof info.maintainer === 'string' && info.maintainer.length > 0) {
      author = info.maintainer;
    }

    // Extract latest release date from the releases data
    let releaseDate: string | null = null;
    if (typeof data.urls === 'object' && Array.isArray(data.urls) && data.urls.length > 0) {
      const firstUrl = data.urls[0] as Record<string, unknown> | undefined;
      if (firstUrl && typeof firstUrl.upload_time_iso_8601 === 'string') {
        releaseDate = firstUrl.upload_time_iso_8601;
      }
    }

    return {
      name: pkgName,
      version,
      description,
      url: `https://pypi.org/project/${pkgName}/`,
      author,
      releaseDate,
    };
  } catch {
    logger.debug({ package: name }, 'Failed to fetch PyPI package metadata');
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function pypiSearch(query: string, limit = 20): Promise<PypiPackage[]> {
  const key = cacheKey('pypi', query, String(limit));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'PyPI search cache hit');
    return cached;
  }

  logger.info({ tool: 'pypi_search', limit }, 'Searching PyPI');

  // Step 1: Search the top packages index for matching names
  const topPackages = await fetchTopPackages();
  const matchedNames = searchTopPackages(query, topPackages, limit);

  // Step 2: Also try a direct JSON API lookup for the exact query as a package name
  // (in case it's not in the top 15k but exists)
  const directLookupNames: string[] = [];
  const queryNormalized = query.trim().toLowerCase();
  const queryHyphen = queryNormalized.replace(/[\s_]+/g, '-');
  const queryUnderscore = queryNormalized.replace(/[\s-]+/g, '_');

  for (const candidate of [queryNormalized, queryHyphen, queryUnderscore]) {
    if (candidate.length > 0 && !matchedNames.includes(candidate)) {
      directLookupNames.push(candidate);
    }
  }

  // Step 3: Fetch metadata for all matched packages in parallel
  const allNames = [...matchedNames, ...directLookupNames];
  const metadataResults = await Promise.allSettled(
    allNames.map((name) => fetchPackageMetadata(name)),
  );

  const packages: PypiPackage[] = [];

  // First add index-matched results (in ranked order)
  for (let i = 0; i < matchedNames.length; i++) {
    const result = metadataResults[i];
    if (result?.status === 'fulfilled' && result.value !== null) {
      packages.push(result.value);
    }
  }

  // Then add direct lookup results (if not already included)
  const seenNames = new Set(packages.map((p) => p.name.toLowerCase()));
  for (let i = matchedNames.length; i < allNames.length; i++) {
    const result = metadataResults[i];
    if (result?.status === 'fulfilled' && result.value !== null) {
      if (!seenNames.has(result.value.name.toLowerCase())) {
        // Direct match goes at the top if we have few index matches
        if (packages.length < 3) {
          packages.unshift(result.value);
        } else {
          packages.push(result.value);
        }
      }
    }
  }

  cache.set(key, packages);
  logger.debug({ resultCount: packages.length }, 'PyPI search complete');

  return packages;
}
