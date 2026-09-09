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
import { codexSearch, codexConfigured } from '../../../tools/codexSearch.js';
import type { SearchResult } from '../../../types.js';
import { assertSafeUrl, safeResponseJson } from '../../../httpGuards.js';
import { retryWithBackoff } from '../../../retry.js';
import { ToolError, unavailableError } from '../../../errors.js';
import { strArray, strField } from '../../../tools/providerFields.js';

export type IndexedSafeSearch = 'strict' | 'moderate' | 'off';
export type IndexedSummaryMode = 'no' | 'yes' | 'only';

export interface IndexedUrlEnrichment {
  readonly url: string;
  readonly generatedSummary?: string;
  readonly generatedSummaryProvider?: string;
}

export interface IndexedProviderPort {
  readonly backend: SearchBackend;
  readonly adapterId: string;
  readonly providerId: string;
  readonly governance: ProviderGovernance;
  readonly maxDurationMs: number;
  /**
   * Worst-case aggregate wall clock for one search invocation: up to
   * governance.maxAttempts attempts, each consuming the per-attempt fetch
   * timeout, plus worst-case retry backoff. Must stay within slice budgets
   * checked by runIndexedProvider.
   */
  readonly searchTimeoutMs?: number;
  search(
    input: Readonly<{
      query: string;
      limit: number;
      safeSearch: IndexedSafeSearch;
      aiSummary: IndexedSummaryMode;
      includeDomains?: readonly string[];
    }>,
  ): Promise<readonly SearchResult[]>;
  enrichUrls?(
    input: Readonly<{
      urls: readonly string[];
      mode: 'summary';
      query?: string;
    }>,
  ): Promise<readonly IndexedUrlEnrichment[]>;
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
  maxResultsPerRequest = 20,
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
    maxResultsPerRequest,
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
    governance: gov('exa', 'search-provider:exa', true, true, 3, 50),
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

export function indexedProviderConfigured(
  config: SearchConfig,
  backend: SearchBackend,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (backend) {
    case 'brave':
      return (config.brave.apiKey ?? '').length > 0;
    case 'searxng':
      return config.searxng.baseUrl.length > 0;
    case 'exa':
      return (config.exa.apiKey ?? '').length > 0;
    case 'duckduckgo':
      return true;
    case 'ollama-search':
      return config.ollamaSearch.baseUrl.length > 0;
    case 'tavily':
      return (config.tavily.apiKey ?? '').length > 0;
    case 'codex':
      return codexConfigured(env);
  }
}

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const EXA_CONTENTS_URL = 'https://api.exa.ai/contents';
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';

function capText(text: string): string {
  return text.length > 8192 ? text.slice(0, 8192) : text;
}

// Per-attempt fetch timeout used by the provider implementations below
// (AbortSignal.timeout(20_000)).
const PROVIDER_ATTEMPT_TIMEOUT_MS = 20_000;
// retryWithBackoff defaults: full jitter over initial 200ms, factor 2, cap 5s.
const RETRY_INITIAL_DELAY_MS = 200;
const RETRY_MAX_DELAY_MS = 5_000;

/**
 * Worst-case aggregate duration of one provider search: every attempt may burn
 * the full per-attempt fetch timeout, and full-jitter exponential backoff can
 * add up to initial * (2^(attempts-1) - 1) ms between attempts. Capped at
 * maxDurationMs so it stays aligned with slice budgets and the runIndexedProvider
 * BUDGET_EXHAUSTED check / duration report.
 */
export function aggregateSearchTimeoutMs(maxAttempts: number, maxDurationMs: number): number {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  let backoff = 0;
  for (let i = 1; i < attempts; i++) {
    backoff += Math.min(RETRY_INITIAL_DELAY_MS * 2 ** (i - 1), RETRY_MAX_DELAY_MS);
  }
  return Math.min(PROVIDER_ATTEMPT_TIMEOUT_MS * attempts + backoff, maxDurationMs);
}

const EXA_HIGHLIGHTS_MAX_CHARACTERS = 2560;

function truncateExaSnippet(text: string, max: number): string {
  if (text.length <= max) return text;
  const budget = max - 1;
  let head = text.slice(0, budget);
  const space = head.lastIndexOf(' ');
  if (space > 0) head = head.slice(0, space);
  return `${head}…`;
}

function exaSnippetFromRecord(record: Record<string, unknown>): string {
  const highlights = strArray(record.highlights);
  if (highlights.length > 0) return highlights.join('\n\n');
  return truncateExaSnippet(strField(record.text), EXA_HIGHLIGHTS_MAX_CHARACTERS);
}

async function exaSearchWithDomains(
  query: string,
  apiKey: string,
  limit: number,
  safeSearch: IndexedSafeSearch,
  includeDomains: readonly string[],
): Promise<readonly SearchResult[]> {
  if (apiKey.length === 0) {
    throw unavailableError('Exa search is not configured. Set EXA_API_KEY.', { backend: 'exa' });
  }
  assertSafeUrl(EXA_SEARCH_URL);
  const body = {
    query,
    numResults: limit,
    type: 'auto',
    includeDomains: [...includeDomains],
    ...(safeSearch === 'strict' ? { moderation: true } : {}),
    contents: { highlights: { maxCharacters: EXA_HIGHLIGHTS_MAX_CHARACTERS } },
  };
  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(EXA_SEARCH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        throw new ToolError('Exa Search API rate limit exceeded (429)', {
          code: 'RATE_LIMIT',
          retryable: false,
          statusCode: 429,
          backend: 'exa',
        });
      }
      if (!res.ok) {
        throw unavailableError(`Exa Search API returned ${String(res.status)}: ${res.statusText}`, {
          statusCode: res.status,
          backend: 'exa',
        });
      }
      return res;
    },
    { label: 'exa-search-domains', maxAttempts: 3 },
  );
  const data = (await safeResponseJson(response, EXA_SEARCH_URL)) as { results?: unknown };
  const mapped: SearchResult[] = [];
  if (Array.isArray(data.results)) {
    for (const result of data.results) {
      if (mapped.length >= limit) break;
      if (typeof result !== 'object' || result === null) continue;
      const record = result as Record<string, unknown>;
      const url = strField(record.url);
      mapped.push({
        title: strField(record.title),
        url,
        description: exaSnippetFromRecord(record),
        position: mapped.length + 1,
        domain: '',
        source: 'exa',
        age: null,
        ageKind: 'unknown',
        extraSnippet: null,
        deepLinks: null,
        contentKind: 'snippet',
        generatedSummary: null,
      });
    }
  }
  return mapped;
}

async function tavilySearchWithDomains(
  query: string,
  apiKey: string,
  limit: number,
  safeSearch: IndexedSafeSearch,
  includeDomains: readonly string[],
): Promise<readonly SearchResult[]> {
  if (apiKey.length === 0) {
    throw unavailableError('Tavily search is not configured. Set TAVILY_API_KEY.', {
      backend: 'tavily',
    });
  }
  assertSafeUrl(TAVILY_SEARCH_URL);
  const body = {
    query,
    max_results: Math.min(limit, 20),
    search_depth: 'basic',
    chunks_per_source: 3,
    include_answer: false,
    include_images: false,
    include_domains: [...includeDomains],
    topic: safeSearch === 'strict' ? 'news' : 'general',
  };
  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(TAVILY_SEARCH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        throw new ToolError('Tavily Search API rate limit exceeded (429)', {
          code: 'RATE_LIMIT',
          retryable: false,
          statusCode: 429,
          backend: 'tavily',
        });
      }
      if (!res.ok) {
        throw unavailableError(
          `Tavily Search API returned ${String(res.status)}: ${res.statusText}`,
          { statusCode: res.status, backend: 'tavily' },
        );
      }
      return res;
    },
    { label: 'tavily-search-domains', maxAttempts: 3 },
  );
  const data = (await safeResponseJson(response, TAVILY_SEARCH_URL)) as { results?: unknown };
  const mapped: SearchResult[] = [];
  if (Array.isArray(data.results)) {
    for (const result of data.results) {
      if (mapped.length >= limit) break;
      if (typeof result !== 'object' || result === null) continue;
      const record = result as Record<string, unknown>;
      const url = strField(record.url);
      mapped.push({
        title: strField(record.title),
        url,
        description: strField(record.content),
        position: mapped.length + 1,
        domain: '',
        source: 'tavily',
        age: null,
        ageKind: 'unknown',
        extraSnippet: null,
        deepLinks: null,
        contentKind: 'snippet',
        generatedSummary: null,
      });
    }
  }
  return mapped;
}

async function exaEnrichUrls(
  apiKey: string,
  urls: readonly string[],
): Promise<readonly IndexedUrlEnrichment[]> {
  const capped = urls.slice(0, 10);
  for (const url of capped) assertSafeUrl(url);
  assertSafeUrl(EXA_CONTENTS_URL);
  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(EXA_CONTENTS_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          urls: [...capped],
          text: false,
          highlights: false,
          summary: true,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        throw unavailableError(`Exa contents API returned ${String(res.status)}`, {
          statusCode: res.status,
          backend: 'exa',
        });
      }
      return res;
    },
    { label: 'exa-contents', maxAttempts: 2 },
  );
  const data = (await safeResponseJson(response, EXA_CONTENTS_URL)) as { results?: unknown };
  const out: IndexedUrlEnrichment[] = [];
  if (!Array.isArray(data.results)) return out;
  for (const result of data.results) {
    if (typeof result !== 'object' || result === null) continue;
    const record = result as Record<string, unknown>;
    const url = strField(record.url);
    const summary = strField(record.summary).trim();
    if (url.length === 0) continue;
    const item: { url: string; generatedSummary?: string; generatedSummaryProvider?: string } = {
      url,
    };
    if (summary.length > 0) {
      item.generatedSummary = capText(summary);
      item.generatedSummaryProvider = 'exa';
    }
    out.push(item);
  }
  return out;
}

async function tavilyEnrichUrls(
  apiKey: string,
  urls: readonly string[],
  query: string,
): Promise<readonly IndexedUrlEnrichment[]> {
  const capped = urls.slice(0, 10);
  for (const url of capped) assertSafeUrl(url);
  assertSafeUrl(TAVILY_EXTRACT_URL);
  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(TAVILY_EXTRACT_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          urls: [...capped],
          query,
          chunks_per_source: 3,
          extract_depth: 'basic',
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        throw unavailableError(`Tavily extract API returned ${String(res.status)}`, {
          statusCode: res.status,
          backend: 'tavily',
        });
      }
      return res;
    },
    { label: 'tavily-extract', maxAttempts: 2 },
  );
  const data = (await safeResponseJson(response, TAVILY_EXTRACT_URL)) as { results?: unknown };
  const out: IndexedUrlEnrichment[] = [];
  if (!Array.isArray(data.results)) return out;
  for (const result of data.results) {
    if (typeof result !== 'object' || result === null) continue;
    const record = result as Record<string, unknown>;
    const url = strField(record.url);
    const raw = strField(record.raw_content).trim();
    if (url.length === 0) continue;
    const item: { url: string; generatedSummary?: string; generatedSummaryProvider?: string } = {
      url,
    };
    if (raw.length > 0) {
      item.generatedSummary = capText(raw);
      item.generatedSummaryProvider = 'tavily';
    }
    out.push(item);
  }
  return out;
}

export function createDefaultIndexedProviderPorts(
  config: SearchConfig,
  env: NodeJS.ProcessEnv = process.env,
): readonly IndexedProviderPort[] {
  return INDEXED_PROVIDER_DEFINITIONS.filter((def) =>
    indexedProviderConfigured(config, def.backend, env),
  ).map((def) => {
    const search = async (
      input: Readonly<{
        query: string;
        limit: number;
        safeSearch: IndexedSafeSearch;
        aiSummary: IndexedSummaryMode;
        includeDomains?: readonly string[];
      }>,
    ): Promise<readonly SearchResult[]> => {
      const clampedLimit = Math.min(input.limit, def.governance.maxResultsPerRequest);
      const domains = input.includeDomains;
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
          if (domains !== undefined && domains.length > 0) {
            return exaSearchWithDomains(
              input.query,
              config.exa.apiKey ?? '',
              clampedLimit,
              input.safeSearch,
              domains,
            );
          }
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
          if (domains !== undefined && domains.length > 0) {
            return tavilySearchWithDomains(
              input.query,
              config.tavily.apiKey ?? '',
              clampedLimit,
              input.safeSearch,
              domains,
            );
          }
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
    const port: IndexedProviderPort = {
      backend: def.backend,
      adapterId: def.adapterId,
      providerId: def.providerId,
      governance: def.governance,
      maxDurationMs: def.maxDurationMs,
      searchTimeoutMs: aggregateSearchTimeoutMs(def.governance.maxAttempts, def.maxDurationMs),
      search,
    };
    if (def.backend === 'exa') {
      return {
        ...port,
        enrichUrls: async (input) => exaEnrichUrls(config.exa.apiKey ?? '', input.urls),
      };
    }
    if (def.backend === 'tavily') {
      return {
        ...port,
        enrichUrls: async (input) =>
          tavilyEnrichUrls(
            config.tavily.apiKey ?? '',
            input.urls,
            input.query !== undefined && input.query.length > 0 ? input.query : 'job listing',
          ),
      };
    }
    return port;
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
