# search-mcp Context

> MCP server over stdio. All JSON-RPC goes to stdout; all logging goes to stderr.

## Architecture

**Transport:** stdio only via `@modelcontextprotocol/sdk` `StdioServerTransport`.
**No HTTP server.** No Fastify/no Express. stdout = JSON-RPC frames only.

```
AI client (Claude Desktop / claude CLI)
  │  JSON-RPC → stdin
  │  JSON-RPC ← stdout
  │  log output ← stderr (pino)
  ▼
search-mcp process
```

## Entry & Server

| File | Role |
|------|------|
| `src/index.ts` | CLI entry. Creates `McpServer`, attaches `StdioServerTransport`, calls `server.connect()`. |
| `src/server.ts` | `createServer()` — instantiates `McpServer` and calls `server.registerTool()` for all 28 tools. |
| `src/logger.ts` | pino — writes all log output to `process.stderr`. |
| `src/config.ts` | Config resolution: encrypted file → env vars → defaults. Cached after first load. |

## Tools (28)

| Category | Tools |
|---|---|
| **Web** | `web_search`, `web_read`, `web_crawl` |
| **GitHub** | `github_repo`, `github_repo_file`, `github_repo_search`, `github_repo_tree`, `github_trending`, `semantic_github_code` |
| **Video** | `youtube_search`, `youtube_transcript`, `semantic_youtube` |
| **Social** | `reddit_search`, `reddit_comments`, `twitter_search` |
| **Research** | `academic_search`, `arxiv_search`, `hackernews_search`, `stackoverflow_search` |
| **Packages** | `npm_search`, `pypi_search` |
| **Products** | `producthunt_search`, `patent_search`, `podcast_search` |
| **Semantic** | `semantic_crawl`, `semantic_jobs`, `semantic_reddit` |
| **System** | `health_check` |

Each tool registered via `server.registerTool(name, schema, handler)`. Input validation via Zod v4 (`zod/v4`). Handler returns `ToolResult<T>` serialized as JSON text content. Errors return `isError: true`.

## Config & Env Vars

Resolution: encrypted config file (`config.enc`) → individual env vars → defaults.

### Search (at least one required)
`SEARXNG_BASE_URL`, `BRAVE_API_KEY`, `EXA_API_KEY`, `SEARCH_BACKEND`

### Embedding (choose one provider)
`EMBEDDING_PROVIDER` (`sidecar`|`ollama`|`transformers`|`openai`, default `sidecar`)

| Provider | Vars |
|---|---|
| `sidecar` | `EMBEDDING_SIDECAR_BASE_URL`, `EMBEDDING_SIDECAR_API_TOKEN`, `EMBEDDING_DIMENSIONS` (default `768`) |
| `ollama` | `EMBEDDING_OLLAMA_BASE_URL` (default `http://localhost:11434`), `EMBEDDING_OLLAMA_MODEL` (default `nomic-embed-text`) |
| `transformers` | `EMBEDDING_TRANSFORMERS_MODEL` (default `Xenova/all-MiniLM-L6-v2`) |
| `openai` | `EMBEDDING_OPENAI_BASE_URL` (default `https://api.openai.com/v1`), `EMBEDDING_OPENAI_MODEL` (default `text-embedding-3-small`), `EMBEDDING_OPENAI_API_KEY` |

### Crawl
`CRAWL4AI_BASE_URL`, `CRAWL4AI_API_TOKEN`

### Social / Video
`YOUTUBE_API_KEY`, `NITTER_BASE_URL`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`

### Specialist
`LISTENNOTES_API_KEY`, `PRODUCTHUNT_API_TOKEN`, `PATENTSVIEW_API_KEY`, `STACKEXCHANGE_API_KEY`, `GITHUB_TOKEN`

### RAG-Anything Bridge
`RAGA_ENABLED`, `RAGA_BRIDGE_URL` (default `http://localhost:8000`), `RAGA_DEFAULT_PARSER` (`auto`|`docling`|`paddleocr`|`mineru`), `RAGA_TIMEOUT_MS` (default `30000`)

### Persistence
`DATABASE_PATH` (default `~/.cache/search-mcp/semantic-crawl/`)

## RAG Pipeline (`src/rag/`)

Core flow: **chunk → embed → BM25+ → RRF → top-K**

- `pipeline.ts` — `prepareCorpus()`, `retrieveCorpus()`, `prepareAndRetrieve()`
- `embedding.ts` — batched embedding client dispatches to configured provider
- `profiles.ts` — `balanced`, `lexical-heavy`, `semantic-heavy`, `high-precision`, `fast`, `precision`, `recall`
- `adapters/` — `text.ts` (web pages), `transcript.ts` (YouTube), `conversation.ts` (Reddit), `job.ts` (listings), `code.ts` (AST-aware)
- `code/` — language detection, lazy tree-sitter WASM grammars, symbol extraction
- `dedup.ts`, `constraints.ts`, `fusion.ts`, `rerank.ts`
- `metrics.ts` — counters, histograms, gauges
- `instrumentation.ts` — tracing spans, timed wrappers

## Utilities (`src/utils/`)

`bm25.ts`, `fusion.ts`, `rerank.ts` (ONNX cross-encoder), `corpusCache.ts` (SQLite), `crawlBudget.ts`, `githubCorpus.ts`, `lexicalConstraint.ts`, `sitemap.ts`, `url.ts`, `cookieBanner.ts`, `rescore.ts`, `extractionConfig.ts`, `extractionQuality.ts`, `llmSummarizer.ts`, `ragAnythingClient.ts` (TypeScript bridge client), `smartExtraction.ts`, `semanticResponse.ts`, `embedding.ts` (dispatch), `ollamaEmbedding.ts`, `transformersEmbedding.ts`, `renderRecovery.ts`

## HTTP Safety (`src/httpGuards.ts`)

- `assertSafeUrl()` — blocks private IPs, localhost, cloud metadata
- `safeResponseText()` / `safeResponseJson()` — enforces 10MB response size limit
- Sidecar/bridge URLs (operator-configured) bypass SSRF guards

## Sidecars

- `sidecar/embedding/` — FastAPI local embedding service
- `sidecar/openai-embedding-proxy/` — OpenAI-compatible proxy to sidecar
- `services/rag-anything-bridge/` — Python bridge for multimodal document extraction (PDFs, Office, scanned docs)

## Error Handling

- Unexpected errors → JSON-RPC protocol-level error (code + message)
- Expected tool errors → `isError: true` + sanitized message in content
- Errors are loud (never silently swallowed)

## Key Constraints

- TypeScript strict mode + `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- ESM-only, local imports with `.js` extension
- Zod v4 from `zod/v4`
- `youtube-transcript` imported from ESM workaround path with `@ts-expect-error`
- `rerank.ts` and `githubCorpus.ts` dynamically imported for fast startup
- Corpus cache is persistent SQLite, survives restarts
