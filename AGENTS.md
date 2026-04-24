# AGENTS.md

> **Version: 2.0.0** — Semantic overhaul: RAG pipeline, embedding sidecar, hybrid ranking, corpus cache, GitHub corpus adapter, structured crawl extraction.

This file provides guidance to AI coding agents (Codex, OpenCode, etc.) when working with code in this repository.

## What This Is

An MCP (Model Context Protocol) server that exposes web search, web reading, deep crawling, **semantic RAG search**, GitHub (repo, file, tree, search, corpus), YouTube, Reddit, Twitter/X, Product Hunt, patent, podcast, academic research, Hacker News, Stack Overflow, npm, PyPI, and news tools over stdio JSON-RPC. Clients connect via stdin/stdout; all logging goes to stderr.

V2.0.0 adds a full retrieval pipeline: Crawl4AI-powered deep crawling → markdown chunking → embedding sidecar (document/query asymmetric) → BM25+ full-text index → RRF hybrid fusion → optional cross-encoder reranking → corpus cache. The `semantic_crawl` tool is the primary entry point; `github_repo_file`, `github_repo_search`, `github_repo_tree`, and `web_crawl` are supporting tools.

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
- `semantic_crawl` — Full RAG pipeline over a crawled corpus. Source types: `url`, `sitemap`, `search`, `github`, `cached`. Returns top-K semantically ranked chunks with bi-encoder, BM25, and RRF scores. Requires `CRAWL4AI_BASE_URL` + `EMBEDDING_SIDECAR_BASE_URL`.

_GitHub_
- `github_repo` — Repo metadata, latest release, optional README.
- `github_repo_file` — Fetch raw content of a specific file from a GitHub repo.
- `github_repo_search` — Search GitHub repos by query string.
- `github_repo_tree` — Browse the directory tree of a GitHub repo at a given ref/path.
- `github_trending` — Scrapes github.com/trending.

_Video & Social_
- `youtube_search` — YouTube Data API v3. Requires `YOUTUBE_API_KEY`. Pairs with `youtube_transcript`.
- `youtube_transcript` — Fetches video captions via youtube-transcript library.
- `reddit_search` — Reddit search (public JSON API or OAuth).
- `reddit_comments` — Reddit post + normalized comment tree.
- `twitter_search` — Searches Twitter/X via Nitter (cheerio). Requires `NITTER_BASE_URL`.

_Research & Discovery_
- `academic_search` — ArXiv + Semantic Scholar (merged, deduplicated).
- `arxiv_search` — ArXiv-only, faster, supports `submittedDate` + category filtering.
- `hackernews_search` — HN Algolia API.
- `stackoverflow_search` — Stack Exchange API.
- `news_search` — GDELT Global Knowledge Graph API.

_Packages & Products_
- `npm_search` — npm registry search.
- `pypi_search` — PyPI search via HTML scraping + JSON API enrichment.
- `producthunt_search` — Product Hunt via GraphQL or public leaderboard.

_Specialist_
- `patent_search` — USPTO PatentsView API. Requires `PATENTSVIEW_API_KEY`.
- `podcast_search` — ListenNotes API. Requires `LISTENNOTES_API_KEY`.

**Config resolution** (`src/config.ts`): encrypted file (`config.enc` + `SEARCH_MCP_CONFIG_KEY`) → individual env vars → defaults. Config is cached after first load.

Key env vars: `BRAVE_API_KEY`, `SEARXNG_BASE_URL`, `SEARCH_BACKEND`, `NITTER_BASE_URL`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`, `LISTENNOTES_API_KEY`, `PRODUCTHUNT_API_TOKEN`, `PATENTSVIEW_API_KEY`, `YOUTUBE_API_KEY`, `STACKEXCHANGE_API_KEY`, `CRAWL4AI_BASE_URL`, `CRAWL4AI_API_TOKEN`, `EMBEDDING_SIDECAR_BASE_URL`, `EMBEDDING_SIDECAR_API_TOKEN`, `EMBEDDING_DIMENSIONS`.

Reddit OAuth requires both `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` — setting exactly one is invalid (health reports degraded, tools throw at first use).

**Semantic pipeline** (`src/tools/semanticCrawl.ts` + `src/chunking.ts` + `src/utils/`):
1. Crawl pages → strip cookie banners → `chunkMarkdown()` (400-token max, 20% overlap, atomic units for code/tables, boilerplate heuristics)
2. Batch embed documents via sidecar (max 512/batch, asymmetric document/query mode)
3. BM25+ index + bi-encoder cosine → RRF fusion → semantic coherence filter → soft lexical constraint
4. Optional cross-encoder reranking (ONNX, local, default off)
5. Corpus cache: 24h TTL, max 50 corpora, stores chunks + embeddings + BM25 index

GitHub corpus: fetches files via GitHub API, chunks with path-prefixed sections. Code-aware path filter by extension.

**Sidecar services** (`sidecar/`):
- `sidecar/embedding/` — Python FastAPI server exposing `POST /embed`.
- `sidecar/openai-embedding-proxy/` — OpenAI-compatible proxy routing `/v1/embeddings` to the sidecar.

**HTTP safety** (`src/httpGuards.ts`): SSRF protection and 10MB response limits. Use `assertSafeUrl` and `safeResponseText`/`safeResponseJson` for all outbound HTTP. Sidecar URLs bypass SSRF guards (operator-configured).

**Tool response pattern**: Every handler wraps in `ToolResult<T>` (data + meta), returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }`. Errors: `isError: true` with sanitized message (no stack trace).

## Key Constraints

- TypeScript strict mode: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- ESM-only (`"type": "module"`), all local imports need `.js` extension
- Zod v4 imported as `zod/v4`
- youtube-transcript broken ESM: import directly from `youtube-transcript/dist/youtube-transcript.esm.js` with `@ts-expect-error`
- `config.json` and `config.enc` are gitignored — never commit API keys
- `rerank.ts` and `githubCorpus.ts` are dynamically imported — do not add static imports
- Corpus cache is in-process only; `cached` source type only works within the same server process lifetime
