import type { SearchBackend, SearchConfig } from '../../../config.js';
import type { ProviderGovernance } from '../contracts.js';
import {
  AdapterCapabilitySchema,
  ADAPTER_CAPABILITY_CONTRACT_VERSION,
} from '../adapterCapability.js';
import type { AdapterCapability } from '../adapterCapability.js';

import { braveSearch } from '../../../tools/braveSearch.js';
import { searxngSearch } from '../../../tools/searxngSearch.js';
import { exaSearch } from '../../../tools/exaSearch.js';
import { duckduckgoSearch } from '../../../tools/duckduckgoSearch.js';
import { ollamaSearch } from '../../../tools/ollamaSearch.js';
import { tavilySearch } from '../../../tools/tavilySearch.js';
import { codexSearch } from '../../../tools/codexSearch.js';
import type { SearchResult } from '../../../types.js';

export type IndexedSafeSearch = 'strict' | 'moderate' | 'off';
export type IndexedSummaryMode = 'no' | 'yes' | 'only';

export interface IndexedProviderPort {
  readonly backend: SearchBackend;
  readonly adapterId: string;
  readonly providerId: string;
  readonly governance: ProviderGovernance;
  readonly maxDurationMs: number;
  search(
    input: Readonly<{
      query: string;
      limit: number;
      safeSearch: IndexedSafeSearch;
      aiSummary: IndexedSummaryMode;
    }>,
  ): Promise<readonly SearchResult[]>;
}

export interface IndexedProviderDefinition {
  readonly backend: SearchBackend;
  readonly adapterId: string;
  readonly providerId: string;
  readonly governance: ProviderGovernance;
  readonly maxDurationMs: number;
}

function gov(
  _backend: SearchBackend,
  providerId: string,
  summary: boolean,
  strict: boolean,
  attempts: number,
): ProviderGovernance {
  return {
    schemaVersion: '1.0.0',
    providerId,
    sourcePolicyId: providerId,
    mode: 'automatedSearch',
    queryHandling: 'raw',
    resultRetention: 'bounded_cache',
    sendsQueryOffDevice: true,
    supportsUrlAttributedSummary: summary,
    supportsStrictSafeSearch: strict,
    maxResultsPerRequest: 20,
    maxAttempts: attempts,
    evidenceRefs: [],
  };
}

export const INDEXED_PROVIDER_DEFINITIONS: readonly IndexedProviderDefinition[] = [
  {
    backend: 'brave',
    adapterId: 'indexed-provider:brave',
    providerId: 'search-provider:brave',
    governance: gov('brave', 'search-provider:brave', false, true, 3),
    maxDurationMs: 70000,
  },
  {
    backend: 'searxng',
    adapterId: 'indexed-provider:searxng',
    providerId: 'search-provider:searxng',
    governance: gov('searxng', 'search-provider:searxng', false, true, 2),
    maxDurationMs: 70000,
  },
  {
    backend: 'exa',
    adapterId: 'indexed-provider:exa',
    providerId: 'search-provider:exa',
    governance: gov('exa', 'search-provider:exa', true, true, 3),
    maxDurationMs: 70000,
  },
  {
    backend: 'duckduckgo',
    adapterId: 'indexed-provider:duckduckgo',
    providerId: 'search-provider:duckduckgo',
    governance: gov('duckduckgo', 'search-provider:duckduckgo', false, true, 2),
    maxDurationMs: 70000,
  },
  {
    backend: 'ollama-search',
    adapterId: 'indexed-provider:ollama-search',
    providerId: 'search-provider:ollama-search',
    governance: gov('ollama-search', 'search-provider:ollama-search', false, false, 2),
    maxDurationMs: 70000,
  },
  {
    backend: 'tavily',
    adapterId: 'indexed-provider:tavily',
    providerId: 'search-provider:tavily',
    governance: gov('tavily', 'search-provider:tavily', true, false, 3),
    maxDurationMs: 70000,
  },
  {
    backend: 'codex',
    adapterId: 'indexed-provider:codex',
    providerId: 'search-provider:codex',
    governance: gov('codex', 'search-provider:codex', false, false, 3),
    maxDurationMs: 70000,
  },
] as const;

export function createDefaultIndexedProviderPorts(
  config: SearchConfig,
): readonly IndexedProviderPort[] {
  return INDEXED_PROVIDER_DEFINITIONS.map((def) => {
    const search = async (
      input: Readonly<{
        query: string;
        limit: number;
        safeSearch: IndexedSafeSearch;
        aiSummary: IndexedSummaryMode;
      }>,
    ): Promise<readonly SearchResult[]> => {
      const clampedLimit = Math.min(input.limit, 20);
      switch (def.backend) {
        case 'brave':
          return braveSearch(
            input.query,
            config.brave.apiKey ?? '',
            clampedLimit,
            input.safeSearch,
          );
        case 'searxng':
          return searxngSearch(input.query, config.searxng.baseUrl, clampedLimit, input.safeSearch);
        case 'exa':
          return exaSearch(
            input.query,
            config.exa.apiKey ?? '',
            clampedLimit,
            input.safeSearch,
            input.aiSummary,
          );
        case 'duckduckgo':
          return duckduckgoSearch(input.query, clampedLimit, input.safeSearch, {
            region: config.duckduckgo.region,
            safeSearch: input.safeSearch,
          });
        case 'ollama-search': {
          const cfg: { baseUrl: string; apiKey?: string } = {
            baseUrl: config.ollamaSearch.baseUrl,
          };
          if (config.ollamaSearch.apiKey) cfg.apiKey = config.ollamaSearch.apiKey;
          return ollamaSearch(input.query, clampedLimit, input.safeSearch, cfg);
        }
        case 'tavily':
          return tavilySearch(
            input.query,
            config.tavily.apiKey ?? '',
            clampedLimit,
            input.safeSearch,
            input.aiSummary,
          );
        case 'codex':
          return codexSearch(input.query, clampedLimit);
        default:
          return [];
      }
    };
    return {
      backend: def.backend,
      adapterId: def.adapterId,
      providerId: def.providerId,
      governance: def.governance,
      maxDurationMs: def.maxDurationMs,
      search,
    };
  });
}

export function indexedProviderCapabilities(
  ports: readonly IndexedProviderPort[],
): readonly AdapterCapability[] {
  const caps = ports.map((p) =>
    AdapterCapabilitySchema.parse({
      schemaVersion: ADAPTER_CAPABILITY_CONTRACT_VERSION,
      adapterId: p.adapterId,
      adapterVersion: '1.0.0',
      edges: [{ operation: 'automatedSearch', route: 'indexed', targetKind: 'discovery_provider' }],
    }),
  );
  return Object.freeze(caps);
}
