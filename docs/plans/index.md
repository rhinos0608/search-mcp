# Search MCP Roadmap — Implementation Plans Index

**Version**: V5.3.0 (Current) · Previous: V4.1.0 (Implemented ✅)

This document indexes all implementation plans for the Search MCP roadmap.

## Current State: V5.3.0 Complete ✅ (2026-05-18)

- **V3.0.0** — COMPLETE: RAG pipeline extraction, YouTube/Reddit adapters
- **V3.0.5** — COMPLETE: job adapter MVP with structured extraction, SEEK/Indeed/Jora
- **V3.1.0 (Phase 1)** — COMPLETE: SQLite corpus cache, Exa neural search
- **V3.1.0 (Code)** — COMPLETE: tree-sitter code adapter, `semantic_github_code`
- **V3.1.1** — COMPLETE: crawl reliability (HTML threading, timeout scaling, size guard)
- **V3.1.5** — COMPLETE: RAG-Anything integration, code review quality fixes
- 900+ tests pass; typecheck ✅ · lint ✅ · format ✅

---

## V3.0.0 — Universal RAG Core

**Status**: Complete ✅ (merged to worktree `v3-implementation`, 2026-04-25)  
**Priority**: Critical  
**Depends On**: V2.0.0 (current)

**Summary**: Extract RAG pipeline from `semanticCrawl.ts` into a dedicated `src/rag/` module. This shared pipeline becomes the foundation for all semantic search tools.

| Document            | Path                                  |
| ------------------- | ------------------------------------- |
| Full Spec           | `docs/plans/v3.0.0/SPEC.md`           |
| Implementation Plan | `docs/plans/v3.0.0/IMPLEMENTATION.md` |

### Key Deliverables

1. **Core Module (`src/rag/`)**
   - `types.ts` — Stable interfaces (Corpus, Chunk, RetrievalResult, RetrievalTrace)
   - `pipeline.ts` — `prepareCorpus()` + `retrieveCorpus()` two-phase entry points
   - `chunking.ts`, `embedding.ts`, `bm25.ts`, `fusion.ts`, `rerank.ts`, `corpusCache.ts`
   - `profiles.ts` — Named settings for different retrieval strategies

2. **Adapter System**
   - `adapters/index.ts` — Registry + interface
   - `adapters/text.ts` — Default (markdown chunking)
   - `adapters/transcript.ts` — For YouTube captions (speaker turns or fixed segments)
   - `adapters/conversation.ts` — For Reddit/HN (flatten tree with parent context)

3. **New Tools**
   - `semantic_youtube` — YouTube transcript search
   - `semantic_reddit` — Reddit comment search

4. **Eval Harness**
   - `src/rag/__tests__/eval/` — Golden query tests for CI quality gates

**Estimated Scope**: ~1,700 LOC new code

---

## V3.0.5 — Job Adapter MVP

**Status**: Complete ✅ (2026-04-25, branch `v3.0.5-job-adapter`)  
**Priority**: High  
**Depends On**: V3.0.0

**Summary**: Add a focused MVP job adapter that extracts structured fields (title, company, location, workMode, salary) from crawled job pages and ranks with weighted composite score.

| Document            | Path                                  |
| ------------------- | ------------------------------------- |
| Full Spec           | `docs/plans/v3.0.5/SPEC.md`           |
| Implementation Plan | `docs/plans/v3.0.5/IMPLEMENTATION.md` |

### Key Deliverables

1. **Job Adapter (`src/rag/adapters/job.ts`)** MVP
   - Extracts structured `JobListingMVP` objects from SEEK, Indeed, Jora pages
   - Confidence scoring per field
   - Verification status (fetched page vs. search snippet vs. aggregator copy)

2. **Simple Constraint-Aware Ranking**
   - Hard filters: location, workMode
   - Weighted composite: semantic _ 0.45 + location _ 0.20 + workMode _ 0.15 + recency _ 0.10 + completeness \* 0.10

3. **Tool**
   - `semantic_jobs` — Job listing search with structured results

**Estimated Scope**: ~750 LOC new code

---

## V3.1.0 — Code / GitHub

**Status**: Complete ✅ (V3.1.0 Code shipped 2026-04-26; Phase 1 shipped 2026-04-25)  
**Priority**: High  
**Depends On**: V3.0.0

**Summary**: Consolidate existing GitHub tools into the RAG pipeline with a dedicated code adapter. Enable semantic query across codebases — "show me where this function is called."

| Document            | Path                                  |
| ------------------- | ------------------------------------- |
| Full Spec           | `docs/plans/v3.1.0/SPEC.md`           |
| Implementation Plan | `docs/plans/v3.1.0/IMPLEMENTATION.md` |

### Key Deliverables

1. **Code Adapter (`src/rag/adapters/code.ts`)**
   - Language detection (TypeScript, JavaScript, Python, Go, Rust)
   - Code-aware chunking (function/class boundaries, not token splits)
   - Symbol extraction (function names, signatures, imports, docstrings)

2. **Tool**
   - `semantic_github_code` — Semantic code search across repos
   - Returns code chunks with symbol context, call sites

**Estimated Scope**: ~800 LOC new code

---

## V3.2.0 — Domain Adapters + Structured Retrieval + Distribution

**Status**: Planning in progress (`v3.2.0-planning` worktree)  
**Priority**: High  
**Depends On**: V3.0.0, V3.0.5, V3.1.0

**Summary**: Complete the domain adapter ecosystem (Stack Overflow, HN, academic, news), upgrade the job adapter to full pipeline, add three-layer deduplication, constraint-aware ranking, source profiles, coverage reporting, and `semantic_search` unified tool prototype. **Includes distribution packaging** (Docker Compose, Ollama/Transformers.js, MCP registry — originally V3.4.0) as Phase 6 intermediate milestone.

| Document            | Path                                       |
| ------------------- | ------------------------------------------ |
| Full Spec           | `docs/plans/v3.2.0/SPEC.md`                |
| Implementation Plan | `docs/plans/v3.2.0/IMPLEMENTATION.md`      |
| Full Implementation | `docs/plans/v3.2.0/IMPLEMENTATION_PLAN.md` |

### Key Deliverables — Domain & Pipeline

1. **New Domain Adapters**
   - `qa.ts` — Stack Overflow Q&A pair preservation (`semantic_stackoverflow`)
   - Conversation adapter for HN (`semantic_hackernews`)
   - `academic.ts` — Paper structure (abstract, intro, method, results, equations, citations; `semantic_academic`)
   - Text adapter for news with news-specific dedup (`semantic_news`)

2. **Full Job Pipeline (upgrade from V3.0.5 MVP)**
   - Structured salary parsing, seniority classification, requirements extraction
   - LinkedIn best-effort via source profiles
   - Three-layer dedup, hard/soft constraint ranking, coverage reporting, explanation generation

3. **Three-Layer Deduplication** (`src/rag/dedup.ts`)
   - URL canonicalization, structured fingerprint, semantic near-dupe
   - Cross-source merge tracking

4. **Constraint-Aware Ranking**
   - Hard constraints: filter (location, salary, experience, workMode)
   - Soft constraints: score boost (proximity, recency, source trust)
   - Explanation generation per result

5. **Source Capability Profiles** (`src/rag/sources.ts`)
   - Per-source dynamic risk, duplicate risk, structured data likelihood, crawl reliability
   - Orchestrator uses profiles to choose strategies

6. **Coverage Reporting** (first-class in every multi-source response)

7. **`semantic_search` Unified Tool Prototype**
   - Single dispatch tool alongside per-tool names (no deprecation)

8. **Full Eval Harness**
   - Golden queries for all adapters
   - Metrics: recall@1, recall@3, recall@10, mrr, latency distribution
   - CI integration: fail if recall@3 < 0.7 or p95Latency > 10s

### Key Deliverables — Distribution (Phase 6 Milestone)

9. **Docker Compose Bundle**
   - `Dockerfile` + `docker-compose.yml` with SearXNG + Crawl4AI + embedding sidecar
   - One-command deploy, zero API-keys mode

10. **Ollama / Transformers.js Embeddings**
    - `EMBEDDING_PROVIDER=ollama` and `EMBEDDING_PROVIDER=transformers` modes
    - Fully local embedding without external API dependencies

11. **MCP Registry Publishing**
    - Listed on mcp.so, FastMCP.market, MCP Registry
    - Feature matrix comparison vs Kindly, Vera, mcp-local-rag, mcp-crawl4ai-rag

**Estimated Scope**: ~2,840 new + ~660 modified LOC (Phase 6 = ~340 new + ~160 modified)

---

## V3.3.0 — Extraction Resilience & Search Recall

**Status**: Complete ✅ (merged 2026-04-30)
**Priority**: High  
**Depends On**: V3.0.0

**Summary**: Hardening extraction quality and search recall based on research into [agent-search](https://github.com/brcrusoe72/agent-search) (9-strategy kill chain, domain trust, query expansion, content scrubbing, self-improvement) and [mcp-crawl4ai-rag](https://github.com/coleam00/mcp-crawl4ai-rag) (contextual embeddings, code extraction, persistent storage).

| Document            | Path                                  |
| ------------------- | ------------------------------------- |
| Full Spec           | `docs/plans/v3.3.0/SPEC.md`           |
| Implementation Plan | `docs/plans/v3.3.0/IMPLEMENTATION.md` |

### 8 Independently Shippable Stages

| #   | Stage                           | Source           | Effort | New Files                        | Modified Files                              |
| --- | ------------------------------- | ---------------- | ------ | -------------------------------- | ------------------------------------------- |
| 1   | **Contextual Embeddings**       | mcp-crawl4ai-rag | Medium | `src/rag/contextualEmbedding.ts` | `semanticCrawl.ts`, `server.ts`, `types.ts` |
| 2   | **Domain Trust & Typosquat**    | agent-search     | Low    | `src/utils/domainTrust.ts`       | `semanticCrawl.ts`, `config.ts`             |
| 3   | **Query Expansion**             | agent-search     | Low    | `src/tools/queryExpansion.ts`    | `webSearch.ts`, `server.ts`                 |
| 4   | **External Recovery Fallbacks** | agent-search     | Medium | `src/utils/externalRecovery.ts`  | `webCrawl.ts`, `types.ts`                   |
| 5   | **Content Scrubbing**           | agent-search     | Medium | `src/utils/contentScrubber.ts`   | `semanticCrawl.ts`, `config.ts`             |
| 6   | **Cross-Backend Search Merge**  | agent-search     | Medium | `src/utils/searchMerge.ts`       | `webSearch.ts`, `types.ts`, `server.ts`     |
| 7   | **Code Example Extraction**     | mcp-crawl4ai-rag | Low    | —                                | `chunking.ts`                               |
| 8   | **Self-Improvement Tracking**   | agent-search     | Low    | `src/utils/extractionStats.ts`   | `webCrawl.ts`, `semanticCrawl.ts`           |

**Estimated Scope**: ~2,500 LOC new code

**All 8 stages complete as of 2026-04-30. 26 files changed, ~2,803 insertions, zero behavior change by default.**

---

## V3.3.1 — Search Backend Expansion

**Status**: Planning
**Priority**: High
**Depends On**: V3.3.0

**Summary**: Expand `web_search` with a true zero-key backend (DuckDuckGo), keep SearXNG/Brave/Exa intact, and add Ollama as an opt-in account-gated web-search backend while preserving crawl4ai/browser rendering and the existing fusion/merge path.

**Note**: This is search-backend work only; Ollama embeddings stay under V3.2.0 / `EMBEDDING_PROVIDER=ollama`.

| Document            | Path                                  |
| ------------------- | ------------------------------------- |
| Full Spec           | `docs/plans/v3.3.1/SPEC.md`           |
| Implementation Plan | `docs/plans/v3.3.1/IMPLEMENTATION.md` |

### Key Deliverables

1. **Zero-key fallback backend**
   - DuckDuckGo-first, no API key required
   - Experimental HTML parsing with short timeouts and conservative retries

2. **Opt-in Ollama web search backend**
   - Account/API key gated search path
   - Explicit config only; disabled by default

3. **Backend health tracker**
   - Sliding-window per-backend health monitoring
   - Degradation/recovery thresholds with hysteresis

4. **Bot-challenge circuit breaker**
   - Challenge detection (403/429, CAPTCHA fingerprints, latency)
   - Exponential backoff with jitter and automatic circuit-breaker recovery

5. **Availability-aware selection + merge**
   - Consume health tracker and circuit breaker for intelligent fallback
   - Preserve `mergeSearchBackends`, dedupe, and fusion behavior

**Estimated Scope**: ~900 LOC new code

---

## V4.0.0 — Deep Research Orchestration Engine

**Status**: Complete ✅ · **Priority**: High  
**Depends On**: V3.3.x (existing search/crawl/RAG tools)

**Summary**: Deep multi-phase research orchestration with LLM-driven control loop. Decomposes queries, discovers sources across 6 backends, extracts structured findings via LLM or regex, fills knowledge gaps adaptively, audits integrity, and synthesizes confidence-weighted narrative reports.

| Document            | Path                                  |
| ------------------- | ------------------------------------- |
| Full Spec           | `docs/plans/v4.0.0/SPEC.md`           |
| Implementation Plan | `docs/plans/v4.0.0/IMPLEMENTATION.md` |

### Key Deliverables

1. **LLM Client (`src/research/llm/chat.ts`)**
   - OpenAI-compatible HTTP client with orchestrator/worker model routing
   - Token tracking, retry with backoff, JSON structured output parsing

2. **LLM Prompts (`src/research/llm/prompts.ts`)**
   - 6 system prompts: evaluate, decide, extract, classify, audit, synthesis
   - All output validated JSON matching TypeScript types

3. **LLM Extraction (`src/research/llm/extractor.ts`)**
   - Worker-based extraction with semaphore parallelism (3 concurrent)
   - Falls back to regex-based extraction when LLM unavailable

4. **LLM Synthesis (`src/research/llm/synthesis.ts`)**
   - Orchestrator-based narrative report generation
   - Falls back to rule-based ResearchSynthesizer

5. **3D Confidence Model (`src/research/confidence.ts`)**
   - Evidence confidence (source authority × freshness × corroboration)
   - Extraction confidence (method reliability × content quality × risk)
   - Consistency confidence (agreement ratio × contradiction status)

6. **Control Loop Orchestrator (`src/research/orchestrator.ts`)**
   - `State → Evaluate → Decide → Act → Update State` adaptive loop
   - Rule-based fallback at every phase when LLM not configured
   - Budget-aware: multi-point exhaustion checks, partial synthesis
   - Audit: LLM + rule-based merged with dedup

7. **MCP Tool (`src/tools/families/research.ts`)**
   - `deep_research` action with `quick`/`standard`/`deep`/`exhaustive` depth profiles
   - ConfigIssue checks for missing env vars
   - Progressive rendering via timeline metadata

**Estimated Scope**: ~3,180 + 2,400 LOC LLM orchestration layers

---

## V4.1.0 — Agent-Enhanced Deep Research Engine

**Status**: Sprint 0 substrate complete · Sprints 1-5 planned · **Priority**: High  
**Depends On**: V4.0.0 (existing deep research pipeline)

**Summary**: Transform the rigid phase pipeline into an agent-guided research engine with typed gap lifecycle (Agenda), budget-aware action gating, LLM-powered query rewriting, failure analysis with retry limits, unified trace events, prose synthesis with inline citations, citation chasing, and SERP clustering.

| Document | Path |
| -------- | ---- |
| Full Spec | `docs/plans/v4.1.0/SPEC.md` |
| Implementation Plan | `docs/plans/v4.1.0/IMPLEMENTATION.md` |

### Sprint Breakdown

| Sprint | Deliverable | Status |
|--------|-------------|--------|
| 0 | Substrate: 5 modules (Agenda, ActionGates, Trace, Knowledge, SourceRanking) + prose synthesis + new types | ✅ Complete |
| 1 | Working loop with gates + agenda (wire into orchestrator) | 📋 Planned |
| 2 | LLM-powered query rewriting + dual-score ranking | 📋 Planned |
| 3 | Failure analysis + gap completion (retry limits, abandonment) | 📋 Planned |
| 4 | Unified knowledge + trace + prose synthesis | 📋 Planned |
| 5 | SERP clustering + language detection | 📋 Planned |

---

## Summary Table

| Version | Focus                    | Key Deliverables                                                                                     | Est. Scope |
| ------- | ------------------------ | ---------------------------------------------------------------------------------------------------- | ---------- |
| V3.0.0  | Core Pipeline            | RAG module extraction, adapter system, YouTube/Reddit tools, eval                                    | ~1,700 LOC |
| V3.0.5  | Jobs MVP                 | Job adapter (SEEK, Indeed, Jora), structured extraction                                              | ~750 LOC   |
| V3.1.0  | Code/GitHub              | Code adapter, semantic GitHub search, SQLite cache, Exa                                              | ~800 LOC   |
| V3.1.1  | Reliability              | HTML threading, timeout scaling, size guard                                                          | ~300 LOC   |
| V3.1.5  | RAG-Anything             | PDF/Office extraction bridge, code review fixes                                                      | ~1,200 LOC |
| V3.2.0  | Domains + Dist           | SO, HN, academic, news adapters, full jobs, dedup, constraints, **Docker Compose, Ollama, registry** | ~2,840 LOC |
| V3.3.0  | Resilience               | Contextual embeddings, domain trust, kill chain, query expansion                                     | ~2,500 LOC |
| V4.0.0  | Deep Research            | LLM control loop, 3D confidence, multi-backend discovery, gap analysis, audit, synthesis             | ~5,600 LOC |
| V4.1.0  | Agent Enhancement         | Typed agenda, budget-aware gates, query rewriting, failure analysis, prose synthesis, trace          | ~1,500 LOC |
| V5.1.0  | Pipeline Fix              | Source ingestion, source lifecycle tracking, prose synthesis, freshness scoring, browser fallback    | ~1,200 LOC |
| V5.2.0  | Browser Bridge            | CDP auto-connect, profile persistence, stealth health, multi-mode browser architecture                | ~2,000 LOC |
| V5.3.0  | Resilience & Pruning      | In-flight pruning, retry/circuit-breaker, compaction, topic-drift, URL health                        | ~2,500 LOC |

| **V5 Series**: ~5,700 LOC new code

---

## Related Documentation

- Architecture: `docs/architecture.md`
- Tools Reference: `docs/tools.md`
- MCP Quickstart: `docs/mcp-quickstart.md`
- Composition with RAG: `docs/composition-with-rag-anything.md`
- Semantic Crawl JS Rendering Recovery: `docs/plans/2026-04-25-semantic-crawl-js-rendering-plan.md`

---

_Generated: 2026-05-04 · Last updated: 2026-05-18 (V5.3.0 Research Resilience & Pruning)_
