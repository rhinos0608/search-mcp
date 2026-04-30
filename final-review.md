# Final Review — ROADMAP.md, PROGRESS.md, docs/plans/index.md

**Date:** 2026-05-01  
**Scope:** Consistency, canonical ordering, misleading statements, and remaining actionable doc issues across the three canonical planning documents.

---

## Issues Found

### 1. Broken link — `docs/plans/V3_REVIEW.md` does not exist
- **Location:** `docs/plans/index.md`, Related Documentation section  
- **Statement:** `V3 Review Notes: docs/plans/V3_REVIEW.md`  
- **Evidence:** File search returned no match for `docs/plans/V3_REVIEW.md`.  
- **Action:** Remove the reference or create the file.

### 2. Misleading modified-file claims in V3.3.0 stage tables
Both `PROGRESS.md` and `docs/plans/index.md` list files as "modified" for specific stages, but those files contain no implementation or import references for the corresponding feature.

#### Stage 2 — Domain Trust & Typosquat
- **Claimed modified:** `semanticCrawl.ts`, `config.ts`, `webCrawl.ts` (`docs/plans/index.md` only)  
- **Actual:** Only `semanticCrawl.ts` and `config.ts` import or reference `domainTrust`. `webCrawl.ts` has no references (`grep` returned no matches).
- **Scope:** `docs/plans/index.md` table (PROGRESS.md correctly omits `webCrawl.ts`).

#### Stage 5 — Content Scrubbing
- **Claimed modified:** `semanticCrawl.ts`, `webRead.ts`, `config.ts`  
- **Actual:** Only `semanticCrawl.ts` imports `scrubContent`. `webRead.ts` has no scrub references.
- **Scope:** Both `PROGRESS.md` and `docs/plans/index.md`.

#### Stage 7 — Code Example Extraction
- **Claimed modified:** `chunking.ts`, `types.ts`  
- **Actual:** `src/chunking.ts` implements code-block extraction (`codeBlocks`, `codeFence`), but `src/types.ts` does not type the new metadata fields.
- **Scope:** Both `PROGRESS.md` and `docs/plans/index.md`.

#### Stage 8 — Self-Improvement Tracking
- **Claimed modified:** `webCrawl.ts`, `semanticCrawl.ts`, `health.ts`  
- **Actual:** `webCrawl.ts` and `semanticCrawl.ts` import `recordOutcome`, but `health.ts` does not reference `extractionStats` or surface domain stats.
- **Scope:** Both `PROGRESS.md` and `docs/plans/index.md`.

#### Stage 1 — Contextual Embeddings
- **Claimed modified:** `semanticCrawl.ts`, `server.ts`, `types.ts`  
- **Actual:** `semanticCrawl.ts` and `server.ts` are correct. `types.ts` has no `contextualEmbedding`, `LlmConfig`, or related fields.
- **Scope:** Both `PROGRESS.md` and `docs/plans/index.md`.

### 3. Minor version-label inconsistency — V3.1 Phase 1 vs V3.1.0 Phase 1
- **ROADMAP.md** lists the release as "V3.1 Phase 1".  
- **PROGRESS.md** and **docs/plans/index.md** refer to it as "V3.1.0" (with sub-bullets for Phase 1 / Code).  
- **Impact:** Low, but adds friction when scanning the release table; canonical name should be `V3.1.0` everywhere.

### 4. Test-count mismatch (non-blocking, informational)
- **PROGRESS.md** states **884 tests pass** for V3.3.0.  
- **docs/plans/index.md** Current State header (dated 2026-04-24) states **700+ tests pass**.  
- These are snapshots from different dates, but updating the index header to the current test count would remove ambiguity.

---

## Correct

- **Canonical ordering** is consistent across all three files; versions ascend correctly from V3.0.0 → V3.4.0.
- **V3.3.1 plan insertion** is fully present and aligned; all three docs describe the same scope (DuckDuckGo zero-key fallback, opt-in Ollama web search, availability-aware selection + merge).
- **V3.3.0 scope, dates, and status** agree everywhere: Complete ✅, merged 2026-04-30.
- **V3.3.1 SPEC & IMPLEMENTATION** exist at the paths listed in `docs/plans/index.md`.
- **V3.2.0 status** consistently marked as in-progress across all three docs.
- **V3.3.1 correctly preserves the embedding/search distinction** — docs explicitly note `EMBEDDING_PROVIDER=ollama` remains separate from the new `ollama-search` web backend.

---

## Fixed (none during review)

_No issues were corrected during this read-only review._

---

## Notes

- The modified-file tables in V3.3.0 were clearly copied from the implementation plan forward into status docs. As the codebase evolved, some files (e.g., `webRead.ts`, `health.ts`, `types.ts`) were either not touched or the corresponding types were defined inline rather than in `types.ts`. A pass to ground-truth every "modified" cell against `git log --name-only` would tighten accuracy.
- If `docs/plans/V3_REVIEW.md` is intentionally omitted, the index should drop the line. If it is planned, a stub or `TODO` placeholder would prevent the broken reference.
