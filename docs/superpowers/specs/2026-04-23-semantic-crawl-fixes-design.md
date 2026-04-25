# Design: `semantic_crawl` Quality & Maturity Fixes

**Date:** 2026-04-23  
**Status:** Approved

## Overview

This spec addresses quality and maturity gaps discovered through live testing of the `semantic_crawl` tool against real documentation sites. The issues fall into three severity tiers based on observed impact:

**P0 — Active harm (breaks core value proposition):**

1. **Reranker is a no-op** — Every test with `useReranker=true` produced bit-for-bit identical results to `useReranker=false` (same chunks, same ordering, same biEncoderScores). The reranker code path exists but silently produces identity.
2. **RRF fusion overweights noisy BM25 matches** — The bi-encoder is working correctly (e.g., "USER instruction" chunk scores 0.686, highest in corpus). But RRF merges bi-encoder + BM25 rankings, and BM25 finds keyword matches in cookie banners and nav content. On large noisy corpora (116 chunks), a cookie banner chunk (0.426) outranks the semantically best chunk (0.686) because the banner also matched query terms like "configure".

**P1 — Silent failure (infrastructure broken):** 3. **Cache is in-memory only** — Corpora built in one call are evicted by the next call seconds later. Disk cache files exist but are never read back. The cache is a tiny in-memory LRU with no persistence. 4. **Crawler focus drift** — Multi-page crawls follow navigation links away from the seed URL's content area and never return (Dockerfile reference → CLI config pages). 5. **Noise chunk contamination** — Cookie banners, language selectors, and social media footers are indexed as content and survive all boilerplate filters.

**P2 — Quality gaps (original spec, lower priority until P0/P1 fixed):** 6. **Keyword blindness** — Semantic retrieval alone misses exact keyword matches, numbers, and named entities. 7. **maxPages bug** — crawl4ai returns more pages than requested. 8. **Cache ephemerality** — 24h TTL, no schema versioning, `process.cwd()` path. 9. **Score invisibility** — BM25, RRF, and reranker scores absent from output.

### Key Finding: Bi-encoder Works; Downstream Is Broken

Live testing confirms the semantic retrieval pipeline (crawl → chunk → embed → cosine similarity) is functioning correctly. "My program is slow even though I used threads" → correctly retrieved the GIL blocking chunk with zero keyword overlap. The problem is entirely downstream: noise in the corpus poisons BM25, RRF overweights that poison, the reranker never runs to correct it, and the cache rebuilds every time.

**Priority order:** Fix P0 (noise filtering + RRF candidate pool quality) before P1 (cache persistence + reranker fix), before P2 (score observability + lexical constraints).

**Note on BM25 integration:** The bi-encoder pipeline alone is working correctly and could ship as a semantic-only retrieval system. BM25 is being retained to solve keyword blindness (exact names, numbers, version strings) which is a real use case for technical documentation queries. However, BM25's promiscuity on noisy corpora is the root cause of the RRF poisoning described in §3. The fixes in §1 (noise filtering) and §3 (pool restriction) are the cost of keeping BM25. If noise filtering proves insufficient in practice, a viable fallback is to disable BM25 entirely and rely on bi-encoder + reranker once the reranker is fixed.

---

## 1. Rendered-UI Filtering (Cookie Banners, Consent Managers)

### Problem

crawl4ai captures JavaScript-rendered cookie consent UIs as document content. OneTrust, Cookiebot, and similar consent managers produce multi-paragraph text that survives all existing boilerplate filters because it has low link density and looks like prose. These chunks then pollute BM25 matching and RRF fusion.

### Solution

Add a **page-level pre-chunking filter** that detects and drops pages dominated by cookie-banner content. If this filter is effective, the RRF candidate pool restriction (§3) becomes less critical because the corpus will already be clean.

**Detection:**
A page is dropped if >40% of its non-empty lines match any of these patterns (case-insensitive):

- Exact substrings: `"OneTrust"`, `"Cookiebot"`, `"cookie consent"`, `"Your Privacy Choices"`, `"Manage Cookies"`, `"Accept All Cookies"`, `"We use cookies to"`, `"By continuing to use this site"`
- Structural: 3+ consecutive lines where every line contains one of `cookie`, `consent`, `privacy`, `tracking`, `gdpr`, `ccpa`, and at least one line contains a button pattern (`[Accept]`, `[Reject]`, `[Manage]`)

```typescript
function isCookieBannerPage(markdown: string): boolean {
  const lines = markdown.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const bannerLines = lines.filter((l) => COOKIE_PATTERNS.some((p) => p.test(l)));
  return bannerLines.length / lines.length > 0.4;
}
```

Runs in `pagesToCorpus` before `chunkMarkdown`. Dropped pages are logged with a warning.

**Interaction with §3:** If §1 is effective and removes the dominant noise source (cookie banners), the RRF candidate pool restriction becomes a safety margin rather than a critical fix. Both should be implemented, but §1 has higher marginal value per page removed.

### Backwards compatibility

No API change. Some noisy pages are dropped — this is desirable.

---

## 2. Crawler Focus Filter

### Problem

Multi-page crawls follow navigation links away from the seed URL's content area. Crawling `docs.docker.com/reference/dockerfile/` with `maxPages=20` returned CLI config pages instead of Dockerfile content.

### Solution

Add a **URL path-prefix filter** after `webCrawl` returns, before page deduplication.

**Algorithm:**

1. Extract the seed URL's pathname (e.g., `/reference/dockerfile/`).
2. Keep only pages whose pathname starts with the seed pathname or is a direct child (one segment deeper).
3. Log count of dropped pages.

```typescript
function isDirectChild(pagePath: string, seedPath: string): boolean {
  // A direct child is one path segment deeper than the seed.
  // e.g. seed=/reference/dockerfile/ -> /reference/dockerfile/build/ is direct
  // e.g. seed=/reference/dockerfile/ -> /reference/dockerfile/build/args/ is NOT direct
  const seedParts = seedPath.split('/').filter(Boolean);
  const pageParts = pagePath.split('/').filter(Boolean);
  return (
    pageParts.length === seedParts.length + 1 &&
    pageParts.slice(0, seedParts.length).join('/') === seedParts.join('/')
  );
}

function filterByPathPrefix(pages: CrawlPageResult[], seedUrl: string): CrawlPageResult[] {
  const seedPath = new URL(seedUrl).pathname;
  return pages.filter((p) => {
    const pagePath = new URL(p.url).pathname;
    return pagePath.startsWith(seedPath) || isDirectChild(pagePath, seedPath);
  });
}
```

**Note on depth:** `isDirectChild` allows exactly one additional path segment. Pages nested deeper (e.g. /a/b/c/d when seed is /a/b/) are dropped unless `allowPathDrift: true` is set. This prevents the crawler from disappearing into deep sub-trees (e.g. CLI reference pages from a Dockerfile reference seed).

**Escape hatch:** `allowPathDrift: boolean` parameter (default `false`).

### Backwards compatibility

No API change. Default behavior tightens focus. Old behavior via `allowPathDrift: true`.

---

## 3. RRF Candidate Pool Restriction

### Problem

RRF merges bi-encoder and BM25 rankings over the full corpus. On noisy corpora, BM25 finds keyword matches in cookie banners and nav content. A chunk with high bi-encoder score but no BM25 match can be outranked by a noisy chunk with medium bi-encoder score + a BM25 match.

Example (116-chunk Dockerfile corpus, query "configure PORT=8080"):

- USER instruction chunk: bi-encoder rank 1 (0.686), no BM25 match → RRF ≈ 0.016
- Cookie banner chunk: bi-encoder rank ~30 (0.426), BM25 rank ~5 (matches "configure") → RRF ≈ 0.016 + 0.016 = 0.032
- Result: cookie banner outranks the semantically best chunk.

### Solution

Restrict the RRF candidate pool to the **top-N bi-encoder results** instead of the full corpus, then inject BM25 matches. This limits BM25's ability to surface noise from the long tail.

```
Pipeline step (after bi-encoder ranking):
  biEncoderTopN   = top N bi-encoder results (N = max(topK * 3, 30))
  bm25TopK      = top K BM25 results
  candidatePool = deduped union of biEncoderTopN + bm25TopK
  fused         = rrfMerge([biEncoderTopN, bm25TopK]) over candidatePool only
```

- `N = max(topK * 3, 30)` ensures the pool is large enough for diversity but small enough to exclude long-tail noise.
- BM25 results that fall outside `biEncoderTopN` are still included via the union.
- This is a guarantee of _pool inclusion_, not _output inclusion_.

### Backwards compatibility

No API change. The set of returned chunks may shrink (only from the candidate pool), and lexical matches may rise in rank.

---

## 4. Cache Persistence Fix

### Problem

Corpora built in one call are evicted by the next call seconds later. Disk cache files exist (`.cache/semantic-crawl/`) but are never read back. The cache is a tiny in-memory LRU with no persistence.

### Root Cause Analysis

`getOrBuildCorpus` calls `readCorpusFromDisk` only after scanning `.json` files and matching by source. The scan uses `stableStringify(e.source) === sourceKey`. If the metadata JSON doesn't round-trip through `stableStringify` identically (e.g., URL ordering differences in `urls` array, or field ordering), the match fails. Additionally, `contentHash` is written but never validated on read.

### Solution

**Validate content hash on read:**

- Recompute hash from `meta.chunks.map(c => c.text).join('\n')` in `readCorpusFromDisk`.
- If mismatch → log warning, return `null`, trigger rebuild.

**Add schema version check:**

- `readCorpusFromDisk` rejects caches without `schemaVersion: 1`.

**Fix source matching:**

- Instead of scanning `.json` files and comparing `stableStringify(source)`, compute the `corpusId` deterministically and check if `{corpusId}.json` exists directly.
- This removes the fragile source-matching scan entirely.

**Environment variable overrides:**

- `SEMANTIC_CRAWL_CACHE_DIR` — cache directory (default: `path.join(os.homedir(), '.cache', 'search-mcp', 'semantic-crawl')`).
- `SEMANTIC_CRAWL_CACHE_TTL_MS` — TTL in ms (default: 7 days).

**Include chunking parameters in corpusId:**

```
sha256(stableStringify(source) + "|" + model + "|" + dimensions + "|" + MAX_TOKENS + "|" + MIN_TOKENS + "|" + OVERLAP_RATIO + "|" + TOKEN_RATIO)
```

### Backwards compatibility

Old caches are silently discarded and rebuilt. This is a one-time migration cost.

---

## 5. Reranker Fix or Removal

### Problem

`useReranker=true` produces identical output to `useReranker=false`. The reranker is either silently failing (catch block swallows error) or the ONNX model is producing identity rankings.

### Diagnosis

1. The catch block in `embedAndRank` logs `logger.warn({ err }, 'Cross-encoder re-ranking failed...')` and falls back to bi-encoder order.
2. The model `Xenova/ms-marco-MiniLM-L-6-v2` may be a bi-encoder ONNX export rather than a cross-encoder. Feeding `[query, doc]` pairs to a bi-encoder and reading `output.data[0]` as a score produces uncorrelated values.

### Solution

**Immediate: Add smoke-test on model load.**

- After `getSession()` loads the model, run a validation inference:
  - `query="hello world", doc="hello world"` → score A
  - `query="hello world", doc="xyz abc def"` → score B
  - Assert `A > B + 0.1`.
- The `0.1` threshold is derived from empirical ms-marco MiniLM cross-encoder score distributions, where good matches typically score ≥ 5 and bad matches ≤ 2. A 0.1 margin is extremely conservative relative to this spread; any model producing scores within 0.1 of each other for these two pairs is not functioning as a cross-encoder.
- If assertion fails, log `fatal` error and refuse to use reranker for process lifetime.

**Make reranker opt-in:**

- Change `embedAndRank` default: `useReranker` defaults to `false`.
- When explicitly enabled and smoke-test passes, log `info` that reranker is active.

**Model replacement (if smoke-test fails):**

- If `Xenova/ms-marco-MiniLM-L-6-v2` fails smoke-test, replace with a verified cross-encoder ONNX export (e.g., `cross-encoder/ms-marco-MiniLM-L-6-v2` via Optimum quantization).

### Backwards compatibility

Reranker becomes opt-in (`false` by default). Callers that explicitly set `useReranker: true` will still get reranked results if the model passes smoke-test, with a warning if it fails.

---

## 6. maxPages Client-Side Enforcement

### Problem

crawl4ai returns more pages than requested, especially in DFS mode.

### Solution

Client-side truncation per-seed after crawl4ai returns:

```typescript
let pages = crawlResult.pages;
// Guarantee the seed URL is first before truncating, since crawl4ai does not
// guarantee ordering (especially in DFS mode the seed may not be first).
const seedIndex = pages.findIndex((p) => p.url === seedUrl);
if (seedIndex > 0) {
  const [seedPage] = pages.splice(seedIndex, 1);
  pages.unshift(seedPage);
}
if (pages.length > perSeedPages) {
  logger.warn(
    { requested: perSeedPages, received: pages.length, seedUrl },
    'semantic_crawl: crawl4ai returned more pages than requested; truncating client-side',
  );
  pages = pages.slice(0, perSeedPages);
}
```

Applied in `crawlSeeds` per-seed, not globally.

### Backwards compatibility

No API change. Returned pages now strictly respect `maxPages`.

---

## 7. Score Observability

### Problem

Consumers cannot interpret or compare scores. Reranker logits are uncalibrated, BM25 scores are absent, and RRF scores are internal-only.

### Solution

Add a `scores` object to every `SemanticCrawlChunk`:

```typescript
export interface ScoreDetail {
  raw: number; // original score (cosine, BM25, RRF sum, logit)
  normalized: number; // 0-1 scale: (raw - minQuery) / (maxQuery - minQuery), or 0 if max === min
  minQuery: number;
  maxQuery: number;
  median: number;
}

export interface RerankScoreDetail extends ScoreDetail {
  medianDelta: number; // raw - median
  rank: number; // 1-based position after reranking
}

export interface SemanticCrawlChunk {
  text: string;
  url: string;
  section: string;
  charOffset: number;
  chunkIndex: number;
  totalChunks: number;
  scores: {
    biEncoder: ScoreDetail;
    bm25: ScoreDetail;
    rrf: ScoreDetail;
    rerank?: RerankScoreDetail;
  };
}
```

**Old fields removed:** `biEncoderScore` and `rerankScore`.

### Backwards compatibility

Breaking change to output schema. Callers must update to use `scores.biEncoder.raw`, etc.

---

## 8. Soft Lexical Constraint

### Problem

Without a lexical filter, noise chunks with spurious keyword matches can survive to the output.

### Solution

Replace hard filter with IDF-weighted token coverage (same as original spec §2):

1. Tokenize query, remove stopwords.
2. Compute IDF for each token against corpus.
3. Select top-3 highest-IDF tokens.
4. Chunk satisfies constraint if it contains at least 2 of these 3 tokens.
5. After RRF fusion, filter the **RRF-restricted candidate pool** (not the full corpus). If fewer than `topK` satisfy, return all satisfying chunks from that pool.

**Edge cases:**

- Query has < 3 non-stopword tokens → require all.
- Query has only stopwords → skip constraint.
- No chunk satisfies → return the full RRF-restricted candidate pool (the pre-filtered ranked list) + warning in `meta.warnings`. The fallback is relative to the RRF pool, not the original corpus.

**Interaction with §3:** Because §3 already restricts the candidate pool to top-N bi-encoder + top-K BM25 results, the soft constraint operates on a relatively clean subset. For small `topK` on noisy corpora, zero-satisfaction is possible; the fallback prevents returning empty results.

### Backwards compatibility

No API change. `meta.warnings` is additive.

---

## Error Handling

| Scenario                                    | Behavior                                                |
| ------------------------------------------- | ------------------------------------------------------- |
| Cookie-banner page detected                 | Drop page with warning, continue                        |
| Crawler path drift detected                 | Filter to path-prefix pages, log count of dropped pages |
| Cache content-hash mismatch                 | Log warning, rebuild silently                           |
| Cache schemaVersion missing                 | Reject, rebuild silently                                |
| Cache directory creation fails              | Log warning, continue without disk cache                |
| Reranker smoke test fails                   | Log fatal, refuse reranker for process lifetime         |
| Soft lexical constraint yields zero matches | Return unfiltered result + warning                      |
| Score normalization denominator is zero     | Set `normalized = 0`, continue                          |
| crawl4ai returns > maxPages                 | Truncate client-side, log warning, continue             |

---

## Testing Strategy

1. **Cookie-banner filter test** — Provide a page that is 50% OneTrust text. Assert `pagesToCorpus` drops it.
2. **Crawler focus filter test** — Provide pages from `/reference/dockerfile/` and `/cli/config/`. Assert only `/reference/dockerfile/` pages survive.
3. **RRF candidate pool test** — Build synthetic corpus: 100 noise chunks + 5 relevant chunks. Query "configure PORT=8080". Assert top-3 contains the relevant chunk and no noise chunks.
4. **Cache persistence test** — Build corpus, wait 1s, load by corpusId. Assert loaded without rebuild.
5. **Reranker smoke-test test** — Mock ONNX session with inverted scores. Assert `getSession()` detects inversion and refuses to rerank.
6. **maxPages enforcement test** — Mock crawl4ai to return 27 pages when 15 requested. Assert `crawlSeeds` returns exactly 15 and logs warning.
7. **Score observability test** — Assert every returned chunk has `scores.biEncoder`, `scores.bm25`, `scores.rrf`.
8. **Soft lexical constraint test** — Query with stopwords only ("how to do it"). Assert no filtering and no warning.
9. **Integration test: semantic-only regression** — Query "GIL blocking" against a known corpus. Assert the GIL-related chunk is still retrieved in top-3 after all filtering and RRF changes. This verifies that the P0/P1 fixes do not regress the working bi-encoder pipeline.
10. **Integration test: noise + RRF interaction** — Build a corpus with 100 noise chunks + 5 relevant chunks. Enable cookie-banner filtering + RRF pool restriction + soft lexical constraint. Query "configure PORT=8080". Assert top-3 contains the relevant chunk and zero noise chunks, and no `meta.warnings` about lexical fallback.

---

## Open Questions

1. **`isDirectChild` depth limit:** The one-segment-deep rule may be too restrictive for doc sites with deep hierarchies (e.g. `/docs/concepts/services/auth/oauth2/flows/`). We may need to relax this to "starts with seedPath plus up to 2 additional segments" based on real-world testing.
2. **Smoke-test epsilon:** The `0.1` threshold is conservative for ms-marco MiniLM but may need tuning if we switch to a different cross-encoder ONNX export.
3. **TOKEN_RATIO in corpusId:** The corpusId hash includes `TOKEN_RATIO`, but this constant is defined in `chunking.ts` and may change. If it changes, all caches invalidate. This is correct behavior (cache should invalidate when chunking changes), but the spec does not define TOKEN_RATIO itself — it references the existing constant.
4. **§3 + §8 interaction on small corpora:** For corpora where `topK * 3` produces a very small pool (e.g. topK=2, pool=6), the soft lexical constraint may over-filter. The fallback path handles this, but we should monitor whether the warning fires frequently in production.
