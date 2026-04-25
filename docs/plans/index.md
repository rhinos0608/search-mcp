# Search MCP Roadmap — Implementation Plans Index

**Version**: 3.0.0 (implemented in worktree, pending merge) → V3.0.5 → V3.1.0 → V3.2.0

This document indexes all implementation plans for the Search MCP roadmap.

## Current State: V3.0.0 ✅ (worktree `v3-implementation`, 2026-04-25)

- Universal RAG core extracted into `src/rag/` (types, pipeline, embedding, adapters, profiles)
- Adapters: `text` (crawl pages), `transcript` (YouTube), `conversation` (Reddit comments)
- New tools: `semantic_youtube`, `semantic_reddit` (both gated by config health)
- All existing V2.0.0 capabilities preserved; `semantic_crawl` fully backward compatible
- 564/565 tests pass; typecheck ✅ · lint ✅ · format ✅

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

**Status**: Ready to Start (V3.0.0 complete)  
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

**Status**: Not Started  
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

## V3.2.0 — Full Domain Adapters + Eval

**Status**: Not Started  
**Priority**: Medium  
**Depends On**: V3.0.0, V3.0.5, V3.1.0

**Summary**: Complete the domain adapter ecosystem (academic, QA, job full), add three-layer deduplication, constraint-aware ranking, and comprehensive eval harness with metrics.

| Document            | Path                                  |
| ------------------- | ------------------------------------- |
| Full Spec           | `docs/plans/v3.2.0/SPEC.md`           |
| Implementation Plan | `docs/plans/v3.2.0/IMPLEMENTATION.md` |

### Key Deliverables

1. **Remaining Domain Adapters**
   - `academic.ts` — Paper structure (abstract, intro, method, results, equations, citations)
   - `qa.ts` — Stack Overflow Q&A pair preservation
   - `jobFull.ts` — Upgraded Job adapter (LinkedIn, Glassdoor, full source profiles)

2. **Three-Layer Deduplication**
   - URL dedup (exact match)
   - Fingerprint dedup (95% content similarity)
   - Semantic dedup (same entity + role)

3. **Constraint-Aware Ranking**
   - Hard constraints: filter (location, salary, experience, workMode, language)
   - Soft constraints: score boost (companySize, techStack, remoteFirst)

4. **Observability**
   - `instrumentation.ts` — Span hierarchy with timing
   - `metrics.ts` — p50/p95/p99 latency, recall, dedup rate

5. **Full Eval Harness**
   - Golden queries for all adapters
   - Metrics: recall@1, recall@3, recall@10, mrr, latency distribution
   - CI integration: fail if recall@3 < 0.7 or p95Latency > 10s

**Estimated Scope**: ~2,000 LOC new code

---

## Summary Table

| Version | Focus         | Key Deliverables                                                  | Est. Scope |
| ------- | ------------- | ----------------------------------------------------------------- | ---------- |
| V3.0.0  | Core Pipeline | RAG module extraction, adapter system, YouTube/Reddit tools, eval | ~1,700 LOC |
| V3.0.5  | Jobs MVP      | Job adapter (SEEK, Indeed, Jora), structured extraction           | ~750 LOC   |
| V3.1.0  | Code/GitHub   | Code adapter, semantic GitHub search                              | ~800 LOC   |
| V3.2.0  | Completion    | Academic, QA, job full, dedup, constraints, metrics, full eval    | ~2,000 LOC |

**Total V3 Series**: ~5,250 LOC new code

---

## Related Documentation

- V3 Review Notes: `docs/plans/V3_REVIEW.md`
- Architecture: `docs/architecture.md`
- Tools Reference: `docs/tools.md`
- MCP Quickstart: `docs/mcp-quickstart.md`
- Composition with RAG: `docs/composition-with-rag-anything.md`

---

_Generated: 2026-04-24 · Last updated: 2026-04-25 (V3.0.0 complete)_
