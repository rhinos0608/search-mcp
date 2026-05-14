# Progress

## Status
Entity-resolution + provenance grounding work complete — all phases implemented and committed.

## Tasks
- [x] Entity-Resolution / Record-Linkage for Deep Research
  - [x] `findingLinkage.ts`: UnionFind transitive clustering with 3 edge methods + 3-zone merge logic
  - [x] `clusterRevision.ts`: LLM-powered cluster revision with conflict resolution
  - [x] `contradictionDetector.ts`: Shared contradiction detection (LLM + rule-based fallback)
  - [x] Three-zone merge: deterministic merge (≥0.92 cosine), LLM review band, lexical/direct fallthrough
  - [x] `greedySplit()` and `splitOversizedClusters()` for oversized cluster management
  - [x] Phase 2 three-zone merge logic + `needsLlmReview` / `mergeStatus` in types
- [x] Source-Chunk Provenance Grounding
  - [x] `provenance.ts`: GroundedClaim/GroundingResult with Perplexity-style citation grounding
  - [x] `extractClaimEntities()`, `groundSynthesisClaims()`, `enrichReport()` wiring
- [x] Budget/timeout increases for LLM-heavy pipeline
  - [x] LLM retry with exponential backoff (8 retries, 60s max delay)
  - [x] Depth profile timeouts: quick 5min, standard 8min, deep 30min, exhaustive 45min, tree 15min
- [x] Free backends academic search expansion
  - [x] Fan-out to all 12 backends in academicSearch.ts
  - [x] Research family source enum expanded

## Files Changed
- `src/research/` — 23 modified + 4 new modules (clusterRevision, contradictionDetector, findingLinkage, provenance)
- `src/tools/academicSearch.ts` — 12-backend fan-out
- `src/tools/deepResearch.ts` — timeout limits aligned with new budgets
- `src/tools/`, `src/browser/`, `src/crawl/`, `src/utils/` — formatting fixes
- `test/research/` — 2 new test files (cluster-revision, provenance-mcp)

## Notes
- All lint and typecheck pass cleanly
- No new npm dependencies
- Backward compatible: existing callers that don't use new cluster/provenance fields see no behavior change
