# V3.0.0 — Universal RAG Core: Implementation Plan

**Status**: Not Started  
**Priority**: Critical  
**Depends On**: V2.0.0 (current, live)

## Overview

Extract the RAG pipeline from `semanticCrawl.ts` into a dedicated `src/rag/` module. This shared pipeline will become the foundation for all semantic search tools (YouTube, Reddit, GitHub, academic, job listings).

## Goals

1. Extract existing RAG logic into reusable `src/rag/` module
2. Prove adapter contract with YouTube and Reddit tools
3. Add eval harness for CI quality gates

## Architecture

```
src/rag/
├── types.ts           # Corpus, Chunk, RetrievalResult, CorpusStatus, RetrievalTrace
├── pipeline.ts       # prepareCorpus() + retrieveCorpus() — two-phase entry points
├── chunking.ts        # moved from src/chunking.ts
├── embedding.ts      # moved from embedTexts/embedTextsBatched
├── bm25.ts           # moved from src/utils/bm25.ts
├── fusion.ts          # moved from src/utils/fusion.ts
├── rerank.ts         # moved from src/utils/rerank.ts
├── corpusCache.ts    # moved from src/utils/corpusCache.ts — with versioned keys
├── profiles.ts      # named RetrievalProfile definitions
├── dedup.ts         # three-layer deduplication (initially placeholder, full impl V3.2)
├── constraints.ts   # constraint-aware ranking (initially placeholder, full impl V3.2)
└── adapters/
    ├── index.ts    # adapter registry + type
    ├── text.ts     # default: markdown chunking
    ├── transcript.ts # speaker turns, time-coded segments
    └── conversation.ts # comment/thread context preservation
```

## Phase 1: Extract Core RAG Module

### src/rag/types.ts

Define stable interfaces that both internal code and external tools will depend on.

```typescript
// Core Types
interface CorpusStatus {
  requested: number; // total items the tool tried to fetch
  fetched: number; // successfully fetched and processed
  failed: number; // fetch/parse failures
  skipped: number; // filtered out (deleted, too short, wrong type)
  cacheHit: boolean; // was this corpus served from cache?
  warnings: string[];
}

interface RetrievalTrace {
  adapter: AdapterType;
  profile: RetrievalProfile;
  chunksIndexed: number;
  embeddingModel: string;
  bm25Candidates: number;
  vectorCandidates: number;
  fusedCandidates: number;
  reranked: boolean;
  cacheHit: boolean;
  timingsMs: {
    fetch: number;
    chunk: number;
    embed: number;
    bm25: number;
    vector: number;
    fusion: number;
    rerank: number;
  };
}

interface RetrievalResult<T> {
  item: T; // the chunk, or structured object (V3.2)
  semanticScore: number;
  bm25Score: number;
  fusedScore: number;
  rerankedScore?: number;
  rank: number;
  metadata: Record<string, unknown>;
}

interface RetrievalResponse<T> {
  results: RetrievalResult<T>[];
  corpusStatus: CorpusStatus;
  coverage?: Coverage;
  retrievalTrace?: RetrievalTrace;
}

// Adapter Types
type AdapterType = 'text' | 'code' | 'transcript' | 'conversation' | 'academic' | 'qa' | 'job';

type RetrievalProfile =
  | 'balanced' // default: equal RRF weight
  | 'lexical-heavy' // BM25-weighted RRF, higher lexical constraint
  | 'semantic-heavy' // vector-weighted RRF, looser lexical constraint
  | 'high-precision' // reranking enabled, tighter coherence filter
  | 'fast'; // skip reranking, fewer BM25 candidates

type RetrievalOpts = {
  adapter: AdapterType;
  topK?: number;
  profile?: RetrievalProfile;
  debug?: boolean;
};

type EmbeddingMode = 'document' | 'query';

interface RawDocument {
  id: string;
  title: string;
  content: string;
  url: string;
  metadata: Record<string, unknown>;
}

interface Chunk {
  id: string;
  text: string;
  url: string;
  section: string;
  charOffset: number;
  chunkIndex: number;
  totalChunks: number;
  metadata: Record<string, unknown>;
}

interface PreparedCorpus {
  corpusId: string;
  chunks: Chunk[];
  embeddings: number[][];
  bm25Index: Bm25Index;
  adapter: AdapterType;
  createdAt: number;
}
```

### src/rag/pipeline.ts

Two-phase entry points:

```typescript
// Phase 1: fetch, normalize, chunk, embed, index
export async function prepareCorpus(
  source: RawDocument[],
  adapter: Adapter,
  options?: PrepareCorpusOptions,
): Promise<PreparedCorpus>;

// Phase 2: rank, rerank, return top-K
export async function retrieveCorpus(
  preparedCorpus: PreparedCorpus,
  query: string,
  options: RetrievalOpts,
): Promise<RetrievalResponse<Chunk>>;
```

**Key decision**: Keep `prepareCorpus` and `retrieveCorpus` as separate calls. This allows:

- Corpus to be built once, queried many times
- Explicit per-stage caching and failure tracking
- Different retrieval profiles without re-embedding

### src/rag/chunking.ts

Move from `src/chunking.ts`. Keep the existing implementation unchanged:

- 400-token max
- 20% overlap
- Atomic units for code/tables
- Boilerplate heuristics

### src/rag/embedding.ts

Move and refactor embedding functions from `semanticCrawl.ts`:

- `embedTexts()` / `embedTextsBatched()`
- Add wrapper to handle mode + title awareness
- Support precomputed embeddings for cached corpora

### src/rag/bm25.ts

Move from `src/utils/bm25.ts`. Already implemented.

### src/rag/fusion.ts

Move from `src/utils/fusion.ts`. Already implemented.

### src/rag/rerank.ts

Move from `src/utils/rerank.ts`. Already implemented.

### src/rag/corpusCache.ts

Move from `src/utils/corpusCache.ts`. Key additions:

- Versioned cache keys (adapter, chunker, embedding model versions)
- Byte-weighted LRU eviction
- `PreparedCorpus` serialization / deserialization

### src/rag/profiles.ts

Define profile-to-settings mapping:

```typescript
const PROFILES: Record<AdapterType, Record<RetrievalProfile, ProfileSettings>> = {
  transcript: {
    balanced: { rrfK: 60, bm25Weight: 0.5, vectorWeight: 0.5, coherenceThreshold: 0.15 },
    semanticHeavy: { rrfK: 60, bm25Weight: 0.3, vectorWeight: 0.7, coherenceThreshold: 0.1 },
    lexicalHeavy: { rrfK: 60, bm25Weight: 0.7, vectorWeight: 0.3, coherenceThreshold: 0.2 },
    highPrecision: {
      rrfK: 60,
      bm25Weight: 0.4,
      vectorWeight: 0.4,
      rerank: true,
      coherenceThreshold: 0.25,
    },
    fast: { rrfK: 30, bm25Weight: 0.5, vectorWeight: 0.5, coherenceThreshold: 0.15, rerank: false },
  },
  conversation: {
    // ... similar
  },
  text: {
    // ... similar
  },
};
```

## Phase 2: Adapter System

### src/rag/adapters/index.ts

```typescript
interface AdapterRegistry {
  get(type: AdapterType): Adapter;
  register(type: AdapterType, adapter: Adapter): void;
  list(): AdapterType[];
}

interface Adapter {
  type: AdapterType;
  chunk(docs: RawDocument[], opts: ChunkOpts): Chunk[];
  prepareForRetrieval(chunks: Chunk[]): PreparedChunk[];
  preferredProfile: RetrievalProfile;
  profileOverrides: Record<RetrievalProfile, ProfileSettings>;
}
```

### src/rag/adapters/text.ts

Default adapter. Uses `chunkMarkdown()` from chunking.ts.

### src/rag/adapters/transcript.ts

For YouTube captions:

- Chunk by speaker turn OR fixed 30-second segments with 5-second overlap
- Speaker turn fallback: auto-generated captions (no diarization) → fixed segments
- Section format: `${videoTitle} > ${timestamp}`
- Warnings in corpusStatus when falling back

### src/rag/adapters/conversation.ts

For Reddit, HN:

- Flatten comment tree with parent context
- Prefix truncated parent (~150 chars) to chunk text before embedding
- Section format: `post_title > parent_comment_snippet` (parent ~80 chars)
- `reply_depth` as metadata (not in section text — pollutes BM25)

## Phase 3: Semantic YouTube Tool

### Tool: semantic_youtube

Uses `semanticCrawl.ts` extraction as guide but calls new pipeline.

**Pipeline:**

1. `youtube_search` → up to 100 video IDs
2. `youtube_transcript` fetched with adaptive concurrency (start 8, increase to 20 if healthy, back off on 429s)
3. Transcript adapter chunks
4. `prepareCorpus()` with transcript adapter
5. `retrieveCorpus()` with balanced or caller-specified profile
6. Cached by versioned key

**Input schema:**

```typescript
{
  query: string,
  maxVideos?: number,        // default 20
  channel?: string,
  sort?: 'relevance' | 'date' | 'viewCount',
  transcriptLanguage?: string,
  profile?: RetrievalProfile,
  topK?: number,
  debug?: boolean
}
```

**Output:** `RetrievalResponse<TranscriptChunk>` with corpusStatus

## Phase 4: Semantic Reddit Tool

### Tool: semantic_reddit

**Pipeline:**

1. `reddit_search` → post list
2. Full comment trees in parallel (adaptive concurrency)
3. Conversation adapter: flatten tree, filter deleted/removed, prefix parent context
4. `prepareCorpus()` with conversation adapter
5. `retrieveCorpus()`
6. Cached by versioned key

**Input schema:**

```typescript
{
  query: string,
  subreddit?: string,
  sort?: 'relevance' | 'hot' | 'new' | 'top',
  timeframe?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all',
  profile?: RetrievalProfile,
  topK?: number,
  debug?: boolean
}
```

## Phase 5: Eval Harness

### src/rag/**tests**/eval/

```
src/rag/__tests__/eval/
├── golden-queries/
│   ├── youtube.json     # { query, expectedTopK: [{ videoId, timestamp }] }
│   ├── reddit.json      # { query, expectedTopK: [{ postId, commentId }] }
│   └── ...
├── eval.ts              # runner: load golden queries, assert top-K hits
└── thresholds.json     # { maxLatencyMs, minRecallTop3, maxChunkCount }
```

### Eval checks:

- Golden query returns expected source/chunk in top 3 or top 10
- Latency budget per stage
- Cache hit/miss behavior
- Chunk count within bounds
- Reranker improves ranking
- Partial failure behavior — 30% corpus failure still returns valid results

**Run as part of CI.**

## Phase 6: Server Integration

### src/server.ts

Register new tools alongside existing ones:

- `semantic_youtube`
- `semantic_reddit`

Keep existing `semantic_crawl` unchanged (calls pipeline internally for parity).

## Quality Gates

- [ ] Existing `semantic_crawl` parity — all V2 golden queries return equivalent results
- [ ] YouTube partial failure tested — 30% transcript failure returns valid results
- [ ] Reddit partial failure tested — deleted/removed comments filtered
- [ ] Cache keys invalidate on adapter/chunker/embedding model change
- [ ] Debug trace timings exist for every pipeline stage
- [ ] Adapter registry: adding new adapter doesn't break existing
- [ ] Byte-weighted cache eviction works

## Open Questions

1. **Corpus ID reuse across tools**: Should `semantic_youtube` and `semantic_reddit` share corpus IDs?
   - Decision: No — namespace by tool (`youtube:`, `reddit:`)

2. **Adaptive concurrency**: Current pattern in `semanticCrawl.ts` vs explicit limits?
   - Decision: Keep current retryWithBackoff pattern, add adaptive layer later

3. **Structured object extraction**: Job listings in V3.0 or V3.2?
   - Decision: V3.0.5 for job MVP, V3.2 for full domain adapter

## Dependencies

- `CRAWL4AI_BASE_URL` (existing)
- `CRAWL4AI_API_TOKEN` (existing)
- `EMBEDDING_SIDECAR_BASE_URL` (existing)
- `EMBEDDING_SIDECAR_API_TOKEN` (existing)
- `YOUTUBE_API_KEY` (existing)

## Estimated Scope

- Core module extraction: ~600 LOC new files
- Adapter system: ~400 LOC
- YouTube tool: ~200 LOC
- Reddit tool: ~200 LOC
- Eval harness: ~300 LOC

**Total new code: ~1,700 LOC**

## Files to Create

1. `src/rag/types.ts`
2. `src/rag/pipeline.ts`
3. `src/rag/chunking.ts` (copy from src/)
4. `src/rag/embedding.ts`
5. `src/rag/profiles.ts`
6. `src/rag/dedup.ts` (placeholder)
7. `src/rag/constraints.ts` (placeholder)
8. `src/rag/adapters/index.ts`
9. `src/rag/adapters/text.ts`
10. `src/rag/adapters/transcript.ts`
11. `src/rag/adapters/conversation.ts`
12. `src/rag/__tests__/eval/`

## Files to Modify

1. `src/tools/semanticCrawl.ts` (use new pipeline internally)
2. `src/tools/semanticYoutube.ts` (new tool file)
3. `src/tools/semanticReddit.ts` (new tool file)
4. `src/server.ts` (register new tools)

## Migration Notes

- `semantic_crawl` interface unchanged — internal refactor only
- New tools are additive — existing discovery tools remain available for lightweight use
- Cache namespace separates tools (`youtube:`, `reddit:`) to avoid ID collisions

---

**Next Step**: V3.0.5 — Job Adapter MVP
