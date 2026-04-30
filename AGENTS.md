# AGENTS.md

> **Version: 3.2.0** — Search MCP server. Keep stdout JSON-RPC only; log to stderr.

Guidance for AI coding agents working in this repository.

## Purpose

MCP server over stdio exposing web search/read/extract/crawl, semantic RAG, GitHub, YouTube, Reddit, Twitter/X, Product Hunt, patents, podcasts, academic research, Hacker News, Stack Overflow, npm, PyPI, jobs, and news tools.

Core RAG flow: corpus ingestion → chunking → embeddings → BM25+ → RRF fusion → top-K retrieval. Shared modules live in `src/rag/`.

## Commands

```bash
npm run dev              # hot-reload dev server
npm run build            # compile TypeScript to dist/
npm start                # run compiled server
npm run dev:json         # dev with JSON logging
npm run start:json       # production with JSON logging
npm run lint             # ESLint
npm run lint:fix         # ESLint autofix
npm run format           # Prettier write
npm run format:check     # Prettier check
npm run typecheck        # tsc --noEmit
npm run config:encrypt   # config.json -> config.enc
npm run config:decrypt   # config.enc -> config.json
```

## Architecture

- `src/server.ts` registers 29 tools inline with Zod schemas via `server.registerTool()` and delegates to `src/tools/*`.
- `src/index.ts` Entry point. Creates `McpServer`, attaches `StdioServerTransport`, calls `server.connect()`.
- `src/logger.ts` routes pino logs to stderr. Never write non-JSON-RPC output to stdout.
- `src/config.ts` resolves config in this order: encrypted config → env vars → defaults, then caches it.
- Tool handlers return `ToolResult<T>` as JSON text content. Errors are sanitized and returned with `isError: true`.

## Main Tools (29 total)

### Search/Read/Crawl
- `web_search`: Exa, Brave, or SearXNG with fallback chain.
- `web_read`: fetch URL and extract readable article content.
- `web_crawl`: Crawl4AI multi-page crawl; timeout = `30s + 15s * maxPages`, capped at 5 min.
- `semantic_crawl`: primary crawl RAG entry point. Supports `url`, `sitemap`, `search`, `github`, and `cached` sources.

### Semantic/RAG
- `semantic_youtube`: YouTube search + transcripts + RAG.
- `semantic_reddit`: Reddit search/comments + RAG; filters deleted/removed comments.
- `semantic_jobs`: job search/extraction for SEEK, Indeed, Jora with dedup, constraints, and weighted ranking.
- `semantic_github_code`: AST-aware GitHub code search using lazy-loaded tree-sitter WASM grammars; defaults to `lexical-heavy`.

### GitHub
- `github_repo`, `github_repo_file`, `github_repo_search`, `github_repo_tree`, `github_trending`.

### Video/Social
- `youtube_search`, `youtube_transcript`, `reddit_search`, `reddit_comments`, `twitter_search`.

### Research/Discovery
- `academic_search`, `arxiv_search`, `hackernews_search`, `stackoverflow_search`.

### Packages/Products
- `npm_search`, `pypi_search`, `producthunt_search`, `patent_search`, `podcast_search`.

### System
- `health_check`: verify server status, config health, backend connectivity.

## RAG Modules

`src/rag/` contains the reusable retrieval system:

- `types.ts`: shared RAG types.
- `pipeline.ts`: `prepareCorpus`, `retrieveCorpus`, `prepareAndRetrieve`.
- `embedding.ts`: embedding provider dispatch (sidecar, ollama, transformers, openai).
- `profiles.ts`: retrieval profiles including `balanced`, `lexical-heavy`, `semantic-heavy`, `high-precision`, `fast`, `precision`, `recall`.
- `adapters/text.ts`: crawl pages to chunks.
- `adapters/transcript.ts`: YouTube transcripts to chunks.
- `adapters/conversation.ts`: Reddit comment trees to chunks.
- `adapters/job.ts`: HTML to structured job listings.
- `adapters/code.ts`: source files to AST-aware code chunks.
- `code/*`: language detection, tree-sitter loading, symbol extraction.
- `dedup.ts`: three-layer deduplication (URL, source+id, company+title).
- `constraints.ts`: hard + soft constraint filtering for job search.
- `metrics.ts`: counters, histograms, gauges for observability.
- `instrumentation.ts`: tracing spans, run tracking, pipeline wrappers.
- `fusion.ts`: RRF + weighted linear fusion.
- `rerank.ts`: optional cross-encoder reranking (ONNX, dynamically imported).
- `corpusCache.ts`: SQLite-backed persistent corpus cache.
- `jobRanking.ts`, `jobDedup.ts`, `types/job.ts`, `sources/jobSources.ts`: job search support.

## Embedding Providers

Provider selection via `EMBEDDING_PROVIDER` env var (default `sidecar`):

| Provider | Description | Required Env Vars |
|---|---|---|
| `sidecar` | FastAPI embedding sidecar | `EMBEDDING_SIDECAR_BASE_URL` |
| `ollama` | Ollama local server | `EMBEDDING_OLLAMA_BASE_URL` (default http://localhost:11434) |
| `transformers` | Transformers.js in-process | — |
| `openai` | OpenAI-compatible API | `EMBEDDING_OPENAI_API_KEY` |

Code search may use `EMBEDDING_CODE_MODEL` for a code-tuned model endpoint.

## Semantic Crawl Pipeline

`semantic_crawl` combines:

1. Crawl via Crawl4AI.
2. Strip cookie banners.
3. Chunk markdown with `chunkMarkdown()` using ~400-token chunks, 20% overlap, and atomic handling for code blocks/tables.
4. Enforce response-size safety via `src/utils/crawlBudget.ts`: preflight `maxPages` cap plus in-flight byte accumulator. Warnings appear as `SemanticCrawlWarning` (typed union with `code` field) in `structuredWarnings`.
5. Embed documents and query through the configured embedding provider.
6. Rank with cosine similarity, BM25+, and RRF.
7. Apply semantic coherence and soft lexical constraints.
8. Optionally cross-encoder rerank through `src/utils/rerank.ts` (ONNX, dynamically imported).
9. Cache corpora persistently in SQLite; re-query with `source: { type: 'cached', corpusId }`.

## Config / Env Vars

```bash
# Search (at least one required)
EXA_API_KEY
BRAVE_API_KEY
SEARXNG_BASE_URL
SEARCH_BACKEND            # 'brave' | 'searxng' | 'exa'

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
GITHUB_TOKEN

# Crawl
CRAWL4AI_BASE_URL
CRAWL4AI_API_TOKEN

# Embedding
EMBEDDING_PROVIDER           # 'sidecar' | 'ollama' | 'transformers' | 'openai'
EMBEDDING_SIDECAR_BASE_URL
EMBEDDING_SIDECAR_API_TOKEN
EMBEDDING_DIMENSIONS        # default 768
EMBEDDING_CODE_MODEL        # optional code-tuned embedding model

# LLM (for contextual embeddings — OpenAI-compatible endpoint, API key optional)
LLM_PROVIDER                # model name (e.g. 'gpt-4o-mini', 'llama3'), passed as-is to /v1/chat/completions
LLM_API_TOKEN               # optional — omit for local servers without auth
LLM_BASE_URL                # base URL for /v1/chat/completions (required)

# Security (V3.3.0 — all opt-in, off by default)
DOMAIN_TRUST_ENABLED        # 'true' | 'false' (default: false)
TRUSTED_DOMAINS             # comma-separated trusted domains
BLOCKED_DOMAINS             # comma-separated blocked domains
SCRUB_CONTENT               # 'true' | 'false' (default: false)

# RAG-Anything Bridge (multimodal document extraction)
RAGA_ENABLED                # 'true' | 'false' (default: false)
RAGA_BRIDGE_URL             # default http://localhost:8000
RAGA_DEFAULT_PARSER         # 'auto' | 'docling' | 'paddleocr' | 'mineru'
RAGA_TIMEOUT_MS             # default 30000

# Persistence
DATABASE_PATH               # default under ~/.cache/search-mcp/semantic-crawl/
```

Reddit OAuth is optional, but `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` must be set together. If only one is present, config is degraded and Reddit tools throw `VALIDATION_ERROR` when used.

## Sidecars & Services

- `sidecar/embedding/`: FastAPI embedding service exposing `POST /embed` with `{ texts, mode, dimensions }`.
- `sidecar/openai-embedding-proxy/`: OpenAI-compatible embeddings proxy to the sidecar.
- `services/rag-anything-bridge/`: Python FastAPI bridge for multimodal document extraction (PDFs, Office, scanned docs) via Docling, PaddleOCR, MinerU.

## HTTP / Safety

- Use `src/httpGuards.ts` for outbound HTTP: `assertSafeUrl`, `safeResponseText`, `safeResponseJson`.
- SSRF guard blocks private IPs, localhost, and cloud metadata endpoints.
- Default HTTP response size limit is 10MB.
- Embedding sidecar and RAGA bridge URLs bypass SSRF guards because they come from operator config, not user input.
- Never commit `config.json`, `config.enc`, or API keys.
- `config.example.json` is a template showing all available config fields.
  Copy it to `config.json` and fill in your values.

## Docker Deployment

```bash
docker compose up -d
# Full stack: search-mcp + Crawl4AI + embedding sidecar + SearXNG
```

## Evaluation Framework

`src/eval/` provides a golden-query evaluation harness:

- Golden query datasets covering academic, general, job, and QA domains
- Scoring: precision, recall, nDCG
- Runner script for batch evaluation
- Test suite for evaluation components

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
- Adapter types include `job`, `code`, `text`, `transcript`, `conversation`.
- Structured warnings use typed union codes (`SemanticCrawlWarning`), not strings.
