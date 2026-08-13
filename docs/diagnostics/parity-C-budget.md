# Parity C: Output-Budget Truncation UX — Diagnostic

**Cluster**: C — OUTPUT-BUDGET TRUNCATION UX  
**Observed**: `web_search` hits 192 KiB budget, truncates inline output, spills full results to `~/.cache/search-mcp/web-search-artifacts/<uuid>.md`. The truncation + artifact spill feels awkward versus a cleaner competitor output.  
**Date**: 2026-08-12

---

## Current Behavior

### (a) What triggers the spill? What gets truncated vs kept?

**Spill trigger** — `src/tools/webSearchArtifact.ts:485-486`:

```ts
const countOverflow = usableResults.length > limit;
const hasOverflow = countOverflow || preview.truncated;
```

Two independent conditions trigger artifact spill:

1. **Count overflow** (line 485): more usable results than the user's requested `limit`
2. **Byte/prose truncation** (line 486): the inline preview hit a budget cap during formatting

When `hasOverflow` is true (line 487), a **full artifact** is written (all results, `full: true` mode, no per-document snippet caps — lines 493-496), and a notice line is appended to the inline preview.

**What gets truncated** — `src/tools/webSearchResultFormatter.ts:1261-1272`:
The `formatInternal` loop processes results **sequentially in rank order** and **breaks at the first result that would exceed `contentBudget`** (line 1267-1269):

```ts
if (utf8Length(candidate) > contentBudget) {
  truncated = true;
  break;
}
```

**Top-ranked results are NOT explicitly guaranteed complete before spill.** They receive the same adaptive per-document budget as all others. A top-#1 result with a 30 KiB document will be truncated to the ceiling (24 KiB) just like any other result. The sequential fill means top results _happen_ to be more complete because they're emitted first and rarely hit the per-doc cap — but there's no special protection.

Within each document, `formatDocument` (line 1001) enforces a per-document byte budget that skips whole blocks when they don't fit (lines 1162-1166):

```ts
if (utf8Length(candidate) + 1 > docContentBudget) {
  truncated = true;
  break;
}
```

**Adaptive per-document allocation** — `src/tools/webSearchResultFormatter.ts:100-134` (`rankDocumentBudget`):

```ts
// Priority-aware rank-skewed allocation: rank-1 gets ~1.5x the average share
// tapering linearly to ~0.6x for the last rank. Weights are normalized to
// ADAPTIVE_TOTAL_UTILIZATION (0.9) of the total budget.
const share = Math.floor((totalBudget * ADAPTIVE_TOTAL_UTILIZATION * weight) / weightSum);
```

- 1 result → 24 KiB (ceiling)
- 5 results → ~34 KiB → capped at 24 KiB (ceiling)
- 10 results → ~17 KiB
- 15 results → ~11 KiB
- 20+ results → 8 KiB (floor)

At 10 results with 17 KiB each = 170 KiB of allocated content, leaving 22 KiB for header + truncation note — but the actual header "Web search results" + per-result headings/metadata consume ~4-6 KiB, so the practical limit is often ~8-12 results before spill.

### (b) Is the 192 KiB total budget fixed or configurable?

**Fixed. Hardcoded. No env var override.**

- `DEFAULT_TOTAL_BUDGET_BYTES = 192 * 1024` — `src/tools/webSearchResultFormatter.ts:52`
- The production call path (`src/tools/standalone/webSearch.ts:166-170`) does **not** pass `totalBudgetBytes`, so it always uses the default.
- `AssembleWebSearchOptions.totalBudgetBytes` exists (line 432 of `webSearchArtifact.ts`) but is only exercised in tests.
- No env var (`WEB_SEARCH_BUDGET`, `SEARCH_MCP_TOTAL_BUDGET`, etc.) is read anywhere in config.ts or the tool registration.

### (c) Is the artifact always written, or only on overflow? Cleanup/TTL?

**Only on overflow.** — `src/tools/webSearchArtifact.ts:487-489`:

```ts
if (!hasOverflow) {
  return { text: preview.text, artifactWritten: false };
}
```

When there's no count overflow and no truncation, no artifact is written. The user gets the full inline results with no spill.

**Cleanup/TTL** — well-designed:

- **TTL**: 24h (`ARTIFACT_TTL_MS` at line 41), expired files removed on every write + on periodic sweep
- **Max files**: 200 (`ARTIFACT_MAX_FILES` at line 43)
- **Max total bytes**: 64 MiB (`ARTIFACT_MAX_TOTAL_BYTES` at line 45)
- **Per-artifact hard cap**: 1 MiB (`ARTIFACT_MAX_BYTES` at line 39)
- **Sweeper**: runs at startup + every hour (`ARTIFACT_SWEEP_INTERVAL_MS` at line 263), unref'd timer
- **Atomic writes**: temp file + rename (lines 389-391), symlink attack protection (lines 154-155, 393-399)
- **Recheck after eviction** (lines 369-378): failed unlinks can't bypass capacity

No TTL/cleanup concerns — the implementation is solid.

### (d) User-facing message

**Truncation note** — `src/tools/webSearchResultFormatter.ts:67`:

```
> Content truncated at output budget.
```

Appended to the inline preview when truncation occurred (line 1316).

**Unified notice** — `src/tools/webSearchArtifact.ts:419-425` (`buildArtifactNotice`):

```
> ⚠ Showing 8 of 12 results. Full results: /path/to/artifact.md
```

Or when the artifact itself was truncated:

```
> ⚠ Showing 8 of 12 results. Full results: /path/to/artifact.md (hard cap)
```

**Suppressed notice** — `src/tools/webSearchArtifact.ts:435-437` (`suppressedNotice`):
When the artifact write is suppressed (no path), a unified "Showing N of M" notice is emitted. When truncation is true but shownCount equals totalCount, the notice reads "Content truncated." instead of the misleading "Showing N of N results."

**Could it be clearer?** Yes:

1. The truncation note (`> Content truncated at output budget.`) is vague — it doesn't say _what_ was truncated. The unified `Showing N of M` notice in `buildArtifactNotice` and `suppressedNotice` addresses this.
2. The artifact notice reveals a filesystem path that's meaningless to a human and opaque to most MCP clients — many clients won't read files from disk.
3. The two messages appear together (truncation note + artifact notice), creating visual clutter. The unified notice merges them.
4. There's no option to suppress the artifact write entirely (for clients that can't read local files).

---

## UX Improvement Options

### Option 1: Priority-Aware Budget Allocation (IMPLEMENTED)

**Status**: Implemented via `rankDocumentBudget()` (formatter:108-134). Top results get ~1.5x the average share, tapering to ~0.6x for the last rank. Weights are normalized to `ADAPTIVE_TOTAL_UTILIZATION` (0.9) of the total budget.

### Option 2: Configurable Total Budget via Env Var

**Idea**: Add `WEB_SEARCH_BUDGET_BYTES` env var, read in config, passed through `AssembleWebSearchOptions`.  
**Tradeoff**: Users with different MCP client limits could tune this. Low risk since the existing `totalBudgetBytes` option already exists.  
**Complexity**: ~5 lines (config.ts + standalone/webSearch.ts).

### Option 3: Cleaner In-Band Signaling (IMPLEMENTED)

**Status**: Implemented via unified `buildArtifactNotice` and `suppressedNotice` with "Showing N of M" format.

### Option 4: Suppress Artifact When Unreachable

**Idea**: Add a `WEB_SEARCH_ARTIFACTS_ENABLED` env var (default true). When false, skip artifact write and only return truncated inline results with a "results truncated, N of M shown" note.  
**Tradeoff**: Some clients (ChatGPT, Codex) can't read local files — the artifact is wasted disk space for them. This lets those deployments avoid the awkward path reference.  
**Complexity**: ~8 lines.

### Option 5: Reduce Per-Result Allocation Floor

**Idea**: Lower `DEFAULT_DOCUMENT_BUDGET_BYTES` from 8 KiB to 4 KiB. More results fit inline before spill.  
**Tradeoff**: Each result shows less content, but more results are shown. For most queries, 4 KiB (≈ 1K tokens) is sufficient for a useful excerpt.  
**Complexity**: 1 line (constant change). Note: a prior diagnosis doc (`docs/diagnosis/web-search-extraction-formatting-budget.md:67`) recommended 4-8 KiB — the current 8 KiB is already at the high end of that range.

---

## Minimal Fix Sketch

The highest-impact, lowest-risk fix combines Options 2 + 3 + 4:

```typescript
// src/config.ts — add env var
export const webSearchBudgetBytes = (): number | undefined => {
  const v = process.env.WEB_SEARCH_BUDGET_BYTES;
  return v !== undefined ? Number(v) : undefined;
};

// src/tools/standalone/webSearch.ts:166 — pass through
const { text: markdown } = assembleWebSearchResponse(results, {
  limit,
  aiSummary: summaryMode,
  totalBudgetBytes: invocationCfg.webSearchBudgetBytes, // new
  ...(writer !== undefined ? { writeArtifact: writer } : {}),
});

// src/tools/webSearchArtifact.ts — single unified notice
export function buildArtifactNotice(
  result: ArtifactWriteResult,
  shownCount: number,
  totalCount: number,
): string {
  const status = result.path === null ? '(write failed)' : result.complete ? '' : '(hard cap)';
  const pathPart = result.path ? `: ${safePathText(result.path)}` : '';
  const truncNote =
    totalCount > shownCount
      ? ` Showing ${shownCount} of ${totalCount} results.`
      : ' Content truncated.';
  return `\n> ⚠${truncNote}${pathPart ? ' Full results' + pathPart : ''} ${status}`.trim();
}
```

---

## Key File Reference

| File                                    | Lines     | What                                                                 |
| --------------------------------------- | --------- | -------------------------------------------------------------------- |
| `src/tools/webSearchResultFormatter.ts` | 52        | `DEFAULT_TOTAL_BUDGET_BYTES = 192 * 1024`                            |
| `src/tools/webSearchResultFormatter.ts` | 54-56     | Per-doc floor (8 KiB) and ceiling (24 KiB)                           |
| `src/tools/webSearchResultFormatter.ts` | 59        | `ADAPTIVE_TOTAL_UTILIZATION = 0.9`                                   |
| `src/tools/webSearchResultFormatter.ts` | 67        | `TRUNCATION_NOTE` string                                             |
| `src/tools/webSearchResultFormatter.ts` | 100-106   | `adaptiveDocumentBudget()` — uniform allocation                      |
| `src/tools/webSearchResultFormatter.ts` | 117-134   | `rankDocumentBudget()` — priority-aware rank-skewed allocation       |
| `src/tools/webSearchResultFormatter.ts` | 1272-1319 | `formatInternal()` — sequential fill + truncation break              |
| `src/tools/webSearchResultFormatter.ts` | 1304-1307 | **The break point**: result dropped when `candidate > contentBudget` |
| `src/tools/webSearchArtifact.ts`        | 39        | `ARTIFACT_MAX_BYTES = 1 MiB`                                         |
| `src/tools/webSearchArtifact.ts`        | 41-45     | TTL (24h), max files (200), max bytes (64 MiB)                       |
| `src/tools/webSearchArtifact.ts`        | 419-425   | `buildArtifactNotice()` — unified "Showing N of M" notice            |
| `src/tools/webSearchArtifact.ts`        | 435-437   | `suppressedNotice()` — notice when artifact write suppressed         |
| `src/tools/webSearchArtifact.ts`        | 456       | Generic fallback notice                                              |
| `src/tools/webSearchArtifact.ts`        | 473-522   | `assembleWebSearchResponse()` — orchestrates preview + artifact      |
| `src/tools/webSearchArtifact.ts`        | 485-486   | Spill trigger: count overflow OR byte truncation                     |
| `src/tools/standalone/webSearch.ts`     | 162-170   | Production call site (no `totalBudgetBytes` override)                |
| `src/utils/outputBudget.ts`             | 31+       | Session-level tracking (side-effect only, not a cap)                 |
| `src/index.ts`                          | 55        | `startArtifactSweeper()` at startup                                  |

---

## Summary (6 lines)

1. **192 KiB total budget is hardcoded** (`formatter:52`) with no env var override — callers cannot tune it.
2. **Spill triggers** when result count > limit OR any content truncation occurs (`artifact:485-486`) — the artifact always writes full results on overflow, inline gets truncated preview.
3. **Top results get priority-aware budget** via `rankDocumentBudget()` (`formatter:117-134`) — rank-1 gets ~1.5x the average share, tapering to ~0.6x for the last rank, normalized to 90% total utilization.
4. **Artifact is only written on overflow** (`artifact:487-489`); cleanup is solid (24h TTL, 200-file/64-MiB caps, hourly sweeper).
5. **User message is a unified "Showing N of M" notice** (`artifact:419-425`, `artifact:435-437`) — single line, no separate truncation note + path clutter.
6. **Highest-impact remaining fix**: add `WEB_SEARCH_BUDGET_BYTES` env var, add `WEB_SEARCH_ARTIFACTS_ENABLED=false` to suppress artifact for clients that can't read local files.
