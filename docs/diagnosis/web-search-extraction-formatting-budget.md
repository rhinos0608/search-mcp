# Diagnosis: web_search Extraction / Formatting / Output Budget

## Data Flow Summary

```
Provider Adapters (brave, exa, tavily, codex, duckduckgo)
  → SearchResult[] (with optional contentKind, generatedSummary, extraSnippet)
  → searchWithBackends() [webSearch.ts]
    → Cross-query dedup via normalizeUrl (url.ts)
    → Per-backend results merged via mergeSearchResults() OR rrfMerge()
      → mergeSearchResults uses normalizeUrlForDedup (searchMerge.ts)
      → rrfMerge uses normalizeUrl (url.ts)
    → Cross-query dedup again via normalizeUrl
    → Rescore + optional semantic rerank
  → formatWebSearchMarkdown() [webSearchResultFormatter.ts]
    → Per-result: buildDocumentContent → cleanResultMarkdown → splitIntoBlocks → renderBlock
    → Per-document budget (48 KiB), total budget (256 KiB)
    → Output: bare Markdown with [N-M] citations
```

## Files Examined

| File                                    | Lines  | Role                                       |
| --------------------------------------- | ------ | ------------------------------------------ |
| `src/tools/standalone/webSearch.ts`     | 1-158  | MCP tool registration, output entry        |
| `src/tools/webSearch.ts`                | 1-723  | Core search orchestration, dedup, ranking  |
| `src/tools/webSearchResultFormatter.ts` | 1-767  | Markdown formatter, HTML stripping, budget |
| `src/utils/searchRichness.ts`           | 1-49   | Content richness scoring                   |
| `src/utils/searchMerge.ts`              | 1-209  | Cross-backend merge/dedup                  |
| `src/utils/url.ts`                      | 1-88   | URL normalization (rrfMerge path)          |
| `src/utils/fusion.ts`                   | 1-60   | RRF merge wrapper                          |
| `src/tools/braveSearch.ts`              | 1-348  | Brave adapter                              |
| `src/tools/exaSearch.ts`                | 1-163  | Exa adapter                                |
| `src/tools/tavilySearch.ts`             | 1-191  | Tavily adapter                             |
| `src/tools/codexSearch.ts`              | 1-256  | Codex adapter                              |
| `src/tools/duckduckgoSearch.ts`         | 1-213  | DuckDuckGo adapter                         |
| `src/types.ts`                          | 74-113 | SearchResult interface                     |
| `src/chunking.ts`                       | 55-135 | stripNavigationMarkdown                    |
| `test/webSearch.test.ts`                | 1-361  | Core search tests (52 tests)               |
| `test/webSearchResultFormatter.test.ts` | 1-617  | Formatter tests (58 tests)                 |
| `test/searchMerge.test.ts`              | 1-282  | Merge/dedup tests                          |
| `test/webSearchRanking.test.ts`         | 1-91   | Ranking tests (4 tests)                    |

## Root-Cause Map

### Symptom 1: Full Pages with Nav/Forms/Footers

**Root Cause: Incomplete HTML stripping in `stripRawHtml`**

- **File**: `src/tools/webSearchResultFormatter.ts:69-117`
- **Severity**: HIGH
- `stripRawHtml()` removes `<script>`, `<style>`, `<nav>` subtrees but NOT `<header>`, `<footer>`, `<aside>`, `<form>`, `<section>`, `<div class="sidebar">` etc.
- Exa returns `text: true` which is full page text (may include residual HTML tags from extraction).
- Tavily returns `raw_content: 'markdown'` which is a full-page markdown dump — retains structural elements not removed by the HTML stripper.
- `stripNavigationMarkdown` (`src/chunking.ts:82-135`) only handles line-level nav patterns (skip links, social share rows, 3+ link rows), not multi-line structural HTML blocks.
- `BOILERPLATE_SECTION_RE` (line 295-296) only matches specific heading patterns ("Related posts", "Subscribe", "Comments", etc.) — not generic structural sections.
- **Falsifiable prediction**: Feed Exa/Tavily results containing `<header>`, `<footer>`, `<aside>`, `<form>` tags → they survive into formatted output.
- **Fix boundary**: `stripRawHtml` in `webSearchResultFormatter.ts:69-117` — add `<header>`, `<footer>`, `<aside>`, `<form>`, `<section>` subtree removal. Smallest fix: add 3 regex replacements (~6 lines).

### Symptom 2: Long Low-Quality YouTube Transcripts

**Root Cause: No content quality gate + overgenerous per-doc budget**

- **File**: `src/tools/webSearchResultFormatter.ts:44-45` (budget constants)
- **File**: `src/tools/webSearchResultFormatter.ts:600-608` (`buildDocumentContent`)
- **Severity**: MEDIUM
- `DEFAULT_DOCUMENT_BUDGET_BYTES = 48 * 1024` (48 KiB = 49,152 bytes ≈ ~12K tokens, assuming 4 bytes per token) — absurdly generous for a search result snippet.
- `buildDocumentContent` (line 600-608) blindly concatenates `description + extraSnippet` with no length-based quality gate.
- When Tavily returns `include_raw_content: 'markdown'`, the full page content is in `extraSnippet` prefixed with `[Full Content]\n`. This can be megabytes for YouTube pages (transcript + comments + related).
- No YouTube-specific treatment: no transcript truncation, no comment section detection, no boilerplate detection for YouTube page structure.
- **Falsifiable prediction**: Search for a popular YouTube video → full transcript + comments + related videos section appear in formatted output, consuming entire document budget.
- **Fix boundary**: Two fixes needed: (1) Cap `extraSnippet` length at the adapter level or in `buildDocumentContent` (~10 lines each). (2) Lower `DEFAULT_DOCUMENT_BUDGET_BYTES` to 4-8 KiB.

### Symptom 3: Same Article Repeated Twice in Different Formats

**Root Cause: Divergent URL normalizers + fragile content fingerprint**

- **File**: `src/utils/searchMerge.ts:31-54` (`normalizeUrlForDedup`)
- **File**: `src/utils/url.ts:41-88` (`normalizeUrl`)
- **File**: `src/utils/searchMerge.ts:56-73` (`normalizedContentFingerprint`)
- **Severity**: HIGH

**Two normalizers, different tracking param sets:**

| Param         | `normalizeUrl` (url.ts) | `normalizeUrlForDedup` (searchMerge.ts) |
| ------------- | ----------------------- | --------------------------------------- |
| `source`      | ✅ stripped             | ❌ NOT stripped                         |
| `src`         | ✅ stripped             | ❌ NOT stripped                         |
| `msclkid`     | ❌ NOT stripped         | ✅ stripped                             |
| `ref_*`       | ❌ NOT stripped         | ✅ stripped (regex)                     |
| `utm_*`       | ✅ explicit list        | ✅ regex `utm_.*`                       |
| Default ports | ✅ stripped             | ❌ NOT stripped                         |

- Same article from Brave (with `?source=brave` tracking) and Exa (clean URL) → `normalizeUrl` strips `source` → deduped in rrfMerge path. But `normalizeUrlForDedup` does NOT strip `source` → NOT deduped in mergeSearchResults path.
- Content fingerprint requires ≥240 char body AND no query params AND same hostname+title. Articles with different snippet lengths (Brave snippet vs Exa full text) won't match.

- **Falsifiable prediction**: Search with 2+ backends returning the same article where one URL has `?source=brave` or `?src=...` → appears twice in output.
- **Fix boundary**: Unify `normalizeUrlForDedup` to use `normalizeUrl` from `url.ts`, or extract a shared `TRACKING_PARAMS` set. ~5 lines in `searchMerge.ts:31-54`.

### Symptom 4: Snippet-Only Result Ambiguity

**Root Cause: Inconsistent `contentKind` across adapters**

| Adapter         | `contentKind`                             | `generatedSummary`   |
| --------------- | ----------------------------------------- | -------------------- |
| Brave           | ❌ undefined (treated as snippet)         | ❌ null              |
| DuckDuckGo      | ❌ undefined (treated as snippet)         | ❌ null              |
| Codex           | `'snippet'`                               | ❌ null              |
| Exa (no/yes)    | `'full'`                                  | yes-only: per-result |
| Exa (only)      | `'summary'`                               | null                 |
| Tavily (no/yes) | `'full'` if raw_content, else `'snippet'` | ❌ null              |
| Tavily (only)   | `'summary'`                               | ❌ null              |

- **File**: `src/tools/braveSearch.ts:331-341` — no `contentKind` in return
- **File**: `src/tools/duckduckgoSearch.ts:86-96` — no `contentKind` in return
- **File**: `src/tools/codexSearch.ts:243-256` — hardcoded `'snippet'`
- **Severity**: LOW (affects ranking visibility, not correctness)
- `contentRichness()` treats undefined as snippet (rank=1), so Brave/DuckDuckGo results are ranked below Exa/Tavily `full` results during dedup. This is semantically correct but invisible to the LLM consumer.
- The formatter metadata line only shows `content: ${contentKind}` when set — so most results show no content kind.
- **Falsifiable prediction**: Brave result with good description loses to Exa `full` result in content richness scoring, even when the Brave description is more relevant.
- **Fix boundary**: Set `contentKind: 'snippet'` explicitly in Brave and DuckDuckGo adapters. ~2 lines each.

## Test Coverage Assessment

### Existing tests that PASS (198 total):

- `test/webSearch.test.ts`: 43 tests — backend resolution, dedup, rerank, error handling
- `test/webSearchResultFormatter.test.ts`: 116 tests — formatting, budgets, security, citations
- `test/searchMerge.test.ts`: 34 tests — URL normalization, merge, Codex tiebreak
- `test/webSearchRanking.test.ts`: 5 tests — bounded Codex preference, provenance

Counts verified **2026-08-13** via `node --import tsx/esm --test test/webSearch.test.ts test/webSearchResultFormatter.test.ts test/searchMerge.test.ts test/webSearchRanking.test.ts` → 198 tests, 198 pass, 0 fail.

### MISSING tests (no existing tests at these seams):

1. **HTML structure stripping** — no test feeds `<header>`, `<footer>`, `<aside>`, `<form>` tags to `cleanResultMarkdown` / `formatWebSearchMarkdown` → cannot verify they are removed.

2. **Cross-normalizer dedup consistency** — no test verifies that `normalizeUrlForDedup(url)` and `normalizeUrl(url)` produce the same result for `?source=...`, `?src=...`, `?msclkid=...` URLs.

3. **Content fingerprint with different-length descriptions** — no test verifies that two results with same URL but different description lengths (one <240 chars) skip fingerprint-based dedup.

4. **Excessive content truncation** — no test verifies that a 50 KiB `extraSnippet` is handled gracefully (current 48 KiB budget truncates silently).

5. **YouTube URL content quality** — no test verifies that YouTube page content from Tavily `raw_content` is appropriately limited.

6. **Brave adapter `contentKind`** — no test verifies Brave sets or doesn't set `contentKind`.

## Ranked Hypotheses

| Rank | Hypothesis                                                                           | Evidence                                                                          | Confidence |
| ---- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------- |
| 1    | `stripRawHtml` misses `<header>/<footer>/<aside>/<form>` subtrees                    | Code review of lines 69-117 — only `<script>/<style>/<nav>` handled               | HIGH       |
| 2    | `normalizeUrlForDedup` ≠ `normalizeUrl` causes missed cross-backend dedup            | Diff of tracking param sets shows `source`, `src` only in `normalizeUrl`          | HIGH       |
| 3    | 48 KiB per-doc budget allows single result to consume all output                     | `DEFAULT_DOCUMENT_BUDGET_BYTES = 48*1024` at line 45                              | HIGH       |
| 4    | Tavily `raw_content` injects full page text into `extraSnippet` without quality gate | Code at `tavilySearch.ts:162-164` blindly appends `[Full Content]\n${rawContent}` | MEDIUM     |
| 5    | Brave/DuckDuckGo missing `contentKind` skews richness ranking                        | `braveSearch.ts:331-341` lacks `contentKind` field                                | LOW        |

## Smallest Broad Fix Boundaries

1. **`src/tools/webSearchResultFormatter.ts:69-117`** (`stripRawHtml`): Add `<header>`, `<footer>`, `<aside>`, `<form>` subtree removal. ~6 lines.

2. **`src/utils/searchMerge.ts:31-54`** (`normalizeUrlForDedup`): Import and reuse `normalizeUrl` from `url.ts` or merge tracking param sets. ~5 lines.

3. **`src/tools/webSearchResultFormatter.ts:44-45`** (budget constants): Reduce `DEFAULT_DOCUMENT_BUDGET_BYTES` from 48 KiB to 4-8 KiB. 1 line.

4. **`src/tools/tavilySearch.ts:162-164`**: Cap `raw_content` length before appending to `extraSnippet`. ~3 lines.

5. **`src/tools/braveSearch.ts:331-341`**: Add `contentKind: 'snippet'` to result mapping. 1 line.

## Test Commands

```bash
# Run all relevant tests
node --import tsx/esm --test test/webSearch.test.ts test/webSearchResultFormatter.test.ts test/searchMerge.test.ts test/webSearchRanking.test.ts

# Typecheck
npx tsc --noEmit
```

Current state: all 198 tests pass, tsc --noEmit clean.
