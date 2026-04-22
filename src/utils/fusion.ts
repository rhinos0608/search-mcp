const TRACKING = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'ref',
  'source',
]);

/** Strip common tracking and advertising query parameters from a URL. */
function stripTrackingParams(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING.has(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return urlStr;
  }
}

/**
 * Normalize a URL for deduplication comparison.
 *
 * - Strip trailing slashes from the pathname.
 * - Strip 'www.' prefix from hostname.
 * - Strip common tracking parameters.
 * - Lower-case hostname.
 *
 * If the URL is malformed, returns the original string unchanged so data
 * is never silently dropped during fusion.
 */
export function normalizeUrl(original: string): string {
  try {
    const stripped = stripTrackingParams(original);
    const url = new URL(stripped);
    let hostname = url.hostname.toLowerCase();
    if (hostname.startsWith('www.')) hostname = hostname.slice(4);
    url.hostname = hostname;
    url.pathname = url.pathname.replace(/\/+$/, '');
    // URL constructor normalizes empty pathname back to '/' for origin-only URLs;
    // return origin directly when the path collapses to root.
    if (url.pathname === '/' && !url.search && !url.hash) {
      return url.origin;
    }
    return url.toString();
  } catch {
    return original;
  }
}

export interface RrfMergeResult<T> {
  item: T;
  rrfScore: number;
}

/**
 * Reciprocal Rank Fusion (RRF).
 *
 * Combines multiple ranked result lists into a single fused ranking. Items
 * appearing in multiple lists get a higher score (sum of reciprocal ranks).
 *
 * @param rankings  Ordered lists per source (best first in each).
 * @param opts.k    RRF constant (default 60).
 * @param opts.keyFn Dedupe key per item within a single ranking (default
 *                   normalizeUrl applied to a `{ url: string }` property —
 *                   callers should override).
 * @param opts.getId Optional cross-source canonical ID. When provided, used
 *                   to merge items across rankings. Items with the same getId
 *                   across rankings get summed RRF scores, and last-ranking
 *                   metadata wins on collision. Within each ranking, keyFn
 *                   deduplicates first before cross-ranking merge.
 */
export function rrfMerge<T>(
  rankings: T[][],
  opts?: { k?: number; keyFn?: (item: T) => string; getId?: (item: T) => string },
): RrfMergeResult<T>[] {
  const k = opts?.k ?? 60;

  const defaultKeyFn = (item: T): string => {
    const record = item as unknown as Record<string, unknown>;
    if (typeof record.url === 'string') return normalizeUrl(record.url);
    // Fallback: use JSON stringification.
    return JSON.stringify(item);
  };

  const keyFn = opts?.keyFn ?? defaultKeyFn;
  // getId is used for cross-ranking merge; keyFn is used for intra-ranking dedup.
  const crossRankDedupFn = opts?.getId ?? keyFn;

  // Pass 1: Within each ranking, deduplicate by keyFn (keep first occurrence).
  // This ensures same item doesn't appear twice in one source.
  const dedupedRankings: T[][] = [];
  for (const ranking of rankings) {
    const seenKeys = new Set<string>();
    const deduped: T[] = [];
    for (const item of ranking) {
      const key = keyFn(item);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        deduped.push(item);
      }
    }
    dedupedRankings.push(deduped);
  }

  // Pass 2: Merge across rankings using crossRankDedupFn (getId or keyFn).
  // Track ranking index so "last ranking metadata wins" only applies across rankings,
  // not within the same ranking (where first item wins for consistency with keyFn dedup).
  const scores = new Map<string, { item: T; score: number; ranking: number }>();

  for (let r = 0; r < dedupedRankings.length; r++) {
    const ranking = dedupedRankings[r];
    if (!ranking) continue;
    for (let i = 0; i < ranking.length; i++) {
      const item = ranking[i];
      if (!item) continue;
      const key = crossRankDedupFn(item);
      const rank = i + 1; // 1-indexed
      const reciprocal = 1 / (k + rank);

      const existing = scores.get(key);
      if (existing) {
        existing.score += reciprocal;
        // Only update item if from a later ranking (last ranking metadata wins).
        // Within the same ranking, first item wins (consistent with keyFn dedup).
        if (existing.ranking < r) {
          existing.item = item;
          existing.ranking = r;
        }
      } else {
        scores.set(key, { item, score: reciprocal, ranking: r });
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(v => ({ item: v.item, rrfScore: v.score }));
}
