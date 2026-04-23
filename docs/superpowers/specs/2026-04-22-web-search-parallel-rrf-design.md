# Parallel RRF web_search Design

## Summary

Replace the sequential fallback fallback chain in `web_search` with parallel execution of Brave and SearXNG using Reciprocal Rank Fusion (RRF), giving strictly better results when both backends are configured.

## Approach

- The `web_search` tool schema remains unchanged — callers see zero surface-area change.
- Both available backends are raced in parallel via `Promise.allSettled`.
- Results are deduplicated by normalized URL.
- Surviving unique results are merged with RRF (k=60).
- If only one backend succeeds (or only one is configured), its results are returned directly.
- If all backends fail, the existing error behavior is preserved.

## Files

| File                     | Change                                                     |
| ------------------------ | ---------------------------------------------------------- |
| `src/utils/fusion.ts`    | **New.** `rrfMerge`, `normalizeUrl`, `stripTrackingParams` |
| `src/tools/webSearch.ts` | Replace sequential fallback with parallel fusion call      |
| `src/server.ts`          | No changes                                                 |

## `src/utils/fusion.ts` — API

```typescript
/**
 * Normalize a URL for deduplication comparison.
 * - Strip trailing slashes
 * - Strip 'www.' prefix from hostname
 * - Strip common tracking parameters
 * - Lower-case hostname
 */
export function normalizeUrl(original: string): string;

/**
 * Reciprocal Rank Fusion.
 * @param rankings — ordered result lists per source; each will get 1-indexed ranks internally
 * @param opts.k   — RRF constant (default 60)
 * @param opts.keyFn — dedupe key per result (default normalizeUrl)
 */
export function rrfMerge<T>(
  rankings: T[][],
  opts?: { k?: number; keyFn?: (item: T) => string },
): { item: T; rrfScore: number }[];
```

### Parameters

- **k**: 60 (standard RRF constant, tuned to balance between rank depth and influence)
- **Tracking params stripped**: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `fbclid`, `gclid`, `ref`, `source`

## `src/tools/webSearch.ts` — Change

Replace the for-loop fallback with:

```typescript
const backends = (['brave', 'searxng'] as const).filter(backendAvailable);
const settled = await Promise.allSettled(
  backends.map((b) => runBackend(b, query, limit * 2, safeSearch)),
);
const valid = settled
  .filter((r): r is PromiseFulfilledResult<SearchResult[]> => r.status === 'fulfilled')
  .map((r) => r.value);

if (valid.length === 0) {
  // collect errors and throw (existing behavior)
}
if (valid.length === 1) return valid[0].slice(0, limit);

const merged = rrfMerge(valid, { k: 60, keyFn: (r) => normalizeUrl(r.url) });
return merged.map((m) => m.item).slice(0, limit);
```

## Error Handling

- One backend failing → log warning, proceed with surviving backend(s).
- All backends failing → throw combined error (unchanged from current).
- If `normalizeUrl` fails on a malformed URL, treat the raw URL as the key so the result still participates in fusion (never silently dropped).

## Caching

- Caching stays in `braveSearch.ts` and `searxngSearch.ts` as-is. The fusion layer does not add its own cache.
- On warm cache hits, `Promise.allSettled` resolves immediately from both caches and fusion is near-zero-cost.

## Testing Plan

1. `normalizeUrl` strips tracking params, slashes, `www.`
2. `normalizeUrl` handles malformed URLs gracefully
3. `rrfMerge` with two distinct rankings produces correct RRF scores
4. `rrfMerge` dedupes same-key items across rankings
5. `rrfMerge` with one ranking returns that ranking in order with scores
6. `webSearch` with both backends succeeding returns merged, deduped, limited results
7. `webSearch` with one backend failing returns results from surviving backend
8. `webSearch` with both backends failing throws error

## Backward Compatibility

- Schema unchanged → zero breaking API change.
- Same `SearchResult[]` return type.
- Existing callers get better (more comprehensive) results, not different structure.
