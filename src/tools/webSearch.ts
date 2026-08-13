import { logger } from '../logger.js';
import { loadConfig, type SearchBackend, type SearchConfig } from '../config.js';
import { braveSearch } from './braveSearch.js';
import { searxngSearch } from './searxngSearch.js';
import { exaSearch } from './exaSearch.js';
import { tavilySearch } from './tavilySearch.js';
import { rrfMerge, type RrfMergeResult } from '../utils/fusion.js';
import {
  multiSignalRescore,
  extractWebSearchSignals,
  applyExplicitYearIntentOrder,
  type ScoredResult,
} from '../utils/rescore.js';
import { expandQuery, type QueryVariation } from './queryExpansion.js';
import {
  mergeSearchResults,
  getResultDomain,
  normalizeUrlForDedup,
  preservePublishedAge,
  unionUpstreamEngines,
} from '../utils/searchMerge.js';
import { isDegraded, recordOutcome } from '../utils/backendHealth.js';
import { isCircuitTripped, recordChallenge } from '../utils/botChallenge.js';
import { isToolError, validationError } from '../errors.js';
import { codexConfigured, codexSearch } from './codexSearch.js';
import type { SearchResult } from '../types.js';
import { getCategoryProfile } from '../utils/searchCategories.js';
import { semanticMatch } from '../utils/semanticMatch.js';
import {
  contentKindRank,
  contentLength,
  richerThan,
  contentRichnessEqual,
  isCodexProduced,
  hasMinimumContent,
} from '../utils/searchRichness.js';
import { getDomainAuthority, getSourceBasis, getSourceQuality } from '../utils/sourceTier.js';
import { isNavigationOnlySearchResult } from './webSearchResultFormatter.js';

// ── Fallback order ───────────────────────────────────────────────────────────

/**
 * Native AI-summary mode for web search.
 * - `no`:   generated summaries disabled (default); full results as usual.
 * - `yes`:  normal all-provider fanout; provider-generated summaries that are
 *           URL-attributable per result (currently Exa) are included under a
 *           `### AI summary` label without hiding full content. Tavily returns
 *           only a query-level answer with no per-URL grounding, so it never
 *           contributes to `yes` (its `include_answer` is not requested/mapped).
 * - `only`: fanout restricted to configured native-summary providers
 *           (Exa/Tavily); result content is summary-only. Tavily `only` uses its
 *           per-result ultra-fast NLP summary.
 */
export type AiSummaryMode = 'no' | 'yes' | 'only';

/**
 * Scores within this delta of each other are treated as equal for the bounded
 * Codex preference: Codex is only used as a tiebreak on (near-)equal ranking
 * scores, never to jump a materially lower-scored result above a fallback.
 */
const SCORE_EPSILON = 1e-6;

/** Fallback preference after Codex in all-provider fanout.
 *
 * Zero-key providers first, then key-backed providers.
 */
export const FALLBACK_ORDER: SearchBackend[] = [
  'duckduckgo',
  'searxng',
  'brave',
  'exa',
  'tavily',
  'ollama-search',
];

/**
 * Backends with verified strict safe-search support.
 *
 * `safeSearch="strict"` fanout is restricted to this set, and never silently
 * downgraded to unfiltered results:
 * - DuckDuckGo (`kp=1`), SearXNG (`safesearch=2`), Brave (`safeSearch=strict`)
 *   have real strict parameters.
 * - Exa has documented `moderation` filtering; strict maps to `moderation: true`.
 *
 * Excluded: Tavily (strict maps to a news-topic workaround, no real filter),
 * Codex (undocumented endpoint, no filter parameter), and Ollama experimental
 * search (body carries no safety field).
 */
export const STRICT_SAFE_BACKENDS: ReadonlySet<SearchBackend> = new Set([
  'duckduckgo',
  'searxng',
  'brave',
  'exa',
]);

// Dedup/ranking helpers below; `isCodexProduced` and richness helpers are
// imported from '../utils/searchRichness.js'.

/**
 * Pure backend-ordering decision shared by web search and health probes.
 *
 * - Explicit override: used verbatim (tests / callers take full control).
 * - Runtime selection includes every provider candidate; availability
 *   filtering later removes unconfigured, circuit-tripped, or degraded ones.
 * - Codex is prepended first when credentials are available (including when
 *   SEARCH_BACKEND is set); when unavailable and not the configured primary it
 *   is omitted. SEARCH_BACKEND only establishes fallback order.
 * - Explicit overrides remain verbatim for internal callers and tests.
 */
export function resolveBackends(
  cfg: SearchConfig,
  overrideBackends: SearchBackend[] | undefined,
  codexAvailable: boolean,
): SearchBackend[] {
  if (overrideBackends) {
    return overrideBackends;
  }
  const preferredOrder = [
    cfg.searchBackend,
    ...FALLBACK_ORDER.filter((backend) => backend !== cfg.searchBackend),
  ];
  if (!codexAvailable) {
    return preferredOrder;
  }
  return ['codex', ...preferredOrder.filter((backend) => backend !== 'codex')];
}

/**
 * Merge two entries for the same normalized URL after cross-query dedup.
 * Content truth: the richer clean representation (full > summary > snippet,
 * then length) wins and `source` stays the provider of the chosen content.
 * `engines` unions all discoverers, so Codex provenance is retained in the
 * engine list even when a richer fallback representation is chosen.
 */
function mergeDedupProvenance(prev: SearchResult, winner: SearchResult): SearchResult {
  const engines = new Set<string>();
  for (const e of prev.engines ?? []) engines.add(e);
  for (const e of winner.engines ?? []) engines.add(e);
  engines.add(prev.source);
  engines.add(winner.source);
  const chosen = richerThan(winner, prev) ? winner : prev;
  const other = chosen === winner ? prev : winner;
  // Preserve a provider generated summary when the chosen (richer) duplicate
  // lacks one: the richer representation's content wins, but an Exa summary is
  // URL-attributable and must survive the same-URL merge.
  const chosenHasSummary =
    typeof chosen.generatedSummary === 'string' && chosen.generatedSummary.length > 0;
  const otherSummary = other.generatedSummary ?? null;
  const retainedSummary =
    chosenHasSummary || !otherSummary ? chosen.generatedSummary : otherSummary;
  const retainedProvider =
    chosenHasSummary || !otherSummary
      ? chosen.generatedSummaryProvider
      : other.generatedSummaryProvider;
  const base: SearchResult = {
    ...chosen,
    generatedSummary: retainedSummary,
    generatedSummaryProvider: retainedProvider,
    engines: [...engines],
  };
  // Union SearXNG upstream engine names across the same-URL duplicates so they
  // survive cross-query dedup even when a non-SearXNG richer donor wins.
  const upstream = unionUpstreamEngines([prev, winner]);
  const withUpstream = upstream === undefined ? base : { ...base, upstreamEngines: upstream };
  // Preserve one publication date from the duplicate when the richer winner
  // lacks one (never overrides conflicting published values, never fetches).
  const { age, ageKind } = preservePublishedAge(withUpstream, other);
  return age === withUpstream.age && ageKind === withUpstream.ageKind
    ? withUpstream
    : { ...withUpstream, age, ageKind };
}

/**
 * rrfMerge keeps the last ranking's metadata when the same normalized URL
 * appears in multiple rankings, which drops the richer representation and the
 * provenance of earlier rankings. For each merged URL we pick the richest clean
 * representation across all rankings (source = its provider), union engines,
 * and re-stamp the merged entry. RRF ordering is left untouched; single-source
 * URLs keep their legacy shape (no engines field added) when nothing changed.
 */
export function restoreRrfProvenance(
  merged: RrfMergeResult<SearchResult>[],
  rankings: SearchResult[][],
): RrfMergeResult<SearchResult>[] {
  const unionByUrl = new Map<
    string,
    {
      richest: SearchResult;
      engines: Set<string>;
      upstream: Set<string>;
      summary?: string;
      summaryProvider?: string;
      publishedAge?: { age: string; ageKind: 'published' };
    }
  >();
  for (const ranking of rankings) {
    for (const item of ranking) {
      const key = normalizeUrlForDedup(item.url);
      let entry = unionByUrl.get(key);
      if (entry === undefined) {
        entry = { richest: item, engines: new Set<string>(), upstream: new Set<string>() };
        unionByUrl.set(key, entry);
      }
      if (richerThan(item, entry.richest)) {
        entry.richest = item;
      }
      // Retain a URL-attributable generated summary from any same-URL item so a
      // richer representation that lacks a summary does not drop the provider one.
      if (typeof item.generatedSummary === 'string' && item.generatedSummary.length > 0) {
        entry.summary = item.generatedSummary;
        if (item.generatedSummaryProvider) entry.summaryProvider = item.generatedSummaryProvider;
      }
      // Retain one publication date so a richer winner lacking one still keeps a
      // published age/ageKind (never fetched/unknown, never conflicting).
      if (entry.publishedAge === undefined && item.ageKind === 'published') {
        if (typeof item.age === 'string' && item.age.length > 0) {
          entry.publishedAge = { age: item.age, ageKind: 'published' };
        }
      }
      entry.engines.add(item.source);
      for (const engine of item.engines ?? []) entry.engines.add(engine);
      const upstreamValues: unknown = item.upstreamEngines;
      if (Array.isArray(upstreamValues)) {
        for (const u of upstreamValues) {
          if (typeof u !== 'string') continue;
          const trimmed = u.trim();
          if (trimmed.length > 0) entry.upstream.add(trimmed);
        }
      }
    }
  }

  return merged.map((entry) => {
    const union = unionByUrl.get(normalizeUrlForDedup(entry.item.url));
    if (union === undefined) return entry;
    const winnerEngines = new Set(entry.item.engines ?? [entry.item.source]);
    const engines = [...union.engines];
    const enginesDiffer =
      engines.length !== winnerEngines.size || engines.some((e) => !winnerEngines.has(e));
    const upstream = union.upstream.size > 0 ? [...union.upstream].sort() : undefined;
    const richest = union.richest;
    const richestUpstream = [...(unionUpstreamEngines([richest]) ?? [])].sort((a, b) =>
      a.localeCompare(b),
    );
    const upstreamSame =
      (upstream === undefined && richestUpstream.length === 0) ||
      (upstream?.length === richestUpstream.length &&
        upstream.every((u, i) => u === richestUpstream[i]));
    // Compare the full richest record (content kind + description + extraSnippet
    // length), not just source+description: an extraSnippet that makes the
    // richest representation genuinely richer must re-stamp the merged entry.
    const contentSame = contentRichnessEqual(entry.item, richest);
    const richestPublished =
      richest.ageKind === 'published' && typeof richest.age === 'string' && richest.age.length > 0;
    const backfillAge = union.publishedAge !== undefined && !richestPublished;
    if (!enginesDiffer && contentSame && !backfillAge && upstreamSame) return entry;
    let age: string | null = richest.age;
    let ageKind: SearchResult['ageKind'] = richest.ageKind;
    if (backfillAge && union.publishedAge !== undefined) {
      age = union.publishedAge.age;
      ageKind = union.publishedAge.ageKind;
    }
    return {
      ...entry,
      item: {
        ...richest,
        position: entry.item.position,
        engines: enginesDiffer ? engines : (richest.engines ?? [richest.source]),
        ...(upstreamSame ? {} : { upstreamEngines: upstream }),
        generatedSummary: union.summary ?? richest.generatedSummary ?? null,
        generatedSummaryProvider: union.summaryProvider ?? richest.generatedSummaryProvider,
        age,
        ageKind,
      },
    };
  });
}

function backendAvailable(
  backend: SearchBackend,
  allCandidates: SearchBackend[] | undefined,
  cfg: SearchConfig,
): boolean {
  // Check circuit breaker first
  if (isCircuitTripped(backend)) {
    logger.debug({ backend }, 'Skipping circuit-tripped backend');
    return false;
  }

  // checkConfigured: internal helper to check if backend is configured
  const isConfigured = (b: SearchBackend): boolean => {
    switch (b) {
      case 'brave':
        return (cfg.brave.apiKey ?? '').length > 0;
      case 'searxng':
        return cfg.searxng.baseUrl.length > 0;
      case 'exa':
        return (cfg.exa.apiKey ?? '').length > 0;
      case 'tavily':
        return (cfg.tavily.apiKey ?? '').length > 0;
      case 'duckduckgo':
        return true;
      case 'ollama-search':
        return cfg.ollamaSearch.baseUrl.length > 0;
      case 'codex':
        // Credentials come from env/auth file, not SearchConfig.
        return codexConfigured(process.env);
      default:
        return false;
    }
  };

  if (!isConfigured(backend)) return false;

  // Check health tracker — skip degraded backends unless they're the only option
  if (isDegraded(backend)) {
    logger.debug({ backend }, 'Backend is degraded');

    // If we have any candidates, check if there's a non-degraded one
    if (allCandidates) {
      const hasHealthyAlternative = allCandidates.some(
        (b) => b !== backend && isConfigured(b) && !isCircuitTripped(b) && !isDegraded(b),
      );
      if (hasHealthyAlternative) {
        logger.debug({ backend }, 'Skipping degraded backend since healthy alternative exists');
        return false;
      }
      logger.debug({ backend }, 'Using degraded backend as last resort (no healthy alternatives)');
    } else {
      // Legacy behavior if no candidates passed
      return false;
    }
  }

  return true;
}

async function runBackend(
  backend: SearchBackend,
  query: string,
  limit: number,
  safeSearch: 'strict' | 'moderate' | 'off',
  deps: WebSearchDeps,
  cfg: SearchConfig,
  aiSummary: AiSummaryMode,
): Promise<SearchResult[]> {
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
        results = await deps.exaSearch(query, cfg.exa.apiKey ?? '', limit, safeSearch, aiSummary);
        break;
      case 'tavily':
        results = await deps.tavilySearch(
          query,
          cfg.tavily.apiKey ?? '',
          limit,
          safeSearch,
          aiSummary,
        );
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
      case 'codex':
        results = await (deps.codexSearch ?? codexSearch)(query, limit);
        break;
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

// ── Provenance tracking ─────────────────────────────────────────────────────

export interface ProvenanceResult {
  usedBackend: string;
  servedBackends: string[];
  usedFallback: boolean;
  fallbackReason?: string;
}

// ── Dependency injection ─────────────────────────────────────────────────────

export async function semanticRerankSearchResults(
  query: string,
  candidates: SearchResult[],
  cfg: SearchConfig,
  category?: string,
): Promise<SearchResult[]> {
  const ranked = await semanticMatch({
    query,
    candidates,
    getText: (result) => `${result.title}\n${result.description}`,
    embeddingBaseUrl: cfg.embeddingSidecar.baseUrl,
    ...(cfg.embeddingSidecar.apiToken ? { embeddingApiToken: cfg.embeddingSidecar.apiToken } : {}),
    embeddingDimensions: cfg.embeddingSidecar.dimensions,
    topK: candidates.length,
    // Web-search-specific credibility floor so a keyword-dense low-credibility
    // result is not promoted by cosine similarity alone. Falls back to the
    // URL hostname when `domain` is empty (e.g. some provider mappings).
    authorityFloor: (result) => getDomainAuthority(getResultDomain(result), category),
  });
  return ranked.map((entry) => entry.item);
}

/** Sidecar requires a URL; alternate providers are selected explicitly. */
export function semanticRerankConfigured(cfg: SearchConfig): boolean {
  return cfg.embeddingSidecar.provider !== 'sidecar' || cfg.embeddingSidecar.baseUrl.length > 0;
}

export interface WebSearchDeps {
  braveSearch: typeof import('./braveSearch.js').braveSearch;
  searxngSearch: typeof import('./searxngSearch.js').searxngSearch;
  exaSearch: typeof import('./exaSearch.js').exaSearch;
  tavilySearch: typeof import('./tavilySearch.js').tavilySearch;
  /** Optional — defaults to the real implementation when omitted. */
  codexSearch?: typeof import('./codexSearch.js').codexSearch;
  /** Optional — defaults to semanticMatch-based ranking when embedding is configured. */
  semanticRerank?: typeof semanticRerankSearchResults;
  /** Optional — hermetic config override; defaults to loadConfig() when omitted. */
  config?: SearchConfig;
  /**
   * Native AI-summary mode forwarded to Exa/Tavily. Optional — defaults to
   * `no` when omitted; internal callers are unaffected.
   */
  aiSummary?: AiSummaryMode;
}

// ── Core search with fusion ──────────────────────────────────────────────────

export async function searchWithBackends(
  query: string,
  limit: number,
  safeSearch: 'strict' | 'moderate' | 'off',
  deps: WebSearchDeps,
  overrideBackends?: SearchBackend[],
  expandQueryOpt = true,
  mergeBackends = true,
  provenanceResult?: { current: ProvenanceResult | null },
  category?: string,
  aiSummary?: AiSummaryMode,
  originalQuery?: string,
): Promise<SearchResult[]> {
  const cfg = deps.config ?? loadConfig();
  const summaryMode: AiSummaryMode = aiSummary ?? deps.aiSummary ?? 'no';

  // ── Query expansion ──────────────────────────────────────────────────
  const queries: QueryVariation[] = expandQueryOpt
    ? expandQuery(query)
    : [{ query: query, strategy: 'original' as const }];

  if (queries.length > 1) {
    logger.info({ count: queries.length }, 'searchWithBackends: query expansion enabled');
  }

  const primary = cfg.searchBackend;
  const backends = resolveBackends(cfg, overrideBackends, codexConfigured(process.env));

  // aiSummary="only" restricts fanout to configured native-summary providers
  // (Exa/Tavily), bypassing the normal all-provider scope per the approved
  // contract. Query expansion, dedup, and ranking still apply.
  const onlyModeScope: SearchBackend[] | undefined =
    summaryMode === 'only' ? ['exa', 'tavily'] : undefined;
  let scope: SearchBackend[] = onlyModeScope ?? backends;

  // strict safe-search: restrict fanout to providers with verified strict
  // support (Brave, SearXNG, DuckDuckGo, Exa-with-moderation). Tavily, Codex,
  // and Ollama search are excluded — they cannot enforce strict filtering.
  // This applies to runtime selection AND explicit overrides; never silently
  // downgrade strict to unfiltered results. When nothing supported remains,
  // fail with an actionable error instead of running unsafe backends.
  let strictFiltered = false;
  if (safeSearch === 'strict') {
    scope = scope.filter((b) => STRICT_SAFE_BACKENDS.has(b));
    strictFiltered = true;
    if (scope.length === 0) {
      throw validationError(
        'safeSearch="strict" requires at least one backend with verified strict safe-search support. Supported: DuckDuckGo (zero-key), SearXNG (SEARXNG_BASE_URL), Brave (BRAVE_API_KEY), Exa (EXA_API_KEY). Tavily, Codex, and Ollama search cannot enforce strict filtering and are excluded from strict fanout.',
        { backend: 'duckduckgo,searxng,brave,exa' },
      );
    }
  }

  const errors: string[] = [];

  let available: SearchBackend[];
  if (onlyModeScope !== undefined) {
    available = scope.filter((b) => backendAvailable(b, scope, cfg));
    if (available.length === 0) {
      throw validationError(
        safeSearch === 'strict'
          ? 'aiSummary="only" with safeSearch="strict" requires a configured Exa backend (EXA_API_KEY): Tavily ultra-fast search cannot enforce strict safe-search filtering and is excluded from strict fanout.'
          : 'aiSummary="only" requires a configured native-summary provider. Set EXA_API_KEY (Exa) or TAVILY_API_KEY (Tavily); neither is configured.',
        { backend: 'exa,tavily' },
      );
    }
  } else {
    available = overrideBackends
      ? strictFiltered
        ? scope
        : backends
      : scope.filter((b) => {
          if (!backendAvailable(b, scope, cfg)) {
            logger.debug({ backend: b }, 'Skipping unavailable backend');
            return false;
          }
          return true;
        });
  }

  const useMerge = mergeBackends && available.length > 1;

  // Codex as primary (auto-use when no explicit SEARCH_BACKEND, or an explicit
  // override) keeps Codex-produced results ahead of fallback-only results even
  // after multi-signal rescoring.
  const codexPrimary = available[0] === 'codex';

  // Track which backends actually contributed results (shared across query variations)
  const contributedBackendSet = new Set<string>();

  // Run each query variation across all backends, collecting per-query results
  const queryPromises = queries.map(async (qv) => {
    const promises = available.map(async (backend) => {
      try {
        const results = await runBackend(
          backend,
          qv.query,
          limit,
          safeSearch,
          deps,
          cfg,
          summaryMode,
        );
        return { backend, results, strategy: qv.strategy };
      } catch (err) {
        // Log non-content metadata only: backend error payloads may echo the
        // raw query and must never be logged. Error classification is already
        // recorded via `recordOutcome` inside `runBackend`.
        logger.warn({ backend, strategy: qv.strategy }, 'Search backend failed');
        throw err;
      }
    });

    const settled = await Promise.allSettled(promises);
    const validResults = new Map<string, SearchResult[]>();

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        contributedBackendSet.add(s.value.backend);
        validResults.set(s.value.backend, s.value.results);
      }
    }

    if (validResults.size === 0) {
      errors.push(`all backends failed (strategy: ${qv.strategy})`);
      return { results: [], strategy: qv.strategy };
    }

    if (useMerge) {
      const merged = mergeSearchResults(validResults, limit, {
        category,
        ...(codexPrimary ? { primary: 'codex' } : {}),
      });
      return { results: merged, strategy: qv.strategy };
    }

    const rankings = Array.from(validResults.values());
    const merged = rrfMerge(rankings, {
      k: 60,
      keyFn: (r) => normalizeUrlForDedup(r.url),
    });

    return { results: restoreRrfProvenance(merged, rankings), strategy: qv.strategy };
  });

  const queryResults = await Promise.all(queryPromises);

  // ── Provenance tracking ──────────────────────────────────────────
  if (provenanceResult) {
    const effectivePrimary: string =
      onlyModeScope !== undefined || safeSearch === 'strict'
        ? (available[0] ?? primary)
        : (overrideBackends?.[0] ?? backends[0] ?? primary);
    const usedFallback = !contributedBackendSet.has(effectivePrimary);
    const fallbackReasons: string[] = [];
    if (usedFallback) {
      if (!available.includes(effectivePrimary as SearchBackend)) {
        fallbackReasons.push(`${effectivePrimary} was unavailable or degraded`);
      } else {
        fallbackReasons.push(`${effectivePrimary} failed to return results`);
      }
    }
    provenanceResult.current = {
      usedBackend: effectivePrimary,
      servedBackends: Array.from(contributedBackendSet).sort(),
      usedFallback,
      ...(fallbackReasons.length > 0 ? { fallbackReason: fallbackReasons.join('; ') } : {}),
    };
  }

  // Deduplicate across query variations by normalized URL, keeping the richest
  // clean representation (full > summary > snippet, then length) and the best
  // relevance anchor. Wrapped RRF results carry an `rrfScore`; bare merged
  // results carry a finite numeric `score` (engine agreement + authority +
  // position) that must be preserved so multi-engine agreement still outranks
  // a single authoritative source after the final rescore.
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
          : (() => {
              // Bare merged result: use its finite numeric composite score as the
              // relevance anchor; fall back to a neutral 0.5 only when missing.
              const score = (item as unknown as { score?: unknown }).score;
              return typeof score === 'number' && Number.isFinite(score) ? score : 0.5;
            })();
      const key = normalizeUrlForDedup(item.url);
      const existing = seen.get(key);
      if (existing === undefined) {
        seen.set(key, { item, rrfScore });
      } else {
        const merged = mergeDedupProvenance(existing.item, item);
        // Keep the richest content/provenance, but always retain the BEST
        // relevance anchor — a richer but lower-ranked representation must not
        // lower the relevance of a URL confirmed by more engines.
        seen.set(key, { item: merged, rrfScore: Math.max(existing.rrfScore, rrfScore) });
      }
    }
  }

  const seenEntries = Array.from(seen.values());
  const allItems = seenEntries.map((e) => e.item);
  if (allItems.length === 0) {
    throw new Error(
      `All search backends failed across all query variations. Ensure at least one backend is configured (DuckDuckGo is zero-key and always available; EXA_API_KEY, BRAVE_API_KEY, TAVILY_API_KEY, or SEARXNG_BASE_URL for key-backed backends).\n${errors.join('\n')}`,
    );
  }

  const allSignals = extractWebSearchSignals(allItems, {
    // Year/recency intent must be read from the ORIGINAL query, not the
    // category-expanded query.
    query: originalQuery ?? query,
  });

  const signaled = seenEntries.map(({ item, rrfScore }, i) => ({
    item,
    rrfScore,
    signals: allSignals[i] ?? {},
  }));

  const rescoreWeights = cfg.rescoreWeights.webSearch;
  const useSemanticRerank = semanticRerankConfigured(cfg);
  const rescored = multiSignalRescore(
    signaled,
    rescoreWeights,
    useSemanticRerank ? allItems.length : limit,
  );
  // Bounded Codex preference on the scored ranking: ranking score sorts first;
  // Codex only tiebreaks (near-)equal scores and only when not materially less
  // rich. Applied before the optional semantic rerank so a low-score Codex
  // result is never moved above a higher-score fallback, and the authoritative
  // semantic order (when used) is not overridden by Codex.
  let finalItems = codexPrimary
    ? applyBoundedCodexPreference(rescored)
    : rescored.map((result) => result.item);

  if (useSemanticRerank) {
    try {
      finalItems = await (deps.semanticRerank ?? semanticRerankSearchResults)(
        query,
        finalItems,
        cfg,
        category,
      );
    } catch {
      // Embedding is an optional ranking enhancement. Keep existing rank if it fails.
      logger.warn('Web search semantic rerank unavailable; retaining lexical ranking');
    }
  }

  // Semantic rerank has no notion of publication year, so apply explicit-year
  // intent after optional reranking (helper no-ops when query has no year).
  finalItems = applyExplicitYearIntentOrder(finalItems, originalQuery ?? query);

  // Remove navigation-only candidates (nonempty input whose cleaned body is
  // only chrome/link-grid/footer) and near-empty results (short body AND short
  // title) before the final requested-limit slice so neither consumes a
  // requested slot. hasMinimumContent is conservative: a result survives when
  // either its body or its title is substantial (academic abstracts, API docs).
  const usableItems = finalItems.filter(
    (item) => !isNavigationOnlySearchResult(item) && hasMinimumContent(item),
  );

  return usableItems.slice(0, limit).map((item, i) => {
    const hostname =
      item.domain.length > 0
        ? item.domain
        : (() => {
            try {
              return new URL(item.url).hostname;
            } catch {
              return '';
            }
          })();
    const contentSignals = {
      contentLength: (item.description + (item.extraSnippet ?? '')).length,
      ...(item.contentKind !== undefined ? { contentKind: item.contentKind } : {}),
      ...(item.engines !== undefined ? { engineCount: item.engines.length } : {}),
    };
    return {
      ...item,
      // Additive honest quality metadata for the formatter / consumers.
      domainAuthorityScore: getDomainAuthority(hostname, category),
      sourceQuality: getSourceQuality(hostname, category),
      // Category-aware basis: domain prior refined with content-level signals
      // (kind/length/engine agreement) when the domain has no named authority.
      sourceBasis: getSourceBasis(hostname, category, contentSignals),
      position: i + 1,
    };
  });
}

/**
 * Bounded reordering giving Codex a preference only among (near-)equal ranking
 * scores, and only when the Codex result is not materially less rich. The
 * ranking score always sorts first, so a low-score Codex result is never moved
 * above a higher-score fallback.
 *
 * Ordering is derived from precomputed, transitive sort keys (not a pairwise
 * comparator): the combined score is quantized into epsilon buckets, then within
 * a bucket results are ordered by absolute richness (kind rank, then length)
 * with Codex winning only exact richness ties, and the original index is the
 * final tie-breaker. This keeps results deterministic across input order and
 * sort implementations.
 */
export function applyBoundedCodexPreference(
  rescored: ScoredResult<SearchResult>[],
): SearchResult[] {
  const keyed = rescored.map((r, index) => {
    const bucket = Math.floor(r.combinedScore / SCORE_EPSILON);
    const rank = contentKindRank(r.item.contentKind);
    const len = contentLength(r.item);
    const codex = isCodexProduced(r.item) ? 1 : 0;
    return { key: [-bucket, -rank, -len, -codex, index] as const, item: r.item };
  });
  keyed.sort((a, b) => compareSortKeys(a.key, b.key));
  return keyed.map((k) => k.item);
}

/** Lexicographic comparison of precomputed numeric sort keys (transitive). */
function compareSortKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function webSearch(
  query: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
  expandQueryOpt = true,
  mergeBackends = true,
  provenanceResult?: { current: ProvenanceResult | null },
  category?: string,
  aiSummary: AiSummaryMode = 'no',
  config?: SearchConfig,
): Promise<SearchResult[]> {
  // Apply category hint if provided
  let effectiveQuery = query;
  if (category) {
    const profile = getCategoryProfile(category);
    if (profile.queryHint) {
      effectiveQuery = `${query} ${profile.queryHint}`;
      logger.info({ category }, 'webSearch: category hint applied');
    }
  }

  const results = await searchWithBackends(
    effectiveQuery,
    limit,
    safeSearch,
    {
      braveSearch,
      searxngSearch,
      exaSearch,
      tavilySearch,
      ...(config !== undefined ? { config } : {}),
    },
    undefined,
    expandQueryOpt,
    mergeBackends,
    provenanceResult,
    category,
    aiSummary,
    // The original query (pre-category-expansion) drives year/recency intent.
    query,
  );

  return results;
}
