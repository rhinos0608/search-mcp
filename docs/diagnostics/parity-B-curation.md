# Cluster B: Curation / Richness / Noise Diagnostic

## Observed Symptom

Per-result content is thinner than competitors; some results are near-empty. The output feels like a raw multi-backend dump rather than curated, substantial-per-result output.

---

## (a) No Minimum-Content / Minimum-Richness Filter — CRITICAL GAP

**Finding:** There is no filter anywhere in the pipeline that drops thin or empty results based on content quality.

### Evidence

The only pre-rendering filter is navigation-only detection:

- **`src/tools/webSearch.ts:743`**: `const usableItems = finalItems.filter((item) => !isNavigationOnlySearchResult(item));`
- **`src/tools/webSearchResultFormatter.ts:944-956`**: `isNavigationOnlySearchResult()` is deliberately conservative. Lines 950-951:

  ```ts
  const hasBody = description.length > 0 || (extra !== null && extra.trim().length > 0);
  if (!hasBody) return false;
  ```

  **A result with empty description AND null extraSnippet is never flagged** — it always passes through.

- **`src/tools/webSearchResultFormatter.ts:931`**: `buildDocumentContent` falls back to title when body is empty:
  ```ts
  if (parts.length === 0 && result.title.trim().length > 0) parts.push(result.title);
  ```
  So a title-only result renders as just the title repeated.

### What's Missing

No pipeline stage applies a minimum threshold on:

- Description character count
- Content length (bytes)
- `contentKind` (every non-Exa provider sets `snippet`; no minimum richness gate)
- Combined description + extraSnippet length

**Impact:** Title-only and near-empty results survive all the way to final output, consuming a rank slot and degrading perceived quality.

### Fix Sketch

Add a lightweight filter after `isNavigationOnlySearchResult` at `webSearch.ts:743`:

```ts
const usableItems = finalItems.filter(
  (item) => !isNavigationOnlySearchResult(item) && hasMinimumContent(item),
);
```

Where `hasMinimumContent` returns false when `description.length + (extraSnippet ?? '').length < N` (e.g. 60 chars) AND title is also empty/very short. This prevents truly empty results from reaching the formatter.

---

## (b) Semantic Rerank Ignores Richness — Thin Can Outrank Rich

### Evidence

**Signal extraction** (`src/utils/rescore.ts:140-175`):

```ts
signals: {
  domainAuthority: ...,
  recency: ...,
  hasDeepLinks: ...,
  // Optionally: yearAlignment
}
```

**No richness signal** (`contentKind`, `contentLength`) is extracted.

**Multi-signal rescore** (`src/config.ts:106-113`):

```
rrfAnchor: 0.45, domainAuthority: 0.25, recency: 0.12, yearAlignment: 0.12, hasDeepLinks: 0.05
```

Sum = 0.99. **Zero weight for content richness.**

**Semantic rerank** (`src/utils/semanticMatch.ts:139-176`):

- Embeds `title + description` only (`webSearch.ts:440`)
- Sort key: cosine bucket (0.05 band) → authority → cosine → index
- `authorityFloor` (`semanticMatch.ts:156-165`) is a **tiebreaker within 0.05 cosine buckets**, not a richness proxy
- **No richness signal** in the sort key

### Scenario: Thin Outranking Rich

Consider two results for the same query:

1. **Thin**: DuckDuckGo snippet, 80 chars description, high cosine (0.92) with query, authority 0.5
2. **Rich**: Exa full page text, 8000 chars, good cosine (0.87), authority 0.7

After `multiSignalRescore`, if result-1 scores higher (e.g. better rrfAnchor + recency), it ranks above result-2. Then semantic rerank embeds both, and result-1's higher cosine puts it first. **The rich result's content advantage is invisible to all scoring.**

Richness is only used as a tiebreaker within the **same score bucket** (`SCORE_EPSILON = 1e-6`) in:

- `mergeSearchResults` (`searchMerge.ts:211-218`)
- `applyBoundedCodexPreference` (`webSearch.ts:785-789`)

These buckets are extremely narrow — effectively, richness only matters when two results have **identical** composite scores.

### Fix Sketch

Add a `contentRichness` signal to `extractWebSearchSignals` (rescore.ts) with a small weight (e.g. 0.03-0.05), or add a richness multiplier post-semantic-rerank. Alternatively, boost the `authorityFloor` usage in semantic rerank to consider richness within a wider relevance band.

---

## (c) Adaptive Budget Does NOT Starve Rich Results — But Slots Are Wasted

### Evidence

**Adaptive budget** (`src/tools/webSearchResultFormatter.ts:94-100`):

```ts
const share = Math.floor((totalBudget * ADAPTIVE_TOTAL_UTILIZATION) / resultCount);
// With 10 results: share = floor(192*1024*0.9/10) = 17,694 bytes (~17 KiB)
// Floor: 8 KiB, Ceiling: 24 KiB
```

**Rendering loop** (`src/tools/webSearchResultFormatter.ts:1261-1272`):

```ts
for (let i = 0; i < results.length; i++) {
  const { text: doc, truncated: dt } = formatDocument(result, i + 1, aiSummary, docBudget, full);
  const candidate = text + doc + '\n';
  if (utf8Length(candidate) > contentBudget) {
    truncated = true;
    break;
  }
  text = candidate;
}
```

A thin result (e.g. 500 bytes of actual content) consumes ~500 bytes of the total 192 KiB budget, **NOT** its full per-document allocation. So thin results don't consume disproportionate byte budget.

**However**, the real "starvation" is at the **rank-slot level**: thin results occupy positions in the `limit`-capped output. With `limit=10` and 4 thin results ranking in the top 10, only 6 rich results get through. The thin results didn't need to be there.

### Fix Sketch

The fix is upstream: ranking improvements (finding b) and minimum-content filtering (finding a) will naturally push thin results out of the top slots. No formatter change needed.

---

## (d) Dedup Correctly Keeps Richer — But Single-Source Thin Results Have No Richer Partner

### Evidence

All dedup paths correctly prefer richer representations:

- **`src/tools/webSearch.ts:134-170`** (`mergeDedupProvenance`): Uses `richerThan()` — richer wins ✓
- **`src/tools/webSearch.ts:180-276`** (`restoreRrfProvenance`): Picks richest across rankings ✓
- **`src/utils/searchMerge.ts:98-120`** (`selectRicherResult`): Uses `richerThan()` — richer wins ✓

**No dedup bug here.** The richer representation always wins when duplicates exist.

**But**: every non-Exa provider sets `contentKind: 'snippet'` (see `braveSearch.ts:365`, `duckduckgoSearch.ts:98`, `searxngSearch.ts:123`, `tavilySearch.ts:188`, `codexSearch.ts:276`). When a URL appears in only ONE backend (no cross-backend duplicate), its snippet representation is the only option. There's no richer partner to select from.

Cross-check with cluster A: this is consistent with the existing diagnostic's observation that `contentKind` is uniformly `snippet` across most providers (`web-search-ranking-quality.md:155-168`).

### Fix Sketch

This is not a dedup fix but a producer-side enrichment: backends that can provide richer content (Exa's `text` endpoint, Brave's page extraction) should do so more aggressively. The existing `webSearchDocEnrich.ts` enrichment (PDF/office documents only) could be broadened to crawl top-ranked thin results.

---

## (e) Result Cap Surfaces Noise — No Quality Gate Before `slice(0, limit)`

### Evidence

**Result cap** (`src/tools/webSearch.ts:745`):

```ts
return usableItems.slice(0, limit).map(...)
```

The pipeline before the cap:

1. `mergeSearchResults` scoring — `engineAgreement*0.4 + domainAuthority*0.3 + position*0.3` (`searchMerge.ts:183-184`). **No richness signal.**
2. Cross-query dedup — richest wins, but only among duplicates
3. `multiSignalRescore` — `rrfAnchor*0.45 + domainAuthority*0.25 + recency*0.12 + yearAlignment*0.12 + hasDeepLinks*0.05`. **No richness signal.**
4. `applyBoundedCodexPreference` — richness only as intra-bucket tiebreaker
5. Optional semantic rerank — cosine similarity only
6. `applyExplicitYearIntentOrder` — year grouping
7. `isNavigationOnlySearchResult` filter — very narrow
8. `slice(0, limit)`

**No stage before the cap considers how thin the content is.** A high-authority, high-relevance snippet with only 80 chars of description will be ranked above and included before a lower-scored but substantially richer result.

### Fix Sketch

Insert a thinness penalty into `multiSignalRescore` (e.g. a `contentDepth` signal derived from `contentLength`), or apply a soft rank demotion for results below a content-length threshold. This naturally pushes thin results below richer alternatives.

---

## Root Cause Summary

| #   | Finding                                                                 | Severity | File:Line                                                 | Fix                                              |
| --- | ----------------------------------------------------------------------- | -------- | --------------------------------------------------------- | ------------------------------------------------ |
| A1  | **No minimum-content filter** — empty/thin results survive to rendering | CRITICAL | `webSearch.ts:743`, `webSearchResultFormatter.ts:944-956` | Add `hasMinimumContent()` filter                 |
| A2  | **Richness absent from all scoring signals** — thin can outrank rich    | HIGH     | `rescore.ts:140-175`, `config.ts:106-113`                 | Add `contentDepth` signal to rescore             |
| A3  | **Semantic rerank ignores content richness**                            | HIGH     | `semanticMatch.ts:139-176`, `webSearch.ts:440`            | Enrichment before rerank, or richness multiplier |
| A4  | **Result cap has no quality gate**                                      | MEDIUM   | `webSearch.ts:745`                                        | Thinness demotion in ranking                     |
| A5  | **All providers emit snippet-kind content**                             | LOW      | Provider files (see cluster A)                            | Broaden doc enrichment                           |

## Adjacent Parity-Blockers

- **Cluster A's domain authority gaps** (DOMAIN_AUTHORITY map missing IEEE, ACM, etc.) compound this: thin results from high-authority but unlisted domains rank lower than they should, making the thin-vs-rich gap more visible.
- **Provider `age: null` sparsity** (cluster A H3) removes a ranking signal that could otherwise differentiate results, making the system more reliant on the signals that DO exist — none of which include richness.
- **The `isNavigationOnlySearchResult` classifier** (finding A1) is deliberately conservative — widening it risks dropping legitimate sparse results (academic papers with short abstracts, API docs with minimal snippets). Any minimum-content filter must be equally cautious.
