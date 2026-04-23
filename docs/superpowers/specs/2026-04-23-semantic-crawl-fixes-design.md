# Design: `semantic_crawl` Quality & Maturity Fixes

**Date:** 2026-04-23
**Status:** Approved

## Overview

This spec addresses four observed quality and maturity gaps in the existing `semantic_crawl` tool:

1. **Keyword blindness** — semantic-only retrieval misses exact keyword matches, numbers, and named entities because bi-encoder embeddings collapse around task semantics (e.g., "configure PORT" maps closer to ENTRYPOINT than EXPOSE).
2. **DFS maxPages bug** — crawl4ai returns more pages than requested (observed: 27 pages when `maxPages=15`), especially in DFS mode.
3. **Cache ephemerality** — corpus cache is stored relative to `process.cwd()`, expires quickly (24h default), corpusId lacks schema/model versioning, and old-format caches are not rejected gracefully.
4. **Reranker invisibility** — reranker scores are uncalibrated logits (e.g., -4.4 to +4.4) with no interpretable baseline, and BM25/RRF scores are completely absent from output.

These fixes are applied as an additive layer on top of the existing architecture defined in `2026-04-23-semantic-crawl-design.md`.

---

## 1. Global Lexical Floor

### Problem
RRF fusion between bi-encoder and BM25 is democratic: if BM25 scores are low relative to semantic scores, lexical matches can still be buried below semantically similar but lexically irrelevant chunks.

### Solution
Before RRF fusion and before optional cross-encoder reranking, always inject the top-3 BM25 results into the candidate pool. These results are guaranteed a slot in the pool regardless of their bi-encoder score.

```
Pipeline step (after bi-encoder ranking, before RRF):
  biEncoderTopK   = top N from cosine similarity
  bm25Top3      = top 3 from BM25 search
  candidatePool = deduped union of biEncoderTopK + bm25Top3
```

- If a BM25 result already exists in `biEncoderTopK`, it is not duplicated.
- The `candidatePool` is then passed to RRF fusion. The BM25 results participate in fusion even if their bi-encoder score would have excluded them.
- This guarantees that strong lexical matches are never invisible to the downstream ranking stages.
- **Important:** This is a guarantee of *pool inclusion*, not *output inclusion*. The soft lexical constraint (§2) may still filter out a BM25 top-3 result if it fails the IDF-coverage check.

### Backwards compatibility
No API change. The set of returned chunks may expand slightly (still capped by `topK`), and lexical matches may rise in rank.

---

## 2. Soft Lexical Constraint

### Problem
The "all tokens must match" hard filter is too brittle for natural language queries with stopwords, variations, and filler.

### Solution
Replace the hard filter with a soft constraint based on IDF-weighted token coverage.

**Algorithm:**
1. Tokenize the query with the same tokenizer as BM25 (`/\b\w+\b/g`, lowercased).
2. Remove English stopwords: `a`, `an`, `the`, `is`, `are`, `was`, `were`, `be`, `been`, `being`, `have`, `has`, `had`, `do`, `does`, `did`, `will`, `would`, `could`, `should`, `may`, `might`, `must`, `shall`, `can`, `need`, `dare`, `ought`, `used`, `to`, `of`, `in`, `for`, `on`, `with`, `at`, `by`, `from`, `as`, `into`, `through`, `during`, `before`, `after`, `above`, `below`, `between`, `under`, `and`, `but`, `or`, `yet`, `so`, `if`, `because`, `although`, `though`, `while`, `where`, `when`, `that`, `which`, `who`, `whom`, `whose`, `what`, `this`, `these`, `those`, `i`, `you`, `he`, `she`, `it`, `we`, `they`, `me`, `him`, `her`, `us`, `them`, `my`, `your`, `his`, `its`, `our`, `their`.
3. Compute IDF for each remaining token against the current corpus using the same IDF formula as BM25: `ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1)`.
4. Sort tokens by IDF descending (rarest first).
5. Select the top-3 highest-IDF tokens as the coverage requirement set.
6. A chunk satisfies the constraint if it contains **at least 2 of these 3 tokens** (case-insensitive whole-word match via the same tokenizer).
7. After RRF fusion, filter the ranked list to only chunks that satisfy the constraint. If fewer than `topK` chunks satisfy it, return all satisfying chunks (may be fewer than `topK`).

### Edge cases
- If the query has fewer than 3 non-stopword tokens, require coverage of **all** non-stopword tokens.
- If the query has only stopwords (e.g., "how to do it"), skip the constraint entirely — return the unfiltered RRF result.
- If no chunk satisfies the constraint, return the unfiltered RRF result and append `"lexical constraint skipped: no chunks matched the IDF coverage requirement"` to `meta.warnings`.

### Backwards compatibility
No API change. The returned chunks may be more keyword-relevant. The warning field is additive.

---

## 3. Score Observability

### Problem
Consumers cannot interpret or compare scores across queries. Reranker logits are uncalibrated (-4.4 to +4.4), BM25 scores are absent, and RRF scores are internal-only.

### Solution
Add a `scores` object to every `SemanticCrawlChunk` in the tool output. Each score type contains: raw value, normalized value, and query-level statistics for context.

```typescript
export interface ScoreDetail {
  raw: number;           // original score (cosine, BM25, RRF sum, logit)
  normalized: number;    // 0-1 scale: (raw - minQuery) / (maxQuery - minQuery), or 0 if max === min
  minQuery: number;      // minimum raw score across all chunks for this query
  maxQuery: number;      // maximum raw score across all chunks for this query
  median: number;        // median (p50) raw score for this query — the only robust percentile for small candidate pools
}

export interface RerankScoreDetail extends ScoreDetail {
  medianDelta: number;   // raw score - median raw score across all reranked chunks (logit deviation from center)
  rank: number;          // 1-based position after reranking
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

**Computation:**
- `minQuery`, `maxQuery`, `median` are computed once per score type across all chunks in the final result set (post-filtering, pre-truncation to `topK`).
- `normalized` is `0` when `maxQuery === minQuery` (all identical) to avoid division by zero.
- `rerank.medianDelta` helps consumers understand whether a reranked chunk is above or below the typical rerank score for this query (`raw - median`). Positive = better than median.
- `rerank.rank` is the 1-based position after reranking, so consumers can see reordering effects.

**Old fields removed:** `biEncoderScore` and `rerankScore` (the flat numbers) are replaced by the nested `scores` object.

### Backwards compatibility
This is a breaking change to the output schema. The old flat score fields are removed. Callers must update to use `scores.biEncoder.raw`, `scores.rerank?.raw`, etc.

---

## 4. Cache Versioning

### Problem
The corpus cache ID is `sha256(source + model + dimensions)` with no chunking or schema version. Changing chunking parameters silently produces stale or incompatible caches. Old caches are not rejected — they are loaded as-is, which may produce wrong `totalChunks`, wrong offsets, or crashes.

### Solution
Include chunking parameters in the corpus ID hash. Reject old-format caches gracefully.

**New corpus ID formula:**
```
sha256(stableStringify(source) + "|" + model + "|" + dimensions + "|" + MAX_TOKENS + "|" + MIN_TOKENS + "|" + OVERLAP_RATIO + "|" + TOKEN_RATIO)
```

Where:
- `stableStringify` is the recursive key-sorting JSON serializer already used in `corpusCache.ts`. Arrays are serialized in their original order; objects have keys sorted lexicographically. For a single URL this is just the URL string.
- `MAX_TOKENS` = 400 (chunking max, from `src/chunking.ts`)
- `MIN_TOKENS` = 50 (chunking min, from `src/chunking.ts`)
- `OVERLAP_RATIO` = 0.2 (chunk overlap, from `src/chunking.ts`)
- `TOKEN_RATIO` = 4 (chars-per-token estimate, from `src/chunking.ts`)

These values are imported from `src/chunking.ts` at runtime, not hardcoded, so if chunking constants change, the cache auto-invalidates.

**Cache rejection:**
- `readCorpusFromDisk` checks for a `schemaVersion` field in metadata. If missing or not equal to `1`, reject the cache (return `null`) and let `getOrBuildCorpus` rebuild.
- New caches are written with `schemaVersion: 1`.
- `contentHash` (from the materialize result) is still checked; if the crawled content hash differs, the cache is also rebuilt.

### Backwards compatibility
Old caches are silently discarded and rebuilt. This is a one-time migration cost.

---

## 5. Stable Cache Directory & TTL

### Problem
Cache is stored at `path.join(process.cwd(), '.cache', 'semantic-crawl')`, which moves depending on where the server is launched. The 24-hour TTL is too short for stable documentation sites.

### Solution
- **Default cache directory:** `path.join(os.homedir(), '.cache', 'search-mcp', 'semantic-crawl')`.
- **Override:** `SEMANTIC_CRAWL_CACHE_DIR` environment variable.
- **Default TTL:** increase to 7 days (`7 * 24 * 60 * 60 * 1000` ms).
- **Override:** `SEMANTIC_CRAWL_CACHE_TTL_MS` environment variable.
- **Max corpora:** remain at 50.
- **Override:** `SEMANTIC_CRAWL_MAX_CORPORA` environment variable.

### Backwards compatibility
No API change. Existing caches at the old `process.cwd()` path are orphaned and will be rebuilt at the new location. This is acceptable because caches are ephemeral by design.

---

## 6. maxPages Enforcement

### Problem
crawl4ai may return more pages than requested, especially in DFS mode where `maxPages` is treated as a hint rather than a hard limit.

### Solution
Client-side truncation in `crawlSeeds` after crawl4ai returns.

```typescript
// In crawlSeeds(), after receiving results from crawl4ai:
let pages = crawlResult.pages;
if (pages.length > perSeedPages) {
  logger.warn(
    { requested: perSeedPages, received: pages.length, seedUrl },
    'semantic_crawl: crawl4ai returned more pages than requested; truncating client-side'
  );
  pages = pages.slice(0, perSeedPages);
}
```

- This is applied per-seed, not globally, because `crawlSeeds` divides `maxPages` across seeds.
- The warning log includes both the requested and received counts so operators can detect crawl4ai drift.

### Backwards compatibility
No API change. The number of returned pages now strictly respects `maxPages`.

---

## Future Work (out of scope)

### IDF-Weighted Query Embedding

The bi-encoder treats every query token equally. An approach that weights rare tokens more heavily (e.g., by repeating high-IDF tokens in the query string before embedding) could improve keyword specificity. However, transformer attention mechanisms do not scale linearly with token repetition — mean-pooling encoders sublinearly attenuate redundancy, and [CLS]-based models behave unpredictably under repetition. This is an empirical bet that requires controlled ablation testing before shipping. It should only be added behind an `enableIdfWeighting` flag (default `false`) with a synthetic benchmark validating improvement. Not included in this implementation cycle.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Soft lexical constraint yields zero matches | Return unfiltered result with `"lexical constraint skipped: no chunks matched the IDF coverage requirement"` appended to `meta.warnings` |
| Score normalization denominator is zero | Set `normalized = 0`, continue |
| Old-format cache on disk | Reject (return `null` from `readCorpusFromDisk`), rebuild silently |
| Cache directory creation fails | Log warning, continue without disk cache (in-memory only) |
| crawl4ai returns > maxPages | Truncate client-side, log warning, continue |

## Testing Strategy

1. **Keyword blindness regression test** — Build a synthetic corpus with four chunks: (A) "ENTRYPOINT configures the startup command", (B) "EXPOSE declares PORT=8080 for external access", (C) "WORKDIR sets the working directory", (D) "COPY copies files into the image". Query "configure PORT=8080 in Dockerfile". Assert EXPOSE (chunk B) is in top-3 and ranked above ENTRYPOINT (chunk A).
2. **Soft lexical constraint test** — Query with stopwords only (e.g., "how to do it"). Assert no filtering occurs and `meta.warnings` does not contain a lexical constraint skip message.
3. **Score observability test** — Assert every returned chunk has `scores.biEncoder`, `scores.bm25`, `scores.rrf`. When reranking is enabled, assert `scores.rerank` exists with `medianDelta` and `rank`.
4. **Cache versioning test** — Write a cache file with no `schemaVersion`. Assert `readCorpusFromDisk` returns `null`. Write a cache with `schemaVersion: 1`. Assert it loads.
5. **Cache directory test** — Set `SEMANTIC_CRAWL_CACHE_DIR` to a temp path. Run `getOrBuildCorpus`. Assert `.json` and `.bin` files appear in the temp path.
6. **maxPages enforcement test** — Mock crawl4ai to return 27 pages when 15 requested. Assert `crawlSeeds` returns exactly 15 and logs a warning.

## Open Questions (none remaining)

All design decisions have been resolved through the brainstorming process.
