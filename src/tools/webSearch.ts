import { logger } from '../logger.js';
import { loadConfig, type SearchBackend } from '../config.js';
import { braveSearch } from './braveSearch.js';
import { searxngSearch } from './searxngSearch.js';
import { exaSearch } from './exaSearch.js';
import { normalizeUrl, rrfMerge } from '../utils/fusion.js';
import { multiSignalRescore, extractWebSearchSignals } from '../utils/rescore.js';
import { expandQuery, type QueryVariation } from './queryExpansion.js';
import { mergeSearchResults } from '../utils/searchMerge.js';
import { isDegraded, recordOutcome } from '../utils/backendHealth.js';
import { isCircuitTripped, recordChallenge } from '../utils/botChallenge.js';
import { isToolError } from '../errors.js';
import type { SearchResult } from '../types.js';

// ── Fallback order ───────────────────────────────────────────────────────────

/** Backend priority when the primary fails.
 *
 * Zero-key providers first (cheapest path), then key-backed providers.
 */
const FALLBACK_ORDER: SearchBackend[] = ['duckduckgo', 'searxng', 'brave', 'exa', 'ollama-search'];

function backendAvailable(backend: SearchBackend): boolean {
  const cfg = loadConfig();

  // Check circuit breaker first
  if (isCircuitTripped(backend)) {
    logger.debug({ backend }, 'Skipping circuit-tripped backend');
    return false;
  }

  // Check health tracker — skip degraded backends unless they're the only option
  if (isDegraded(backend)) {
    logger.debug({ backend }, 'Skipping degraded backend');
    return false;
  }

  switch (backend) {
    case 'brave':
      return (cfg.brave.apiKey ?? '').length > 0;
    case 'searxng':
      return cfg.searxng.baseUrl.length > 0;
    case 'exa':
      return (cfg.exa.apiKey ?? '').length > 0;
    case 'duckduckgo':
      // Zero-key backend — always available unless circuit-tripped or degraded (checked above)
      return true;
    case 'ollama-search':
      return cfg.ollamaSearch.baseUrl.length > 0;
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
  try {
    let results: SearchResult[];
    switch (backend) {
      case 'brave':
        results = await deps.braveSearch(query, cfg.brave.apiKey ?? '', limit, safeSearch);
        break;
      case 'searxng':
        results = await deps.searxngSearch(query, cfg.searxng.baseUrl, limit, safeSearch);
        break;
      case 'exa':
        results = await deps.exaSearch(query, cfg.exa.apiKey ?? '', limit, safeSearch);
        break;
      case 'duckduckgo': {
        const { duckduckgoSearch } = await import('./duckduckgoSearch.js');
        results = await duckduckgoSearch(query, limit, safeSearch, cfg.duckduckgo);
        break;
      }
      case 'ollama-search': {
        const { ollamaSearch } = await import('./ollamaSearch.js');
        results = await ollamaSearch(query, limit, safeSearch, cfg.ollamaSearch);
        break;
      }
      default:
        throw new Error(`Unhandled search backend: ${backend as string}`);
    }
    // Record success outcome
    recordOutcome(backend, 'success');
    return results;
  } catch (err: unknown) {
    // Classify the error and record the appropriate outcome
    let isTimeout = false;
    let isChallenge = false;

    if (isToolError(err)) {
      isTimeout = err.code === 'TIMEOUT';
      isChallenge =
        err.code === 'RATE_LIMIT' ||
        (err.code === 'UNAVAILABLE' && err.statusCode === 403) ||
        (err.code === 'UNAVAILABLE' && err.statusCode === 429);
    } else {
      // Fallback: string matching for non-ToolError exceptions (network errors, etc.)
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      isTimeout = msg.includes('timeout') || msg.includes('abort');
      isChallenge =
        msg.includes('challenge') ||
        msg.includes('captcha') ||
        (msg.includes('403') && !msg.includes('[403]'));
    }

    if (isChallenge) {
      recordOutcome(backend, 'bot_challenge');
      recordChallenge(backend);
    } else if (isTimeout) {
      recordOutcome(backend, 'timeout');
    } else {
      recordOutcome(backend, 'error');
    }

    throw err;
  }
}

// ── Dependency injection ─────────────────────────────────────────────────────

export interface WebSearchDeps {
  braveSearch: typeof import('./braveSearch.js').braveSearch;
  searxngSearch: typeof import('./searxngSearch.js').searxngSearch;
  exaSearch: typeof import('./exaSearch.js').exaSearch;
}

// ── Core search with fusion ──────────────────────────────────────────────────

export async function searchWithBackends(
  query: string,
  limit: number,
  safeSearch: 'strict' | 'moderate' | 'off',
  deps: WebSearchDeps,
  overrideBackends?: SearchBackend[],
  expandQueryOpt?: boolean,
  mergeBackends?: boolean,
): Promise<SearchResult[]> {
  const cfg = loadConfig();

  // ── Query expansion ──────────────────────────────────────────────────
  const queries: QueryVariation[] =
    expandQueryOpt === true ? expandQuery(query) : [{ query, strategy: 'original' as const }];

  if (queries.length > 1) {
    logger.info(
      { original: query, count: queries.length },
      'searchWithBackends: query expansion enabled',
    );
  }

  const primary = cfg.searchBackend;

  const backends = overrideBackends ?? [primary, ...FALLBACK_ORDER.filter((b) => b !== primary)];

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

  const useMerge = mergeBackends === true && available.length > 1;

  // Run each query variation across all backends, collecting per-query results
  const queryPromises = queries.map(async (qv) => {
    const promises = available.map(async (backend) => {
      try {
        const results = await runBackend(backend, qv.query, limit, safeSearch, deps);
        return { backend, results, strategy: qv.strategy };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ backend, err: msg, strategy: qv.strategy }, 'Search backend failed');
        throw err;
      }
    });

    const settled = await Promise.allSettled(promises);
    const validResults = new Map<string, SearchResult[]>();

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        validResults.set(s.value.backend, s.value.results);
      }
    }

    if (validResults.size === 0) {
      errors.push(`query "${qv.query}": all backends failed`);
      return { results: [], strategy: qv.strategy };
    }

    if (useMerge) {
      const merged = mergeSearchResults(validResults, limit);
      return { results: merged, strategy: qv.strategy };
    }

    const merged = rrfMerge(Array.from(validResults.values()), {
      k: 60,
      keyFn: (r) => normalizeUrl(r.url),
    });

    return { results: merged, strategy: qv.strategy };
  });

  const queryResults = await Promise.all(queryPromises);

  // Deduplicate across query variations by normalized URL, keeping longest snippet and best rrfScore
  const seen = new Map<string, { item: SearchResult; rrfScore: number }>();
  for (const { results } of queryResults) {
    for (const result of results) {
      // results might be wrapped { item, rrfScore } from rrfMerge or bare from mergeSearchResults
      const item: SearchResult =
        'item' in (result as unknown as Record<string, unknown>)
          ? (result as { item: SearchResult }).item
          : (result as SearchResult);
      const rrfScore: number =
        'rrfScore' in (result as unknown as Record<string, unknown>)
          ? (result as { rrfScore: number }).rrfScore
          : 0.5;
      const key = normalizeUrl(item.url);
      const existing = seen.get(key);
      if (existing === undefined || item.description.length > existing.item.description.length) {
        seen.set(key, { item, rrfScore });
      }
    }
  }

  const seenEntries = Array.from(seen.values());
  const allItems = seenEntries.map((e) => e.item);
  if (allItems.length === 0) {
    throw new Error(
      `All search backends failed across all query variations. Ensure at least one backend is configured (DuckDuckGo is zero-key and always available; EXA_API_KEY, BRAVE_API_KEY, or SEARXNG_BASE_URL for key-backed backends).\n${errors.join('\n')}`,
    );
  }

  const allSignals = extractWebSearchSignals(allItems);

  const signaled = seenEntries.map(({ item, rrfScore }, i) => ({
    item,
    rrfScore,
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
  expandQueryOpt = false,
  mergeBackends = false,
): Promise<SearchResult[]> {
  return searchWithBackends(
    query,
    limit,
    safeSearch,
    {
      braveSearch,
      searxngSearch,
      exaSearch,
    },
    undefined,
    expandQueryOpt,
    mergeBackends,
  );
}
