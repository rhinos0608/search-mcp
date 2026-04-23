# Multi-Signal RRF Rescoring Design

## Summary

Wire a generic rescoring layer into every tool that produces ranked results. Extractors emit fully-normalized signal values; `multiSignalRescore` is a pure weighted sum + sort. RRF fusion gains cross-source canonical dedup via `getId`. All tool pipelines stay uniform regardless of sort mode.

**Scope:** `webSearch`, `academicSearch` (new parallel RRF), `hackernewsSearch`, `redditSearch`.

---

## Design Principle: Normalize in Extractors, Sum in Rescorer

`multiSignalRescore` does **one job only** — weighted sum + sort. Every signal arriving in `signals: Record<string, number>` is already unit-scaled (or otherwise appropriately scaled). Per-tool extractors own all transform decisions because they know the signal semantics.

This means:

- Extractors apply `log(1 + x)` to citations/engagement, then min-max normalize.
- Extractors apply `exp(-age_days / half_life)` to recency.
- Booleans pass through as `0` or `1` directly.
- RRF scores get min-max normalized by the extractor.

`multiSignalRescore` becomes ~20 lines: `combined = weights.rrfAnchor * rrf + Σ(weights[s] * signals[s])`, sort, slice.

---

## Signal Normalization Strategies (Extractor-Side)

Each signal is normalized by the extractor that produces it:

| Signal                                 | Distribution      | Extractor Transform               |
| -------------------------------------- | ----------------- | --------------------------------- |
| `rrfScore`                             | Uniform-ish       | Min-max across candidate set      |
| `recency` (age in days)                | Exponential decay | `exp(-age_days / half_life)`      |
| `citationCount`                        | Heavy-tailed      | `log(1 + x)` then min-max         |
| `engagement` (points, comments, score) | Heavy-tailed      | `log(1 + max(0, x))` then min-max |
| `venue`                                | Boolean           | `0` or `1` (no transform)         |
| `hasDeepLinks`                         | Boolean           | `0` or `1` (no transform)         |

### Min-max normalizer

```typescript
function minMaxNormalize(values: number[]): number[];
```

- `[1, 2, 3]` → `[0, 0.5, 1.0]`
- All equal → all `0` (zero variance; no single item should dominate)
- Empty → `[]`
- Single element → `[0]`

**Booleans bypass min-max.** `hasVenue: 1` is already unit-scaled. Passing `{0, 1}` through min-max is either a no-op or a divide-by-zero risk; the extractor emits the raw value directly.

### Recency exponential decay

```typescript
function applyRecencyDecay(ageDays: number, halfLifeDays: number): number;
```

```
score = exp(-age_days / half_life)
```

No further normalization — the decay curve is the normalization. Tunable half-life per tool:

| Tool       | Half-life           | Rationale                            |
| ---------- | ------------------- | ------------------------------------ |
| Web search | 7 days              | News, fast-moving content            |
| HN         | 180 days            | Long-tail relevance                  |
| Reddit     | 180 days            | Long-tail relevance                  |
| Academic   | 3 years (1095 days) | Foundational papers beat recent ones |

### Heavy-tailed signals

```typescript
function applyLogTransform(value: number): number;
```

```
score = log(1 + max(0, value))
```

Then min-max normalize across the candidate set. `max(0, value)` guards against negative Reddit scores and null/undefined engagement. Prevents one viral post or highly-cited paper from flattening all other scores.

---

## Rescore API

### Extractor output

```typescript
interface RrfResultWithSignals<T> {
  item: T;
  rrfScore: number; // raw RRF score (not yet normalized)
  signals: Record<string, number>; // fully normalized by extractor
}
```

### Core function (pure weighted sum)

```typescript
function multiSignalRescore<T>(
  items: RrfResultWithSignals<T>[],
  weights: Record<string, number>, // rrfAnchor, recency, citations, engagement, venue, …
  limit: number,
): Array<{
  item: T;
  combinedScore: number;
  breakdown: {
    rrfAnchor: number; // min-max normalized RRF contribution
    signals: Record<string, number>; // per-signal contribution
  };
}>;
```

Formula:

```
combinedScore = weights.rrfAnchor * rrf_norm + Σ(weights[s] * signals[s])
```

Where `rrf_norm = minMaxNormalize(items.map(i => i.rrfScore))`.

Then sort descending, slice to `limit`.

### Guardrail: RRF anchor weight

Assert `weights.rrfAnchor >= max(...Object.values(weights).filter((_, k) => k !== 'rrfAnchor'))` at startup.

This ensures RRF dominates any single other signal — it can't be swamped by one dimension. If violated, log a warning (don't hard-fail, to allow deliberate override in config).

---

## Fusion with Canonical Dedup IDs

The `rrfMerge` function gets a `getId` callback:

```typescript
function rrfMerge<T>(
  rankings: T[][],
  opts?: {
    k?: number;
    keyFn?: (item: T) => string; // normalized dedup key (URL or hash)
    getId?: (item: T) => string; // canonical ID for cross-source boost
  },
): Array<{ item: T; rrfScore: number }>;
```

- **`keyFn`**: Normalized dedup key for deduplication within a single list (unchanged).
- **`getId`**: Canonical ID. When two rankings contain the same ID, their individual RRF contributions (`1/(k + rank)`) are summed into a single boosted entry.

**keyFn vs getId example:** Two items in the same ranking might have different URLs (`keyFn` differs) but the same DOI (`getId` matches). Intra-list dedup by `keyFn` keeps both (different URLs are different results). Cross-source merge by `getId` collapses them into one boosted entry. This is intended — the same work surfaced through different URLs gets a cross-source relevance boost.

**Merge semantics when getId collides:** Last-writer-wins on metadata fields, with per-field preference for the more populated entry. Specifically: for `AcademicPaper`, `citationCount`, `venue`, and `doi` are taken from whichever source has a non-null value; if both have it, the last ranking's item wins (Semantic Scholar is typically the second/last ranking, and it has richer metadata).

### Academic dedup strategy

Canonical ID for `getId`:

1. DOI if present (case-folded, trimmed)
2. Fallback: `normalizeTitle(paper.title) + "|" + firstAuthorName`

`normalizeTitle`:

- Unicode NFC normalization
- Case-fold to lowercase
- Strip LaTeX commands (`\textit{}`, `\mathbf{}`, etc.) — regex `\\[a-zA-Z]+\{([^}]*)\}` captures inner text
- Strip math mode (`$...$`, `$$...$$`)
- Strip punctuation except alphanumeric and spaces
- Collapse whitespace

Author normalization:

- Extract first author from `authors[0]`
- If format is `"J. A. Smith"` or `"Smith, J. A."`, normalize to `"smith"` (last name only, lowercase)
- If single name (e.g., `"Smith"`), use as-is (lowercase)

**Preprint vs published versions:** Different DOIs for the same work (preprint DOI vs journal DOI) will not collapse. That's acceptable for v1 — the preprint and published version are often genuinely different (additional data, peer review). Future improvement: Crossref/DOI resolution to canonical work ID.

---

## Sort-Mode Awareness

### Rule: Always run RRF; drop signals that double-count.

- `sort=relevance`: RRF uses relevance rank. All signals active (recency, engagement, etc.).
- `sort=date`: RRF uses date/recency rank. Drop the `recency` signal (it's already in the rank). Keep engagement and comments.
- `sort=top`: RRF uses top-score rank. Drop the `engagement` signal (it's in the rank). Keep recency and comments.

This keeps the pipeline shape uniform: RRF always runs, `multiSignalRescore` always runs, but the extractor omits signals that would double-count the sort key.

---

## Per-Tool Signal Extraction

### `webSearch`

```typescript
interface WebSearchSignals {
  recency: number; // exp(-age_days / 7), or 0 if age missing
  hasDeepLinks: number; // 0 or 1
}
```

- `age`: parse `result.age` string to days old (see `parseAgeToDays` util below)
- `deepLinks`: boolean → `1` if `deepLinks` array is non-empty, else `0`

### `academicSearch`

```typescript
interface AcademicSignals {
  recency: number; // exp(-age_days / 1095)
  citations: number; // log(1 + citationCount), min-max normalized
  venue: number; // 1 if venue non-null and non-empty, else 0
}
```

### `hackernewsSearch`

```typescript
interface HNSignals {
  recency: number; // exp(-age_days / 180)
  engagement: number; // log(1 + max(0, points)), min-max
  commentEngagement: number; // log(1 + max(0, numComments)), min-max
}
```

- `sort=relevance`: all three signals active
- `sort=date`: drop `recency` (already in rank)
- `sort=top`: drop `engagement` (already in rank)

### `redditSearch`

```typescript
interface RedditSignals {
  recency: number; // exp(-age_days / 180)
  engagement: number; // log(1 + max(0, score)), min-max
  commentEngagement: number; // log(1 + max(0, numComments)), min-max
}
```

Same sort-mode rules as HN.

---

## Result-Set Size Asymmetry

Before RRF merge, cap each input ranking to the same `N`. Use `N = limit * 2` (same as `webSearch` pattern). This prevents a backend that returns 50 items from dominating one that returns 10.

---

## Age Parsing Utility

```typescript
// src/utils/time.ts
function parseAgeToDays(ageStr: string | null): number | null;
```

Handles Brave's mixed `age` field:

- `"1 hour ago"` → `1/24`
- `"2 days ago"` → `2`
- `"1 week ago"` → `7`
- `"2024-01-15"` → `daysSince('2024-01-15')`
- `"Jan 15, 2024"` → `daysSince('2024-01-15')`
- `null` / `undefined` / `""` → `null`

If parsing fails, return `null` (signal extractor will use a default — e.g., treat as very old with `exp(-∞ / halfLife) ≈ 0`).

---

## Integration

### `src/utils/rescore.ts` — New

```typescript
// Transform functions (extractor-side)
export function applyRecencyDecay(ageDays: number, halfLifeDays: number): number;
export function applyLogTransform(value: number): number;
export function minMaxNormalize(values: number[]): number[];

// Age parsing
export function parseAgeToDays(ageStr: string | null): number | null;

// Pure weighted sum rescoring
export function multiSignalRescore<T>(
  items: Array<{ item: T; rrfScore: number; signals: Record<string, number> }>,
  weights: Record<string, number>,
  limit: number,
): Array<{
  item: T;
  combinedScore: number;
  breakdown: { rrfAnchor: number; signals: Record<string, number> };
}>;

// Per-tool signal extractors
export function extractWebSearchSignals(
  results: SearchResult[],
): Array<{ rrfScore: number; signals: Record<string, number> }>;
export function extractAcademicSignals(
  papers: AcademicPaper[],
): Array<{ rrfScore: number; signals: Record<string, number> }>;
// ... etc
```

### `src/utils/fusion.ts` — Extend `rrfMerge`

Add `getId` parameter. When two items share the same `getId`, sum their RRF contributions (`1/(k + rank)`) into a single entry. Use `last-writer-wins` on metadata fields.

### `src/utils/time.ts` — New

`parseAgeToDays`, `daysSince`.

### `src/tools/webSearch.ts`

- Already calls `rrfMerge` → `RrfMergeResult<SearchResult>[]`
- Extract signals via `extractWebSearchSignals`
- `multiSignalRescore(signaledResults, config.rescoreWeights.webSearch, limit)`

### `src/tools/academicSearch.ts`

- Parallel query ArXiv + Semantic Scholar (like `webSearch` pattern)
- `rrfMerge` with `getId` for DOI/title dedup
- Extract signals via `extractAcademicSignals`
- `multiSignalRescore`

### `src/tools/hackernewsSearch.ts`

- `rrfMerge([[...results]])` (single source)
- Extract signals via `extractHNSignals(sort)`
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
  commentEngagement: number;
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

Default weights per tool (weights don't need to sum to 1.0; they are relative importance):

```typescript
const DEFAULT_RESCORE_WEIGHTS = {
  webSearch: { rrfAnchor: 0.5, recency: 0.2, hasDeepLinks: 0.05 },
  academicSearch: { rrfAnchor: 0.5, recency: 0.05, citations: 0.3, venue: 0.15 },
  hackernewsSearch: { rrfAnchor: 0.5, recency: 0.15, engagement: 0.2, commentEngagement: 0.15 },
  redditSearch: { rrfAnchor: 0.5, recency: 0.1, engagement: 0.25, commentEngagement: 0.15 },
};
```

---

## Files

| File                            | Change                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `src/utils/rescore.ts`          | **New.** Transform functions, normalizers, `multiSignalRescore`, per-tool extractors |
| `src/utils/time.ts`             | **New.** `parseAgeToDays`, `daysSince`                                               |
| `src/utils/fusion.ts`           | Add `getId` parameter to `rrfMerge`; merge-collision metadata policy                 |
| `src/tools/webSearch.ts`        | Wire `multiSignalRescore` after RRF                                                  |
| `src/tools/academicSearch.ts`   | Parallel ArXiv+SS → RRF with `getId` → rescoring                                     |
| `src/tools/hackernewsSearch.ts` | RRF (single source) → sort-mode-aware signals → rescoring                            |
| `src/tools/redditSearch.ts`     | Same as HN                                                                           |
| `src/config.ts`                 | Add `RescoreConfig` with per-tool weights                                            |
| `test/rescore.test.ts`          | Unit tests for `multiSignalRescore`, transforms, and extractors                      |
| `test/time.test.ts`             | Unit tests for `parseAgeToDays`                                                      |
| `test/rescore.eval.ts`          | **Roadmap.** Eval harness with judgment set                                          |

---

## Testing Plan

### `test/rescore.test.ts`

**Transform functions:**

1. `applyRecencyDecay`: 0 days → `1.0`; half_life → `≈0.5`; 3×half_life → `≈0.125`
2. `applyLogTransform`: `0` → `0`; `100` → `≈4.6`; `10000` → `≈9.2` (saturates)
3. `applyLogTransform` with negative input: `-5` → `0` (clipped by `max(0, x)`)
4. `minMaxNormalize`: `[1,2,3]` → `[0, 0.5, 1.0]`
5. `minMaxNormalize` all equal: `[5,5,5]` → `[0, 0, 0]`
6. `minMaxNormalize` single element: `[7]` → `[0]`
7. `minMaxNormalize` empty: `[]` → `[]`

**Rescorer:** 8. `multiSignalRescore` with homogeneous signals → rank order unchanged (weights equal) 9. `multiSignalRescore` with recency bias → newer items bubble up 10. `multiSignalRescore` with citation bias → higher-cited items rank first 11. `multiSignalRescore` with `weights.rrfAnchor: 1, others: 0` → pure RRF (regression test) 12. `multiSignalRescore` with limit < results → truncates correctly 13. `multiSignalRescore` with single item → returns that item, score = `weights.rrfAnchor * 0` 14. `multiSignalRescore` with all signals identical → stable sort preserves original order 15. `multiSignalRescore` with NaN in one signal → NaN propagates (documented behavior)

**Guardrail:** 16. Guardrail fires when `rrfAnchor < max(other weight)` → logs warning 17. Guardrail silent when `rrfAnchor >= max(other weight)` → no log

**Extractors:** 18. `extractWebSearchSignals`: recency from age, hasDeepLinks boolean 19. `extractAcademicSignals`: citations log+minmax, venue boolean, recency decay 20. `extractHNSignals` relevance mode: all signals present 21. `extractHNSignals` date mode: recency omitted 22. `extractRedditSignals` top mode: engagement omitted

**Fusion:** 23. `rrfMerge` with `getId`: same ID in two rankings → single boosted entry, score = sum of both RRF contributions 24. `rrfMerge` with `getId`: no match → no cross-source accumulation 25. `rrfMerge` with `getId` collision: metadata from last ranking wins

### `test/time.test.ts`

26. `parseAgeToDays("2 days ago")` → `2`
27. `parseAgeToDays("1 week ago")` → `7`
28. `parseAgeToDays("2024-01-15")` → days since that date
29. `parseAgeToDays(null)` → `null`
30. `parseAgeToDays("")` → `null`
31. `parseAgeToDays("unknown")` → `null`

---

## Self-Review Checklist

1. [x] All signals normalized in extractors; rescorer is pure weighted sum
2. [x] Booleans pass through as `0`/`1` (no min-max)
3. [x] RRF anchor guardrail: `rrfAnchor >= max(other weight)`
4. [x] Sort-mode awareness: drop double-counting signal, not RRF
5. [x] Negative values handled: `log(1 + max(0, x))`
6. [x] Missing/null values: extractors provide sensible defaults (e.g., `0` for missing engagement)
7. [x] Merge semantics: last-writer-wins, with per-field preference for populated values
8. [x] Academic dedup: detailed title normalization + author extraction
9. [x] Result-set capping: `limit * 2` per input ranking before RRF
10. [x] Age parsing: separate tested utility
11. [x] Adversarial test cases: single item, all-equal, NaN propagation, null age
12. [x] Eval harness on roadmap, not blocking v1
