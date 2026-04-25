# V3 Roadmap Review Notes

**Date**: 2026-04-24  
**Scope**: `docs/plans/index.md` and V3.0.0, V3.0.5, V3.1.0, V3.2.0 specs

## Summary

The roadmap direction is sound: extract the semantic retrieval machinery from `semanticCrawl.ts`, prove the shared pipeline with non-web-crawl corpora, then add domain adapters. The main fixes are sequencing and fidelity to the current V2 codebase.

The implementation plans in each stage now assume the current repository shape:

- Tests use `node:test` through `scripts/run-tests.cjs`.
- Local imports are ESM with `.js` extensions.
- Tool handlers return `ToolResult<T>` through `successResponse()` / `errorResponse()`.
- `zod/v4` is used for schemas.
- `src/utils/corpusCache.ts` is already disk-backed, not in-process-only.
- `src/utils/githubCorpus.ts` currently returns `GitHubCorpusDocument[]`, not a rich corpus object.
- Existing `SemanticCrawlChunk.scores` must remain compatible during migration.

## Corrections Incorporated

1. **V3.0.0 cache wording**
   The spec said the current cache is in-process and that V3 adds serialization. The current cache already writes metadata and binary embeddings to disk. V3.0.0 should migrate this implementation into `src/rag/corpusCache.ts`, add adapter/profile/version metadata, and preserve disk compatibility where practical.

2. **V3.0.0 migration order**
   The risky part is not creating new files; it is changing score and chunk types while `semantic_crawl` still depends on them. The plan now keeps a compatibility wrapper first, then migrates `semantic_crawl` internally after tests are in place.

3. **V3.0.0 eval scope**
   A full network-dependent eval suite is too large for the first extraction stage. V3.0.0 should add deterministic unit/integration tests plus offline golden fixtures. Full adapter-wide metrics stay in V3.2.0.

4. **V3.0.5 job source reliability**
   LinkedIn should not be attempted in the MVP because it is auth-wall prone and low reliability. The MVP stays with SEEK, Indeed, and Jora. LinkedIn and Glassdoor remain V3.2.0 source-profile work.

5. **V3.0.5 ranking data flow**
   The weighted job score needs query embeddings and listing embeddings from the shared pipeline instead of a bespoke embedding path. The plan adds a structured-result projection layer after retrieval.

6. **V3.1.0 GitHub corpus shape**
   The spec assumed an older `fetchGitHubCorpus(owner, repo, ref, filter)` signature. The current function accepts one options object and returns documents. The plan uses it as a source collector and leaves richer code metadata in the adapter.

7. **V3.1.0 code parsing scope**
   Regex-only parsing for nested JavaScript/TypeScript functions is brittle. The implementation plan starts with line-range heuristics and symbol headers, then tests expected behavior. Full AST parsing is left as a future enhancement unless a dependency is added deliberately.

8. **V3.2.0 async pseudocode**
   The spec shows `await` inside a non-async `deduplicate()` example. The plan defines async semantic dedup explicitly and keeps URL/fingerprint dedup synchronous.

9. **V3.2.0 Stack Overflow answers**
   The current `stackoverflow_search` returns question search results only. QA adapter work must first add a fetch path for answers, or the adapter cannot preserve answer context.

10. **Documentation polish**
    Fixed the `p#` typo in the V3.1.0 spec heading and added implementation-plan links to the roadmap index.

## Week-One Semantic Tool Stress Test Findings

The new semantic tools are broadly sound, but the week-one tests exposed a few guardrail gaps that should shape the next iteration:

- `semantic_reddit` is reliable with subreddit-scoped queries, but broad cross-Reddit search is noisy enough that it should be treated as an opt-in fallback, not a primary path.
- `commentLimit` must be hard-capped at 100 for Reddit. The upstream API rejects larger values, so the schema needs to match reality.
- `semantic_youtube` channel filtering works, but transcript chunking still returns short, decontextualized fragments when captions are split too finely. The plan should preserve YouTube as a search + transcript retrieval flow, not promise sentence-level coherence from raw auto-captions.
- GitHub code retrieval is highly sensitive to pre-filters. Broad repo crawls drift into examples or surface files; query/file/language filters should be treated as mandatory guidance for non-trivial repos.
- DFS crawl strategy needs a hard `maxPages` stop. The stress test overran the configured page budget, so page accounting must be part of the acceptance criteria.
- Structured extraction knobs like `extractionConfig` and cached-corpus reuse should continue to be documented as side-channel features, not assumed to influence semantic ranking.
- The upside: the failures were shallow and localized. The underlying architecture, scoring breakdowns, and corpus shaping are still strong.

## Suggested Execution Order

1. V3.0.0: extraction and compatibility.
2. V3.0.5: structured jobs MVP on top of the new pipeline.
3. V3.1.0: code adapter and semantic GitHub code tool.
4. V3.2.0: remaining adapters, dedup, constraints, metrics, and eval.

Do not start V3.0.5 or V3.1.0 before V3.0.0 exposes stable adapter and retrieval types. That avoids parallel type churn across tool implementations.
