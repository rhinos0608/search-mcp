# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP (Model Context Protocol) server that exposes web search, web reading, GitHub, YouTube, Reddit, Twitter/X, Product Hunt, patent, podcast, academic research, Hacker News, Stack Overflow, npm, PyPI, and news tools over stdio JSON-RPC. Clients like Claude Desktop or the Claude CLI connect via stdin/stdout; all logging goes to stderr.

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
- `web_search` — Multi-backend search with fallback chain: primary backend (configured) → remaining backend. Supports Brave and SearXNG.
- `web_read` — Fetches a URL and extracts article content via Mozilla Readability + jsdom.
- `github_repo` — GitHub API (unauthenticated) for repo metadata, latest release, optional README.
- `github_trending` — Scrapes github.com/trending with cheerio (no API).
- `youtube_transcript` — Fetches video captions via youtube-transcript library.
- `reddit_search` — Reddit search via shared Reddit transport (`src/tools/redditClient.ts`): public JSON API by default, OAuth (`oauth.reddit.com`) when `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` are both set.
- `reddit_comments` — Fetches a Reddit post plus a normalized comment tree via the same shared transport. Supports `url` / `permalink` / `subreddit`+`article` locators, focused subthreads via `comment`+`context`, and `sort` / `depth` / `limit` / `showMore` controls.
- `twitter_search` — Searches Twitter/X via a configurable Nitter instance (cheerio scraping). Requires `NITTER_BASE_URL`.
- `producthunt_search` — Product Hunt search via GraphQL API (with `PRODUCTHUNT_API_TOKEN`) or public leaderboard scraping fallback.
- `patent_search` — USPTO PatentsView API for US patent search. Requires `PATENTSVIEW_API_KEY` (free registration).
- `podcast_search` — ListenNotes API for podcast episode search. Requires `LISTENNOTES_API_KEY`.
- `academic_search` — ArXiv API + Semantic Scholar API for academic paper search (free, no auth). Supports searching either or both with merged/deduplicated results.
- `hackernews_search` — HN Algolia API for searching stories/comments (free, no auth). Supports type filtering, sort by relevance/date, and date range.
- `youtube_search` — YouTube Data API v3 for video discovery. Returns video IDs + metadata. Requires `YOUTUBE_API_KEY`. Pairs with `youtube_transcript`.
- `arxiv_search` — Fast direct ArXiv-only search with full date range filtering via `submittedDate`. Supports category filtering. Faster than `academic_search` for ArXiv-only queries.
- `stackoverflow_search` — Stack Exchange API for searching questions. Supports tag filtering and accepted-answer filtering. Optional `STACKEXCHANGE_API_KEY` for higher rate limits.
- `npm_search` — npm registry search API (free, no auth). Returns packages with metadata, scores, and repository links.
- `pypi_search` — PyPI search via HTML scraping (cheerio) with top-result enrichment from PyPI JSON API (free, no auth).
- `news_search` — GDELT Global Knowledge Graph API for news articles (free, no auth). Supports date range filtering and language selection.

**Config resolution** (`src/config.ts`): encrypted file (`config.enc` + `SEARCH_MCP_CONFIG_KEY` env var) → individual env vars (`BRAVE_API_KEY`, `SEARXNG_BASE_URL`, `SEARCH_BACKEND`, `NITTER_BASE_URL`, `LISTENNOTES_API_KEY`, `PRODUCTHUNT_API_TOKEN`, `PATENTSVIEW_API_KEY`, `YOUTUBE_API_KEY`, `STACKEXCHANGE_API_KEY`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`) → defaults. Config is cached after first load. Reddit OAuth is optional: both `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` must be set to enable the OAuth path; setting exactly one is treated as invalid configuration (server starts, health reports degraded, Reddit tools throw `VALIDATION_ERROR` at first use).

**HTTP safety** (`src/httpGuards.ts`): SSRF protection (blocks private IPs, localhost, cloud metadata endpoints) and 10MB response size limits. All outbound HTTP in tools should use `assertSafeUrl` and `safeResponseText`/`safeResponseJson`.

**Tool response pattern**: Every tool handler wraps results in `ToolResult<T>` (data + meta with tool name, duration, timestamp), then returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }`. Errors return `isError: true` with a sanitized (no stack trace) message.

## Key Constraints

- TypeScript strict mode with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- ESM-only (`"type": "module"` in package.json), all local imports need `.js` extension
- Zod v4 imported as `zod/v4`
- youtube-transcript has a broken ESM export; the workaround imports directly from `youtube-transcript/dist/youtube-transcript.esm.js` with `@ts-expect-error`
- `config.json` and `config.enc` are gitignored — never commit API keys
