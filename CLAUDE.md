# CLAUDE.md

> **Version: 3.1.5** — RAG-Anything Integration: multimodal document extraction (PDFs, Office, scanned docs) via Python bridge service, plus code review-driven quality fixes across the RAG pipeline.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP (Model Context Protocol) server that exposes web search, web reading, deep crawling, **semantic RAG search**, GitHub (repo, file, tree, search, corpus), YouTube, Reddit, Twitter/X, Product Hunt, patent, podcast, academic research, Hacker News, Stack Overflow, npm, PyPI, and news tools over stdio JSON-RPC. Clients like Claude Desktop or the Claude CLI connect via stdin/stdout; all logging goes to stderr.

V3.0.0 extracts the retrieval pipeline into reusable `src/rag/` modules and adds two new semantic tools: `semantic_youtube` (search + transcripts + RAG) and `semantic_reddit` (search + comments + RAG). V3.0.5 adds the `semantic_jobs` tool with structured job listing extraction (SEEK, Indeed, Jora), three-layer dedup, and constraint-aware weighted ranking. V3.1.0 adds `semantic_github_code` (AST-aware code search via lazy-loaded tree-sitter WASM grammars, lexical-heavy profile). V3.1.1 fixes three reliability bugs: `semantic_jobs` now receives full HTML from Crawl4AI for structured extraction; `web_crawl` timeout scales with `maxPages` (30s + 15s × pages, capped at 5 min); `semantic_crawl` has a two-layer response-size guard (preflight `maxPages` cap + in-flight byte accumulator) to prevent MCP 52MB response limit crashes. V3.1.5 adds RAG-Anything integration for multimodal document extraction (PDFs, Office, scanned documents) via a Python bridge service, plus code review-driven fixes: 'job' adapter type, code adapter identity fix, semantic score mapping by documentId, corpus ID versioning, corpus cache type cleanup, and crawlBudget type canonicalization. The `semantic_crawl` tool remains the primary crawl entry point. The shared RAG core: bi-encoder embeddings → BM25+ → RRF fusion → top-K.

## Commands

```bash
npm run dev              # Start dev server with hot-reload (tsx watch)
npm run build            # Compile TypeScript → dist/
npm start                # Run compiled server (dist/index.js)
npm run lint             # ESLint (strict type-checked + stylistic)
npm run lint:fix         # ESLint with auto-fix
npm run format           # Prettier write
npm run format:check     # Prettier check
npm run typecheck        # tsc --noEmit
npm run config:encrypt   # Encrypt config.json → config.enc
npm run config:decrypt   # Decrypt config.enc → config.json
```

Append `--json` (via `dev:json` / `start:json`) for structured JSON logging instead of pino-pretty.

## Architecture

**Transport**: stdio only. stdout is exclusively for JSON-RPC frames; never write anything else to stdout. All logging uses pino routed to stderr via `src/logger.ts`.

**Tool registration**: `src/server.ts` creates the `McpServer` and registers all tools inline with Zod input schemas. Each tool delegates to a function in `src/tools/`.

**Tools** (one file each in `src/tools/`):

_Search & Read_

- `web_search` — Multi-backend search with fallback chain: primary backend (configured) → remaining backend. Supports Exa, Brave, and SearXNG.
- `web_read` — Fetches a URL and extracts article content via Mozilla Readability + jsdom.
- `web_crawl` — Deep multi-page crawl via Crawl4AI (JS rendering). Returns markdown + HTML per page. Timeout scales with `maxPages` (30s + 15s × pages, cap 5 min). Requires `CRAWL4AI_BASE_URL`.
- `semantic_crawl` — Full RAG pipeline over a crawled corpus. Source types: `url`, `sitemap`, `search` (search-then-crawl), `github` (code-aware), `cached` (re-use corpus by ID). Returns top-K semantically ranked chunks with bi-encoder, BM25, and RRF scores. Requires `CRAWL4AI_BASE_URL` + `EMBEDDING_SIDECAR_BASE_URL`.
- `semantic_youtube` — YouTube video search + transcript fetch + RAG pipeline. Returns top-K semantically ranked transcript passages. Requires `YOUTUBE_API_KEY` + `EMBEDDING_SIDECAR_BASE_URL`.
- `semantic_reddit` — Reddit post search + comment thread fetch + RAG pipeline. Deleted/removed comments auto-filtered. Returns top-K semantically ranked comment passages. Requires `EMBEDDING_SIDECAR_BASE_URL`.
- `semantic_jobs` — Job listing search across job boards (SEEK, Indeed, Jora) via web search + crawl. Extracts structured fields from HTML (title, company, location, salary, work mode) using Cheerio and JSON-LD; requires Crawl4AI v0.8.x for HTML delivery. Deduplicates across sources, applies constraint filters, and ranks with weighted composite scoring (semantic 0.45, location 0.20, workMode 0.15, recency 0.10, completeness 0.10). Returns structured `JobListingMvp` objects with confidence scores and verification status. `corpusStatus` includes full extraction funnel (requested, fetched, failed, extracted, deduplicated, filtered). Requires `EMBEDDING_SIDECAR_BASE_URL` + a search backend (`BRAVE_API_KEY` or `SEARXNG_BASE_URL`).

_GitHub_

- `github_repo` — GitHub API (unauthenticated) for repo metadata, latest release, optional README.
- `github_repo_file` — Fetch raw content of a specific file from a GitHub repo via the API.
- `github_repo_search` — Search GitHub repos by query string; returns ranked repo list with metadata.
- `github_repo_tree` — Browse the directory tree of a GitHub repo at a given ref/path.
- `github_trending` — Scrapes github.com/trending with cheerio (no API).
- `semantic_github_code` — AST-aware code search over a GitHub repository. Chunks by function/class/method boundaries via lazy-loaded tree-sitter WASM grammars (TS, JS, Python, Go, Rust). Returns ranked code chunks with path, language, line range, symbol metadata, and RAG scores. Defaults to `lexical-heavy` profile. Requires `EMBEDDING_SIDECAR_BASE_URL`; `EMBEDDING_CODE_MODEL` is optional but recommended for conceptual queries.

_Video & Social_

- `youtube_search` — YouTube Data API v3 for video discovery. Returns video IDs + metadata. Requires `YOUTUBE_API_KEY`. Pairs with `youtube_transcript`.
- `youtube_transcript` — Fetches video captions via youtube-transcript library.
- `reddit_search` — Reddit search via shared Reddit transport (`src/tools/redditClient.ts`): public JSON API by default, OAuth (`oauth.reddit.com`) when `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` are both set.
- `reddit_comments` — Fetches a Reddit post plus a normalized comment tree via the same shared transport. Supports `url` / `permalink` / `subreddit`+`article` locators, focused subthreads via `comment`+`context`, and `sort` / `depth` / `limit` / `showMore` controls.
- `twitter_search` — Searches Twitter/X via a configurable Nitter instance (cheerio scraping). Requires `NITTER_BASE_URL`.

_Research & Discovery_

- `academic_search` — ArXiv API + Semantic Scholar API for academic paper search (free, no auth). Supports searching either or both with merged/deduplicated results.
- `arxiv_search` — Fast direct ArXiv-only search with full date range filtering via `submittedDate`. Supports category filtering. Faster than `academic_search` for ArXiv-only queries.
- `hackernews_search` — HN Algolia API for searching stories/comments (free, no auth). Supports type filtering, sort by relevance/date, and date range.
- `stackoverflow_search` — Stack Exchange API for searching questions. Supports tag filtering and accepted-answer filtering. Optional `STACKEXCHANGE_API_KEY` for higher rate limits.
- `news_search` — GDELT Global Knowledge Graph API for news articles (free, no auth). Supports date range filtering and language selection.

_Packages & Products_

- `npm_search` — npm registry search API (free, no auth). Returns packages with metadata, scores, and repository links.
- `pypi_search` — PyPI search via HTML scraping (cheerio) with top-result enrichment from PyPI JSON API (free, no auth).
- `producthunt_search` — Product Hunt search via GraphQL API (with `PRODUCTHUNT_API_TOKEN`) or public leaderboard scraping fallback.

_Specialist_

- `patent_search` — USPTO PatentsView API for US patent search. Requires `PATENTSVIEW_API_KEY` (free registration).
- `podcast_search` — ListenNotes API for podcast episode search. Requires `LISTENNOTES_API_KEY`.

**Config resolution** (`src/config.ts`): encrypted file (`config.enc` + `SEARCH_MCP_CONFIG_KEY` env var) → individual env vars → defaults. Config is cached after first load.

Key env vars:

- Search: `EXA_API_KEY`, `BRAVE_API_KEY`, `SEARXNG_BASE_URL`, `SEARCH_BACKEND`
- Social: `NITTER_BASE_URL`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`
- Specialist: `LISTENNOTES_API_KEY`, `PRODUCTHUNT_API_TOKEN`, `PATENTSVIEW_API_KEY`, `YOUTUBE_API_KEY`, `STACKEXCHANGE_API_KEY`
- Crawl: `CRAWL4AI_BASE_URL`, `CRAWL4AI_API_TOKEN`
- Embedding: `EMBEDDING_SIDECAR_BASE_URL`, `EMBEDDING_SIDECAR_API_TOKEN`, `EMBEDDING_DIMENSIONS` (default 768), `EMBEDDING_CODE_MODEL` (optional; code-tuned model endpoint for `semantic_github_code` — without it the tool warns and falls back to the prose model)
- Persistence: `DATABASE_PATH` (SQLite corpus cache path; defaults under `~/.cache/search-mcp/semantic-crawl/`)

Reddit OAuth is optional: both `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` must be set together; setting exactly one is treated as invalid configuration (server starts, health reports degraded, Reddit tools throw `VALIDATION_ERROR` at first use).

**RAG core** (`src/rag/`): shared pipeline used by `semantic_crawl`, `semantic_youtube`, `semantic_reddit`, `semantic_jobs`, and `semantic_github_code`.

- `types.ts` — `RagChunk`, `PreparedCorpus`, `RetrievalResponse`, `RetrievalProfileName`, etc.
- `pipeline.ts` — `prepareCorpus()`, `retrieveCorpus()`, `prepareAndRetrieve()` (embedding → BM25 → RRF → top-K); `corpusIdFor()` includes chunking parameters for cache compatibility
- `embedding.ts` — `embedTexts()`, `embedTextsBatched()` (sidecar client, bypasses SSRF guard)
- `profiles.ts` — `balanced`, `lexical-heavy`, `semantic-heavy`, `high-precision`, `fast`, `precision`, `recall` retrieval profiles
- `adapters/text.ts` — crawl pages → `RagChunk[]`
- `adapters/transcript.ts` — YouTube transcript segments → `RagChunk[]`
- `adapters/conversation.ts` — Reddit comment trees → `RagChunk[]` (filters deleted/removed, includes parent context)
- `adapters/job.ts` — Job listing HTML → `JobListingMvp[]` (structured extraction: title, company, location, salary, work mode, caveats, confidence); uses `AdapterType = 'job'`
- `adapters/code.ts` — Source files → `RagChunk[]` via tree-sitter AST (functions, classes, methods); defaults to `lexical-heavy` profile; falls back to text chunking on unsupported languages; uses `AdapterType = 'code'`; filters empty chunks from symbol extraction
- `code/languages.ts` — Extension/shebang → language detection (`typescript`, `javascript`, `python`, `go`, `rust`, `markdown`, `shell`, `unknown`)
- `code/treeSitter.ts` — Lazy WASM grammar loader (one parser instance per language, loaded on first use)
- `code/symbols.ts` — AST symbol extraction with line-range metadata (path, symbolName, symbolKind, signature, imports, docstring)
- `types/job.ts` — `JobListingMvp`, `JobSearchConstraints`, `JobFieldConfidence`, `WorkMode`, `VerificationStatus`
- `sources/jobSources.ts` — Host-pattern source detection (SEEK, Indeed, Jora) and source reliability profiles
- `jobRanking.ts` — Hard constraint filters (location, workMode, maxSalary, excludeTitles) + weighted composite scoring
- `jobDedup.ts` — Three-layer dedup: exact URL, source+jobId, company+title

**Semantic pipeline** (`src/tools/semanticCrawl.ts` + `src/chunking.ts` + `src/utils/`):

1. Corpus ingestion: crawl pages via Crawl4AI → strip cookie banners → `chunkMarkdown()` (400-token max, 20% overlap, atomic units for code blocks/tables, boilerplate heuristics)
2. **Response-size guard** (`src/utils/crawlBudget.ts`): preflight heuristic cap on `maxPages` (site-aware: 8MB/page JS-heavy, 1.5MB/page default; safe budget ~41MB) + in-flight per-page byte accumulator that stops collection and records `omittedPages` when budget is approached. Emits typed `SemanticCrawlSizeWarning` objects in `structuredWarnings`.
3. Embedding: batched document embeddings via sidecar (max 512/batch, document/query asymmetric, title-aware). Query embedded in parallel.
4. Hybrid ranking: bi-encoder cosine → BM25+ (`src/utils/bm25.ts`) → RRF fusion via `src/rag/pipeline.ts` (internal `retrieveSemanticChunks()` wrapper)
5. Post-filtering: semantic coherence filter (centroid similarity for borderline chunks) → soft IDF-weighted lexical constraint (`src/utils/lexicalConstraint.ts`)
6. Optional cross-encoder reranking (`src/utils/rerank.ts`, ONNX-based, local, default off)
7. Corpus cache (`src/utils/corpusCache.ts`): Persistent via SQLite (`better-sqlite3`), configurable TTL, byte-weighted LRU eviction, default database path from `DATABASE_PATH` or `~/.cache/search-mcp/semantic-crawl/corpus-cache.sqlite`. Re-query via `source: { type: 'cached', corpusId }`.

GitHub corpus (`src/utils/githubCorpus.ts`): fetches repo files via GitHub API, uses `chunkMarkdown` with path-prefixed sections. Supports branch, file extension filter, and query pre-filter.

**Sidecar services** (`sidecar/`):

- `sidecar/embedding/` — Python FastAPI server running a local embedding model (nomic-embed-text or similar). Exposes `POST /embed` accepting `{ texts, mode, dimensions }`.
- `sidecar/openai-embedding-proxy/` — OpenAI-compatible proxy that routes `/v1/embeddings` to the sidecar.

**HTTP safety** (`src/httpGuards.ts`): SSRF protection (blocks private IPs, localhost, cloud metadata endpoints) and 10MB response size limits. All outbound HTTP in tools should use `assertSafeUrl` and `safeResponseText`/`safeResponseJson`. Exception: sidecar URLs come from operator config and bypass SSRF guards.

**Tool response pattern**: Every tool handler wraps results in `ToolResult<T>` (data + meta with tool name, duration, timestamp), then returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }`. Errors return `isError: true` with a sanitized (no stack trace) message.

**Utilities** (`src/utils/`):

- `bm25.ts` — BM25+ full-text index
- `fusion.ts` — Reciprocal Rank Fusion (RRF) merge across ranked lists
- `rerank.ts` — Cross-encoder reranking via ONNX runtime
- `corpusCache.ts` — SQLite-backed corpus store (chunks + embeddings + BM25 index); `normalizeSource()` sorts URL arrays and GitHub extensions for stable identity; `CachedCorpus` is a clean type (no phantom fields)
- `crawlBudget.ts` — Response-size budget utilities: `SAFE_BYTES`, `DEFAULT_AVG_PAGE_BYTES`, `JS_HEAVY_AVG_PAGE_BYTES`, `isLikelyJsHeavySite()`; uses canonical `SemanticCrawlSourceType` from `src/types.ts`
- `lexicalConstraint.ts` — IDF-weighted soft token coverage constraint
- `githubCorpus.ts` — GitHub API → document corpus converter
- `crawlBudget.ts` — Response-size budget utilities: `SAFE_BYTES`, `DEFAULT_AVG_PAGE_BYTES`, `JS_HEAVY_AVG_PAGE_BYTES`, `isLikelyJsHeavySite()`, `estimateSerializedBytes()`
- `extractionConfig.ts` — Structured data extraction config schema for Crawl4AI
- `elementHelpers.ts`, `elementTruncation.ts`, `htmlElements.ts`, `markdownElements.ts` — Structured content element types and truncation logic
- `sitemap.ts` — XML sitemap parser + sitemap-index detection
- `url.ts` — URL deduplication
- `cookieBanner.ts` — Cookie-banner page detection
- `rescore.ts` — Score normalization utilities

## Key Constraints

- TypeScript strict mode with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- ESM-only (`"type": "module"` in package.json), all local imports need `.js` extension
- Zod v4 imported as `zod/v4`
- youtube-transcript has a broken ESM export; the workaround imports directly from `youtube-transcript/dist/youtube-transcript.esm.js` with `@ts-expect-error`
- `config.json` and `config.enc` are gitignored — never commit API keys
- `rerank.ts` and `githubCorpus.ts` are dynamically imported (`await import(...)`) to keep startup fast when those features are unused
- Embedding sidecar URLs bypass SSRF guards — they come from operator config, not user input
- Corpus cache is persistent via SQLite; the `cached` source type works across server restarts
- `AdapterType` includes `job` (for `semantic_jobs`), `code` (for `semantic_github_code`), `text`, `transcript`, `conversation`, `github`, `url`, `sitemap`, `search`, `cached`

**RAG-Anything integration** (`services/rag-anything-bridge/`):

- `src/main.py` — FastAPI bridge service with multi-parser architecture (Docling, PaddleOCR, MinerU)
- `src/parsers/parser_router.py` — Automatic parser selection based on content type
- `src/processors/content_processor.py` — Structured content extraction and normalization
- `src/utils/cache.py` — Content-addressable caching with TTL
- `src/utils/storage.py` — Filesystem-based storage with hash distribution
- `src/utils/ragAnythingClient.ts` — TypeScript HTTP client with retry and caching
- `src/utils/extractionQuality.ts` — Configurable quality thresholds and escalation
- `src/utils/smartExtraction.ts` — Smart extraction orchestration with quality-based escalation
- Docker configuration: `Dockerfile`, `docker-compose.yml` (with optional Redis, Prometheus, Grafana)

**Identity model** (important for V4 migration):

- **Source key**: `stableStringify(normalizeSource(source))` — stable descriptor of what was requested; used for thundering-herd dedup and source_index lookup
- **Corpus ID**: `sha256(normalized_source | model | dimensions | chunking_params)` — identity of a specific prepared corpus; source-based, not content-hash-based
- **Content hash**: `sha256(chunk texts joined)` — integrity check on cached chunk text
- **Document ID**: set by adapters (file path for code, jobId/sourceUrl for jobs, index for generic)
- **Chunk identity**: corpus-scoped `chunkIndex` (position within the chunk array); not globally unique

**Structured warnings** (V4 direction — currently string arrays, should become typed codes):

- `semantic_crawl`: already uses `SemanticCrawlSizeWarning` typed objects for response-size guard
- `semantic_jobs`: uses string warnings (e.g., crawl failures, markdown-only pages, byte budget truncation)
- All other tools: string-only warnings in `ToolResult.meta.warnings`
- V4 should introduce a `WarningCode` type union and `StructuredWarning { code, severity, message, source? }` across all tools

## V4 Roadmap — Persistent Corpus Indexes

V4 turns semantic results from ephemeral per-session cache into durable, named, queryable indexes: "from semantic search tool to persistent research memory for coding agents."

### V4.0 — Persistent Corpus Indexes

- Named persistent indexes surviving restarts
- Index management tools: `index_create`, `index_query`, `index_list`, `index_describe`, `index_delete`, `index_compact`
- Local-first SQLite/filesystem backend with `StorageProvider` / `IndexStore` abstraction
- Index version metadata: schema version, adapter version, chunker version, embedding model/dimensions/mode, pipeline config, created/refreshed timestamps, content hashes, compatibility status
- Migration/invalidation rules for pipeline version changes

### V4.1 — Index Refresh and Maintenance

- Incremental refresh with source freshness checks
- Dedup compaction and stale document detection
- Index health reports and storage quota controls
- Export/import for corpus portability

### V4.2 — Cloud Storage and Team-Ready Backends

- S3-compatible asset storage for raw docs and extraction artifacts
- Optional Postgres/pgvector or remote index backend
- Cloud sync primitives and auth boundary preparation

### V4.3 — Packaging, Telemetry, and Monetisation Readiness

- Packaged install path with Docker images and config profiles
- Opt-in privacy-preserving telemetry (operational only: tool invoked, source type, success/failure, latency buckets, chunk counts — no content, queries, or paths)
- Feature-flag framework
- Monetisable layers: managed cloud indexes, team/shared indexes, hosted crawling, scheduled refresh, cloud sync
