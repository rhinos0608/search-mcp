# CLAUDE.md

> **Version: 6.0.0** — HTTP/HTTPS transport with React browser dashboard (provider config, API key management, Tailscale access), session-gated dashboard API, dual-mode startup (stdio-only or HTTP+stdio), ConfigManager with AES-256-GCM encrypted config, and all V3.x features (semantic RAG, multi-provider embeddings, RAG-Anything, extraction resilience).

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP (Model Context Protocol) server that exposes web search, web reading, deep crawling, **semantic RAG search**, GitHub (repo, file, tree, search, corpus), YouTube, Reddit, Twitter/X, Product Hunt, patent, podcast, academic research, Hacker News, Stack Overflow, npm, PyPI, and news tools over stdio JSON-RPC. Clients like Claude Desktop or the Claude CLI connect via stdin/stdout; all logging goes to stderr.

**V6.0.0** adds opt-in HTTP transport with a React browser dashboard: set `HTTP_PORT` to enable. The dashboard serves at `/dashboard`, the MCP endpoint at `/mcp` (Bearer token auth). A `ConfigManager` manages AES-256-GCM encrypted config (`config.enc`); on first run it generates an `mcpApiKey` printed once to stderr. Startup is dual-mode: `HTTP_PORT` absent → original `loadConfig()` stdio-only path; `HTTP_PORT` set → `ConfigManager` + `startHttpServer`.

V3.3.0 adds extraction resilience: contextual embeddings, domain trust, external recovery (Wayback/Google Cache), content scrubbing, query expansion, cross-backend search merging, code example extraction, and self-improvement tracking. V3.2.0 adds multi-provider embeddings (Ollama, Transformers.js, OpenAI), Docker Compose full-stack, evaluation framework, observability/metrics. V3.1.0 adds `semantic_github_code` (AST-aware code search via tree-sitter). V3.0.0 extracts the retrieval pipeline into reusable `src/rag/` modules.

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
npm run install:dashboard  # npm install inside dashboard/
npm run build:dashboard    # Vite build of dashboard → dist-dashboard/
npm run build:all          # npm run build && npm run build:dashboard
```

Append `--json` (via `dev:json` / `start:json`) for structured JSON logging instead of pino-pretty.

**HTTP mode startup (enables dashboard):**
```bash
HTTP_PORT=8050 SEARCH_MCP_CONFIG_KEY="your-passphrase" npm start
```
On first run this prints the generated `mcpApiKey` to stderr — that key is the dashboard login password and MCP Bearer token. Subsequent runs read from `config.enc`.

## Architecture

**Transport**: Dual-mode. When `HTTP_PORT` is unset, stdio only — stdout is exclusively for JSON-RPC frames; never write anything else to stdout. When `HTTP_PORT` is set, the server binds an HTTP server on that port (MCP at `/mcp`, dashboard at `/dashboard`) **and** also connects the stdio transport. All logging uses pino routed to stderr via `src/logger.ts`.

**Tool registration**: `src/server.ts` creates the `McpServer` and registers all tools inline with Zod input schemas. Each tool delegates to a function in `src/tools/`.

**Tools** (one file each in `src/tools/`):

_Search & Read_

- `web_search` — Multi-backend search with fallback chain: primary backend (configured) → remaining backend. Supports Exa, Brave, and SearXNG. Optional `expandQuery` generates rule-based query variations (concept, question, scope, opposition) for broader coverage. Optional `mergeSearchBackends` queries all configured backends in parallel and merges/deduplicates results with composite scoring (engine agreement 40%, domain authority 30%, position 30%).
- `web_read` — Fetches a URL and extracts article content via Mozilla Readability + jsdom.
- `web_crawl` — Deep multi-page crawl via Crawl4AI (JS rendering). Returns markdown + HTML per page. Timeout scales with `maxPages` (30s + 15s × pages, cap 5 min). Requires `CRAWL4AI_BASE_URL`. When Crawl4AI returns placeholder/empty content, attempts external recovery via Wayback Machine CDX API and Google Cache (tagged as `recoverySource` in page metadata).
- `semantic_crawl` — Full RAG pipeline over a crawled corpus. Source types: `url`, `sitemap`, `search` (search-then-crawl), `github` (code-aware), `cached` (re-use corpus by ID). Returns top-K semantically ranked chunks with bi-encoder, BM25, and RRF scores. Requires `CRAWL4AI_BASE_URL` + `EMBEDDING_SIDECAR_BASE_URL`. Supports optional `useContextualEmbeddings` for LLM-enriched chunk context before embedding. Content scrubbing (opt-in via config) redacts injection/exfiltration patterns before chunking. Domain trust evaluation (opt-in) blocks known typosquats and suspicious domains. Extraction stats track per-domain success rates and can short-circuit known-failing domains.
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
- Specialist: `LISTENNOTES_API_KEY`, `PRODUCTHUNT_API_TOKEN`, `PATENTSVIEW_API_KEY`, `YOUTUBE_API_KEY`, `STACKEXCHANGE_API_KEY`, `GITHUB_TOKEN`
- Crawl: `CRAWL4AI_BASE_URL`, `CRAWL4AI_API_TOKEN`
- Embedding: `EMBEDDING_PROVIDER` (sidecar|ollama|transformers|openai, default sidecar), `EMBEDDING_SIDECAR_BASE_URL`, `EMBEDDING_SIDECAR_API_TOKEN`, `EMBEDDING_DIMENSIONS` (default 768), `EMBEDDING_CODE_MODEL` (optional), `EMBEDDING_OLLAMA_BASE_URL` (default http://localhost:11434), `EMBEDDING_OLLAMA_MODEL` (default nomic-embed-text), `EMBEDDING_TRANSFORMERS_MODEL` (default Xenova/all-MiniLM-L6-v2), `EMBEDDING_OPENAI_BASE_URL`, `EMBEDDING_OPENAI_MODEL` (default text-embedding-3-small), `EMBEDDING_OPENAI_API_KEY`
- RAG-Anything: `RAGA_ENABLED`, `RAGA_BRIDGE_URL` (default http://localhost:8000), `RAGA_DEFAULT_PARSER`, `RAGA_TIMEOUT_MS` (default 30000)
- Persistence: `DATABASE_PATH` (SQLite corpus cache path; defaults under `~/.cache/search-mcp/semantic-crawl/`)

Reddit OAuth is optional: both `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` must be set together; setting exactly one is treated as invalid configuration (server starts, health reports degraded, Reddit tools throw `VALIDATION_ERROR` at first use).

**V3.3.0 env vars (all opt-in, off by default):**

- Security: `DOMAIN_TRUST_ENABLED` (true/false), `TRUSTED_DOMAINS`, `BLOCKED_DOMAINS` (comma-separated), `SCRUB_CONTENT` (true/false)
- LLM (contextual embeddings): `LLM_PROVIDER` (model name), `LLM_API_TOKEN` (optional), `LLM_BASE_URL` (required)

**RAG core** (`src/rag/`): shared pipeline used by `semantic_crawl`, `semantic_youtube`, `semantic_reddit`, `semantic_jobs`, and `semantic_github_code`.

- `types.ts` — `RagChunk`, `PreparedCorpus`, `RetrievalResponse`, `RetrievalProfileName`, etc.
- `pipeline.ts` — `prepareCorpus()`, `retrieveCorpus()`, `prepareAndRetrieve()` (embedding → BM25 → RRF → top-K); `corpusIdFor()` includes chunking parameters for cache compatibility
- `embedding.ts` — `embedTexts()`, `embedTextsBatched()` (multi-provider dispatch: sidecar, ollama, transformers, openai; bypasses SSRF guard)
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

1. Corpus ingestion: crawl pages via Crawl4AI → strip cookie banners → optional domain trust filtering → optional content scrubbing → `chunkMarkdown()` (400-token max, 20% overlap, atomic units for code blocks/tables, boilerplate heuristics). Code blocks >=300 chars are extracted with language metadata.
2. **V3.3.0: Contextual embeddings** (opt-in): when `useContextualEmbeddings` is true and LLM is configured, each chunk is enriched with LLM-generated context (`src/rag/contextualEmbedding.ts`) before embedding.
3. **Response-size guard** (`src/utils/crawlBudget.ts`): preflight heuristic cap on `maxPages` (site-aware: 8MB/page JS-heavy, 1.5MB/page default; safe budget ~41MB) + in-flight per-page byte accumulator that stops collection and records `omittedPages` when budget is approached. Emits typed `SemanticCrawlWarning` objects in `structuredWarnings`.
4. Embedding: batched document embeddings via sidecar (max 512/batch, document/query asymmetric, title-aware). Query embedded in parallel.
5. Hybrid ranking: bi-encoder cosine → BM25+ (`src/utils/bm25.ts`) → RRF fusion via `src/rag/pipeline.ts` (internal `retrieveSemanticChunks()` wrapper)
6. Post-filtering: semantic coherence filter (centroid similarity for borderline chunks) → soft IDF-weighted lexical constraint (`src/utils/lexicalConstraint.ts`)
7. Optional cross-encoder reranking (`src/utils/rerank.ts`, ONNX-based, local, default off)
8. Corpus cache (`src/utils/corpusCache.ts`): Persistent via SQLite (`better-sqlite3`), configurable TTL, byte-weighted LRU eviction, default database path from `DATABASE_PATH` or `~/.cache/search-mcp/semantic-crawl/corpus-cache.sqlite`. Re-query via `source: { type: 'cached', corpusId }`.

GitHub corpus (`src/utils/githubCorpus.ts`): fetches repo files via GitHub API, uses `chunkMarkdown` with path-prefixed sections. Supports branch, file extension filter, and query pre-filter.

**Embedding providers** (`src/utils/`):

- `embedding.ts` — Provider dispatch: selects runtime provider based on `EMBEDDING_PROVIDER` env var
- `ollamaEmbedding.ts` — Ollama local embedding via HTTP API
- `transformersEmbedding.ts` — In-process Transformers.js embedding (ONNX)
- Sidecar: FastAPI server at `sidecar/embedding/` with OpenAI-compatible proxy at `sidecar/openai-embedding-proxy/`

**Sidecar services** (`sidecar/`):

- `sidecar/embedding/` — Python FastAPI server running a local embedding model (nomic-embed-text or similar). Exposes `POST /embed` accepting `{ texts, mode, dimensions }`.
- `sidecar/openai-embedding-proxy/` — OpenAI-compatible proxy that routes `/v1/embeddings` to the sidecar.

**HTTP safety** (`src/httpGuards.ts`): SSRF protection (blocks private IPs, localhost, cloud metadata endpoints) and 10MB response size limits. All outbound HTTP in tools should use `assertSafeUrl` and `safeResponseText`/`safeResponseJson`. Exception: sidecar URLs come from operator config and bypass SSRF guards.

**Tool response pattern**: Every tool handler wraps results in `ToolResult<T>` (data + meta with tool name, duration, timestamp), then returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }`. Errors return `isError: true` with a sanitized (no stack trace) message.

**Utilities** (`src/utils/`):

- `bm25.ts` — BM25+ full-text index
- `fusion.ts` — Reciprocal Rank Fusion (RRF) merge across ranked lists
- `rerank.ts` — Cross-encoder reranking via ONNX runtime
- `metrics.ts` — Counters, histograms, gauges with label support for observability
- `instrumentation.ts` — Tracing spans, run tracking, pipeline wrappers (`spanSync`, `spanAsync`, `InstrumentedPipeline`)
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
- `externalRecovery.ts` — Wayback Machine CDX + Google Cache fallback when Crawl4AI fails
- `contentScrubber.ts` — Regex-based threat detection and redaction (prompt injection, exfiltration, impersonation, XSS)
- `domainTrust.ts` — Domain reputation evaluation, typosquat detection, blocklist/allowlist
- `searchMerge.ts` — Cross-backend search result dedup and scoring
- `extractionStats.ts` — Per-domain crawl outcome tracking and self-improvement skip logic

## Key Constraints

- TypeScript strict mode with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- ESM-only (`"type": "module"` in package.json), all local imports need `.js` extension
- Zod v4 imported as `zod/v4`
- youtube-transcript has a broken ESM export; the workaround imports directly from `youtube-transcript/dist/youtube-transcript.esm.js` with `@ts-expect-error`
- `config.json` and `config.enc` are gitignored — never commit API keys
- `rerank.ts` and `githubCorpus.ts` are dynamically imported (`await import(...)`) to keep startup fast when those features are unused
- Embedding sidecar and RAGA bridge URLs bypass SSRF guards — they come from operator config, not user input
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

**Docker Compose deployment** (`docker-compose.yml`):

Full-stack deployment with four services:
- `search-mcp` — The MCP server (port 8050, stdio HTTP proxy)
- `search-mcp-crawl4ai` — Crawl4AI browser service (port 8051)
- `search-mcp-embedding` — Embedding sidecar (port 8001)
- `search-mcp-searxng` — SearXNG meta-search (port 8081)

Start with `docker compose up -d`.

**Evaluation framework** (`src/eval/`):

- Golden query datasets covering academic, general, job, and QA domains
- Scoring: precision, recall, nDCG
- Runner for batch evaluation across retrieval profiles
- Test suite for evaluation components

**Structured warnings** (V4 direction — currently typed unions, should become consistent across all tools):

- `semantic_crawl`: already uses `SemanticCrawlWarning` typed objects for response-size guard
- `semantic_jobs`: uses string warnings (e.g., crawl failures, markdown-only pages, byte budget truncation)
- All other tools: string-only warnings in `ToolResult.meta.warnings`
- V4 should introduce a `WarningCode` type union and `StructuredWarning { code, severity, message, source? }` across all tools

## Commit Style

```
feat(rag): add persistent corpus cache
fix(crawl): enforce page budget before extraction
fix(security): block SSRF targets in smart extraction
docs(roadmap): align v3.1 plan
test(jobs): cover source normalization
refactor(server): split tool registration
chore(release): tag v3.2.0
```

- Use [Conventional Commits](https://www.conventionalcommits.org/).
- Scopes name the subsystem (`rag`, `crawl`, `github`, `server`, etc.), not the release version.
- Keep subjects imperative and under ~72 characters.
- Mention user-visible behavior in the body when relevant.
- Use `fix(security)` for security-sensitive hardening.
- Tag releases separately with `chore(release): tag vX.Y.Z`.
- Squash noisy fixups (typo, lint-only, "oops missed file", broken intermediates) before merge.
- Keep meaningful fixes visible — especially correctness, security, and regression fixes.

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
