# CLAUDE.md

> **Version: 7.0.0** — Family-based tool architecture (17 tools, 73 actions), HTTP/HTTPS transport with React browser dashboard (provider config, API key management, Tailscale access), session-gated dashboard API, dual-mode startup (stdio-only or HTTP+stdio), ConfigManager with AES-256-GCM encrypted config, deep research engine, knowledge graph, browser automation, agentic browsing, and all V3.x features (semantic RAG, multi-provider embeddings, RAG-Anything, extraction resilience).

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP (Model Context Protocol) server exposing **17 tools with 73 actions** over stdio JSON-RPC: web search/extract/crawl, semantic RAG, GitHub, YouTube, Reddit, academic research (14 backends), Hacker News, Stack Overflow, npm, PyPI, jobs, browser automation, agentic browsing, knowledge graph, and deep research. Clients like Claude Desktop or the Claude CLI connect via stdin/stdout; all logging goes to stderr.

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

**Tool registration**: `src/server.ts` is the composition root. Tools are registered in two patterns:

- **Family tools** (8): defined in `src/tools/families/`, registered via `registerFamily()` from `src/tools/registry.ts`. Each family is a single MCP tool with a discriminated-union `action` field. Unavailable actions return actionable errors at runtime.
- **Standalone tools** (9): defined in `src/tools/standalone/`, call `server.registerTool()` directly.

Some tools are conditionally gated by config: `web_crawl` (Crawl4AI), `semantic_crawl` (Crawl4AI + embedding), `semantic_jobs` (embedding + search), `deep_research` (DEEP_RESEARCH_ENABLED), `browser` (BROWSER_ENABLED), `knowledge_graph` (KG_ENABLED).

**Standalone tools** (in `src/tools/standalone/`):

- `web_search` — Multi-backend search with fallback chain (Exa, Brave, SearXNG). Optional `expandQuery` for rule-based query variations. Optional `mergeSearchBackends` for parallel cross-backend merging.
- `web_crawl` — Deep multi-page crawl via Crawl4AI. Timeout = 30s + 15s × maxPages (cap 5 min). External recovery via Wayback Machine / Google Cache when Crawl4AI fails. Requires `CRAWL4AI_BASE_URL`.
- `semantic_crawl` — Full RAG pipeline over crawled corpus. Sources: `url`, `sitemap`, `search`, `github`, `cached`. Returns top-K semantically ranked chunks. Requires `CRAWL4AI_BASE_URL` + `EMBEDDING_SIDECAR_BASE_URL`.
- `semantic_crawl_list_corpora` — List cached corpora.
- `semantic_crawl_inspect_corpus` — Inspect a specific cached corpus.
- `semantic_jobs` — Job search across SEEK, Indeed, Jora. Structured extraction, dedup, constraint filtering, weighted ranking. Requires `EMBEDDING_SIDECAR_BASE_URL` + search backend.
- `health_check` — Server status, config health, backend connectivity.
- `deep_research` — Async deep multi-source research via job/poll protocol. Actions: `start`, `run`, `poll`, `list`, `cancel`, `save`. Phases: decomposition → discovery → extraction → gap analysis → audit → synthesis. Requires `DEEP_RESEARCH_ENABLED=true`.
- `fetch_focus` ⚠️ deprecated — use `agentic_browse.focus` instead.

**Family tools** (in `src/tools/families/`, registered via `registerFamily()`):

- `github` — Actions: `repo`, `file`, `list_dir`, `tree`, `search`, `trending`, `code_search` (AST-aware via tree-sitter).
- `youtube` — Actions: `search` (API), `transcript` (free), `semantic` (search + transcript + RAG).
- `reddit` — Actions: `search` (free API), `comments` (nested tree), `semantic` (search + comments + RAG).
- `research` — 14 actions: `academic`, `pubmed`, `wikipedia`, `arxiv`, `hackernews`, `stackoverflow`, `openalex`, `crossref`, `datacite`, `ror`, `semantic_scholar`, `gdelt`, `wikidata`, `auto` (rule-based router).
- `packages` — Actions: `npm`, `pypi`.
- `browser` — 24 actions: `navigate`, `snapshot`, `click`, `type`, `evaluate`, `screenshot`, `extract`, `act`, `wait`, `wait_for`, `dialog_handle`, `iframe_context`, `scroll_to_load`, `paginate`, `download`, `table_extract`, `network_intercept`, `resource_timing`, `diff`, `pdf`, `storage`, `network`, `tabs`, `session`. Backends: Playwright + CDP, optional CloakBrowser. Gated by `BROWSER_ENABLED`.
- `agentic_browse` — Actions: `browse`, `present`, `read`, `focus`. In-memory document store with optional deep research.
- `knowledge_graph` — 10 actions: `ingest`, `query`, `entity_lookup_batch`, `status`, `rebuild`, `family_list`, `family_get`, `family_merge`, `run_list`, `run_rollback`. Gated by `KG_ENABLED`.

**Config resolution** (`src/config.ts`): encrypted file (`config.enc` + `SEARCH_MCP_CONFIG_KEY` env var) → individual env vars → defaults. Config is cached after first load.

Key env vars:

- Search: `EXA_API_KEY`, `BRAVE_API_KEY`, `SEARXNG_BASE_URL`, `SEARCH_BACKEND` (brave|searxng|exa|tavily), `TAVILY_API_KEY`
- Social: `NITTER_BASE_URL`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`, `YOUTUBE_API_KEY`
- Research: `STACKEXCHANGE_API_KEY`, `GITHUB_TOKEN`
- Crawl: `CRAWL4AI_BASE_URL`, `CRAWL4AI_API_TOKEN`
- Embedding: `EMBEDDING_PROVIDER` (sidecar|ollama|transformers|openai, default sidecar), `EMBEDDING_SIDECAR_BASE_URL`, `EMBEDDING_SIDECAR_API_TOKEN`, `EMBEDDING_DIMENSIONS` (default 768), `EMBEDDING_CODE_MODEL` (optional), `EMBEDDING_OLLAMA_BASE_URL` (default http://localhost:11434), `EMBEDDING_OPENAI_API_KEY`
- LLM (contextual embeddings, browser.act, deep research): `LLM_PROVIDER` (model name), `LLM_API_TOKEN` (optional), `LLM_BASE_URL` (required)
- RAG-Anything: `RAGA_ENABLED`, `RAGA_BRIDGE_URL` (default http://localhost:8000), `RAGA_DEFAULT_PARSER`, `RAGA_TIMEOUT_MS` (default 30000)
- Browser: `BROWSER_ENABLED`, `BROWSER_ENGINE` (playwright|cloak), `BROWSER_MODE` (stealth|user|profile), `BROWSER_PROFILE_DIR`, `CLOAKBROWSER_*`
- Deep Research: `DEEP_RESEARCH_ENABLED`, `DEEP_RESEARCH_BASE_URL`, `DEEP_RESEARCH_MODEL`, `DEEP_RESEARCH_WORKER_MODEL`, `DEEP_RESEARCH_DEFAULT_DEPTH`
- Knowledge Graph: `KG_ENABLED`
- Security (opt-in): `DOMAIN_TRUST_ENABLED`, `TRUSTED_DOMAINS`, `BLOCKED_DOMAINS`, `SCRUB_CONTENT`
- Persistence: `DATABASE_PATH` (SQLite corpus cache path; defaults under `~/.cache/search-mcp/semantic-crawl/`)

Reddit OAuth is optional: both `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` must be set together; setting exactly one is treated as invalid configuration (server starts, health reports degraded, Reddit tools throw `VALIDATION_ERROR` at first use).

**RAG core** (`src/rag/`): shared pipeline used by `semantic_crawl`, `youtube.semantic`, `reddit.semantic`, `semantic_jobs`, and `github.code_search`.

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
- `sidecar/jobspy/` — Python sidecar for job scraping via JobSpy.

**HTTP safety** (`src/httpGuards.ts`): SSRF protection (blocks private IPs, localhost, cloud metadata endpoints) and 10MB response size limits. All outbound HTTP in tools should use `assertSafeUrl` and `safeResponseText`/`safeResponseJson`. Exception: sidecar URLs come from operator config and bypass SSRF guards.

**Tool response pattern**: Every tool handler wraps results in `ToolResult<T>` (data + meta with tool name, duration, timestamp), then returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }`. Errors return `isError: true` with a sanitized (no stack trace) message.

**Utilities** (`src/utils/`):

- `bm25.ts` — BM25+ full-text index
- `fusion.ts` — Reciprocal Rank Fusion (RRF) merge across ranked lists
- `rerank.ts` — Cross-encoder reranking via ONNX runtime
- `metrics.ts` — Counters, histograms, gauges with label support for observability
- `instrumentation.ts` — Tracing spans, run tracking, pipeline wrappers (`spanSync`, `spanAsync`, `InstrumentedPipeline`)
- `corpusCache.ts` — SQLite-backed corpus store (chunks + embeddings + BM25 index); `normalizeSource()` sorts URL arrays and GitHub extensions for stable identity; `CachedCorpus` is a clean type (no phantom fields)
- `crawlBudget.ts` — Response-size budget utilities: `SAFE_BYTES`, `DEFAULT_AVG_PAGE_BYTES`, `JS_HEAVY_AVG_PAGE_BYTES`, `isLikelyJsHeavySite()`, `estimateSerializedBytes()`
- `lexicalConstraint.ts` — IDF-weighted soft token coverage constraint
- `githubCorpus.ts` — GitHub API → document corpus converter
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
- `AdapterType` includes `job`, `code`, `text`, `transcript`, `conversation`, `academic`, `qa`

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
