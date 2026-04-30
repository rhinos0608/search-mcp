# Progress

> Canonical plan status lives in `docs/plans/index.md`.

## Status
Complete — V3.3.0 Extraction Resilience & Search Recall merged (2026-04-30); V3.3.1 search-backend expansion now planned

## V3.3.0 — Extraction Resilience & Search Recall

### Status: Complete ✅

All 8 stages from `docs/plans/v3.3.0/SPEC.md` are implemented, tested, and merged into `main`.

| # | Stage | Status | Files Created | Files Modified |
|---|-------|--------|---------------|----------------|
| 1 | **Contextual Embeddings** | ✅ | `src/rag/contextualEmbedding.ts` | `semanticCrawl.ts`, `server.ts`, `types.ts` |
| 2 | **Domain Trust & Typosquat** | ✅ | `src/utils/domainTrust.ts` | `semanticCrawl.ts`, `config.ts` |
| 3 | **Query Expansion** | ✅ | `src/tools/queryExpansion.ts` | `webSearch.ts`, `server.ts` |
| 4 | **External Recovery Fallbacks** | ✅ | `src/utils/externalRecovery.ts` | `webCrawl.ts`, `types.ts` |
| 5 | **Content Scrubbing** | ✅ | `src/utils/contentScrubber.ts` | `semanticCrawl.ts`, `config.ts` |
| 6 | **Cross-Backend Search Merge** | ✅ | `src/utils/searchMerge.ts` | `webSearch.ts`, `types.ts`, `server.ts` |
| 7 | **Code Example Extraction** | ✅ | — | `chunking.ts` |
| 8 | **Self-Improvement Tracking** | ✅ | `src/utils/extractionStats.ts` | `semanticCrawl.ts`, `webCrawl.ts` |

### Verification
- Typecheck: ✅ (strict mode)
- Lint: ✅
- Tests: 884 pass (all V3.3.0-specific tests included)
- All stages are additive with zero behavior change by default

## Phase Status

| Phase/Version | Feature | Status |
|---------------|---------|--------|
| V3.0.0 | Universal RAG Core | ✅ |
| V3.0.5 | Job Adapter MVP | ✅ |
| V3.1.0 | Code/GitHub Adapter | ✅ |
| V3.1.1 | Crawl Reliability Fixes | ✅ |
| V3.1.5 | RAG-Anything Integration | ✅ |
| V3.2.0 | Domain Adapters + Distribution | 🟡 In progress |
| V3.3.0 | Extraction Resilience | ✅ |
| V3.3.1 | Search Backend Expansion | 🟡 Planned |

## Up Next

### V3.3.1 — Search Backend Expansion (planned)
- DuckDuckGo zero-key fallback
- Opt-in Ollama web search backend
- Preserve crawl4ai/browser rendering and search fusion

### V3.4.0 — Integration (planned)
- Resolver pattern, output budget, structured errors, diagnostics
