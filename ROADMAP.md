# Roadmap

## V2.0.0 — Semantic Overhaul (current)

The semantic layer is live for **web** and **GitHub** sources via `semantic_crawl`:

- Crawl4AI-powered deep crawling with JS rendering
- Markdown chunking (400-token max, 20% overlap, atomic units, boilerplate heuristics)
- Embedding sidecar (document/query asymmetric, batched, title-aware)
- Hybrid retrieval: bi-encoder cosine + BM25+ → RRF fusion
- Semantic coherence filter + soft IDF-weighted lexical constraint
- Optional cross-encoder reranking (ONNX, local)
- Corpus cache (24h TTL, 50-corpus limit, reuse by ID)
- GitHub corpus adapter (code-aware, extension/branch/query filter)

---

## V3.0.0 — Universal RAG Core

**Goal**: ship the shared RAG spine, prove the adapter contract with two flagship tools, and build the eval/observability foundation that keeps every subsequent source adapter honest.

The core decision remains: `src/rag/` shared pipeline, not per-tool RAG implementations. Six tiny RAG gremlins in a trench coat is how you get six different chunking functions with slightly different edge-case handling. V3.0 locks in the architecture; V3.1 and V3.2 expand the surface area.

### Design Principles

**Facts vs interpretation**: the tool produces facts (extracted fields, source URLs, fetch status, confidence scores, coverage). The calling agent produces interpretation ("good foot-in-the-door rate", "worth applying"). Both are useful, but they must not live in the same layer. A `JobListing` carries what was extracted from the listing page; whether $36/hr is "competitive" is a judgment the agent adds on top. This separation keeps the tool honest and the results composable.

**V3.0-alpha extraction order**:

1. Start by making `semantic_crawl` call the new `src/rag/` pipeline internally while preserving its exact external interface — parity testing against current behavior
2. Split the pipeline into `prepareCorpus()` and `retrieveCorpus()` phases
3. Move cache, BM25, fusion, rerank, lexical constraints, and chunking behind stable internal interfaces
4. Only after those interfaces are stable should YouTube or Reddit become semantic tools

### Why Not Every Source in V3.0

Each source has a different failure ecology. YouTube has transcript rate limits and missing diarization. Reddit/HN have thread structure and deleted comments. Academic has PDF extraction hell. Stack Overflow has code blocks, stale accepted answers, and answer ranking. News has article extraction, paywalls, duplicate wire stories, and GDELT URL weirdness. The plan recognizes these individually, but V3.0 still bundles too many wild animals into one crate. Ship the core + two tools that prove the contract works, then expand.

### Release Phasing

**V3.0.0** ships in three internal milestones to reduce delivery risk:

| Milestone      | Scope                                                                                | Gate                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **V3.0-alpha** | Extract `src/rag/`, preserve existing `semantic_crawl` behavior, prove no regression | All existing semantic_crawl tests pass; zero behavioral change on web corpus                              |
| **V3.0-beta**  | Add one new adapter + tool (YouTube), validate adapter contract end-to-end           | YouTube golden-query eval passes; adapter registration works; cache keys versioned                        |
| **V3.0**       | Add Reddit, evals enforced in CI, debug traces stable                                | Both adapters pass evals; partial-failure behavior tested; cache invalidation verified per pipeline stage |

The problem this solves: YouTube and Reddit both involve external fetch weirdness, partial data, adaptive concurrency, cache invalidation, and different chunking behavior. Doing both while also refactoring the core pipeline is where bugs breed in the walls.

**V3.1.0** — code/GitHub (tree-sitter code adapter)
**V3.0.5** — narrow job adapter MVP (extracted from V3.2 scope)
**V3.2.0** — long-tail source expansion (academic, Stack Overflow, HN, remaining sources, unified `semantic_search` prototype)

---

### Architecture

```
src/rag/
├── types.ts           # Corpus, Chunk, RetrievalResult, CorpusStatus, RetrievalTrace
├── pipeline.ts        # prepareCorpus() + retrieveCorpus() — two-phase entry points
├── chunking.ts        # moved from src/chunking.ts
├── embedding.ts       # moved from embedTexts/embedTextsBatched
├── bm25.ts            # moved from src/utils/bm25.ts
├── fusion.ts          # moved from src/utils/fusion.ts
├── rerank.ts          # moved from src/utils/rerank.ts
├── corpusCache.ts     # moved from src/utils/corpusCache.ts — with versioned keys
├── profiles.ts        # named RetrievalProfile definitions
├── dedup.ts           # three-layer deduplication system
├── constraints.ts     # constraint-aware ranking
└── adapters/
    ├── index.ts       # adapter registry + type
    ├── text.ts        # default: markdown chunking
    ├── transcript.ts  # speaker turns, time-coded segments, diarization fallback
    └── conversation.ts # comment/thread context preservation
```

---

### Two-Phase Pipeline: Build Then Retrieve

Corpus preparation and retrieval are separate concerns with different failure modes, caching semantics, and observability needs. If 37 out of 100 YouTube transcripts fail, that is a corpus build result, not a ranking error. If five news URLs scrape garbage boilerplate, that should be visible before embeddings ever happen.

```ts
// Phase 1: fetch, normalize, chunk, embed, index
prepareCorpus(source, adapterConfig): Promise<PreparedCorpus>

// Phase 2: rank, rerank, return top-K
retrieveCorpus(preparedCorpus, query, opts): Promise<RetrievalResult[]>
```

`PreparedCorpus` contains the chunked + embedded corpus ready for querying. It can be cached and reused across multiple `retrieveCorpus()` calls with different queries.

### The Bridge Pattern

V3's real product is the bridge between existing discovery tools and the RAG core. The non-semantic tools are already acquisition tools — `youtube_search`, `reddit_search`, `academic_search`, `hackernews_search`, `stackoverflow_search`, `news_search`, `web_crawl`, etc. They become feeders:

```
DiscoveryToolResult → RawDocument[] → Adapter → PreparedCorpus → RetrievalResponse<T>
```

V3 does not reinvent fetching. It standardizes the bridge. Each discovery tool produces `RawDocument[]` (title, content, URL, metadata). The adapter normalizes them into domain-appropriate chunks. The pipeline embeds, indexes, and ranks. The response envelope returns structured results with coverage, traces, and confidence.

This means `semantic_youtube` is not "learn YouTube from scratch" — it is "build a corpus over `youtube_transcript` results and retrieve timestamped chunks." The fetch machinery already exists.

---

### Core Types

```ts
interface CorpusStatus {
  requested: number; // total items the tool tried to fetch
  fetched: number; // successfully fetched and processed
  failed: number; // fetch/parse failures
  skipped: number; // filtered out (deleted, too short, wrong type)
  cacheHit: boolean; // was this corpus served from cache?
  warnings: string[]; // machine-readable warnings for observability
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
```

### Response Envelope

Corpus status and retrieval trace belong to the retrieval response envelope, not each individual result. Duplicating the same status across top-K results is the kind of thing that doesn't hurt at 10 results but gets silly at 50.

```ts
interface RetrievalResponse<T> {
  results: RetrievalResult<T>[];
  corpusStatus: CorpusStatus;
  coverage?: Coverage; // V3.2: multi-source coverage reporting
  retrievalTrace?: RetrievalTrace; // only when opts.debug = true
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
```

Tools return `RetrievalResponse<T>`, not bare `RetrievalResult[]`. This keeps the per-result type clean and makes structured responses (V3.2 domain objects, coverage, explanations) naturally composable.

---

### Retrieval Profiles

Named profiles keep the public API sane while avoiding hardcoded adapter constants that require recompilation to tune.

```ts
type RetrievalProfile =
  | 'balanced' // default: equal RRF weight
  | 'lexical-heavy' // BM25-weighted RRF, higher lexical constraint
  | 'semantic-heavy' // vector-weighted RRF, looser lexical constraint
  | 'high-precision' // reranking enabled, tighter coherence filter
  | 'fast'; // skip reranking, fewer BM25 candidates

type RetrievalOpts = {
  adapter: AdapterType;
  topK?: number; // default 10
  profile?: RetrievalProfile; // default 'balanced'
  debug?: boolean; // include RetrievalTrace in results
};
```

Each adapter maps profiles to its internal settings (BM25 weight, coherence threshold, candidate pool sizes, lexical constraint strength). The profile names are public and stable; the internal tuning values live in the adapter and can change without a breaking API change.

If an adapter needs a genuinely tool-specific tuning (e.g. code BM25 weight higher than conversation), it happens at the adapter level behind the profile name. Users never see `bm25Weight: 1.7`.

---

### Cache Design

Cache keys must include every retrieval-invalidating factor, not just query and source:

```ts
type CacheKey = {
  source: SourceType;
  query: string;
  filters: Record<string, unknown>; // date range, subreddit, channel, etc.
  adapter: AdapterType;
  adapterVersion: string; // bump when adapter logic changes
  chunkerVersion: string; // bump when chunking params change
  embeddingModel: string; // which model produced the embeddings
  embeddingMode: EmbeddingMode;
  corpusFetchParams: Record<string, unknown>; // maxVideos, maxPosts, language, branch, etc.
};
```

Serialized to a deterministic hash for the actual cache key. Without versioning, you get ghost bugs where results look "wrong" because yesterday's chunking or embedding settings are silently being reused.

Corpus cache limits: 24h TTL, **byte-weighted LRU eviction** (not count-based). Count-based limits are a cardboard fence — a corpus of 100 tiny Reddit threads and a corpus of 100 long YouTube transcripts are not the same animal.

```ts
const CACHE_LIMITS = {
  maxCorpora: 100, // soft cap, eviction is byte-weighted LRU
  maxCorpusBytes: 50 * 1024 * 1024, // 50 MB per corpus
  maxTotalCacheBytes: 500 * 1024 * 1024, // 500 MB across all corpora
  maxChunksPerCorpus: 10_000,
  maxEmbeddingVectors: 100_000, // across all cached corpora
  ttlMs: 24 * 60 * 60 * 1000, // 24h
};
```

Eviction policy: when `maxTotalCacheBytes` is exceeded, evict the corpus with the lowest `(lastAccessTime, byteSize)` score — stale and small goes first. A fresh large corpus beats a stale small one. Namespaced by tool (`web:`, `youtube:`, `reddit:`, etc.) to avoid collisions.

**Cache restart behavior**: the corpus cache is in-process only (no persistence across server restarts). If a caller supplies a `corpusId` from a previous session, the cache returns a specific error — `CACHE_MISS_EXPIRED_OR_RESTARTED` — not a generic failure. This matters because a user who gets a `corpusId`, restarts their MCP server, and queries the same ID should understand why it's gone rather than hitting a cryptic error.

---

### Adapter Registry

```ts
type AdapterType = 'text' | 'code' | 'transcript' | 'conversation' | 'academic' | 'qa' | 'job';

interface Adapter {
  type: AdapterType;
  chunk(docs: RawDocument[], opts: ChunkOpts): Chunk[];
  section(chunk: Chunk): string; // section metadata builder
  preferredProfile: RetrievalProfile; // default profile for this adapter
  profileOverrides: Record<RetrievalProfile, ProfileSettings>; // internal tuning
}
```

Each adapter declares its chunking strategy, section format, preferred default profile, and per-profile tuning overrides. The pipeline calls `adapter.chunk()` during `prepareCorpus` and uses the adapter's profile config during `retrieveCorpus`.

---

### V3.0 Adapters

#### Text Adapter (`adapters/text.ts`)

Default adapter. Standard markdown chunking (400-token max, 20% overlap, atomic units, boilerplate heuristics). Used by web content and article bodies. Carries forward unchanged from V2.

#### Transcript Adapter (`adapters/transcript.ts`)

For YouTube captions and similar timed media. Chunk by speaker turn or fixed 30-second segments with 5-second overlap.

**Speaker turn fallback**: auto-generated captions (the majority of YouTube content) do not carry diarization. The adapter logs an explicit notice when falling back to fixed segments: `"No speaker turns detected — falling back to fixed 30s segments for <video_id>"`. The fallback is visible in `corpusStatus.warnings`, not invisible.

#### Conversation Adapter (`adapters/conversation.ts`)

For Reddit, HN, and similar threaded discussion platforms. Handles comment tree flattening with parent context preservation.

**Parent context in chunk text, not just section field**: many replies are semantically useless alone — "Exactly," "This," "That's the issue," "No, because..." Without parent context inside the chunk text, embeddings will underperform. The adapter prefixes a truncated parent comment (~150 chars) to the chunk text before embedding, and includes the parent snippet in the section field for BM25.

**Section format**: `post_title > parent_comment_snippet` (truncated parent text, ~80 chars). `reply_depth` as an integer carries no semantic content for BM25 — the parent's text is what matters.

---

### Tool-by-Tool V3.0 Plan

#### `semantic_youtube`

**Flagship tool**. Proves the pipeline handles multi-document corpus building, timestamps, caching, transcript chunking, and a real user-visible win.

Pipeline:

1. `youtube_search` returns up to 100 video IDs
2. `youtube_transcript` fetched with **adaptive concurrency**: start at 8, increase to 20 only if success rate and latency look healthy, back off globally on rate-limit-ish failures (429s, timeouts, empty responses). Not blind `Promise.all` with cap 20.
3. Transcript adapter chunks each transcript
4. `prepareCorpus()` builds the embedded corpus. `corpusStatus` reports how many transcripts were fetched vs failed.
5. `retrieveCorpus()` ranks with `balanced` profile (or caller-specified)
6. Corpus cached by versioned key including query, max videos, transcript language, sort mode, and normalized query hash — not just `youtubeQuery:${query}`

New tool input: query + optional channel/date/maxVideos filters. Output: top-K transcript chunks with video title, timestamp, relevance scores, and `corpusStatus`.

#### `semantic_reddit`

**Second flagship**. Proves conversation-thread context, partial corpus handling, and adaptive fetching on a platform with thread structure and deleted comments.

Pipeline:

1. `reddit_search` returns post list
2. Fetch full comment trees in parallel (adaptive concurrency, same pattern as YouTube)
3. Conversation adapter: flatten comment tree, filter deleted/removed, prefix parent context into chunk text, set section to `post_title > parent_snippet`
4. `prepareCorpus()` with `corpusStatus` tracking fetch failures and filtered comments
5. `retrieveCorpus()` with `conversation` adapter profile
6. Cache by versioned key including subreddit, query, sort, timeframe

New tool input: query + optional subreddit/sort/timeframe. Output: top-K comment chunks with post title, author, comment depth as metadata, relevance scores, and `corpusStatus`.

---

### Eval Harness

Before shipping V3.0, define a minimal eval framework. Not academic ceremony — just enough to stop regressions and validate that the pipeline actually works across adapters.

```
src/rag/__tests__/eval/
├── golden-queries/
│   ├── youtube.json     # { query, expectedTopK: [{ videoId, timestamp }] }
│   ├── reddit.json      # { query, expectedTopK: [{ postId, commentId }] }
│   └── ...
├── eval.ts              # runner: load golden queries, assert top-K hits
└── thresholds.json      # { maxLatencyMs, minRecallTop3, maxChunkCount, ... }
```

Eval checks per adapter:

- Golden query returns expected source/chunk in top 3 or top 10
- Latency budget per stage (fetch, chunk, embed, rank)
- Cache hit/miss behavior
- Chunk count within bounds
- Reranker improves ranking over no-rerank baseline
- Partial failure behavior — 30% corpus failure still returns valid results

**Per-adapter profile calibration**: profile names like `balanced` are stable and public, but a `balanced` profile for code, Reddit, and job listings should not imply identical weights. Each adapter gets calibration tests proving that profile names mean something:

```
src/rag/__tests__/eval/
├── golden-queries/
│   ├── youtube.json
│   ├── reddit.json
│   └── ...
├── profile-calibration/
│   ├── conversation-balanced.json   # balanced weights for Reddit
│   ├── transcript-balanced.json     # balanced weights for YouTube
│   ├── code-lexical-heavy.json      # lexical-heavy beats balanced on identifier queries
│   └── text-balanced.json           # baseline: web content balanced
├── eval.ts
└── thresholds.json
```

Each calibration file defines queries where `lexical-heavy` should beat `balanced` (identifier searches on code) or where `semantic-heavy` should win (vague conceptual queries on transcripts). If `balanced` and `semantic-heavy` return identical rankings for every adapter, the profile system is decorative, not functional.

Run as part of CI. V3.0 ships with YouTube and Reddit golden queries; each V3.x release adds queries for its new adapters.

For RAG, vibes lie. Evals are the lantern.

---

### Observability

Every `RetrievalResult` includes `corpusStatus` and, when `opts.debug` is true, the full `retrievalTrace`. The trace breaks down per-stage timings and candidate pool sizes. This is what makes the system tunable in practice — without it, you're guessing whether BM25 or the vector component is doing the heavy lifting on any given query.

---

### V3 Config Additions

```
EMBEDDING_CODE_MODEL=nomic-embed-code     # V3.1: code-tuned embedding model endpoint
YOUTUBE_PARALLEL_TRANSCRIPT_LIMIT=20     # max concurrency (adaptive fetcher target ceiling)
CORPUS_CACHE_MAX=100                      # up from 50
CORPUS_CACHE_TTL_MS=86400000             # 24h default
```

**Code embedding degradation path** (V3.1 concern, documented now): users who skip `EMBEDDING_CODE_MODEL` will get prose embeddings on code. This handles identifier-level search ("find `handleSubmit`") okay but falls apart on semantic queries like "where does error handling happen for network timeouts." This limitation must be surfaced prominently in the README — not buried in config docs — as a known gap when the code embedding model is not configured.

---

## V3.0.5 — Job Adapter MVP

V2 crawl testing exposed the ceiling: the tool succeeds at discovery but not at disciplined structured retrieval. A V2 job crawl found 30+ relevant listings, extracted compensation ranges, work modes, and locations — but all of that structure lived in the assistant's interpretation, not in the tool's output. The tool returned ranked chunks; the assistant reverse-engineered the structure.

This narrow MVP bridges that gap without waiting for the full V3.2 domain-adapter machinery.

### Why Not Wait for V3.2

The full V3.2 job adapter includes constraint-aware ranking with hard/soft filters, three-layer dedup, coverage reporting, explanation generation, and the full structured pipeline. That is the right end state. But a focused MVP — extract structured fields from crawled job pages and rank with a simple weighted score — would already beat "semantic chunk plus assistant interpretation." V2 proved the demand exists; V3.0.5 proves the extraction contract works.

### JobListingMVP

A slimmed-down `JobListing` that captures what V2 crawl testing showed actually matters:

```ts
interface JobListingMVP {
  // Extracted fields (facts, not interpretation)
  title: string;
  company?: string;
  location?: string;
  workMode: 'onsite' | 'hybrid' | 'remote' | 'unknown';
  salaryRaw?: string; // "$35-45.60/hr", "$80k + super" — raw text
  source: 'seek' | 'indeed' | 'jora' | 'linkedin' | 'other';
  sourceUrl?: string;
  jobId?: string;
  postedRaw?: string; // raw date string from listing
  extractedText: string; // full listing body for embedding

  // Confidence per field
  confidence: {
    title: number; // 0-1
    location: number;
    workMode: number;
    salary: number;
    overall: number;
  };

  // Provenance — how strong is this result?
  verificationStatus:
    | 'listing_page_fetched' // we hit the actual listing page
    | 'search_result_only' // search snippet, not full page
    | 'aggregator_result' // copied from another board (Jora from SEEK)
    | 'needs_manual_check'; // extraction unreliable, low confidence

  // Caveats extracted from the listing
  caveats: string[]; // ["temp contract", "via agency", "closing soon"]
}
```

Key addition: `verificationStatus`. A Jora result copied from SEEK is not as strong as a directly fetched SEEK listing. A LinkedIn snippet behind an auth wall is weaker still. This field lets rankers and downstream agents weight provenance without guessing.

### Simple Constraint-Aware Scoring

No full constraint pipeline yet. A weighted composite that already beats pure semantic ranking for job queries:

```ts
score =
  semanticScore * 0.45 + // vector similarity to query
  locationScore * 0.2 + // query location match
  workModeScore * 0.15 + // query work-mode preference match
  recencyScore * 0.1 + // posted recently
  completenessScore * 0.1; // fields actually populated (salary, location)
```

This is the minimum viable constraint-aware ranking. V3.2 replaces it with the full hard-filter → soft-boost → quality-signal → explanation pipeline.

### Tool: `semantic_jobs` (MVP)

Pipeline:

1. `web_search` + `web_crawl` for SEEK, Indeed, Jora pages (source profiles inform strategy)
2. Job MVP adapter parses each page → `JobListingMVP[]`
3. Filter by hard constraints (location, workMode) if provided
4. Rank with weighted composite score
5. Return `RetrievalResponse<JobListingMVP>` with `corpusStatus`

Input: query + optional filters (location, workMode). Output: ranked job listings with confidence scores, verification status, and caveats. No dedup yet (V3.2 adds that). No multi-source coverage object yet (V3.2 adds that). But the structured extraction and provenance tracking already transform "here are some relevant chunks" into "here are job listings with varying levels of trust."

---

## V3.1.0 — Intelligence, Extraction, and Code

**Goal**: Transform the extraction and caching layers to be robust enough for production agent workflows, moving beyond simple markdown parsing and volatile in-memory storage. This incorporates research findings on Kill Chain extraction and Contextual Embeddings alongside the original Code intelligence goals.

### 1. Robust Infrastructure (Persistence & Neural Search)

- **Persistent Corpus Cache:** Migrate `src/utils/corpusCache.ts` from in-process memory to SQLite (`better-sqlite3`). This solves the critical issue where `source: "cached"` dies on server restart. Includes byte-weighted LRU eviction.
- **Neural Search Integration:** Add Exa as a supported search backend (`EXA_API_KEY`) to enable semantic web/code search before crawling even begins.

### 2. Advanced Extraction (The "Kill Chain")

- **Kill Chain Content Extraction:** Implement a multi-strategy extraction fallback: `Crawl4AI -> Readability (jsdom) -> Wayback Machine -> Google Cache`. This drastically improves success rates on 404s, paywalls, and JS-heavy sites.
- **Contextual Embeddings:** Add an optional LLM preprocessing step to generate document context for each chunk _before_ embedding, significantly boosting retrieval precision.

### 3. Code Intelligence & AST Chunking

- **Tree-sitter Code Adapter (`adapters/code.ts`):** Move beyond regex heuristics. Chunk at function/class/module boundaries using WASM-based tree-sitter grammars (TS, JS, Python, Go, Rust), lazy-loaded on first use.
- **Code Example Extraction:** In regular text/web adapters, treat markdown code blocks (` ``` `) as distinct atomic units with `contextBefore` and `contextAfter` metadata for better technical retrieval.
- **Repo Guardrails:** Enforce byte/file caps and `.gitignore` awareness in the GitHub adapter to prevent monorepo explosion.

---

## V3.2.0 — Domain Adapters + Structured Retrieval

The adapter contract has been hardened by real use across YouTube, Reddit, and GitHub. V3.2 introduces the biggest unlock: **domain adapters that extract structured objects**, not just markdown chunks.

### Coverage Reporting (First-Class)

Every multi-source response includes coverage statistics. A superior tool should not pretend all sources were equally crawled.

```ts
interface Coverage {
  sourcesAttempted: string[]; // ["seek", "indeed", "jora", "linkedin"]
  sourcesSucceeded: string[]; // ["seek", "jora"]
  sourcesPartial: string[]; // ["indeed"]
  sourcesFailed: string[]; // ["linkedin"]
  documentsFound: number; // total from all sources
  documentsIndexed: number; // after filtering + dedup
  chunksIndexed: number; // final chunk count
  duplicateDocumentsRemoved: number; // removed by dedup pipeline
  warnings: string[]; // "Indeed returned mostly dynamic shell pages", ...
}
```

This one feature makes the tool feel more honest than most AI search tools. It tells the user what the machine actually saw, not what it wishes it saw.

---

### Domain Adapters (Not Just Text Adapters)

Generic scrapers turn everything into markdown. V3.2 builds **domain adapters** that turn source-specific content into structured objects.

#### Job Adapter (`adapters/job.ts`)

Builds on the V3.0.5 MVP contract. The full V3.2 adapter adds structured salary parsing, seniority classification, requirements extraction, and the full dedup/constraint/coverage pipeline.

```ts
interface JobListing {
  // Core fields
  title: string;
  company?: string;
  location?: string;
  workMode: 'onsite' | 'remote' | 'hybrid' | 'unknown';

  // Compensation (structured, not raw string)
  salary?: {
    min: number;
    max: number;
    currency: string;
    unit: 'hour' | 'year' | 'month';
    raw: string; // original extracted text
  };

  // Metadata
  seniority: 'entry' | 'mid' | 'senior' | 'lead' | 'executive' | 'unknown';
  requirements: string[]; // extracted skills/requirements
  niceToHave?: string[];

  // Source info
  source: 'seek' | 'indeed' | 'jora' | 'linkedin' | 'other';
  applyUrl: string;
  jobId?: string;
  postedAt: Date | null;
  expiresAt: Date | null;

  // Provenance (from V3.0.5 MVP — hardened here)
  verificationStatus:
    | 'listing_page_fetched'
    | 'search_result_only'
    | 'aggregator_result'
    | 'needs_manual_check';

  // Confidence scores (expanded from MVP)
  confidence: {
    salary: number; // 0-1: did we find a salary?
    workMode: number; // 0-1: confident in WFH/hybrid/onsite?
    seniority: number; // 0-1: confident in level?
    completeness: number; // overall extraction quality
  };

  // Caveats (from V3.0.5 MVP — expanded here)
  caveats: string[]; // ["temp contract", "via agency", "closing soon"]

  // For retrieval
  extractedText: string;
  embedding: number[];
  bm25Tokens: string[];
}
```

The job adapter parses HTML, extracts structured fields, handles missing data gracefully, and produces a canonical `JobListing` object. The rest of the pipeline operates on structured objects, not markdown soup. All fields are optional except `title`, `source`, and `workMode` — job listings from hostile pages should still produce a valid (if sparse) object rather than failing.

---

### Constraint-Aware Ranking

Standard semantic search blends everything into one vector. V3.2 separates ranking into explicit stages:

```ts
interface RetrievalResult<T> {
  item: T; // the structured object (JobListing, etc.)

  // Component scores
  semanticScore: number; // vector similarity to query
  constraintScore: number; // how well it matches hard constraints

  // Quality signals
  qualityScore: number; // completeness, recency, source trust
  duplicateScore: number; // is this a dedup winner or merged?

  // Final ranking
  overallScore: number; // weighted combination
  rank: number; // final position

  // Why this ranked here
  explanation: {
    matched: string[]; // "data-entry/admin role", "Parramatta", "hybrid"
    caveats: string[]; // "temp contract", "not fully WFH"
  };
}

interface QueryConstraints {
  hard: {
    // must match — filter stage
    location?: string[]; // ["Sydney", "Inner West", "Western Sydney"]
    workMode?: WorkMode[]; // ["remote", "hybrid"]
    maxSalary?: number;
    minExperience?: number;
    excludeTitles?: string[]; // ["senior manager", "principal"]
  };

  soft: {
    // prefer — boost stage
    titleKeywords?: string[]; // ["data entry", "admin", "reception"]
    locations?: string[]; // preferred locations (rank boost)
    recentOnly?: boolean; // posted within N days
  };
}
```

The ranking pipeline:

```
1. fetch all source documents
2. parse via domain adapter → structured objects
3. apply hard constraints → filter stage (any miss = excluded)
4. compute semantic score for survivors
5. compute soft preference boost
6. compute quality signals (salary present? source trustworthy? recent?)
7. compute dedupe winner/merge status
8. combine → final rank
9. generate explanation from matched constraints + caveats
```

For a query like "low-level data entry/admin around Sydney, preferably WFH":

- Hard constraint: location in Sydney/Inner West/Western Sydney
- Soft preference: workMode = hybrid or remote
- Quality: salary present? posted recently?

Result output says:

```
Fit: 87%
Reason: data-entry/admin role, Parramatta, hybrid, hourly rate listed.
Caveat: temp contract, not fully WFH.
```

This explanation layer is very hard for generic search APIs to provide unless the developer builds it downstream.

---

### Three-Layer Deduplication (First-Class Pipeline Stage)

Mandatory for jobs, news, Reddit mirrors, HN reposts, academic papers, Stack Overflow mirrors.

```ts
// src/rag/dedup.ts
interface Deduplicator {
  // Layer 1: URL canonicalization
  canonicalize(url: string): string; // remove tracking params, normalize domains

  // Layer 2: structured fingerprint
  fingerprint(item: JobListing | NewsArticle | AcademicPaper): string;
  // - jobs: title + company + location normalized
  // - news: title + publisher + date
  // - papers: DOI or arXiv ID or title hash

  // Layer 3: semantic near-dupe
  findNearDuplicates(items: T[], threshold: number): Map<string, string[]>;
  // embedding similarity above threshold → same cluster
}

interface DedupResult {
  canonicalId: string; // the "winner" ID to keep
  mergedFrom: string[]; // all IDs merged into this one
  reason: string; // "exact URL match", "same job posting", "semantic near-dup"
}
```

Each domain adapter implements the fingerprint method. The pipeline shows in results:

```
Merged from: SEEK, Jora
Canonical source: SEEK
```

This alone makes job search feel dramatically more professional.

---

### Source Capability Profiles

Every source has different failure modes. The orchestrator should know them upfront, not discover them every run.

```ts
const sourceProfiles: Record<Source, SourceProfile> = {
  seek: {
    dynamicRisk: 'medium', // JS-rendered content possible
    duplicateRisk: 'medium', // cross-posts to other SEEK owned sites
    structuredDataLikely: true, // structured job fields present
    freshnessImportant: true, // jobs expire quickly
    crawlReliability: 'high',
  },
  indeed: {
    dynamicRisk: 'high', // heavy JS, dynamic shells
    duplicateRisk: 'high', // scraped content, mirrors
    structuredDataLikely: false, // unstructured, scattered
    fallbackPreferred: 'web_search', // prefers web_search to web_crawl
    crawlReliability: 'medium',
  },
  linkedin: {
    dynamicRisk: 'very_high',
    authWallRisk: 'very_high',
    structuredDataLikely: 'partial', // some structured fields
    crawlReliability: 'low',
  },
  jora: {
    dynamicRisk: 'low',
    duplicateRisk: 'high', // aggregator with SEEK duplicates
    structuredDataLikely: true,
    crawlReliability: 'high',
  },
  reddit: {
    dynamicRisk: 'none',
    duplicateRisk: 'medium', // cross-posts to r/Australia r/Brisbane
    structuredDataLikely: false, // comment trees
    crawlReliability: 'high',
  },
  // ... per source
};
```

The orchestrator uses profiles to choose strategies intelligently:

- "LinkedIn has auth wall risk — try unauthenticated first, fallback to cached if needed"
- "Indeed has high duplicate risk — run dedup aggressively"
- "SEEK is fresh — prioritize caching with short TTL"
- "Indeed fallback to web_search, not web_crawl, since dynamicRisk is high"

Source profiles are defined once in `src/rag/sources.ts` and consulted by every multi-source tool.

**Dynamic source health** (future evolution): static profiles are the seed; runtime feedback is the crop. Over time, source profiles should be informed by observed behavior, not just declared properties:

```ts
interface SourceHealth {
  source: Source;
  // Rolling observations (updated per crawl session)
  crawlSuccessRate: number; // last 50 fetches: how many succeeded?
  averageExtractionQuality: number; // structured fields actually populated
  authWallFrequency: number; // how often we hit auth walls?
  duplicateRate: number; // how often dedup fires for this source?
  freshnessReliability: number; // does the age we see match reality?
  avgResponseLatencyMs: number;
  lastHealthyAt: Date;
  lastDegradedAt?: Date;
}
```

Static profiles handle the initial heuristics ("LinkedIn has auth wall risk — try unauthenticated first"). Dynamic health handles the drift ("Indeed's extraction quality dropped 30% this week — downrank in fusion weight"). V3.2 ships with static profiles; dynamic health is a V3.3 candidate once enough crawl history accumulates.

---

### V3.2 Tool Expansions

#### `semantic_stackoverflow`

- Q&A adapter: chunk question body + each answer separately. Code blocks as atomic units.
- Section format: `${question_title} > answer score:${score} accepted:${accepted}`. Author is metadata, not section text — usernames pollute BM25. Score and accepted flag are available to the ranker and post-ranking display.
- Accepted flag is metadata for the ranker, not a hard categorical tier. The cross-encoder reranker surfaces quality better than a binary accepted/not-accepted distinction. The accepted answer is often a fossil wearing a crown.

#### `semantic_hackernews`

- Conversation adapter (same as Reddit), with HN-specific tree flattening.
- Section format: `post_title > parent_comment_snippet`.

#### `semantic_academic`

- Academic adapter: chunk by abstract / introduction / methods / results / conclusion sections. LaTeX math blocks as atomic units. Figure/table captions preserved where possible — they are often retrieval gold.
- PDF extraction needs its own path, not the readability pipeline. Report extraction quality per paper. Abstract-only fallback when full text extraction fails.
- Citation metadata preserved: DOI, arXiv ID, venue, year.
- Section confidence: when the adapter can't reliably detect section boundaries (poorly formatted PDFs), fall back to text adapter with a warning in `corpusStatus`.

#### `semantic_news`

- Text adapter for article bodies.
- **Deduplication is first-class**: news corpora are full of syndicated duplicates and rewrites. Without near-duplicate detection, top-K collapses into five versions of the same article. Pipeline: URL canonicalization → title similarity check → embedding-level near-dupe filtering before ranking.
- Cache by versioned key including date range and dedup settings.

#### `semantic_jobs` (evolved from V3.0.5 MVP)

The job search use case that motivated domain adapters, constraint-aware ranking, and coverage reporting. V3.0.5 proved the extraction contract; V3.2 adds the full pipeline: multi-source fetch, three-layer dedup, hard/soft constraint ranking, coverage reporting, and explanation generation.

Pipeline:

1. Multi-source fetch: SEEK, Indeed, Jora, LinkedIn (if accessible) in parallel via source profiles
2. Job adapter parses each response → structured `JobListing` objects
3. Deduplicate across all sources via three-layer system
4. Prepare corpus with job adapter
5. Apply hard constraints (location, workMode, salary, seniority)
6. Rank with soft preferences + quality signals
7. Generate explanations for top-K results
8. Return + Coverage with per-source success/failure/warning

Input: query + constraints. Output: structured job listings with coverage, explanations, dedupe info.

#### `semantic_search` (unified tool prototype)

The flat namespace (`semantic_crawl`, `semantic_github`, `semantic_youtube`...) gets unwieldy past ~8 tools. The existing `source` parameter design already points to the long-term shape:

```ts
type SemanticSearchSource =
  | { type: 'web'; url: string }
  | { type: 'github'; owner: string; repo: string; branch?: string }
  | { type: 'youtube'; query: string; maxVideos?: number }
  | { type: 'reddit'; query: string; subreddit?: string }
  | { type: 'hackernews'; query: string }
  | { type: 'academic'; query: string; source?: 'arxiv' | 'semantic_scholar' | 'all' }
  | { type: 'stackoverflow'; query: string; tagged?: string }
  | { type: 'news'; query: string; dateFrom?: string; dateTo?: string }
  | { type: 'jobs'; query: string; constraints?: QueryConstraints };
```

V3.2 ships `semantic_search` as a prototype alongside the per-tool names. Both paths dispatch to the same `prepareCorpus()` + `retrieveCorpus()` pipeline internally. The per-tool names remain supported — no deprecation in V3.2.

---

## Quality Gates

No version ships unless its gates pass. These are checked in CI, not vibes.

### V3.0 Gates

- [ ] Existing `semantic_crawl` parity preserved — all V2 golden queries return equivalent results
- [ ] YouTube partial failure tested — 30% transcript failure still returns valid ranked results
- [ ] Reddit partial failure tested — deleted/removed comments filtered without crashing
- [ ] Cache keys invalidate correctly on adapter version, chunker version, or embedding model change
- [ ] Debug trace timings exist for every pipeline stage (fetch, chunk, embed, bm25, vector, fusion, rerank)
- [ ] Adapter registry: adding a new adapter does not break existing tool registrations
- [ ] Byte-weighted cache eviction triggers correctly at `maxTotalCacheBytes`
- [ ] Per-adapter profile calibration: `balanced` and `semantic-heavy` produce meaningfully different rankings

### V3.0.5 Gates

- [ ] Job MVP adapter extracts title, location, workMode, salary from at least SEEK and Jora pages
- [ ] `verificationStatus` correctly distinguishes fetched pages from search snippets from aggregator results
- [ ] Weighted composite score beats pure semantic ranking on location-constrained job queries
- [ ] Confidence scores reflect reality — a listing with no salary returns `salary: 0`, not a hallucinated value
- [ ] Caveats extracted from listing text (not invented by the tool)
- [ ] All fields are facts from the listing page; no interpretation layer

### V3.1 Gates

- [ ] Repo indexing respects byte caps and file caps — no unbounded monorepo ingestion
- [ ] Generated/vendor files excluded (lockfiles, `*.generated.*`, `build/`)
- [ ] Tree-sitter fallback is explicit — unrecognized extensions log and fall back to text adapter
- [ ] `lexical-heavy` profile beats `balanced` on identifier-heavy code queries ("find `handleSubmit`")
- [ ] Code embedding degradation path surfaced in README when `EMBEDDING_CODE_MODEL` not configured
- [ ] WASM grammars lazy-load on first use per language, not at startup

### V3.2 Gates

- [ ] Structured extraction includes confidence scoring on every extracted field
- [ ] Three-layer dedup reduces repeated results — cross-source job listings merged correctly
- [ ] Coverage reporting present in every multi-source response
- [ ] Constraint-aware ranking can explain inclusions and exclusions (matched + caveats)
- [ ] Static source profiles consulted by every multi-source tool
- [ ] `semantic_search` prototype dispatches to same pipeline as per-tool names

---

## Migration Notes

- `semantic_crawl` stays unchanged; its internals are extracted into `src/rag/` but the tool interface does not break.
- All semantic tools are **additive** — the underlying `youtube_search`, `reddit_search`, etc. remain as-is for lightweight use cases that don't need full corpus search.
- The corpus cache namespace separates tool corpora (`web:`, `github:`, `youtube:`, etc.) to avoid ID collisions.
- Cache keys are versioned — adapter or chunking changes invalidate cached corpora automatically.
- Domain adapters are additive — they produce structured objects that flow through the same retrieval pipeline, not a separate code path.
