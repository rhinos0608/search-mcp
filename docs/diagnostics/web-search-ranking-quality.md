# web_search Ranking/Source Quality/Freshness Diagnostic

## Scoring Flow (end-to-end)

```
Provider Fanout → Per-Query Merge → Cross-Query Dedup → Signal Extraction → Multi-Signal Rescore → Codex Tiebreak → Semantic Rerank → Formatter
```

### Phase 1: Provider Fanout (`src/tools/webSearch.ts:496-514`)

Each backend runs via `runBackend()` → returns `SearchResult[]`.

| Provider   | `age` field                                          | `contentKind`      |
| ---------- | ---------------------------------------------------- | ------------------ |
| Brave      | `age ?? page_age ?? page_fetched` (relative strings) | snippet (default)  |
| Exa        | `publishedDate` (ISO date)                           | full or summary    |
| SearXNG    | `publishedDate`                                      | snippet (default)  |
| Tavily     | **always null**                                      | snippet or summary |
| DuckDuckGo | **always null**                                      | snippet (default)  |
| Codex      | **always null**                                      | snippet            |

### Phase 2: Per-Query Merge

Two paths depending on `mergeSearchBackends` (default: true):

**Path A — `mergeSearchResults()`** (`src/utils/searchMerge.ts:158-173`):

```ts
score = min(engineAgreement / 2, 1) * 0.4 + domainAuthority * 0.3 + positionPenalty * 0.3;
```

- `engineAgreement`: count of backends returning same URL (capped at 2)
- `domainAuthority`: hardcoded `DOMAIN_AUTHORITY` map (`searchMerge.ts:8-29`)
- `positionPenalty`: `1 / ln(position + e)` — logarithmic decay

**Path B — `rrfMerge()`** (`src/utils/fusion.ts:27-93`):

```ts
score = Σ(1 / (60 + rank_i)); // Pure positional, no quality/freshness
```

### Phase 3: Cross-Query Dedup (`src/tools/webSearch.ts:574-596`)

Map by normalized URL, keeping richest representation (by `contentRichness()`) and best rrfScore.

### Phase 4: Multi-Signal Rescore

**Signal extraction** (`src/utils/rescore.ts:73-85`):

```ts
extractWebSearchSignals() → { recency, hasDeepLinks }
- recency: parseAgeToDays(age) → exp(-days/7) → minMaxNormalize()
- hasDeepLinks: (deepLinks?.length ?? 0) > 0 ? 1 : 0
```

**Scoring** (`src/utils/rescore.ts:40-71`):

```ts
combinedScore = rrfAnchor * rrfNorm + Σ(weight[key] * signals[key]);
```

**Default weights** (`src/config.ts:104-105`):

```
rrfAnchor: 0.5, recency: 0.2, hasDeepLinks: 0.05
```

### Phase 5: Bounded Codex Preference (`src/tools/webSearch.ts:655-674`)

Tiebreaks within `SCORE_EPSILON=1e-6` only; never overrides a materially higher score.

### Phase 6: Semantic Rerank (`src/utils/semanticMatch.ts:44-132`)

Pure cosine similarity of `title + description` embeddings vs query. **No domain, freshness, or quality signals.**

### Phase 7: Formatting (`src/tools/webSearchResultFormatter.ts` — `metadataLine()`)

Bare Markdown with `[N-M]` citations. The metadata line (`metadataLine()`) shows `via:` (all MCP backends that surfaced the URL, marking the content donor with `(content)`, and appending SearXNG upstream engine names as bracketed metadata), a `fetched`/`published`/`date` label for the age, a `content:` label when the content kind is non-default, and a `quality:` label with its basis (or a generic domain prior).

---

## Ranked Hypotheses (by severity)

### H1: `DOMAIN_AUTHORITY` map gaps — authoritative tech sources get default score

**Severity**: CRITICAL  
**File**: `src/utils/searchMerge.ts:8-29`

The `DOMAIN_AUTHORITY` map contains ~25 domains. **Missing entirely**:

- `ieee.org`, `acm.org`, `nature.com`, `science.org`, `springer.com`, `mdpi.com`
- `pubmed.ncbi.nlm.nih.gov`, `dl.acm.org`, `ieeexplore.ieee.org`

All missing domains fall to `getDomainAuthority()` default of `0.3` (line 94).

Meanwhile:

- `youtube.com: 0.3` — **same as IEEE**
- `medium.com: 0.5` — **higher than IEEE**
- `substack.com: 0.45` — **higher than IEEE**
- `reddit.com: 0.4` — **higher than IEEE**

**Impact**: In `mergeSearchResults` composite: `domainAuthority * 0.3`. An IEEE result gets 0.3×0.3=0.09. A Medium blog gets 0.5×0.3=0.15. That's a 0.06 score advantage for the blog — enough to flip rankings when engine agreement is tied.

**Regression seam**: `test/searchMerge.test.ts` — add authority map tests.

---

### H2: Recency decay too aggressive + no absolute freshness gate

**Severity**: HIGH  
**Files**: `src/utils/rescore.ts:19-21,73-85`, `src/utils/time.ts:7-43`

- `applyRecencyDecay(days, halfLife=7)`: exp(-days/7)
  - 7 days → 0.368
  - 30 days → 0.014
  - 600+ days (Oct 2023 → Aug 2026) → ≈0

- `minMaxNormalize` makes recency relative within the batch:
  - If ALL results have `age: null` → all recency = 0 → signal is useless
  - If one result has age and others don't → the one with age gets 1.0 (but it could be old)
  - If two results have age, 1 day vs 30 days → 1.0 vs 0.014

- **No absolute freshness filter**: no way to express "this query needs results from 2024+". An arXiv paper from Oct 2023 with `age: "2023-10-15"` gets recency ≈ 0, but its **domain authority (0.9)** and **high RRF score** (if ranked well in one backend) can still dominate.

**Impact**: Old authoritative content (arXiv 0.9 authority) outranks newer but lower-authority content. The recency signal (weight 0.2) cannot compensate when authority (0.3 factor in searchMerge) is the dominant differentiator.

**Regression seam**: `test/rescore.test.ts` — recency decay tests exist (lines 18-30).

---

### H3: 3 of 6 providers never populate `age` — recency signal is data-sparse

**Severity**: HIGH  
**Files**:

- `src/tools/tavilySearch.ts:174` — `age: null`
- `src/tools/duckduckgoSearch.ts:94` — `age: null`
- `src/tools/codexSearch.ts:250` — `age: null`

Only Brave (relative strings), Exa (ISO dates), and SearXNG (publishedDate) provide age data.

In a default config (Codex primary + all fallbacks), results from 3 of 6 providers have `age: null`. `parseAgeToDays(null)` returns `null` → recency = 0 for those results. With minMaxNormalize, only the Brave/Exa/SearXNG results with valid age get nonzero recency.

**Impact**: When the primary backend (Codex) returns results without age, the recency signal is entirely dependent on fallback providers. If Brave is the only fallback with age, only its results get a recency boost, potentially creating a "Brave boost" artifact.

**Regression seam**: `test/webSearch.test.ts` — age/rescore test at line 356.

---

### H4: Semantic rerank is source-quality agnostic

**Severity**: MEDIUM  
**File**: `src/utils/semanticMatch.ts:44-132`

Semantic rerank computes: `cosineSimilarity(embed(title + description), embed(query))`. No domain weight, no freshness, no content quality score. A sensationalist YouTube title that keyword-matches the query can achieve higher cosine similarity than a measured IEEE Spectrum article.

**Impact**: When semantic rerank is configured, it overrides the multiSignalRescore order entirely (lines 631-641 in webSearch.ts). Source quality and freshness are completely ignored.

**Regression seam**: `test/webSearch.test.ts:137-187` — semantic rerank tests exist but don't test domain-quality interaction.

---

### H5: `rrfMerge` path lacks domain quality signal

**Severity**: LOW-MEDIUM  
**File**: `src/utils/fusion.ts:27-93`

When `mergeBackends=false`, `rrfMerge` is used. RRF is purely positional: `1/(60+rank)`. No domain authority, no freshness, no content quality. The `domainAuthority` scoring from `mergeSearchResults` is lost entirely.

Most deployments use `mergeBackends=true` (the default, hardcoded in `standalone/webSearch.ts:68`), so this is a latent issue rather than a frequent one.

---

### H6: `contentKind` inconsistency across providers

**Severity**: LOW  
**Files**: Provider-specific

| Provider   | `contentKind`      | Set where?                    |
| ---------- | ------------------ | ----------------------------- |
| Brave      | unset (→ snippet)  | braveSearch.ts (not set)      |
| Exa        | full or summary    | exaSearch.ts:153              |
| SearXNG    | unset (→ snippet)  | searxngSearch.ts (not set)    |
| Tavily     | snippet or summary | tavilySearch.ts:177           |
| DuckDuckGo | unset (→ snippet)  | duckduckgoSearch.ts (not set) |
| Codex      | snippet            | codexSearch.ts:253            |

This affects `contentRichness()` dedup (searchRichness.ts) but not scoring signals. A Codex snippet always loses to an Exa "full" in dedup, which is the intended behavior.

---

## `DOMAIN_AUTHORITY` Gap Analysis

| Domain                  | Current Score  | Expected Tier | Gap       |
| ----------------------- | -------------- | ------------- | --------- |
| ieee.org                | 0.3 (default)  | 0.8-0.9       | +0.5-0.6  |
| acm.org                 | 0.3 (default)  | 0.8-0.9       | +0.5-0.6  |
| nature.com              | 0.3 (default)  | 0.85          | +0.55     |
| science.org             | 0.3 (default)  | 0.85          | +0.55     |
| springer.com            | 0.3 (default)  | 0.8           | +0.5      |
| pubmed.ncbi.nlm.nih.gov | 0.3 (default)  | 0.85          | +0.55     |
| youtube.com             | 0.3 (explicit) | 0.3           | —         |
| medium.com              | 0.5 (explicit) | 0.35-0.4      | -0.1-0.15 |

Fixing the map would shift IEEE above YouTube by 0.15 in a 2-engine match scenario (0.24 vs 0.09 contribution).

---

## Available Metadata Not Currently Used in Scoring

1. **`SearchResult.engines`**: Array of backend names. Not used as a quality signal in multiSignalRescore (only in searchMerge's engineAgreement).
2. **`SearchResult.contentKind`**: Not used as a quality signal.
3. **`SearchResult.domain`**: Only used in searchMerge's DOMAIN_AUTHORITY lookup; not available in multiSignalRescore.
4. **`DomainTrust` scores** (`src/utils/domainTrust.ts`): Comprehensive trust system (ESTABLISHED_DOMAINS, lookalike detection, TLD suspicion) — **only used in semanticCrawl.ts**, NOT in web_search.
5. **Provider-specific metadata** (e.g., Brave's `page_age`, `page_fetched`): Brave already uses these in the age field, but other providers have unused metadata.

---

## Deterministic Regression Seams

| File                       | Existing Tests                                             | Extension Point                                          |
| -------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `test/rescore.test.ts`     | recency decay, multiSignalRescore, extractWebSearchSignals | Add absolute freshness threshold, domain-quality signals |
| `test/searchMerge.test.ts` | mergeSearchResults, DOMAIN_AUTHORITY, Codex tiebreak       | Add authority map gaps, missing domain tests             |
| `test/webSearch.test.ts`   | age/rescore, semantic rerank, cross-query dedup            | Add freshness gating, provider age sparsity tests        |
| `test/codexSearch.test.ts` | Codex mapping, baseSearchConfig                            | age=null verification                                    |
| `test/exaSearch.test.ts`   | Exa mapping                                                | publishedDate → age verification                         |

---

## Compatibility Risks

1. **DOMAIN_AUTHORITY expansion**: Adding domains to the map changes scoring for ALL existing queries. Risk: a previously top-ranked blog domain could drop. Mitigation: new domains get conservative values (0.7-0.9); existing values unchanged.

2. **Recency half-life change**: Reducing from 7d → e.g., 30d would make older results less penalized. But existing behavior at 7d is already aggressive — changing could affect any user who relies on "fresh results first."

3. **New signals in multiSignalRescore**: Adding a `domainQuality` signal requires updating `RescoreWeights` interface, `DEFAULT_RESCORE_WEIGHTS`, validation, and all test configs. The `validateRescoreWeights` guardrail (rrfAnchor >= maxOther) constrains maximum weight of any new signal.

4. **Absolute freshness filter**: Would require new config options (e.g., `freshnessWindow`) and new test cases. Could break queries that intentionally surface old authoritative content (e.g., "seminal papers on X").

5. **Semantic rerank domain-weighting**: Changing semanticMatch to incorporate domain quality would require modifying the embedding similarity computation or adding a post-embedding score boost. This changes behavior for ALL callers (not just web_search).

---

## Proposed Scoring Principles

1. **Authoritative sources must score above commercial blogs for informational queries** — DOMAIN_AUTHORITY map is the primary lever; gaps for ieee.org, acm.org, etc. are the most impactful fix.

2. **Freshness should be both relative AND absolute** — keep existing relative normalization (within batch) but add an absolute freshness penalty for results older than a configurable threshold (e.g., 180 days for "news/recent" queries, no penalty for "all time").

3. **Domain quality must survive semantic rerank** — either inject domain authority as a post-embedding score multiplier, or apply a quality gate BEFORE semantic rerank that boosts/demotes results based on trust tier.

4. **Provider age sparsity must be compensated** — when a result has null age, infer a "maximum uncertainty" recency baseline of **0.3** rather than 0, so null-age results are not penalized vs. results with old age.

5. **engagement/keyword signals should NOT dominate source quality** — the current weights (hasDeepLinks=0.05) are conservative; adding engagement signals should require the guardrail that rrfAnchor >= any single other signal.

---

## Focused Checks (for implementation)

1. **Add missing domains to DOMAIN_AUTHORITY**: ieee.org=0.85, acm.org=0.85, nature.com=0.85, science.org=0.85, springer.com=0.8, pubmed.ncbi.nlm.nih.gov=0.85, dl.acm.org=0.85, ieeexplore.ieee.org=0.85. Downgrade medium.com from 0.5 to 0.4. Add test: `test/searchMerge.test.ts` — IEEE > YouTube > blog.

2. **Add `domainQuality` signal to `extractWebSearchSignals`**: Use `DomainTrust` or a lightweight domain lookup. Add to `RescoreWeights` with weight ≤ rrfAnchor. Add guardrail test.

3. **Add absolute freshness penalty**: New signal `freshnessPenalty` with configurable half-life. For null age, use the same unknown-age baseline as the recency signal (0.3) rather than a separate "moderate penalty". Add config option.

4. **Null age → "unknown" recency**: In `extractWebSearchSignals`, when `parseAgeToDays` returns null, assign a baseline recency value of **0.3** instead of 0. This is the single unknown-age behavior: null age → recency 0.3 (and the same 0.3 baseline for the freshness penalty). This prevents null-age results from being systematically penalized.

5. **Semantic rerank post-boost**: After cosine similarity, multiply by `1 + α * domainQuality` where α is a small weight (0.1-0.2). This preserves semantic relevance while giving authoritative domains a modest boost.
