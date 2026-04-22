import { logger } from '../logger.js';
import { loadConfig, type SearchBackend } from '../config.js';
import { braveSearch } from './braveSearch.js';
import { searxngSearch } from './searxngSearch.js';
import { normalizeUrl, rrfMerge } from '../utils/fusion.js';
import { multiSignalRescore, extractWebSearchSignals } from '../utils/rescore.js';
import type { SearchResult } from '../types.js';

// ── Fallback order ───────────────────────────────────────────────────────────

/** Backend priority when the primary fails. */
const FALLBACK_ORDER: SearchBackend[] = ['brave', 'searxng'];

function backendAvailable(backend: SearchBackend): boolean {
  const cfg = loadConfig();
  switch (backend) {
    case 'brave':
      return cfg.brave.apiKey.length > 0;
    case 'searxng':
      return cfg.searxng.baseUrl.length > 0;
  }
}

async function runBackend(
  backend: SearchBackend,
  query: string,
  limit: number,
  safeSearch: 'strict' | 'moderate' | 'off',
  deps: WebSearchDeps,
): Promise<SearchResult[]> {
  const cfg = loadConfig();
  switch (backend) {
    case 'brave':
      return deps.braveSearch(query, cfg.brave.apiKey, limit, safeSearch);
    case 'searxng':
      return deps.searxngSearch(query, cfg.searxng.baseUrl, limit, safeSearch);
  }
}

// ── Dependency injection ─────────────────────────────────────────────────────

export interface WebSearchDeps {
  braveSearch: typeof import('./braveSearch.js').braveSearch;
  searxngSearch: typeof import('./searxngSearch.js').searxngSearch;
}

// ── Core search with fusion ──────────────────────────────────────────────────

export async function searchWithBackends(
  query: string,
  limit: number,
  safeSearch: 'strict' | 'moderate' | 'off',
  deps: WebSearchDeps,
  overrideBackends?: SearchBackend[],
): Promise<SearchResult[]> {
  const cfg = loadConfig();
  const primary = cfg.searchBackend;

  const backends =
    overrideBackends ??
    [primary, ...FALLBACK_ORDER.filter((b) => b !== primary)];

  const errors: string[] = [];

  const available = overrideBackends
    ? backends
    : backends.filter((b) => {
        if (!backendAvailable(b)) {
          logger.debug({ backend: b }, 'Skipping unavailable backend');
          return false;
        }
        return true;
      });

  const promises = available.map(async (backend) => {
    try {
      const results = await runBackend(
        backend,
        query,
        limit,
        safeSearch,
        deps,
      );
      return { backend, results };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ backend, err: msg }, 'Search backend failed');
      errors.push(`${backend}: ${msg}`);
      throw err;
    }
  });

  const settled = await Promise.allSettled(promises);
  const valid: SearchResult[][] = [];

  for (const s of settled) {
    if (s.status === 'fulfilled') {
      valid.push(s.value.results);
    }
  }

  if (valid.length === 0) {
    throw new Error(
      `All search backends failed. Ensure at least one backend is configured (BRAVE_API_KEY or SEARXNG_BASE_URL).\n${errors.join('\n')}`,
    );
  }

  if (valid.length === 1) {
    return (valid[0] ?? []).slice(0, limit);
  }

  const merged = rrfMerge(valid, {
    k: 60,
    keyFn: (r) => normalizeUrl(r.url),
  });

  const allItems = merged.map((m) => m.item);
  const allSignals = extractWebSearchSignals(allItems);

  const signaled = merged.map((m, i) => ({
    item: m.item,
    rrfScore: m.rrfScore,
    signals: allSignals[i] ?? {},
  }));

  const rescoreWeights = loadConfig().rescoreWeights.webSearch;

  const rescored = multiSignalRescore(signaled, rescoreWeights, limit);

  return rescored.map((r, i) => ({
    ...r.item,
    position: i + 1,
  }));
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function webSearch(
  query: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
): Promise<SearchResult[]> {
  return searchWithBackends(query, limit, safeSearch, {
    braveSearch,
    searxngSearch,
  });
}
