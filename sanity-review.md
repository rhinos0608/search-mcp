# Sanity Review — ROADMAP.md, PROGRESS.md, docs/plans/index.md

**Date**: 2026-05-01
**Scope**: Post-cleanup consistency check for broken links, stale version references, inaccurate stage-file claims, and cross-document contradictions.

---

## Findings

### Blocker — Stale `package.json` version

- **Location**: `package.json` line 3
- **Issue**: Version is `"3.1.0"` while all three planning documents describe **V3.3.0 as complete** and **V3.3.1 as in planning**.
- **Evidence**:
  - `ROADMAP.md`: V3.3.0 marked ✅ Done, V3.3.1 🟡 Planned
  - `PROGRESS.md`: "Complete — V3.3.0 … merged (2026-04-30)"
  - `docs/plans/index.md`: "Current State: V3.3.0 Complete ✅"
- **Resolution**: Bump `package.json` version to `"3.3.0"` (or `"3.3.1"` if a prerelease bump is preferred).

### Note — V3.2.0 status is understated in `docs/plans/index.md`

- **Location**: `docs/plans/index.md` → V3.2.0 section
- **Issue**: Documents V3.2.0 as **"Planning in progress"** (`v3.2.0-planning` worktree), yet a large portion of its deliverables are already implemented and present in `main`.
- **Evidence of existing implementation**:
  - Docker Compose bundle: `docker-compose.yml` (root) + `Dockerfile` (root) — includes SearXNG, Crawl4AI, embedding sidecar, rag-anything-bridge
  - Ollama / Transformers.js embeddings: `src/utils/ollamaEmbedding.ts`, `src/utils/transformersEmbedding.ts`
  - Domain adapters: `src/rag/adapters/qa.ts`, `academic.ts`, `conversation.ts`, `text.ts`
  - Dedup / constraints: `src/rag/dedup.ts`, `src/rag/constraints.ts`, `src/rag/jobDedup.ts`, `src/rag/jobRanking.ts`
  - Job pipeline: `src/rag/adapters/job.ts`, `src/rag/sources/jobSources.ts`
- **What is still missing**: `semantic_stackoverflow`, `semantic_hackernews`, `semantic_academic`, `semantic_news`, `semantic_search` tool registrations; `src/rag/sources.ts` capability profiles; eval harness CI gates; MCP registry publishing.
- **Resolution**: Update V3.2.0 status from **"Planning in progress"** to **"In progress (partial — adapters, dedup, constraints, Docker Compose, and Ollama/Transformers embeddings landed)"** so the plan reflects reality.

### Note — Minor status-label inconsistency between ROADMAP and canonical index

- **Location**: `ROADMAP.md` table vs `docs/plans/index.md` V3.2.0 header
- **Issue**: `ROADMAP.md` uses "🟡 In progress" for V3.2.0; `docs/plans/index.md` uses "🟡 Planning in progress". If the cleanup pass intended to align these, the canonical index is lagging behind the ROADMAP.
- **Resolution**: Align both to the same status label (recommend "🟡 In progress" since substantial implementation has already landed).

### Correct — Verified claims

- **Broken internal links**: None. All `.md` and code paths referenced in the three documents exist on disk.
- **V3.3.0 stage-file claims**: All 8 stages’ created/modified files exist and contain the expected V3.3.0 logic (verified by spot-check of `src/rag/contextualEmbedding.ts`, `src/utils/domainTrust.ts`, `src/tools/queryExpansion.ts`, `src/utils/externalRecovery.ts`, `src/utils/contentScrubber.ts`, `src/utils/searchMerge.ts`, `src/chunking.ts`, `src/utils/extractionStats.ts`, and their claimed modification targets).
- **Version/date consistency**: `2026-05-01` current-date references, `2026-04-30` merge dates, and V3.3.1 planning headers are consistent across all three documents.
- **Test count**: `884 tests pass` appears identically in both `PROGRESS.md` and `docs/plans/index.md`; no contradictory number is present.

---

## Summary

| File | Issues | Severity |
|------|--------|----------|
| `package.json` | Version stuck at 3.1.0 | **Blocker** |
| `docs/plans/index.md` | V3.2.0 status understated ("Planning" vs actual partial implementation) | Note |
| `ROADMAP.md` ↔ `docs/plans/index.md` | V3.2.0 status labels not aligned | Note |
| Cross-file links | All internal links resolve | Correct |
| Stage-file claims (V3.3.0) | All files exist and are correctly attributed | Correct |
