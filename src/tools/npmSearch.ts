import { logger } from '../logger.js';
import { safeResponseJson, assertSafeUrl } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, timeoutError } from '../errors.js';
import type { NpmPackage } from '../types.js';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/-/v1/search';
const USER_AGENT = 'search-mcp/1.0';
const REQUEST_TIMEOUT_MS = 15_000;

const cache = new ToolCache<NpmPackage[]>({ maxSize: 100, ttlMs: 10 * 60 * 1000 });

export async function npmSearch(query: string, limit = 20): Promise<NpmPackage[]> {
  const key = cacheKey('npm', query, String(limit));
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'npm search cache hit');
    return cached;
  }

  const params = new URLSearchParams({
    text: query,
    size: String(Math.min(limit, 250)),
  });

  const url = `${NPM_REGISTRY_URL}?${params.toString()}`;
  assertSafeUrl(url);

  logger.info({ tool: 'npm_search', limit }, 'Searching npm registry');

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });

        if (!res.ok) {
          throw unavailableError(`npm registry returned ${String(res.status)}: ${res.statusText}`, {
            statusCode: res.status,
            backend: 'npm',
          });
        }

        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === 'AbortError') {
          throw timeoutError('npm registry request timed out after 15 seconds', {
            backend: 'npm',
            cause: err,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    { label: 'npm-search', maxAttempts: 2 },
  );

  const json: unknown = await safeResponseJson(response, url);

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Unexpected npm registry response shape');
  }

  const body = json as Record<string, unknown>;
  const objects = body.objects;

  if (!Array.isArray(objects)) {
    throw new Error('Unexpected npm registry response: missing objects array');
  }

  const results: NpmPackage[] = (objects as unknown[])
    .map((obj) => {
      if (typeof obj !== 'object' || obj === null) return null;
      const o = obj as Record<string, unknown>;

      const pkg =
        typeof o.package === 'object' && o.package !== null
          ? (o.package as Record<string, unknown>)
          : null;

      if (!pkg) return null;

      const name = typeof pkg.name === 'string' ? pkg.name : '';
      if (!name) return null;

      const version = typeof pkg.version === 'string' ? pkg.version : '';
      const description = typeof pkg.description === 'string' ? pkg.description : '';

      const keywords: string[] = Array.isArray(pkg.keywords)
        ? (pkg.keywords as unknown[]).filter((k): k is string => typeof k === 'string')
        : [];

      // Author
      let author: string | null = null;
      if (typeof pkg.author === 'object' && pkg.author !== null) {
        const a = pkg.author as Record<string, unknown>;
        if (typeof a.name === 'string') author = a.name;
      } else if (typeof pkg.author === 'string') {
        author = pkg.author;
      }

      // Publisher
      let publisher: string | null = null;
      if (typeof pkg.publisher === 'object' && pkg.publisher !== null) {
        const p = pkg.publisher as Record<string, unknown>;
        if (typeof p.username === 'string') publisher = p.username;
      }

      // Links
      let repository: string | null = null;
      if (typeof pkg.links === 'object' && pkg.links !== null) {
        const links = pkg.links as Record<string, unknown>;
        if (typeof links.repository === 'string') repository = links.repository;
      }

      const date = typeof pkg.date === 'string' ? pkg.date : null;

      // Score
      let score: number | null = null;
      if (typeof o.score === 'object' && o.score !== null) {
        const s = o.score as Record<string, unknown>;
        if (typeof s.final === 'number') score = Math.round(s.final * 1000) / 1000;
      }

      return {
        name,
        version,
        description,
        keywords,
        author,
        publisher,
        url: `https://www.npmjs.com/package/${name}`,
        repository,
        date,
        score,
      } satisfies NpmPackage;
    })
    .filter((pkg): pkg is NpmPackage => pkg !== null);

  cache.set(key, results);
  logger.debug({ resultCount: results.length }, 'npm search complete');

  return results;
}
