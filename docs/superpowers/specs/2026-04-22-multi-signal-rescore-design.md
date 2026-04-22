# Multi-Signal RRF Rescoring Design

## Summary

Wire a generic rescoring layer into every tool that produces ranked results. The layer takes ranked results, extracts signal values, normalizes them using signal-appropriate strategies, combines them with RRF, and returns a re-ranked list.

**Scope:** `webSearch`, `academicSearch` (new parallel RRF), `hackernewsSearch`, `redditSearch`.

---

## Signal Normalization Strategies

Each signal uses a strategy appropriate to its distribution:

| Signal | Distribution | Normalization |
|--------|-------------|---------------|
| `rrfScore` (normalized within candidate set) | Uniform-ish | Min-max |
| `originalRank` (1-based rank → [0,1]) | Uniform-ish | Min-max |
| `hasVenue` | Boolean | Min-max (0→0, 1→1) |
| `recency` (age in days) | Exponential decay | `exp(-age_days / half_life)` — no further normalization |
| `citationCount` | Heavy-tailed | `log(1 + x)` before min-max |
| `engagement` (points, comments) | Heavy-tailed | `log(1 + x)` before min-max |

### Recency exponential decay

```
score_recency = exp(-age_days / half_life)
```

No additional normalization — the decay curve is the normalization. Tunable half-life per tool:

| Tool | Half-life | Rationale |
|------|-----------|-----------|
| Web search | 7 days | News, fast-moving content |
| HN | 180 days | Long-tail relevance |
| Reddit | 180 days | Long-tail relevance |
| Academic | 3 years (1095 days) | Foundational papers beat recent ones |

### Heavy-tailed signals

```
score = log(1 + x)
```

Then min-max normalize across the candidate set. Prevents one viral post or highly-cited paper from flattening all other scores.

---

## Rescore API

### New type: `ScoredResult<T>`

```typescript
interface ScoredResult<T> {
  item: T;
  combinedScore: number;
  breakdown: {
    rrf: number;
    signals: Record<string, number>;  // per-signal contribution, post-normalization
  };
}
```

The `RrfMergeResult<T>` type is extended to carry signals inline:

```typescript
interface RrfResultWithSignals<T> {
  item: T;
  rrfScore: number;
  signals: Record<string, number>;  // co-located, never a parallel array
}
```

### Core function

```typescript
function multiSignalRescore<T>(
  items: RrfResultWithSignals<T>[],
  weights: Record<string, number>,  // rrf, recency, citations, engagement, venue, …
  limit: number,
): ScoredResult<T>[]
```

Rescoring formula:

1. Min-max normalize RRF score across the candidate set: `rrf_norm[i] = (rrfScore[i] - min) / (max - min)`
2. Apply recency decay (already decayed, no further normalization)
3. Apply `log(1 + x)` to citation/engagement, then min-max normalize
4. Combine: `combined = weights.rrf × rrf_norm + Σ(weights[s] × signal_norm[s])`
5. Sort descending, slice to `limit`

### Guardrail: RRF anchor weight

Assert `weights.rrf >= sum(Object.values(weights).filter(k => k !== 'rrf'))` at startup.
If this fires, log a warning — don't hard-fail (allows override in config).
Rename config field to `weights.rrfAnchor` to make the anchor role explicit.

---

## Fusion with canonical dedup IDs

The `rrfMerge` function gets a `getId` callback:

```typescript
function rrfMerge<T>(
  rankings: T[][],
  opts?: {
    k?: number;
    keyFn?: (item: T) => string;  // normalized dedup key (URL or hash)
    getId?: (item: T) => string;  // canonical ID for cross-source boost
  },
): RrfMergeResult<T>[]
```

- **`keyFn`**: Normalized dedup key for deduplication within a single list (unchanged).
- **`getId`**: Canonical ID (DOI if present, else normalized title hash). When two rankings contain the same ID, their ranks are summed into a single boosted entry. Dedup happens **during** merge, not before or after.

Academic dedup strategy:
- DOI if present → canonical
- Fallback: normalized title + first-author hash

---

## Per-Tool Signal Extraction

### `webSearch`

```typescript
interface WebSearchSignals {
  rrf: number;       // normalized RRF score
  recency: number;   // exp(-age_days / 7)
  hasDeepLinks: number;  // 0 or 1 (min-max)
}
```

- `age`: parse `result.age` to days old
- `deepLinks`: boolean → min-max

### `academicSearch`

```typescript
interface AcademicSignals {
  rrf: number;
  recency: number;   // exp(-age_days / 1095)
  citations: number;  // log(1 + citationCount), min-max
  venue: number;     // 0 or 1
}
```

### `hackernewsSearch`

```typescript
interface HNSignals {
  rrf: number;        // 1/(k+rank), normalized — OR skip rrf if date sort used
  recency: number;   // exp(-age_days / 180)
  engagement: number; // log(1 + points), min-max
  commentEngagement: number; // log(1 + numComments), min-max
}
```

**Sort mode awareness:**
- `sort=relevance`: rank is relevance signal → use in RRF slot
- `sort=date`: rank is recency → skip RRF; `recency` signal carries date weight

Extractor receives the sort mode and constructs signals accordingly.

### `redditSearch`

```typescript
interface RedditSignals {
  rrf: number;        // (same awareness as HN)
  recency: number;   // exp(-age_days / 180)
  engagement: number; // log(1 + score), min-max
  comments: number;  // log(1 + numComments), min-max
}
```

---

## Integration

### `src/utils/rescore.ts` — New

```typescript
import type { RrfMergeResult } from './fusion.js';

// Signal-specific transforms (applied before min-max)
export function applyLogTransform(value: number): number;
export function applyRecencyDecay(ageDays: number, halfLifeDays: number): number;

// Min-max normalizer
export function minMaxNormalize(values: number[]): number[];

// Core rescoring
export function multiSignalRescore<T>(
  items: Array<{
    item: T;
    rrfScore: number;
    signals: Record<string, number>;
  }>,
  weights: Record<string, number>,
  limit: number,
): Array<{
  item: T;
  combinedScore: number;
  breakdown: { rrf: number; signals: Record<string, number> };
}>;

// Per-tool signal extractors
export function extractWebSearchSignals(results: SearchResult[]): WebSearchSignals[];
// ... etc
```

### `src/utils/fusion.ts` — Extend `rrfMerge`

Add `getId` callback parameter. When two items share the same `getId` result, accumulate both ranks into one entry (boosted cross-source appearance).

### `src/tools/webSearch.ts`

- Already calls `rrfMerge` → get `RrfMergeResult<SearchResult>[]`
- Extract signals per result → `RrfResultWithSignals<SearchResult>[]`
- Call `multiSignalRescore(signaledResults, config.rescoreWeights, limit)`

### `src/tools/academicSearch.ts`

- Parallel query ArXiv + Semantic Scholar (like webSearch pattern)
- `rrfMerge` with `getId` for DOI/title dedup
- Extract signals (citations, year, venue)
- `multiSignalRescore` → final list

### `src/tools/hackernewsSearch.ts`

- Single source → `rrfMerge([[...results]])`
- Sort-mode-aware signal extraction
- `multiSignalRescore`

### `src/tools/redditSearch.ts`

- Same pattern as HN

### `src/config.ts`

```typescript
interface RescoreWeights {
  rrfAnchor: number;
  recency: number;
  citations: number;
  engagement: number;
  comments: number;
  venue: number;
  hasDeepLinks: number;
}

interface RescoreConfig {
  webSearch: RescoreWeights;
  academicSearch: RescoreWeights;
  hackernewsSearch: RescoreWeights;
  redditSearch: RescoreWeights;
}
```

Default weights per tool:

```typescript
const DEFAULT_RESCORE_WEIGHTS = {
  webSearch:        { rrfAnchor: 0.5, recency: 0.15, engagement: 0.10, hasDeepLinks: 0.05 },
  academicSearch:   { rrfAnchor: 0.5, recency: 0.05, citations: 0.30, venue: 0.15 },
  hackernewsSearch: { rrfAnchor: 0.5, recency: 0.15, engagement: 0.20, comments: 0.15 },
  redditSearch:     { rrfAnchor: 0.5, recency: 0.10, engagement: 0.25, comments: 0.15 },
};
```

---

## Files

| File | Change |
|------|--------|
| `src/utils/rescore.ts` | **New.** Transform functions, normalizers, `multiSignalRescore`, per-tool extractors |
| `src/utils/fusion.ts` | Add `getId` parameter to `rrfMerge` for canonical cross-source dedup |
| `src/tools/webSearch.ts` | Wire `multiSignalRescore` after RRF |
| `src/tools/academicSearch.ts` | Parallel ArXiv+SS → RRF with `getId` → rescoring |
| `src/tools/hackernewsSearch.ts` | RRF (single source) → sort-mode-aware signals → rescoring |
| `src/tools/redditSearch.ts` | Same as HN |
| `src/config.ts` | Add `RescoreConfig` with per-tool weights |
| `test/rescore.test.ts` | Unit tests for `multiSignalRescore` and signal extractors |
| `test/rescore.eval.ts` | **Roadmap.** Manual eval harness with judgment set (20–50 queries) |

---

## Testing Plan

### Unit tests (`test/rescore.test.ts`)

1. `applyRecencyDecay`: decay at 0 = 1.0, at half_life ≈ 0.5, at 3× half_life ≈ 0.125
2. `applyLogTransform`: log(1+0)=0, log(1+100) ≈ 4.6, saturates for large values
3. `minMaxNormalize`: all equal → all 0; [1,2,3] → [0, 0.5, 1.0]; empty → []
4. `multiSignalRescore` with homogeneous signals → rank order unchanged
5. `multiSignalRescore` with recency bias → newer items bubble up
6. `multiSignalRescore` with citation bias → higher-cited items rank first
7. `multiSignalRescore` with `weights.rrfAnchor: 1` → pure RRF (regression)
8. `multiSignalRescore` with limit < results → truncates correctly
9. Signal extractor for web search: recency, hasDeepLinks
10. Signal extractor for academic: log(1+citations), venue bool, year decay
11. Sort-mode awareness in HN extractor: relevance mode vs date mode
12. `rrfMerge` with `getId`: same ID appears in two rankings → single boosted entry
13. `rrfMerge` with `getId`: no match → no cross-source accumulation
14. Guardrail fires when `rrfAnchor < sum(other weights)` → logs warning

### Eval harness (`test/rescore.eval.ts`) — roadmap

```typescript
interface EvalQuery {
  query: string;
  description: string;  // what this tests
  expectedOrder: string[];  // URLs or IDs in preferred order
  category: 'recency' | 'citations' | 'engagement' | 'fusion';
}

const EVAL_QUERIES: EvalQuery[] = [
  // Recency: results from last 24h should outrank 1-year-old for same topic
  // Citations: highly-cited paper outranks obscure one
  // Engagement: HN post with 500 pts outranks 10-pt post
  // Fusion: duplicate URL across Brave and SearXNG gets RRF boost
  // ...
];
```

Run: `npm run eval` — logs NDCG or simple rank-correlation against `expectedOrder`.

---

## Self-Review Checklist

1. [x] All signals normalized with appropriate strategy (min-max, decay, log)
2. [x] RRF anchored with explicit `rrfAnchor` naming and guardrail
3. [x] Signal data co-located with item (no parallel arrays)
4. [x] Dedup during RRF merge with `getId` callback
5. [x] Sort-mode awareness in HN and Reddit extractors
6. [x] Per-tool weights in config (not global)
7. [x] Eval harness on roadmap, not blocking v1
8. [x] No TBD / placeholder sections