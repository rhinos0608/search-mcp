# Parity A: Extraction Depth — Root Cause Analysis

## Symptom 1: Official source URL renders with empty content body

### Root Cause A1: `enrichDocumentSnippets` only enriches file-extension URLs, not HTML pages

**File:** `src/tools/webSearchDocEnrich.ts:58`

```typescript
if (!isDocumentUrl(result.url)) continue;
```

**Gate:** `src/utils/documentUtils.ts:44-51`

```typescript
export function isDocumentUrl(url: string): boolean {
  const pathname = new URL(url).pathname.toLowerCase();
  return DOCUMENT_EXTENSIONS.has(pathname.slice(pathname.lastIndexOf('.')));
}
```

`isDocumentUrl` returns `false` for extensionless HTML paths like `/index/introducing-o3-and-o4-mini/`. The enrichment pipeline (fetch + parse full document) is never triggered for HTML pages, regardless of how thin their snippet is.

**Called from:** `src/tools/standalone/webSearch.ts:147`

```typescript
const enriched = await enrichDocumentSnippets(searchResults, effectiveCfg, limit);
```

**Severity:** High — primary cause of the empty-body symptom.

**Fix sketch:** After `enrichDocumentSnippets`, add a second pass that fetches HTML pages whose `description.length` is below a threshold (e.g. <200 chars) and whose `contentKind === 'snippet'`. Use Readability (already available in `documentExtraction.ts` via `htmlToMarkdown`) to extract the full page body. Cap the pass by `maxEnrich` budget. This is the same pattern used by `enrichDocumentSnippets` but with `isDocumentUrl` replaced by an "is thin HTML page" predicate.

---

### Root Cause A2: All backends return snippet-only content by design — no full-text retrieval

Every backend maps results to `contentKind: 'snippet'` and retrieves only bounded excerpts:

| Backend | Description source                          | contentKind | File:Line                     |
| ------- | ------------------------------------------- | ----------- | ----------------------------- |
| Exa     | `highlights.join('\n\n')` (max 2560 chars)  | `snippet`   | `exaSearch.ts:85,151,160`     |
| Brave   | `r.description ?? ''`                       | `snippet`   | `braveSearch.ts:357,365`      |
| Tavily  | `normalizeChunkJoinDelimiter(content)`      | `snippet`   | `tavilySearch.ts:175-176,188` |
| Codex   | `r.snippet ?? ''`                           | `snippet`   | `codexSearch.ts:268,276`      |
| Ollama  | `truncateExcerpt(content)` (max 2560 bytes) | `snippet`   | `ollamaSearch.ts:194,202`     |

Critically, Exa's response includes a `text` field (`exaSearch.ts:22`) with full page content, but it is **never read** — only `highlights` is used (line 139). When a page is newly published and Exa has not yet generated highlights, the result has URL + title but empty body.

**Severity:** Medium — structural limitation. All backends intentionally return snippets to bound latency and cost.

**Fix sketch:** For the top-1 result (or top-N when budget allows), if description is empty/thin (<200 chars), issue a lightweight in-process fetch + Readability parse. This is essentially what `enrichDocumentSnippets` does for document URLs, but extended to HTML pages. The infrastructure already exists in `documentExtraction.ts:htmlToMarkdown()` (line 191) and `tryFetchHtml()` (line 214).

---

### Root Cause A3: Dedup correctly preserves richest, but "richest" is thin when all backends are thin

**File:** `src/utils/searchRichness.ts:42-46`

```typescript
export function richerThan(a: SearchResult, b: SearchResult): boolean {
  const ra = contentRichness(a);
  const rb = contentRichness(b);
  return ra[0] > rb[0] || (ra[0] === rb[0] && ra[1] > rb[1]);
}
```

**Called from:** `src/tools/webSearch.ts:140`

```typescript
const chosen = richerThan(winner, prev) ? winner : prev;
```

When all backends return the same URL with `contentKind: 'snippet'` and similarly thin descriptions (or empty), `richerThan` finds them equivalent and the first-seen representation is kept. This is correct behavior but means no content enrichment occurs post-merge.

**Severity:** Low — this is a consequence of A1+A2, not an independent bug. The dedup logic itself is sound.

**No fix needed** in dedup; fix A1/A2 instead.

---

## Symptom 2: PDF from official domain not discovered or extracted

### Root Cause B1: Search backends don't surface raw PDF URLs from official domains

No search backend (Exa, Brave, Codex, Tavily, Ollama) returns the `cdn.openai.com/...system card.pdf` URL in search results for queries about o3/o4-mini. Search engines surface the HTML blog post, not the raw PDF.

**Severity:** High — a fundamental gap in discovery. The PDF exists but is invisible to web_search.

**Fix sketch:** Two approaches:

1. **Domain-aware supplemental fetch:** For top results from known official domains (e.g. `openai.com`, `cdn.openai.com`), scan the rendered HTML for `<a href="*.pdf">` links and promote them as supplementary results. This requires a lightweight HTML fetch of the top result page.
2. **Query augmentation:** Append `filetype:pdf` to a secondary query variation when the user's intent may include technical documents. This is a search-engine-level approach that works when the backend supports it (SearXNG, Google via DuckDuckGo).

---

### Root Cause B2: PDF parsing IS wired into web_search via `enrichDocumentSnippets`, but only when a PDF URL appears in results

**File:** `src/tools/webSearchDocEnrich.ts:58` → `src/utils/documentExtraction.ts:526-561`

The chain is:

1. `enrichDocumentSnippets` checks `isDocumentUrl(result.url)` → true for `.pdf` URLs
2. Calls `extractDocumentUrl(result.url)` → dispatches to `extractBinaryDocument`
3. `extractBinaryDocument` at `documentExtraction.ts:442-481` runs `parsePdf()` for `.pdf` extension
4. `parsePdf` at `documentParsers/pdf.ts:153-256` parses the PDF into markdown

**Config gating:** `documentParsing.enabled` defaults to `true` (`config.ts:393`). PDF parsing is ON by default. The gate is **not** the problem — the PDF URL simply never enters the result set.

**Severity:** Not a bug in PDF parsing itself. The gap is in discovery (B1).

---

### Root Cause B3: `extractionStats.shouldSkipDomain` is dead code — not a factor

**File:** `src/utils/extractionStats.ts:78-96`

`shouldSkipDomain` is defined but **never called** from any other module (confirmed by grep: 0 external callers). The `extractionStats` module is only used by:

- `src/crawl/middlewares.ts` — records crawl outcomes (not web_search)
- `src/tools/semanticCrawl.ts` — records semantic crawl outcomes (not web_search)

**Severity:** None — dead code, cannot affect web_search.

**No fix needed.**

---

## Adjacent Parity-Blockers Noticed

### Adjacent 1: Exa's `text` field (full page content) is discarded

**File:** `src/tools/exaSearch.ts:22` — `text?: unknown` is in the interface but never read.

Exa's API returns full page content in `text`, but the code intentionally uses only `highlights` (bounded excerpt) to control latency and cost. When highlights are empty for a new page, this content is lost.

### Adjacent 2: Codex backend can return URL + title with completely empty snippet

**File:** `src/tools/codexSearch.ts:268`

```typescript
description: r.snippet ?? '',
```

When the Codex API returns a result without a `snippet` field, description is `''`. Combined with `contentKind: 'snippet'` (line 276) and `extraSnippet: null` (line 274), the result has `contentLength = 0`. This contributes to empty-body rendering.

### Adjacent 3: Formatter renders empty content gracefully but uselessly

**File:** `src/tools/webSearchResultFormatter.ts:916-919`

```typescript
const description = result.description.trim();
if (description.length > 0) parts.push(result.description);
```

When description is empty, no body text is emitted — only the header (`## [N] title` + url + metadata). The result is valid markdown but has no actionable content for the consumer.

---

## Summary

| #   | Root Cause                                                          | Severity | Fix Complexity    |
| --- | ------------------------------------------------------------------- | -------- | ----------------- |
| A1  | `enrichDocumentSnippets` skips HTML pages (only document-file URLs) | **High** | Medium            |
| A2  | All backends return snippet-only content; no HTML fetch fallback    | **High** | Medium            |
| A3  | Dedup keeps "richest" but all representations are thin              | Low      | N/A (consequence) |
| B1  | Search backends don't surface raw PDF URLs from official domains    | **High** | High              |
| B2  | PDF parsing is wired but PDF URL never enters results               | N/A      | (see B1)          |
| B3  | `extractionStats.shouldSkipDomain` is dead code                     | None     | N/A               |
