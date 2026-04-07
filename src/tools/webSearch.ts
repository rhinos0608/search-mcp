import { logger } from '../logger.js';
import { loadConfig, type SearchBackend } from '../config.js';
import { braveSearch } from './braveSearch.js';
import { searxngSearch } from './searxngSearch.js';
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
): Promise<SearchResult[]> {
  const cfg = loadConfig();
  switch (backend) {
    case 'brave':
      return braveSearch(query, cfg.brave.apiKey, limit, safeSearch);
    case 'searxng':
      return searxngSearch(query, cfg.searxng.baseUrl, limit, safeSearch);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function webSearch(
  query: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
): Promise<SearchResult[]> {
  const cfg = loadConfig();
  const primary = cfg.searchBackend;

  // Build ordered list: primary first, then remaining fallbacks
  const backends = [primary, ...FALLBACK_ORDER.filter((b) => b !== primary)];
  const errors: string[] = [];

  for (const backend of backends) {
    if (!backendAvailable(backend)) {
      logger.debug({ backend }, 'Skipping unavailable backend');
      continue;
    }

    try {
      return await runBackend(backend, query, limit, safeSearch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ backend, err: msg }, 'Search backend failed, trying next');
      errors.push(`${backend}: ${msg}`);
    }
  }

  throw new Error(
    `All search backends failed. Ensure at least one backend is configured (BRAVE_API_KEY or SEARXNG_BASE_URL).\n${errors.join('\n')}`,
  );
}
