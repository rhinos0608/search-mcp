# AGENTS.md

> **Version: 3.1.1** — Search MCP server. Keep stdout JSON-RPC only; log to stderr.

Guidance for AI coding agents working in this repository.

## Purpose

MCP server over stdio exposing web search/read/extract/crawl, semantic RAG, GitHub, YouTube, Reddit, Twitter/X, Product Hunt, patents, podcasts, academic research, Hacker News, Stack Overflow, npm, PyPI, jobs, and news tools.

Core RAG flow: corpus ingestion → chunking → embeddings → BM25+ → RRF fusion → top-K retrieval. Shared modules live in `src/rag/`.

## Commands

```bash
npm run dev              # hot-reload dev server
npm run build            # compile TypeScript to dist/
npm start                # run compiled server
npm run lint             # ESLint
npm run lint:fix         # ESLint autofix
npm run format           # Prettier write
npm run format:check     # Prettier check
npm run typecheck        # tsc --noEmit
npm run config:encrypt   # config.json -> config.enc
npm run config:decrypt   # config.enc -> config.json
```

Use `dev:json` / `start:json` for structured JSON logging.

## Architecture

- `src/server.ts` registers tools inline with Zod schemas and delegates to `src/tools/*`.
- `src/logger.ts` routes pino logs to stderr. Never write non-JSON-RPC output to stdout.
- `src/config.ts` resolves config in this order: encrypted config → env vars → defaults, then caches it.
- Tool handlers return `ToolResult<T>` as JSON text content. Errors are sanitized and returned with `isError: true`.

## Main Tools

Search/read/crawl:

- `web_search`: Exa, Brave, or SearXNG with fallback chain.
- `web_read`: fetch URL and extract readable article content.
- `web_extract`: extract structured data from a URL using a Zod schema or natural language description.
- `web_crawl`: Crawl4AI multi-page crawl; timeout = `30s + 15s * maxPages`, capped at 5 min.
- `semantic_crawl`: primary crawl RAG entry point. Supports `url`, `sitemap`, `search`, `github`, and `cached` sources.

Semantic/RAG tools:

- `semantic_youtube`: YouTube search + transcripts + RAG.
- `semantic_reddit`: Reddit search/comments + RAG; filters deleted/removed comments.
- `semantic_jobs`: job search/extraction for SEEK, Indeed, Jora with dedup, constraints, and weighted ranking.
- `semantic_github_code`: AST-aware GitHub code search using lazy-loaded tree-sitter WASM grammars; defaults to `lexical-heavy`.

GitHub:

- `github_repo`, `github_repo_file`, `github_repo_search`, `github_repo_tree`, `github_trending`.

Video/social:

- `youtube_search`, `youtube_transcript`, `reddit_search`, `reddit_comments`, `twitter_search`.

Research/discovery:

- `academic_search`, `arxiv_search`, `hackernews_search`, `stackoverflow_search`, `news_search`.

Packages/products/specialist:

- `npm_search`, `pypi_search`, `producthunt_search`, `patent_search`, `podcast_search`.

## RAG Modules

`src/rag/` contains the reusable retrieval system:

- `types.ts`: shared RAG types.
- `pipeline.ts`: `prepareCorpus`, `retrieveCorpus`, `prepareAndRetrieve`.
- `embedding.ts`: sidecar embedding client and batching.
- `profiles.ts`: retrieval profiles including `balanced`, `lexical-heavy`, `semantic-heavy`, `high-precision`, `fast`, `precision`, `recall`.
- `adapters/text.ts`: crawl pages to chunks.
- `adapters/transcript.ts`: YouTube transcripts to chunks.
- `adapters/conversation.ts`: Reddit comment trees to chunks.
- `adapters/job.ts`: HTML to structured job listings.
- `adapters/code.ts`: source files to AST-aware code chunks.
- `code/*`: language detection, tree-sitter loading, symbol extraction.
- `jobRanking.ts`, `jobDedup.ts`, `types/job.ts`, `sources/jobSources.ts`: job search support.

## Semantic Crawl Pipeline

`semantic_crawl` combines:

1. Crawl via Crawl4AI.
2. Strip cookie banners.
3. Chunk markdown with `chunkMarkdown()` using ~400-token chunks, 20% overlap, and atomic handling for code blocks/tables.
4. Enforce response-size safety via `src/utils/crawlBudget.ts`: preflight `maxPages` cap plus in-flight byte accumulator. Warnings appear as `SemanticCrawlSizeWarning` in `structuredWarnings`.
5. Embed documents and query through the sidecar.
6. Rank with cosine similarity, BM25+, and RRF.
7. Apply semantic coherence and soft lexical constraints.
8. Optionally cross-encoder rerank through `src/utils/rerank.ts`.
9. Cache corpora persistently in SQLite; re-query with `source: { type: 'cached', corpusId }`.

## Config / Env Vars

Important env vars:

```bash
# Search
EXA_API_KEY
BRAVE_API_KEY
SEARXNG_BASE_URL
SEARCH_BACKEND

# Social/video
NITTER_BASE_URL
REDDIT_CLIENT_ID
REDDIT_CLIENT_SECRET
REDDIT_USER_AGENT
YOUTUBE_API_KEY

# Specialist/research
LISTENNOTES_API_KEY
PRODUCTHUNT_API_TOKEN
PATENTSVIEW_API_KEY
STACKEXCHANGE_API_KEY

# Crawl / embedding
CRAWL4AI_BASE_URL
CRAWL4AI_API_TOKEN
EMBEDDING_SIDECAR_BASE_URL
EMBEDDING_SIDECAR_API_TOKEN
EMBEDDING_DIMENSIONS        # default 768
EMBEDDING_CODE_MODEL        # optional for code search

# Persistence
DATABASE_PATH               # default under ~/.cache/search-mcp/semantic-crawl/
```

Reddit OAuth is optional, but `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` must be set together. If only one is present, config is degraded and Reddit tools throw `VALIDATION_ERROR` when used.

## Sidecars

- `sidecar/embedding/`: FastAPI embedding service exposing `POST /embed` with `{ texts, mode, dimensions }`.
- `sidecar/openai-embedding-proxy/`: OpenAI-compatible embeddings proxy to the sidecar.

## HTTP / Safety

- Use `src/httpGuards.ts` for outbound HTTP: `assertSafeUrl`, `safeResponseText`, `safeResponseJson`.
- SSRF guard blocks private IPs, localhost, and cloud metadata endpoints.
- Default HTTP response size limit is 10MB.
- Embedding sidecar URLs bypass SSRF guards because they come from operator config, not user input.
- Never commit `config.json`, `config.enc`, or API keys.

## Commit Style

```
feat(rag): add persistent corpus cache
fix(crawl): enforce page budget before extraction
fix(security): block SSRF targets in smart extraction
docs(roadmap): align v3.1 plan
test(jobs): cover source normalization
refactor(server): split tool registration
chore(release): tag v3.1.5
```

- Use [Conventional Commits](https://www.conventionalcommits.org/).
- Scopes name the subsystem, not the release version.
- Keep subjects imperative and under ~72 characters.
- Mention user-visible behavior in the body when relevant.
- Use `fix(security)` for security-sensitive hardening.
- Tag releases with `chore(release): tag vX.Y.Z`.
- Squash noisy fixups (typo, lint-only, "oops missed file", broken intermediates).
- Keep meaningful fixes visible — correctness, security, and regression fixes.

## Key Constraints

- TypeScript strict mode with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, and `noUnusedParameters`.
- ESM-only package. Local imports need `.js` extensions.
- Import Zod v4 from `zod/v4`.
- `youtube-transcript` needs the direct ESM import workaround from `youtube-transcript/dist/youtube-transcript.esm.js` with `@ts-expect-error`.
- `rerank.ts` and `githubCorpus.ts` are dynamically imported to keep startup fast.
- Corpus cache is persistent SQLite and survives server restarts.
