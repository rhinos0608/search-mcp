# Spec: Context Window Protection for search-mcp Clients

**Inspired by:** `mksglu/context-mode` (14.9k ⭐, 98% context reduction)
**Target:** `search-mcp` MCP server
**Status:** Implementation phase

---

## Architecture Decision: Integration Strategy

Context-mode is an independent MCP server that wraps ALL tool calls. search-mcp is a domain-specific MCP server. We cannot simply wrap — we must integrate the patterns **inside** search-mcp's own tool handlers.

**Integration points:**
1. `src/tools/response.ts` — shared response formatting (affects ALL tools)
2. `src/tools/standalone/*.ts` — individual tool wrappers
3. `src/utils/` — new utility modules
4. User-facing `AGENTS.md` — routing instructions

---

## Feature 1: Output Budget Tracking (IMMEDIATE)

### What it does
Tracks bytes returned per tool call and per session, exposed via `health_check`.

### Files to modify
- **NEW:** `src/utils/outputBudget.ts`
- **MODIFY:** `src/tools/response.ts` — add tracking to `successResponse()` and `errorResponse()`
- **MODIFY:** `src/health.ts` — expose budget stats in health report

### Reference from context-mode
```typescript
// context-mode: src/server.ts ~line 380
const sessionStats = {
  calls: {} as Record<string, number>,
  bytesReturned: {} as Record<string, number>,
  bytesSandboxed: 0,
  cacheHits: 0,
  cacheBytesSaved: 0,
  sessionStart: Date.now(),
};

function trackResponse(toolName: string, response: ToolResult): ToolResult {
  const bytes = response.content.reduce(
    (sum, c) => sum + Buffer.byteLength(c.text), 0
  );
  sessionStats.calls[toolName] = (sessionStats.calls[toolName] || 0) + 1;
  sessionStats.bytesReturned[toolName] =
    (sessionStats.bytesReturned[toolName] || 0) + bytes;
  persistStats();
  return response;
}
```

### Implementation approach
1. Create `OutputBudgetTracker` singleton class with:
   - `recordResponse(toolName: string, bytes: number, isError: boolean): void`
   - `recordSandboxed(toolName: string, bytes: number): void`
   - `recordCacheHit(bytesSaved: number): void`
   - `getStats(): OutputBudgetStats`
   - `getPerToolBreakdown(): ToolStats[]`

2. Add byte counting to `successResponse()` and `errorResponse()` in `src/tools/response.ts`

3. Add `output_budget` section to `health_check` response

4. Add `output_budget` probes to `runHealthProbes()` in `src/health.ts`

### Types
```typescript
interface OutputBudgetStats {
  totalCalls: number;
  totalBytesReturned: number;
  totalBytesSandboxed: number;
  cacheHits: number;
  cacheBytesSaved: number;
  sessionStart: number;
  savingsRatio: number; // sandboxed / (returned + sandboxed)
  byTool: Record<string, ToolBudgetStats>;
}

interface ToolBudgetStats {
  calls: number;
  bytesReturned: number;
  avgBytesPerCall: number;
}
```

### Test plan
- Unit test: recordResponse accumulates correctly
- Unit test: stats reset between sessions
- Integration test: health_check includes output_budget section
- Verify: byte counting doesn't affect response content

---

## Feature 2: AGENTS.md Routing Instructions (IMMEDIATE)

### What it does
Teaches AI models using search-mcp to process results in sandboxes instead of reading raw data into context.

### Files to create
- **NEW:** `AGENTS.md` at project root
- **NEW:** `configs/AGENTS.md` at project root (canonical location)

### Reference from context-mode
```markdown
# context-mode — MANDATORY routing rules

## Think in Code — MANDATORY
Analyze/count/filter/compare/search/parse/transform data: **write code** via
`ctx_execute(language, code)`, `console.log()` only the answer.
Do NOT read raw data into context. PROGRAM the analysis, not COMPUTE it.

## Tool selection
0. MEMORY: ctx_search(sort: "timeline") — after resume
1. GATHER: ctx_batch_execute(commands, queries) — ONE call replaces 30+
2. FOLLOW-UP: ctx_search(queries: [...]) — batch ALL questions
3. PROCESSING: ctx_execute / ctx_execute_file — sandbox
4. WEB: ctx_fetch_and_index → ctx_search — raw HTML never enters context
```

### Content for search-mcp AGENTS.md
```markdown
# search-mcp — Context-Efficient Search

## When to use sandbox processing

When search_mcp returns > 3 results or > 5KB: use ctx_execute_file() or
ctx_execute() to filter/analyze instead of reading all into context.

search_mcp tools return rich metadata — parse programmatically, don't read.

## Processing patterns

#ctx_execute("javascript", `const r = JSON.parse(RAW_RESULT); ...`)
```

### Implementation
**This is a documentation-only change.** No code changes needed.

---

## Feature 3: Smart Snippet Extraction (IMMEDIATE)

### What it does
Replaces first-N truncation with query-term-aware window extraction. Instead of returning the first 400 chars of a chunk that may miss the match, extract a window around where query terms actually appear.

### Files to modify
- **NEW:** `src/utils/smartSnippet.ts`
- **MODIFY:** `src/rag/pipeline.ts` — use smart snippets in `retrieveCorpus()` results
- **MODIFY:** `src/utils/corpusCache.ts` — use smart snippets in cached result formatting

### Reference from context-mode
context-mode uses two approaches:

**Approach A: FTS5 highlight markers** (preferred when available)
```typescript
// context-mode: src/server.ts ~line 1000
const STX = "\x02";
const ETX = "\x03";

export function positionsFromHighlight(highlighted: string): number[] {
  const positions: number[] = [];
  let cleanOffset = 0;
  let i = 0;
  while (i < highlighted.length) {
    if (highlighted[i] === STX) {
      positions.push(cleanOffset);
      i++;
      while (i < highlighted.length && highlighted[i] !== ETX) {
        cleanOffset++;
        i++;
      }
      if (i < highlighted.length) i++;
    } else {
      cleanOffset++;
      i++;
    }
  }
  return positions;
}
```

**Approach B: Fallback indexOf scan** (when no FTS markers)
```typescript
// context-mode: src/server.ts ~line 1050
export function extractSnippet(
  content: string,
  query: string,
  maxLen = 1500,
  highlighted?: string,
): string {
  // Find all match positions from highlight markers or indexOf
  // Merge overlapping windows
  // Return best window(s) within maxLen
}
```

### Implementation approach

**For search-mcp, use Approach B** (we don't use FTS5 highlight() in the current pipeline). The algorithm:

```
smartSnippet(content: string, queryTerms: string[], maxChars: number): string
  1. Split query into individual terms
  2. Find all positions of each term in content (case-insensitive)
  3. Take the earliest match position
  4. Expand window: start = max(0, pos - maxChars/4), end = min(len, start + maxChars)
  5. Snap to paragraph boundaries (double newline)
  6. If multiple terms have distant matches (span > window), emit separate windows
```

### Types
```typescript
interface SnippetOptions {
  maxChars?: number;      // default 400
  surroundChars?: number; // default 100 (context around match)
  snapToParagraphs?: boolean; // default true
}

function extractSmartSnippet(
  content: string,
  query: string,
  options?: SnippetOptions,
): string;
```

### Test plan
- Single term match: window centered on first occurrence
- Multi-term match: window covering all terms if within span
- No match: return prefix + ellipsis
- Long content: respect maxChars
- Paragraph snapping: start/end at paragraph boundaries

---

## Feature 4: Levenshtein Fuzzy Correction (MEDIUM)

### What it does
Auto-corrects typos in search queries before executing the search, using Levenshtein distance against a vocabulary of known terms.

### Files to create/modify
- **NEW:** `src/utils/fuzzyCorrection.ts`
- **MODIFY:** `src/tools/webSearch.ts` — apply fuzzy correction before query execution

### Reference from context-mode
```typescript
// context-mode: src/store.ts ~line 120
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

// Adaptive edit distance thresholds:
function maxEditDistance(wordLength: number): number {
  if (wordLength <= 4) return 1;
  if (wordLength <= 12) return 2;
  return 3;
}
```

### Approach
For search-mcp, we can't maintain a vocabulary of all possible search terms. Instead:

1. **Query-level correction**: Split query into words, check each word against a small domain vocabulary (common search terms, previous queries)
2. **Adaptive thresholds**: Shorter words get smaller edit distance
3. **Non-intrusive**: Corrected query is shown as `original → corrected` in metadata
4. **Opt-in**: `fuzzyCorrect: true` parameter (default true for `web_search`)

### Implementation
```typescript
// src/utils/fuzzyCorrection.ts
export function correctQuery(
  query: string,
  vocabulary?: string[],
): { corrected: string; changes: Array<{ original: string; corrected: string }> }

export function levenshteinDistance(a: string, b: string): number;
export function maxEditDistance(wordLength: number): number;
```

### Vocabulary sources
1. Common programming terms (extracted from search-mcp's own codebase)
2. Previous successful queries (from query_log in corpus cache)
3. A static list of ~200 common search terms

### Test plan
- "kuberntes" → "kubernetes" (1 edit, ≤4 → max 1)
- "authentication" → "authentication" (1 edit, ≤12 → max 2)
- "contex" → "context" (1 edit, ≤4 → max 1)
- No false correction of valid rare terms

---

## Feature 5: Intent-Driven Output Filtering (MEDIUM)

### What it does
Adds an optional `intent` parameter to search tools. When provided and results are large, indexes results into a temporary knowledge base and returns only intent-matched snippets instead of full results.

### Files to modify
- **MODIFY:** `src/tools/webSearch.ts` — add `intent` parameter
- **NEW:** `src/utils/intentFilter.ts`
- **MODIFY:** `src/tools/standalone/webSearch.ts` — add to Zod schema

### Parameter
```typescript
// Added to web_search and semantic_crawl schemas
intent: z.string().optional()
// e.g., intent: "implementation details and code examples"
```

### Behavior
```
web_search(query="context window optimization", intent="code patterns")
→ Runs full search (50 results)
→ Detects: results total 85KB > 5KB threshold
→ Filters: indexes all results, searches for "code patterns", returns top matches
→ Response: 3KB of intent-matched snippets + metadata about total results
```

### Implementation approach

**Use existing infrastructure**: search-mcp already has `ContentStore`-like functionality via `corpusCache.ts` and the RAG pipeline. For intent filtering:

1. Run the full search normally
2. Check if result byte size exceeds threshold (5KB)
3. If intent provided AND threshold exceeded:
   a. Create in-memory BM25 index from result texts
   b. Search BM25 for intent terms
   c. Combine: top BM25 matches + top original results
   d. Return combined with intent metadata
4. If intent not provided OR under threshold: return normally

```typescript
// src/utils/intentFilter.ts
interface IntentFilterResult<T> {
  filtered: boolean;
  results: T[];
  totalResults: number;
  filteredCount: number;
  searchableTerms: string[]; // terms for follow-up ctx_search
  bytesBefore: number;
  bytesAfter: number;
}

function applyIntentFilter<T extends { text?: string; title?: string; snippet?: string }>(
  items: T[],
  intent: string,
  thresholdBytes?: number, // default 5000
): IntentFilterResult<T>;
```

### Test plan
- Under-threshold results: no filtering, full return
- Over-threshold with intent: returns filtered subset
- No intent: full return regardless of size
- Searchable terms: reasonable vocabulary extracted

---

## Feature 6: Porter Stemming for FTS5 (MEDIUM — deferred)

### What it does
Adds Porter stemming tokenizer to the corpus cache FTS5 tables so "configuration" matches "configure", "cached" matches "caching".

### Why deferred
Requires schema migration on existing cache tables. Design the approach but implement after validating Features 1-5.

### Approach sketch (not for immediate implementation)
```sql
-- New table with porter tokenizer
CREATE VIRTUAL TABLE chunks_porter USING fts5(
  chunk_id, text,
  tokenize='porter unicode61'
);

-- Migration: copy from existing chunks table
INSERT INTO chunks_porter SELECT chunk_id, text FROM chunks;
```

---

## Implementation Order & Dependencies

```
Phase 1 (parallel):
  [Worker A] Feature 1: Output Budget Tracking
  [Worker B] Feature 2: AGENTS.md
  [Worker C] Feature 3: Smart Snippet Extraction

Phase 2 (sequential — depends on Phase 1):
  [Worker D] Feature 4: Fuzzy Correction
  [Worker E] Feature 5: Intent Filtering
  (can run in parallel after Phase 1)

Phase 3:
  [Reviewer] Review all changes
```

## File Change Summary

| File | Action | Features |
|------|--------|----------|
| `src/utils/outputBudget.ts` | NEW | 1 |
| `src/tools/response.ts` | MODIFY | 1, 3 |
| `src/health.ts` | MODIFY | 1 |
| `AGENTS.md` | NEW | 2 |
| `configs/AGENTS.md` | NEW | 2 |
| `src/utils/smartSnippet.ts` | NEW | 3 |
| `src/rag/pipeline.ts` | MODIFY | 3 |
| `src/utils/corpusCache.ts` | MODIFY | 3 |
| `src/utils/fuzzyCorrection.ts` | NEW | 4 |
| `src/tools/webSearch.ts` | MODIFY | 4, 5 |
| `src/tools/standalone/webSearch.ts` | MODIFY | 4, 5 |
| `src/utils/intentFilter.ts` | NEW | 5 |
| `src/tools/semanticCrawl.ts` | MODIFY | 5 |

## Success Metrics

1. **Output budget tracking**: `health_check` shows per-tool byte counts
2. **Smart snippets**: Search results show matches in context, not just prefix
3. **Fuzzy correction**: Tests show "kuberntes" → "kubernetes" correction
4. **Intent filtering**: 85KB search → 3KB filtered with intent param
5. **No regressions**: Existing test suite passes
