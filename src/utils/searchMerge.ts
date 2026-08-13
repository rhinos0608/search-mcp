import type { SearchResult } from '../types.js';
import { contentKindRank, contentLength, richerThan } from './searchRichness.js';
import { getDomainAuthority, getSourceBasis, getSourceQuality } from './sourceTier.js';

/**
 * Web-search-specific tracking/attribution params that are unequivocally
 * non-functional (click IDs and analytics tags never change page content).
 * Deliberately narrower than the shared crawl `TRACKING_PARAMS` in `./url.ts`
 * — that set also strips ambiguous generic keys (`ref`, `source`, `src`,
 * `pos`) which can carry real functional meaning (e.g. `?ref=version-1` vs
 * `?ref=version-2` may render different content) and must not be collapsed
 * away for web-search URL identity.
 */
const WEB_SEARCH_TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
]);

function isWebSearchTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith('utm_') || WEB_SEARCH_TRACKING_PARAMS.has(k);
}

export interface MergedSearchResult extends SearchResult {
  engines: string[];
}

export function normalizeUrlForDedup(url: string): string {
  try {
    const parsed = new URL(url);
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('www.')) hostname = hostname.slice(4);
    parsed.hostname = hostname;
    parsed.hash = '';
    // Default ports (http 80 / https 443) are already normalized to empty by the
    // WHATWG URL parser; explicit non-default ports are kept for identity.
    // Strip only unequivocal tracking/attribution params (utm_*, click IDs,
    // analytics tags). Generic keys like `ref`/`source`/`src`/`pos` are kept
    // — they can carry real functional meaning and stripping them risks
    // merging distinct content under one identity.
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isWebSearchTrackingParam(key)) {
        parsed.searchParams.delete(key);
      }
    }
    // Normalize trailing slash
    let pathname = parsed.pathname;
    if (pathname.endsWith('/') && pathname !== '/') {
      pathname = pathname.slice(0, -1);
    }
    parsed.pathname = pathname;
    return parsed.toString();
  } catch {
    return url.toLowerCase().trim();
  }
}

function isPublished(result: SearchResult): boolean {
  return result.ageKind === 'published' && typeof result.age === 'string' && result.age.length > 0;
}

/**
 * Preserve one publication date from a same-URL duplicate when the chosen
 * (richer) result lacks one. Never synthesizes: fetched/unknown ages never
 * replace publication data, and conflicting published values keep the chosen
 * result's own semantics.
 */
export function preservePublishedAge(
  chosen: SearchResult,
  other: SearchResult,
): Pick<SearchResult, 'age' | 'ageKind'> {
  if (isPublished(chosen)) return { age: chosen.age, ageKind: chosen.ageKind };
  if (isPublished(other)) return { age: other.age, ageKind: other.ageKind };
  return { age: chosen.age, ageKind: chosen.ageKind };
}

export function unionUpstreamEngines(items: readonly SearchResult[]): string[] | undefined {
  const set = new Set<string>();
  for (const item of items) {
    const values: unknown = item.upstreamEngines;
    if (!Array.isArray(values)) continue;
    for (const e of values) {
      if (typeof e !== 'string') continue;
      const trimmed = e.trim();
      if (trimmed.length > 0) set.add(trimmed);
    }
  }
  return set.size > 0 ? [...set].sort((a, b) => a.localeCompare(b)) : undefined;
}

function selectRicherResult(previous: SearchResult, candidate: SearchResult): SearchResult {
  const richer = richerThan(candidate, previous) ? candidate : previous;
  const other = richer === candidate ? previous : candidate;
  const richerHasSummary =
    typeof richer.generatedSummary === 'string' && richer.generatedSummary.length > 0;
  const otherSummary = other.generatedSummary ?? null;
  const base: SearchResult =
    richerHasSummary || !otherSummary
      ? richer
      : {
          ...richer,
          generatedSummary: otherSummary,
          generatedSummaryProvider: other.generatedSummaryProvider,
        };
  // Union SearXNG upstream engine names across the same-URL duplicates so they
  // survive even when a non-SearXNG richer donor wins the content slot.
  const upstream = unionUpstreamEngines([richer, other]);
  const withUpstream = upstream === undefined ? base : { ...base, upstreamEngines: upstream };
  const { age, ageKind } = preservePublishedAge(withUpstream, other);
  return age === withUpstream.age && ageKind === withUpstream.ageKind
    ? withUpstream
    : { ...withUpstream, age, ageKind };
}

export function getResultDomain(result: SearchResult): string {
  let hostname = result.domain;
  if (hostname.length === 0) {
    try {
      hostname = new URL(result.url).hostname;
    } catch {
      hostname = '';
    }
  }
  return hostname;
}

export function mergeSearchResults(
  backendResults: Map<string, SearchResult[]>,
  limit = 10,
  options: { category?: string | undefined; primary?: string | undefined } = {},
): MergedSearchResult[] {
  if (backendResults.size === 0) return [];

  // Step 1: deduplicate by normalized URL, tracking engine agreement
  const byUrl = new Map<
    string,
    { result: SearchResult; engines: Set<string>; bestPosition: number }
  >();

  for (const [engine, results] of backendResults) {
    for (const result of results) {
      const key = normalizeUrlForDedup(result.url);
      const existing = byUrl.get(key);

      if (existing === undefined) {
        byUrl.set(key, {
          result,
          engines: new Set([engine]),
          bestPosition: result.position,
        });
      } else {
        existing.engines.add(engine);
        // Content truth: keep the richest clean representation (full page text
        // beats a summary beats a thin snippet, then length). `source` stays
        // the provider of the chosen content; engines union discovery.
        existing.result = selectRicherResult(existing.result, result);
        if (result.position < existing.bestPosition) {
          existing.bestPosition = result.position;
        }
      }
    }
  }

  // Step 2: score each result. Identity is URL-only — distinct normalized
  // URLs (even same host/title/body) always remain distinct results. Content
  // similarity is not a safe cross-URL identity signal (it would false-merge
  // e.g. `/v1/release-notes` and `/v2/release-notes`); any intra-document
  // duplicate cleanup belongs to the formatter, not URL-level merge.
  const scored = Array.from(byUrl.values()).map((entry) => {
    const engineAgreement = entry.engines.size;
    const hostname = getResultDomain(entry.result);
    const domainAuthority = getDomainAuthority(hostname, options.category);
    const positionPenalty = 1 / Math.log(entry.bestPosition + Math.E);

    // Composite score: engine agreement * 0.4 + domain authority * 0.3 + position * 0.3
    const score =
      Math.min(engineAgreement / 2, 1) * 0.4 + domainAuthority * 0.3 + positionPenalty * 0.3;

    return {
      ...entry.result,
      // Additive honest quality metadata, derived deterministically from the
      // domain. Never a claim that the source is correct.
      domainAuthorityScore: domainAuthority,
      sourceQuality: getSourceQuality(hostname, options.category),
      // Category-aware basis: domain prior refined with content-level signals
      // (kind/length/engine agreement) when the domain has no named authority.
      sourceBasis: getSourceBasis(hostname, options.category, {
        contentLength: (entry.result.description + (entry.result.extraSnippet ?? '')).length,
        ...(entry.result.contentKind !== undefined
          ? { contentKind: entry.result.contentKind }
          : {}),
        engineCount: entry.engines.size,
      }),
      engines: Array.from(entry.engines),
      score,
    };
  });

  // Step 3: sort by score descending first. The primary backend (e.g. auto-used
  // Codex) gets a bounded preference ONLY as a tiebreak among (near-)equal
  // scores, and only when it is not materially less rich — so a low-score Codex
  // result is never moved above a higher-score fallback, and rich content is
  // not starved by the Codex partition.
  //
  // Ordering is derived from precomputed, transitive sort keys (not a pairwise
  // comparator): the score is quantized into epsilon buckets, then within a
  // bucket results are ordered by absolute richness (kind rank, then length)
  // with the primary backend winning only exact richness ties, and the original
  // index is the final tie-breaker. This keeps results deterministic across
  // input order and sort implementations.
  const SCORE_EPSILON = 1e-6;
  const keyed = scored.map((entry, index) => {
    const bucket = Math.floor(entry.score / SCORE_EPSILON);
    const rank = contentKindRank(entry.contentKind);
    const len = contentLength(entry);
    const primary =
      options.primary !== undefined && entry.engines.includes(options.primary) ? 1 : 0;
    return { key: [-bucket, -rank, -len, -primary, index] as const, entry };
  });
  keyed.sort((a, b) => compareSortKeys(a.key, b.key));
  const sorted = keyed.map((k) => k.entry);

  // Step 4: return top-k with position reassigned
  return sorted.slice(0, limit).map((r, i) => ({
    ...r,
    position: i + 1,
  }));
}

/** Lexicographic comparison of precomputed numeric sort keys (transitive). */
function compareSortKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
