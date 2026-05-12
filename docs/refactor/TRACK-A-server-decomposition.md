# Track A: Server Composition Root Decomposition — Completion Report

**Goal:** Shrink `src/server.ts` from 1153 lines of mixed wiring-and-implementation to a pure composition root (~74 lines). Each standalone tool gets its own registration module with inline schemas and handlers.

**Status:** ✅ Complete — typecheck passes, lint passes (pre-existing cloak.ts error only).

## Outcome

### Files Created

| File | Purpose | Lines |
|------|---------|-------|
| `src/tools/standalone/webSearch.ts` | Inline schema + handler, wraps `webSearch()` | ~50 |
| `src/tools/standalone/webRead.ts` | Inline schema + handler, RAGA fallback, readability fallback | ~150 |
| `src/tools/standalone/webCrawl.ts` | Inline schema + handler, RAGA fallback, extraction config | ~170 |
| `src/tools/standalone/semanticCrawl.ts` | Inline schema + handler, RAGA fallback, contextual embeddings | ~310 |
| `src/tools/standalone/semanticJobs.ts` | Inline schema + handler, gated | ~170 |
| `src/tools/standalone/fetchFocus.ts` | Gated on crawl4ai + deepResearch config | ~30 |
| `src/tools/standalone/healthCheck.ts` | Wraps `runHealthProbes()` | ~20 |
| `src/utils/ragaFallback.ts` | Shared RAGA extraction, `tryRagaFallback()`, `normalizeLlmForValidation()`, `buildLlmFallback()` | ~160 |
| `src/utils/crawlResultShaping.ts` | `readabilityFallbackResult()`, `extractionWarnings()` | ~90 |

### Files Modified

| File | Before | After | Delta |
|------|--------|-------|-------|
| `src/server.ts` | 1153 lines | **74 lines** | -1079 lines |

### Architecture After

```
src/server.ts                    # Pure wiring: imports, loadConfig, register tools (74 lines)
├── src/utils/ragaFallback.ts    # Shared RAGA extraction for document URLs
├── src/utils/crawlResultShaping.ts  # Shared crawl result normalization
├── src/tools/standalone/        # 7 standalone tool registration modules
│   ├── webSearch.ts
│   ├── webRead.ts
│   ├── webCrawl.ts
│   ├── semanticCrawl.ts
│   ├── semanticJobs.ts
│   ├── fetchFocus.ts
│   └── healthCheck.ts
├── src/tools/families/          # Unchanged (youtube, reddit, github, packages, research, browser)
└── src/tools/deepResearch.ts    # Unchanged
```

### What Changed From the Spec

| Spec Prediction | Actual Outcome |
|----------------|----------------|
| `readabilityFallbackResult` stays in server.ts | Extracted to `crawlResultShaping.ts` |
| `normalizeLlmForValidation` stays in server.ts | Moved to `ragaFallback.ts` |
| `buildLlmFallback` stays in server.ts | Moved to `ragaFallback.ts` |
| Each module exports capability check function | Not implemented (deferred) |
| `extractWithRAGA` stays in server.ts | Core logic in `tryRagaFallback()`, progress wrap stays in server |
| server.ts ~80 lines | server.ts 74 lines |

### Key Constraints Preserved

- ✅ ESM imports with `.js` extension
- ✅ Zod v4 from `zod/v4`
- ✅ TypeScript strict mode
- ✅ No behavioural changes — pure decomposition
- ✅ Each tool keeps schema + handler together
