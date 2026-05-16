# Context-Mode Integration Analysis for search-mcp

**Repo:** `mksglu/context-mode` (14.9k ⭐, 15 platforms, 98% context reduction)
**Analysis date:** 2026-05-17
**Target project:** `search-mcp` (MCP server for web/knowledge search)

---

## Executive Summary

Context-mode solves the problem of MCP tool output flooding AI coding agents' context windows. It provides a sandbox execution layer, an FTS5-based knowledge base with BM25 search, session continuity across compactions, and multi-platform adapter routing. The architecture maps directly onto search-mcp's needs — every web_search/web_read/web_crawl result is raw data that currently enters the user's context window uncompressed.

**Key transferable patterns identified: 9**
**Estimated integration effort: moderate (2-3 weeks)**
**Highest-impact, lowest-effort wins: 3**

---

## 1. Tool Selection Hierarchy & Routing Instructions

### Pattern
Context-mode injects a **MANDATORY routing block** into the model's prompt (via `CLAUDE.md`, `AGENTS.md`, or `SYSTEM.md`) that teaches the model which tools to use for which data types. This is enforced at two levels:

1. **Prompt-level routing** (always works): A markdown file with explicit tool selection rules
2. **Hook-level enforcement** (platform-dependent): `PreToolUse` hooks that intercept and redirect `Bash`, `Read`, `WebFetch` calls

### Key rules from `configs/claude-code/CLAUDE.md`:
```
0. MEMORY: ctx_search(sort: "timeline") — after resume
1. GATHER: ctx_batch_execute(commands, queries) — ONE call replaces 30+
2. FOLLOW-UP: ctx_search(queries: [...]) — batch ALL questions
3. PROCESSING: ctx_execute / ctx_execute_file — sandbox
4. WEB: ctx_fetch_and_index → ctx_search — raw HTML never enters context
5. INDEX: ctx_index(content, source) — FTS5 storage
```

### Applicability to search-mcp
**HIGH.** search-mcp already has the exact same problem — every `web_search`, `web_read`, `web_crawl`, `semantic_crawl` result is raw HTML/markdown going straight into context. We should:

- Add a `CLAUDE.md` / `AGENTS.md` routing template in search-mcp's `configs/` directory
- Teach the model to use `ctx_execute` for processing search results (analysis/filtering in sandbox)
- Recommend `ctx_index` + `ctx_search` for documentation that needs to be referenced repeatedly
- Add `ctx_fetch_and_index` as the preferred web fetch tool (index → search, raw never enters context)

---

## 2. Sandbox Execution (ctx_execute / ctx_execute_file)

### Pattern
Code execution in isolated subprocesses — **only stdout enters context**. Raw data (files, API responses, logs) never leaves the sandbox.

**Architecture (`src/executor.ts`):**
- `PolyglotExecutor` class with 12 language runtimes (JS, TS, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, Elixir, C#)
- Auto-detects Bun for 3-5x faster JS/TS execution
- Process isolation via `spawn()` with separate process boundary
- `hardCapBytes` (100MB) output limit
- Credential passthrough: `gh`, `aws`, `gcloud`, `kubectl`, `docker` inherit env vars
- Smart truncation: 60% head + 40% tail when output exceeds limit
- UTF-8-safe byte-prefix truncation (binary search, surrogate pair guard)
- Intent-driven filtering: when `intent` param provided, indexes output → BM25 search → returns matches

**Key implementation details:**
```typescript
// security.ts — blocking shell-escape patterns in non-shell code
export function extractShellCommands(code: string, language: string): string[] {
  // Detects: exec(), spawn(), subprocess.run(), etc.
  // Each extracted command is eval'd against the Bash deny policy
}
```

### Applicability to search-mcp
**HIGH.** search-mcp already sends large result sets to context. The sandbox pattern could be integrated as:

- A new `search_execute` tool that processes search results in a sandbox
- Extending current tools with a `processInSandbox` option that returns only analysis output
- The "Think in Code" paradigm: instead of reading 20 search results into context to find patterns, the model writes code that does the analysis

---

## 3. Progressive Throttling

### Pattern
Rate-limit search calls to prevent context flooding from excessive queries:

- **Calls 1-3:** Normal results (2 per query)
- **Calls 4-8:** Reduced results (1 per query) + warning
- **Calls 9+:** Blocked — redirects to `ctx_batch_execute`

### Applicability to search-mcp
**MEDIUM.** search-mcp could benefit from output budget tracking:

- Track bytes returned per session per tool
- Progressive response compaction when budget exceeds threshold
- Redirect excessive `web_search` calls to a batch processing mode

---

## 4. Output Budget Tracking & Stats

### Pattern
Real-time tracking of context consumption:

```typescript
// server.ts — sessionStats
const sessionStats = {
  calls: {} as Record<string, number>,
  bytesReturned: {} as Record<string, number>,
  bytesIndexed: 0,
  bytesSandboxed: 0,  // bytes consumed inside sandbox (NEVER entered context)
  cacheHits: 0,
  cacheBytesSaved: 0,
  sessionStart: Date.now(),
};
```

Every tool response is tracked via `trackResponse(toolName, response)`:
```typescript
function trackResponse(toolName: string, response: ToolResult): ToolResult {
  const bytes = response.content.reduce(
    (sum, c) => sum + Buffer.byteLength(c.text), 0
  );
  sessionStats.calls[toolName] = (sessionStats.calls[toolName] || 0) + 1;
  sessionStats.bytesReturned[toolName] = (sessionStats.bytesReturned[toolName] || 0) + bytes;
  persistStats(); // writes sidecar JSON for statusline
  return response;
}
```

### Applicability to search-mcp
**HIGH.** This is low effort, high impact. search-mcp should:

- Add per-tool byte tracking to every tool handler
- Expose via `health_check` or a new `ctx_stats`-like tool
- Allow clients to monitor their context consumption
- Provide per-backend breakdown (Exa vs Brave vs SearXNG vs Crawl4AI)

---

## 5. Intent-Driven Output Filtering

### Pattern
When `ctx_execute` output exceeds 5KB and an `intent` parameter is provided, instead of returning the full output, context-mode:

1. Indexes the full output into FTS5 knowledge base
2. Searches for sections matching the intent
3. Returns only relevant matches
4. Provides "searchable terms" vocabulary for follow-up queries

### Applicability to search-mcp
**HIGH.** This could be added as an optional parameter to `web_search`, `web_read`, and `web_crawl`:

```typescript
// Proposed: add intent filtering to existing tools
web_search({
  query: "context window optimization patterns",
  intent: "implementation details and code examples", // NEW
  maxResults: 20
})
// Instead of 50KB of raw results, returns 2KB of intent-matched snippets
```

---

## 6. FTS5 BM25 Knowledge Base with Hybrid Ranking

### Pattern
Context-mode uses SQLite FTS5 with a sophisticated search pipeline:

**Indexing (`src/store.ts`):**
- Markdown chunked by headings (code blocks kept intact)
- Dual tokenizer: Porter stemmer + trigram
- Stopword removal for BM25 quality
- Title/heading weighting (5x in BM25)
- Max chunk size: 4096 bytes (prevents length normalization issues)

**Search pipeline:**
1. **Porter stemming** — FTS5 MATCH with porter tokenizer ("caching" matches "cached")
2. **Trigram substring** — partial string matching ("useEff" finds "useEffect")
3. **Reciprocal Rank Fusion (RRF)** — merges both ranked lists
4. **Proximity reranking** — multi-term queries get boosted when terms appear close together
5. **Fuzzy correction** — Levenshtein distance with adaptive threshold:
   - ≤4 chars: max edit distance 1
   - ≤12 chars: max edit distance 2
   - >12 chars: max edit distance 3
6. **Smart snippets** — returns windows around query term matches instead of truncation
7. **FTS5 highlight markers** — STX/ETX markers for exact match positions

**TTL Cache:**
- 24h URL cache: `ctx_fetch_and_index` skips re-fetch
- `force: true` bypass
- 14-day content DB cleanup on startup
- Per-project isolation (different DB per platform config dir)

### Applicability to search-mcp
**MEDIUM-HIGH.** search-mcp already has RAG infrastructure (`src/rag/`) with:
- BM25+ (via `src/rag/pipeline.ts`)
- RRF fusion (`src/rag/fusion.ts`)
- Embedding-based semantic search
- Corpus cache (SQLite-based `src/utils/corpusCache.ts`)

**What context-mode adds that search-mcp could adopt:**
- **Porter stemming** for FTS5 to improve recall ("configuration" ↔ "configure")
- **Trigram tokenizer** for substring matching (currently search-mcp uses only embeddings + BM25)
- **Levenshtein fuzzy correction** with adaptive thresholds
- **Smart snippet extraction** using FTS5 highlight markers (search-mcp currently returns first-N truncation)
- **Proximity reranking**: boost results where query terms are adjacent
- **24h TTL cache** for URL fetches (reduces network calls on repeat queries)

---

## 7. Session Continuity & Resume Snapshots

### Pattern
When the AI agent's context window compacts, it loses working memory. Context-mode solves this by:

1. **Capturing every event** via PostToolUse hooks: tool calls, user messages, file edits, decisions
2. **Persisting to SQLite** (`SessionDB` in `src/session/db.ts`)
3. **Building resume snapshots** on PreCompact hook — priority-filtered event selection
4. **Injecting snapshots** on SessionStart — model continues without asking "what were we working on?"
5. **Auto-memory search** — scans `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` + platform memory dir

**Event priority levels:**
```typescript
export const EventPriority = {
  LOW: 1,     // routine events
  NORMAL: 2,  // tool calls
  HIGH: 3,    // file edits, decisions
  CRITICAL: 4 // errors, user corrections
};
```

**Unified search across sources** (`src/search/unified.ts`):
- `sort: "relevance"` → ContentStore BM25 only
- `sort: "timeline"` → ContentStore + SessionDB + auto-memory, chronological sort

### Applicability to search-mcp
**MEDIUM.** This is deep infrastructure that requires hook integration. However, certain aspects are directly applicable:

- **Resume-aware search**: When search-mcp is used across session compactions, previous search results could be recovered
- **Decision persistence**: `semantic_crawl` decisions (which URLs crawled, which filtered) could survive compaction
- **Auto-memory for search context**: The model could `ctx_search` for "what search patterns did we use last session?"

---

## 8. Security: Command Deny Policy + File Path Guards

### Pattern
Two-layer security in `src/security.ts`:

**Shell command deny policies:**
- Parses `~/.claude/settings.json` for `permissions.deny` patterns
- Evaluates commands before execution
- Splits chained commands (`&&`, `||`, `;`, `|`) respecting quotes
- Detects shell-escape calls in non-shell code (`exec()`, `spawn()`, `subprocess.run()`)
- Glob-to-regex conversion for flexible pattern matching

**File path deny policies:**
- Read deny patterns prevent reading sensitive files
- File glob with `**` support
- Case-insensitive matching option
- Resolve paths against project dir for relative matching

### Applicability to search-mcp
**LOW-MEDIUM.** search-mcp already has SSRF protection (`src/httpGuards.ts`). The security patterns could inform:

- URL blocklist/allowlist with glob support (currently hardcoded hostnames only)
- Command injection detection (if adding sandbox execution)

---

## 9. Multi-Platform Adapter Architecture

### Pattern
15 adapters with a clean base class (`src/adapters/base.ts`):

```typescript
export abstract class BaseAdapter implements HookAdapter {
  abstract readonly platform: PlatformId;
  abstract readonly name: string;
  abstract getConfigDir(): string;
  abstract getSessionDir(): string;
  abstract getInstructionFiles(): string[];
  abstract getMemoryDir(): string;
  // ...
}
```

**Detection** (`src/adapters/detect.ts`): Auto-detects platform from env vars + MCP handshake `clientInfo`:
- `CLAUDE_CODE_*` → Claude Code
- `CURSOR_TRACE_ID` → Cursor
- `OPENCODE_*` → OpenCode
- `PI_CODING_AGENT_DIR` → Pi
- etc.

### Applicability to search-mcp
**LOW.** search-mcp doesn't need multi-platform support currently. But the **adapter pattern itself** is a clean architectural pattern worth noting.

---

## Priority Integration Recommendations

### 🔴 Immediate wins (low effort, high impact)

#### A. Output Budget Tracking
Add `trackResponse()` to every tool handler in search-mcp. Expose through `health_check`.

**Files to touch:**
- All tool handlers under `src/tools/`
- `src/health.ts` (add stats endpoint)

**Estimated effort:** 2-3 hours

#### B. AGENTS.md Routing Instructions
Create `configs/AGENTS.md` that teaches models how to use search-mcp tools efficiently:

```markdown
# search-mcp — Context-Efficient Search

## Tool Selection Hierarchy

0. **MEMORY**: ctx_search(sort: "timeline") — after resume
1. **GATHER**: web_search + web_read — primary search
2. **PROCESSING**: ctx_execute(language, code) — analyze results in sandbox
3. **INDEX**: ctx_index(content, source) — store for repeated reference
4. **DEEP**: semantic_crawl — sites needing multi-page exploration

## Think in Code — MANDATORY

Analyze search results: **write code** via ctx_execute(), console.log() only the answer.
Do NOT read 20 search results into context to compare them manually.
```

**Estimated effort:** 1 hour

#### C. Smart Snippet Extraction with FTS5 Highlight Markers
Replace current first-N truncation in search results with context-mode's FTS5 `highlight()`-based window extraction.

**Files to touch:**
- `src/rag/pipeline.ts` (search result formatting)
- `src/utils/corpusCache.ts` (cached result formatting)

**Estimated effort:** 3-4 hours

### 🟡 Medium-term wins (moderate effort, moderate impact)

#### D. Levenshtein Fuzzy Correction
Add to `src/rag/pipeline.ts` or `src/tools/webSearch.ts`:
- Detect typos in query terms
- Auto-correct before searching
- Adaptive edit distance thresholds

**Estimated effort:** 4-6 hours

#### E. Porter Stemming for FTS5
Add porter tokenizer to search-mcp's corpus cache FTS5 tables for better recall:
- "configuring" matches "configure", "configuration"
- Requires schema migration for existing corpora

**Files to touch:**
- `src/utils/corpusCache.ts` (schema + tokenizer config)

**Estimated effort:** 4-6 hours

#### F. Intent-Driven Output Filtering
Add optional `intent` parameter to search tools that:
1. Runs the full search
2. Indexes results into FTS5
3. Returns only intent-matched snippets
4. Reports total results count + available search terms

**Estimated effort:** 6-8 hours

### 🟢 Long-term investments (high effort, high impact)

#### G. Progressive Throttling per Session
Track per-session call counts and reduce response sizes progressively:
- Calls 1-5: Full results
- Calls 6-15: Reduced results + warning
- Calls 16+: Redirect to batch processing

**Estimated effort:** 8-12 hours

#### H. Session Continuity Bridge
Persist search decisions (queries, selected URLs, findings) across session compactions so the model can resume search work without repeating queries.

**Estimated effort:** 2-3 weeks (requires hook infrastructure)

---

## Implementation Notes

### Byte-Safe Truncation Pattern
Context-mode's `src/truncate.ts` provides a clean utility for any outputting tool:

```typescript
// Binary search for longest prefix within byte budget
function byteSafePrefix(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(str) <= maxBytes) return str;
  let lo = 0, hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // Guard against UTF-16 surrogate pair split
  if (lo > 0) {
    const code = str.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1;
  }
  return str.slice(0, lo);
}
```

### Smart Truncation (Head+Tail)
When full output exceeds budget:
- Keep first 60% of lines (context)
- Keep last 40% of lines (errors/messages)
- Report: `"[N lines / X KB truncated — showing first A + last B lines]"`
- Snap to line boundaries (never mid-line)
- UTF-8 safe (never corrupt multi-byte characters)

### Stopword Filtering for Better BM25
Context-mode filters 80+ stopwords before BM25 ranking. search-mcp should do the same:
- Common English words ("the", "and", "for", ...)
- Code/changelog noise ("update", "test", "fix", "add", ...)

---

## Architecture Comparison

| Component | context-mode | search-mcp | Gap |
|-----------|-------------|-----------|-----|
| Sandbox execution | 12 languages | None | **Large** |
| Knowledge base | FTS5 BM25 + trigram + fuzzy | SQLite corpus cache + embeddings + BM25+ | **Medium** (search-mcp has more but lacks stemming/fuzzy) |
| Search fusion | RRF (porter + trigram) | RRF (embedding + BM25+) | **Complementary** (could combine) |
| Snippet extraction | FTS5 highlight markers | First-N truncation | **Small** (context-mode superior) |
| Output budget tracking | Per-tool, per-session | None | **Medium** |
| Session continuity | Full event capture + snapshots | None | **Large** |
| Intent filtering | 5KB threshold + BM25 match | None | **Medium** |
| URL caching | 24h TTL, force bypass, 14d cleanup | Corpus cache (different use case) | **Small** |
| Security policies | Command + file path deny | SSRF guards only | **Small** |
| Multi-platform | 15 adapters | None (single provider) | **Large** (not needed for search-mcp) |

---

## Risk Assessment

1. **Porter stemming migration**: Existing FTS5 tables need schema change. Backward-compatible approach: add porter tokenizer as new table, migrate lazily.

2. **Intent filtering accuracy**: BM25-only filtering may miss semantically relevant results. Consider combining with embedding similarity for filter stage.

3. **Session continuity complexity**: Requires hook infrastructure search-mcp doesn't have. Start with stateless improvements first.

4. **Progressive throttling UX**: Aggressive throttling may frustrate users who genuinely need many results. Make thresholds configurable.
