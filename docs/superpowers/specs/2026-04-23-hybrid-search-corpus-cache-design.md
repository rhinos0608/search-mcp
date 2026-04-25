# Hybrid Search + Corpus Cache Design

**Date:** 2026-04-23

## Goal

Add BM25+ lexical retrieval to semantic_crawl's existing dense (bi-encoder) pipeline, fuse both rankings via RRF, and enable iterative querying against the same corpus by caching materialized corpora (chunks + embeddings + BM25 index) to disk. Follow-up queries with a `corpusId` skip re-crawl and re-embed entirely.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         QUERY PHASE (per call)                          │
│                                                                         │
│  Source → Params hash → Cache hit? ──yes──► Load corpus from disk       │
│       │                                  (chunks, embeddings, BM25 idx) │
│       │ no                                                               │
│       ▼                                                                 │
│  MATERIALIZATION PHASE (once per unique source)                         │
│       │                                                                 │
│       ├──► Crawl → Chunk → Deduplicate ──► [chunks]                    │
│       │                                                                 │
│       ├──► Embed chunks (batched) ──► [embeddings]                       │
│       │                                                                 │
│       └──► Build BM25+ inverted index ──► [BM25 index]                   │
│                                                                         │
│       ├──► Serialize corpus (JSON + binary embeddings) → disk            │
│       │                                                                 │
│       └──► Return corpusId (deterministic hash)                         │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     FUSION PHASE                                  │   │
│  │                                                                  │   │
│  │  Bi-encoder ranking (cosine sim) ──┐                             │   │
│  │                                    ├──► RRF merge ──► topN       │   │
│  │  BM25+ ranking (query terms) ────────┘   (k=60)                  │   │
│  │                                                                  │   │
│  │  Semantic coherence filter (borderline off-topic removal)        │   │
│  │                                                                  │   │
│  │  Optional cross-encoder re-rank (top 30 candidates)            │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

## New Components

### 1. BM25+ Index (`src/utils/bm25.ts`)

Implements Okapi BM25+ directly — no external dependency. The algorithm is simple enough (~80 lines) that vendoring is cleaner than adding a package.

**Interface:**

```typescript
interface Bm25Document {
  id: string;
  text: string;
}

interface Bm25Index {
  search(query: string, topK?: number): { id: string; score: number }[];
}

export function buildBm25Index(docs: Bm25Document[]): Bm25Index;
```

**Tokenization:** Simple word boundary split (`/\b\w+\b/g`), lowercased. Stop words are not filtered — BM25 handles common words naturally via IDF.

**Parameters:** `k1 = 1.2`, `b = 0.75`, `delta = 1.0` (BM25+ variant). Average document length computed over the corpus.

### 2. Corpus Cache (`src/utils/corpusCache.ts`)

Disk-backed cache storing materialized corpora. Each corpus is identified by a deterministic `corpusId`.

**Cache key construction (deterministic `corpusId`):**

```
corpusId = sha256(normalizedSourceParams + "|" + embeddingModel + "|" + embeddingDimensions)
```

Where `normalizedSourceParams` is a stable JSON serialization of the source configuration (sorted keys, no undefined values), and `embeddingModel` comes from the sidecar's response (e.g., "gemma300m").

**Two-tier keying:**

1. **Params hash** (`corpusId`) — computed instantly from source + model. Used for cache lookup. If hit and within TTL, skip materialization.
2. **Content hash** — computed post-crawl from chunk text content. Stored alongside the corpus. On cache hit, if content hash changed (detected via a lightweight re-crawl or ETag comparison), re-materialize even though params hash matched.

**Storage format (per corpus, two files):**

- `{corpusId}.json` — metadata (source params, content hash, model info, chunks as JSON, BM25 index as JSON)
- `{corpusId}.bin` — embeddings as raw Float32Array binary blob

The `.bin` file layout:

```
[4 bytes: number of embeddings (uint32)]
[4 bytes: dimensions per embedding (uint32)]
[N × D × 4 bytes: float32 values]
```

**Cache directory:** `.cache/semantic-crawl/` (relative to project root). Created on first use. Gitignored.

**Cache eviction:** LRU (max 50 corpora) + TTL (24h). Eviction happens on write — before persisting a new corpus, if the cache exceeds the cap OR contains entries older than TTL, remove least-recently-used entries first. TTL expiry is checked at load time (if an entry is stale, it's treated as a miss).

**Async materialization lock:** A `Map<string, Promise<Corpus>>` prevents thundering herd. First caller for a given `corpusId` creates the materialization promise; subsequent concurrent callers for the same `corpusId` await the same promise.

**Interface:**

```typescript
interface CachedCorpus {
  corpusId: string;
  source: SemanticCrawlSource;
  contentHash: string;
  model: string;
  dimensions: number;
  chunks: CorpusChunk[];
  embeddings: number[][]; // loaded from .bin
  bm25Index: Bm25Index; // rebuilt from chunks on load
  createdAt: number; // Unix ms
  lastAccessedAt: number; // Unix ms
}

export async function getOrBuildCorpus(
  source: SemanticCrawlSource,
  materializeFn: () => Promise<{ chunks: CorpusChunk[]; embeddings: number[][]; model: string }>,
  opts: { ttlMs?: number; maxCorpora?: number },
): Promise<CachedCorpus>;

export async function loadCorpusById(corpusId: string): Promise<CachedCorpus | null>;

export function invalidateCorpus(corpusId: string): void;
```

### 3. Cached Source Type

A new `SemanticCrawlSource` variant:

```typescript
export interface CachedSource {
  type: 'cached';
  corpusId: string;
}
```

When `semanticCrawl` receives a `cached` source, it:

1. Loads the corpus from disk via `loadCorpusById`.
2. If miss (TTL expiry, LRU eviction, or never existed): returns a structured error telling the caller the corpus is gone — the client can re-issue with the original source.
3. If hit: proceeds directly to the fusion phase (bi-encoder + BM25+ RRF), skipping crawl, chunk, dedup, and embed.

**Deterministic `corpusId` behavior:** Because `corpusId` is derived from source params + model, re-crawling the same source after TTL expiry yields the same `corpusId`. This makes transparent re-materialization idempotent — the agent doesn't need to learn a new handle.

### 4. Modified `embedAndRank` Pipeline

The existing `embedAndRank` helper in `semanticCrawl.ts` gains a BM25+ ranking step and RRF fusion:

```
Before (current):
  dedup → embed → bi-encoder rank → coherence filter → rerank → topK

After:
  [from cache or materialize: chunks + embeddings + BM25 index]
  → bi-encoder rank (cosine sim) ──┐
  → BM25+ score (query terms) ────┼──► RRF merge ──► coherence filter
  → optional rerank ──► topK
```

**RRF details:**

- `k = 60` (standard default, robust without tuning)
- Both rankings use the same deduplication key (chunk URL + text hash)
- RRF produces a fused ranked list; coherence filter runs on the fused results
- Cross-encoder re-rank still operates on the top 30 candidates post-fusion

## Data Flow

### First Call (Cold Cache)

```
semanticCrawl({ source: { type: 'url', url: 'https://react.dev/learn' }, query: 'components' })
  → params hash → cache miss
  → crawl → chunk → dedup → embed → build BM25 index
  → serialize to disk (corpusId determined)
  → bi-encoder rank + BM25+ rank → RRF → coherence → rerank
  → return { corpusId, chunks, ... }
```

### Follow-Up Call (Warm Cache)

```
semanticCrawl({ source: { type: 'cached', corpusId: 'abc123...' }, query: 'auth' })
  → loadCorpusById('abc123...') → cache hit
  → bi-encoder rank + BM25+ rank → RRF → coherence → rerank
  → return { corpusId, chunks, ... }
```

### Transparent Cache Hit (Same Source, Same Query or Different)

```
semanticCrawl({ source: { type: 'url', url: 'https://react.dev/learn' }, query: 'something else' })
  → params hash → cache hit (within TTL)
  → load from disk
  → bi-encoder rank + BM25+ rank → RRF → coherence → rerank
  → return { corpusId, chunks, ... }
```

## Error Handling

| Scenario                            | Behavior                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Cache miss on `cached` source       | Return `isError: true` with message: `Corpus 'abc123' not found or expired. Re-issue with the original source to rebuild.` |
| Content hash mismatch (stale cache) | Treat as miss, re-materialize transparently, log warning                                                                   |
| BM25 index build failure (unlikely) | Log warning, fall back to pure bi-encoder ranking                                                                          |
| Embedding binary read failure       | Log error, treat as miss, re-materialize                                                                                   |
| Cache directory not writable        | Log warning, continue without caching (materialize every time)                                                             |
| Thundering herd (concurrent misses) | Single materialization via promise dedup; all callers await same result                                                    |

## Testing Strategy

1. **BM25+ unit tests** (`test/bm25.test.ts`) — score known documents against known queries, verify ranking order
2. **Corpus cache unit tests** (`test/corpusCache.test.ts`) — serialize/deserialize roundtrip, LRU eviction, TTL expiry, async lock dedup
3. **Integration test** (`test/semanticCrawl.test.ts`) — first call returns `corpusId`, second call with `cached` source returns same results without crawling
4. **RRF fusion test** — verify that chunks matching only BM25 or only bi-encoder both surface in fused results

## Files to Create / Modify

| File                         | Action | Purpose                                                                    |
| ---------------------------- | ------ | -------------------------------------------------------------------------- |
| `src/utils/bm25.ts`          | Create | BM25+ index builder and scorer                                             |
| `src/utils/corpusCache.ts`   | Create | Disk-backed corpus cache with LRU+TTL                                      |
| `src/tools/semanticCrawl.ts` | Modify | Add BM25+ scoring, RRF fusion, `cached` source type, cache integration     |
| `src/types.ts`               | Modify | Add `CachedSource` to `SemanticCrawlSource` union                          |
| `src/server.ts`              | Modify | Register updated `semantic_crawl` Zod schema (add `cached` source variant) |
| `test/bm25.test.ts`          | Create | BM25+ correctness tests                                                    |
| `test/corpusCache.test.ts`   | Create | Cache serialize/deserialize, eviction, lock tests                          |
| `test/semanticCrawl.test.ts` | Modify | Add `cached` source integration tests                                      |
| `.gitignore`                 | Modify | Add `.cache/semantic-crawl/`                                               |

## Scope Boundaries

**In scope:**

- BM25+ inline implementation
- Corpus disk cache with binary embedding storage
- Deterministic `corpusId` from source params + model
- Two-tier keying (params + content hash)
- Async materialization lock
- LRU+TTL eviction
- `cached` source type
- RRF fusion of bi-encoder + BM25+ rankings
- All tests

**Out of scope (future):**

- Cross-corpus queries (multiple corpora in one call)
- HTTP HEAD/ETag freshness validation (content hash covers the same concern)
- LanceDB or other vector database integration
- Streaming cache writes
- Distributed cache (single-node only)

## Dependencies

**No new npm dependencies.** BM25+ is implemented inline. Binary I/O uses Node.js built-in `fs` APIs (`readFileSync`/`writeFileSync` with `Buffer`). The existing `rrfMerge` utility in `src/utils/fusion.ts` handles the fusion step.

## Performance Characteristics

| Step                                          | Approximate Cost                  |
| --------------------------------------------- | --------------------------------- |
| BM25+ index build                             | ~2ms per 1000 chunks              |
| BM25+ scoring (per query)                     | ~1ms per 1000 chunks              |
| Embedding binary read (1000 chunks × 768-dim) | ~6MB, ~5ms from SSD               |
| JSON embedding read (same)                    | ~45MB, ~40ms from SSD             |
| RRF merge (two lists of 1000)                 | ~1ms                              |
| **Cold cache total**                          | Crawl + embed dominate            |
| **Warm cache total**                          | ~10ms (I/O + BM25 + RRF + rerank) |

## API Changes

### `SemanticCrawlResult`

Add `corpusId: string` to the result type. Present on every successful call (whether cold or warm cache).

```typescript
export interface SemanticCrawlResult {
  seedUrl: string;
  query: string;
  pagesCrawled: number;
  totalChunks: number;
  successfulPages: number;
  corpusId: string; // NEW: deterministic handle for follow-up queries
  chunks: SemanticCrawlChunk[];
}
```

### `SemanticCrawlSource`

Add `CachedSource` to the union:

```typescript
export type SemanticCrawlSource =
  | UrlSource
  | SitemapSource
  | SearchSeedSource
  | GitHubSource
  | CachedSource; // NEW
```

## Notes

- The `model` field from the embedding sidecar response (`EmbedResponse.model`) is used in the cache key. If the sidecar is updated to a different model (e.g., gemma300m → gemma2b), existing caches become misses naturally because the model string changes.
- `BOILERPLATE_CENTROID_THRESHOLD` and `isBorderline` behavior are unchanged — the semantic coherence filter runs on the RRF-fused results, not on individual rankings.
- `useReranker` flag behavior is unchanged — cross-encoder still optional and falls back gracefully.
