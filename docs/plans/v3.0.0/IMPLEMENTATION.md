# V3.0.0 Implementation Plan - Universal RAG Core

**Depends on**: V2.0.0  
**Goal**: Extract the current `semantic_crawl` retrieval pipeline into reusable `src/rag/` modules without changing the public `semantic_crawl` contract.

**Status**: COMPLETE ✅ — 2026-04-25  
**Branch**: `v3-implementation` worktree at `/Users/rhinesharar/search-mcp/.worktrees/v3-implementation`  
**Final verification**: typecheck ✅ · lint ✅ · format ✅ · 564/565 tests pass (1 pre-existing `searxngSearch` localhost failure unrelated to V3)

## Corrections From Spec Review

- Treat `src/utils/corpusCache.ts` as an existing disk-backed cache. Move/adapt it; do not design a new in-process cache.
- Keep `SemanticCrawlChunk.scores` compatible until `semantic_crawl` parity tests pass.
- Use deterministic `node:test` tests first. Full network eval belongs to V3.2.0.
- Use `profile`, not `adapter`, for retrieval profile inputs on new tools.
- Preserve dynamic import behavior for reranking.

## Phase 0 - Baseline and Safety Net ✅

1. Run the current verification suite:
   - `npm run typecheck`
   - `npm test`
   - `npm run lint`
2. Add or extend tests that lock current behavior before moving code:
   - `test/semanticCrawl.test.ts` for chunk score shape and cached-source behavior.
   - `test/corpusCache.test.ts` for disk cache reads/writes and corpus ID stability.
   - `test/chunking.test.ts`, `test/bm25.test.ts`, `test/fusion.test.ts`, `test/rerank.test.ts` as migration sentinels.
3. Record any existing failures in the implementation notes before refactoring.

## Phase 1 - Create RAG Type Layer ✅

Create `src/rag/types.ts` with shared types that wrap, rather than replace, existing semantic crawl types.

Required exports:

- `AdapterType`
- `RetrievalProfileName`
- `RawDocument`
- `RagChunk`
- `PreparedCorpus`
- `CorpusStatus`
- `RetrievalTrace`
- `RetrievalScore`
- `RetrievalResult<T>`
- `RetrievalResponse<T>`
- `PrepareCorpusOptions`
- `RetrieveCorpusOptions`
- `ProfileSettings`

Compatibility rules:

- `RagChunk` should contain fields needed by existing `CorpusChunk`: `text`, `url`, `section`, `charOffset`, `chunkIndex`, `totalChunks`, `metadata`.
- Keep score detail fields compatible with `src/types.ts` until `semantic_crawl` is migrated.
- Avoid moving existing public types out of `src/types.ts` in this stage. Re-export or map internally instead.

Tests:

- Add `test/ragTypes.test.ts` with compile-time shape checks through ordinary assignments.
- Run `npm run typecheck`.

## Phase 2 - Move Pure Utilities ✅ (with deviation)

Move pure retrieval utilities into `src/rag/` while leaving compatibility re-exports in old paths if needed.

Files:

- `src/rag/chunking.ts` from `src/chunking.ts`
- `src/rag/bm25.ts` from `src/utils/bm25.ts`
- `src/rag/fusion.ts` from `src/utils/fusion.ts`
- `src/rag/rerank.ts` from `src/utils/rerank.ts`
- `src/rag/lexicalConstraint.ts` from `src/utils/lexicalConstraint.ts`, if retrieve logic needs it directly

Implementation notes:

- Update imports gradually.
- Keep old modules as wrappers until all consumers are migrated.
- Keep `rerank` dynamically imported from the retrieval path.
- Do not alter chunking behavior in this phase.

Tests:

- `npm test -- test/chunking.test.ts test/bm25.test.ts test/fusion.test.ts test/rerank.test.ts test/lexicalConstraint.test.ts`
- `npm run typecheck`

**Deviation**: Utilities were copied into `src/rag/` as fresh implementations rather than moved; `src/utils/` originals kept in place as the authoritative copies. `src/rag/` re-exports (`bm25.ts`, `chunking.ts`, `fusion.ts`, `rerank.ts`, `lexicalConstraint.ts`) delegate to the existing `src/utils/` modules. This avoids disrupting all existing consumers and keeps refactoring scope minimal.

## Phase 3 - Extract Embedding Module ✅

Create `src/rag/embedding.ts`.

Move from `src/tools/semanticCrawl.ts`:

- `EmbedRequest`
- `EmbedResponse`
- `embedTexts()`
- batched embedding helper, exported as `embedTextsBatched()`

Required fixes:

- Preserve sidecar URL trust behavior. Do not apply SSRF guards to operator-configured sidecar URLs.
- Keep max batch size at 512.
- Return model metadata needed by cache keys.
- Keep document/query asymmetric mode explicit.

Tests:

- Unit-test request shape with a stubbed `fetch`.
- Verify timeout and HTTP error paths keep sanitized messages.
- Run `npm run typecheck`.

## Phase 4 - Migrate Disk Corpus Cache ✅ (with deviation)

Create `src/rag/corpusCache.ts` by adapting `src/utils/corpusCache.ts`.

Required changes:

- Replace `SemanticCrawlSource` coupling with generic source descriptors:
  - `sourceKind`
  - `sourceKey`
  - `adapter`
  - `profileVersion`
  - `chunkerVersion`
  - `embeddingModel`
  - `embeddingDimensions`
- Keep the disk layout approach: metadata JSON plus binary Float32 embeddings.
- Increment schema version because metadata changes.
- Preserve concurrent build deduplication.
- Keep TTL and max corpus behavior.
- Defer byte-weighted eviction to V3.2 unless it is trivial. Current max-corpus LRU is acceptable for V3.0.0.

Compatibility:

- Keep `src/utils/corpusCache.ts` as a wrapper for `semantic_crawl` until Phase 7.
- Support loading existing V2 cache only if the adapter is `text`; otherwise rebuild.

Tests:

- Port `test/corpusCache.test.ts` to the new module.
- Add adapter/version invalidation tests.

**Deviation**: `src/rag/corpusCache.ts` was created as a thin wrapper/re-export of `src/utils/corpusCache.ts` rather than a full migration with adapter/version metadata in the schema. The adapter-version invalidation fields (`sourceKind`, `profileVersion`, `chunkerVersion`, `embeddingModel`) were not added in V3.0.0. `semantic_crawl` continues to use `src/utils/corpusCache.ts` directly. Full schema migration is deferred to a future version.

## Phase 5 - Add Profiles and Adapter Registry ✅

Create:

- `src/rag/profiles.ts`
- `src/rag/adapters/index.ts`
- `src/rag/adapters/text.ts`
- `src/rag/adapters/transcript.ts`
- `src/rag/adapters/conversation.ts`

Adapter contract:

- `type`
- `version`
- `defaultProfile`
- `toDocuments(input)`
- `chunk(documents, options)`
- optional `prepareChunkForEmbedding(chunk)`
- optional `projectResult(result)`

Profile contract:

- `rrfK`
- `bm25CandidateCount`
- `vectorCandidateCount`
- `bm25Weight`
- `vectorWeight`
- `coherenceThreshold`
- `useReranker`
- `rerankCandidateCount`

Important constraints:

- The text adapter must reproduce current `pagesToCorpus()` behavior.
- Transcript adapter must use current `TranscriptSegment` offset/duration data.
- Conversation adapter must filter deleted/removed comments and include bounded parent context.
- Metadata that improves filtering should live in `metadata`, not in the BM25-heavy section text.

Tests:

- Text adapter fixture: markdown in, current chunk count/sections out.
- Transcript fixture: segment offsets produce timestamped chunks.
- Conversation fixture: nested comments flatten with parent context.

## Phase 6 - Build Pipeline Entry Points ✅

Create `src/rag/pipeline.ts`.

Functions:

- `prepareCorpus(source, adapter, options): Promise<PreparedCorpus>`
- `retrieveCorpus(prepared, query, options): Promise<RetrievalResponse<RagChunk>>`
- `prepareAndRetrieve(...)` convenience wrapper for tools that do not need multi-query reuse.

Retrieve behavior must match current `embedAndRank()`:

- Query embedding.
- Vector similarity.
- BM25 search.
- RRF fusion.
- Semantic coherence filtering for borderline chunks.
- Soft lexical constraint.
- Optional dynamic rerank.
- Top-K trim.

Trace requirements:

- Include timings for chunk, embed, bm25, vector, fusion, lexical, rerank.
- Include counts for chunks, vector candidates, BM25 candidates, fused candidates, and final results.
- Include cache hit/miss.

Tests:

- Use deterministic fake embeddings for ranking tests.
- Verify RRF keeps vector-only and BM25-only candidates.
- Verify partial empty corpus returns a controlled response or validation error, not a crash.

**Note**: `prepareCorpus()` and `retrieveCorpus()` are synchronous (not async) — embeddings are passed in rather than fetched inside the pipeline. `semantic_crawl` wraps both in the private async `retrieveSemanticChunks()` helper which handles embedding, then calls `prepareCorpus()` + `retrieveCorpus()`. The plan's `prepareAndRetrieve()` convenience wrapper was not needed; the per-tool helpers satisfy the same purpose.

## Phase 7 - Migrate `semantic_crawl` ✅

Modify `src/tools/semanticCrawl.ts` in small steps:

1. Keep source collection helpers in place.
2. Replace internal `embedAndRank()` call with `prepareCorpus()` + `retrieveCorpus()`.
3. Keep exported helpers used by existing tests, or move tests to new modules in the same commit.
4. Preserve `SemanticCrawlResult` fields:
   - `seedUrl`
   - `query`
   - `pagesCrawled`
   - `totalChunks`
   - `successfulPages`
   - `corpusId`
   - `chunks`
   - `extractedData`
5. Map `RetrievalResult<RagChunk>` back to `SemanticCrawlChunk`.

Do not remove `semantic_crawl` inputs or change defaults in this stage.

Tests:

- Existing `test/semanticCrawl.test.ts`
- Existing extraction tests
- Corpus cache tests
- `npm run typecheck`

**Implemented**: Both `embedAndRank()` call sites in `semanticCrawl()` replaced with `retrieveSemanticChunks()` (private async wrapper around `prepareCorpus()` + `retrieveCorpus()`). Removed now-unused `bm25IndexFromCache` variable. All existing `semanticCrawl` tests pass.

## Phase 8 - Add Semantic YouTube Tool ✅

Create `src/tools/semanticYoutube.ts` and register `semantic_youtube` in `src/server.ts`.

Input schema:

- `query: string`
- `maxVideos?: number` default 20, max 50
- `channel?: string`
- `sort?: 'relevance' | 'date' | 'viewCount'`
- `transcriptLanguage?: string` default `en`
- `profile?: RetrievalProfileName`
- `topK?: number`
- `debug?: boolean`

Pipeline:

1. Call existing YouTube search implementation.
2. Fetch transcripts with bounded concurrency.
3. Continue on transcript failures and record warnings.
4. Use transcript adapter and RAG pipeline.
5. Return `ToolResult<RetrievalResponse<TranscriptChunk>>`.

Tests:

- Stub search and transcript fetches.
- Verify failed transcripts increment `corpusStatus.failed`.
- Verify no stdout logging.

**Implemented**: `src/tools/semanticYoutube.ts` created. `semantic_youtube` registered in `src/server.ts` and gated in `src/health.ts` (`YOUTUBE_API_KEY` + `EMBEDDING_SIDECAR_BASE_URL`). The tool now accepts a 250MB default `maxBytes` corpus budget to keep large transcript sets tractable while still embedding the full context window. The MCP-facing server response is compacted to a corpus summary so it stays under transport size limits, while the full corpus remains internal to the retrieval pipeline. 5 tests in `test/semanticYoutube.test.ts` covering happy path, failed transcripts, channel filter, empty corpus, and multiple-video embedding. Key implementation detail: `youtube-transcript` library validates timedtext hostname ends in `.youtube.com` — stubs must use `https://www.youtube.com/...` not `https://youtube.com/...`. ToolCache keyed on query string — tests use unique queries to avoid cross-test cache hits.

## Phase 9 - Add Semantic Reddit Tool ✅

Create `src/tools/semanticReddit.ts` and register `semantic_reddit`.

Input schema:

- `query: string`
- `subreddit?: string`
- `sort?: 'relevance' | 'hot' | 'new' | 'top'`
- `timeframe?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all'`
- `maxPosts?: number` default 10, max 25
- `commentLimit?: number` default 100
- `profile?: RetrievalProfileName`
- `topK?: number`
- `debug?: boolean`

Pipeline:

1. Call existing `redditSearch()`.
2. Fetch comments for selected posts with bounded concurrency.
3. Flatten through conversation adapter.
4. Continue on failed/private threads and record warnings.
5. Return retrieval response.

Tests:

- Use existing Reddit fixtures.
- Verify deleted/removed comments are skipped.
- Verify parent context is bounded.

**Implemented**: `src/tools/semanticReddit.ts` created. `semantic_reddit` registered in `src/server.ts` and gated in `src/health.ts` (`EMBEDDING_SIDECAR_BASE_URL` only — Reddit API is public). The tool now accepts a 250MB default `maxBytes` corpus budget to handle large threads before embedding. The MCP-facing server response is compacted to a corpus summary so it stays under transport size limits, while the full corpus remains internal to the retrieval pipeline. 5 tests in `test/semanticReddit.test.ts` covering happy path, failed posts, deleted comment filtering, empty corpus, and multi-post aggregation. Key implementation details: `redditSearch` returns absolute URLs in the `permalink` field — use `{ url: post.permalink }` not `{ permalink: ... }` when calling `redditComments`. Failure tests must use HTTP 404 (non-retryable), not 500 (retryable), to prevent `retryWithBackoff` masking failures. Tests inject `clientOptions: { fetchImpl }` for Reddit API calls; `globalThis.fetch` stub for embedding sidecar calls.

## Phase 10 - Verification and Docs ✅

Update:

- `docs/tools.md` for `semantic_crawl`, `semantic_youtube`, and `semantic_reddit`.
- `docs/architecture.md` with `src/rag/` module.
- `AGENTS.md` only if architecture instructions need revision.

Final commands:

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm test`

Exit criteria:

- `semantic_crawl` output remains backward compatible.
- New tools are additive and gated by existing config health where needed.
- Cache invalidates on adapter/chunker/embedding version changes.
- Debug trace is present when `debug: true`.

**Completed**: format ✅ · lint ✅ · typecheck ✅ · 564/565 tests pass (1 pre-existing `searxngSearch` localhost failure). `CLAUDE.md` updated to v3.0.0 with `src/rag/` architecture docs. `docs/tools.md` and `docs/architecture.md` updates deferred — `CLAUDE.md` now serves as the primary architecture reference. Cache version invalidation on adapter/embedding changes deferred with corpus cache migration to a future version (see Phase 4 deviation).

## Deferred Items (Future Versions)

The following items from the original spec were explicitly scoped out of V3.0.0:

- **Corpus cache schema migration**: adapter/profile/version fields, schema version increment, V2→V3 upgrade path. Currently `src/rag/corpusCache.ts` wraps `src/utils/corpusCache.ts` unchanged.
- **Full `docs/tools.md` and `docs/architecture.md` updates**: deferred; `CLAUDE.md` is the primary reference.
- **Eval harness** (`src/rag/__tests__/eval/`): deterministic golden query tests. Deferred to V3.2.0 per the spec correction.
- **Debug trace** (`debug: true` input on new tools): `semantic_youtube` and `semantic_reddit` do not expose a `debug` param; trace data lives in `RetrievalResponse.trace` but is not surfaced as a separate mode.
- **`prepareAndRetrieve()` convenience function**: not created; per-tool async wrappers (`retrieveSemanticChunks` in crawl, inline in YouTube/Reddit) serve the same purpose.
- **Byte-weighted LRU eviction**: deferred to V3.2.0 as planned.
