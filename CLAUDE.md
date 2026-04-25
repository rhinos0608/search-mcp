# CLAUDE.md

> **Version: 3.0.5** — Universal RAG core + Job Adapter MVP: shared pipeline, multi-adapter retrieval, structured job listing extraction, constraint-aware ranking, dedup.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP (Model Context Protocol) server that exposes web search, web reading, deep crawling, **semantic RAG search**, GitHub (repo, file, tree, search, corpus), YouTube, Reddit, Twitter/X, Product Hunt, patent, podcast, academic research, Hacker News, Stack Overflow, npm, PyPI, and news tools over stdio JSON-RPC. Clients like Claude Desktop or the Claude CLI connect via stdin/stdout; all logging goes to stderr.

V3.0.0 extracts the retrieval pipeline into reusable `src/rag/` modules and adds two new semantic tools: `semantic_youtube` (search + transcripts + RAG) and `semantic_reddit` (search + comments + RAG). V3.0.5 adds the `semantic_jobs` tool with structured job listing extraction (SEEK, Indeed, Jora), three-layer dedup, and constraint-aware weighted ranking. The `semantic_crawl` tool remains the primary crawl entry point. The shared RAG core: bi-encoder embeddings → BM25+ → RRF fusion → top-K.

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

- `web_search` — Multi-backend search with fallback chain: primary backend (configured) → remaining backend. Supports Brave and SearXNG.
- `web_read` — Fetches a URL and extracts article content via Mozilla Readability + jsdom.
- `web_crawl` — Deep multi-page crawl via Crawl4AI (JS rendering). Returns raw markdown per page. Requires `CRAWL4AI_BASE_URL`.
- `semantic_crawl` — Full RAG pipeline over a crawled corpus. Source types: `url`, `sitemap`, `search` (search-then-crawl), `github` (code-aware), `cached` (re-use corpus by ID). Returns top-K semantically ranked chunks with bi-encoder, BM25, and RRF scores. Requires `CRAWL4AI_BASE_URL` + `EMBEDDING_SIDECAR_BASE_URL`.
- `semantic_youtube` — YouTube video search + transcript fetch + RAG pipeline. Returns top-K semantically ranked transcript passages. Requires `YOUTUBE_API_KEY` + `EMBEDDING_SIDECAR_BASE_URL`.
- `semantic_reddit` — Reddit post search + comment thread fetch + RAG pipeline. Deleted/removed comments auto-filtered. Returns top-K semantically ranked comment passages. Requires `EMBEDDING_SIDECAR_BASE_URL`.
- `semantic_jobs` — Job listing search across job boards (SEEK, Indeed, Jora) via web search + crawl. Extracts structured fields (title, company, location, salary, work mode), deduplicates across sources, applies constraint filters, and ranks with weighted composite scoring (semantic 0.45, location 0.20, workMode 0.15, recency 0.10, completeness 0.10). Returns structured `JobListingMvp` objects with confidence scores and verification status. Requires `EMBEDDING_SIDECAR_BASE_URL` + a search backend (`BRAVE_API_KEY` or `SEARXNG_BASE_URL`).

_GitHub_

- `github_repo` — GitHub API (unauthenticated) for repo metadata, latest release, optional README.
- `github_repo_file` — Fetch raw content of a specific file from a GitHub repo via the API.
- `github_repo_search` — Search GitHub repos by query string; returns ranked repo list with metadata.
- `github_repo_tree` — Browse the directory tree of a GitHub repo at a given ref/path.
- `github_trending` — Scrapes github.com/trending with cheerio (no API).

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

- Search: `BRAVE_API_KEY`, `SEARXNG_BASE_URL`, `SEARCH_BACKEND`
- Social: `NITTER_BASE_URL`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`
- Specialist: `LISTENNOTES_API_KEY`, `PRODUCTHUNT_API_TOKEN`, `PATENTSVIEW_API_KEY`, `YOUTUBE_API_KEY`, `STACKEXCHANGE_API_KEY`
- Crawl: `CRAWL4AI_BASE_URL`, `CRAWL4AI_API_TOKEN`
- Embedding: `EMBEDDING_SIDECAR_BASE_URL`, `EMBEDDING_SIDECAR_API_TOKEN`, `EMBEDDING_DIMENSIONS` (default 768)

Reddit OAuth is optional: both `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` must be set together; setting exactly one is treated as invalid configuration (server starts, health reports degraded, Reddit tools throw `VALIDATION_ERROR` at first use).

**RAG core** (`src/rag/`): shared pipeline used by `semantic_crawl`, `semantic_youtube`, and `semantic_reddit`.

- `types.ts` — `RagChunk`, `PreparedCorpus`, `RetrievalResponse`, `RetrievalProfileName`, etc.
- `pipeline.ts` — `prepareCorpus()`, `retrieveCorpus()`, `prepareAndRetrieve()` (embedding → BM25 → RRF → top-K)
- `embedding.ts` — `embedTexts()`, `embedTextsBatched()` (sidecar client, bypasses SSRF guard)
- `profiles.ts` — `balanced`, `fast`, `precision`, `recall` retrieval profiles
- `adapters/text.ts` — crawl pages → `RagChunk[]`
- `adapters/transcript.ts` — YouTube transcript segments → `RagChunk[]`
- `adapters/conversation.ts` — Reddit comment trees → `RagChunk[]` (filters deleted/removed, includes parent context)
- `adapters/job.ts` — Job listing HTML → `JobListingMvp[]` (structured extraction: title, company, location, salary, work mode, caveats, confidence)
- `types/job.ts` — `JobListingMvp`, `JobSearchConstraints`, `JobFieldConfidence`, `WorkMode`, `VerificationStatus`
- `sources/jobSources.ts` — Host-pattern source detection (SEEK, Indeed, Jora) and source reliability profiles
- `jobRanking.ts` — Hard constraint filters (location, workMode, maxSalary, excludeTitles) + weighted composite scoring
- `jobDedup.ts` — Three-layer dedup: exact URL, source+jobId, company+title

**Semantic pipeline** (`src/tools/semanticCrawl.ts` + `src/chunking.ts` + `src/utils/`):

1. Corpus ingestion: crawl pages via Crawl4AI → strip cookie banners → `chunkMarkdown()` (400-token max, 20% overlap, atomic units for code blocks/tables, boilerplate heuristics)
2. Embedding: batched document embeddings via sidecar (max 512/batch, document/query asymmetric, title-aware). Query embedded in parallel.
3. Hybrid ranking: bi-encoder cosine → BM25+ (`src/utils/bm25.ts`) → RRF fusion via `src/rag/pipeline.ts` (internal `retrieveSemanticChunks()` wrapper)
4. Post-filtering: semantic coherence filter (centroid similarity for borderline chunks) → soft IDF-weighted lexical constraint (`src/utils/lexicalConstraint.ts`)
5. Optional cross-encoder reranking (`src/utils/rerank.ts`, ONNX-based, local, default off)
6. Corpus cache (`src/utils/corpusCache.ts`): 24h TTL, max 50 corpora, stores chunks + embeddings + BM25 index. Re-query via `source: { type: 'cached', corpusId }`.

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
- `corpusCache.ts` — In-process corpus store (chunks + embeddings + BM25 index)
- `lexicalConstraint.ts` — IDF-weighted soft token coverage constraint
- `githubCorpus.ts` — GitHub API → document corpus converter
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
- Corpus cache is in-process only (no persistence across server restarts); the `cached` source type only works within the same server process lifetime
