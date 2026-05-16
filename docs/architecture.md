# Architecture

## What is MCP?

Model Context Protocol (MCP) is an open standard that lets AI assistants (clients) call external tools and access resources through a defined JSON-RPC interface. An MCP server exposes a set of named tools; the client discovers them, sends structured call requests, and receives structured responses.

`search-mcp` is a stdio-transport MCP server. Communication follows this flow:

```
AI client (e.g. Claude Desktop, claude CLI)
    │
    │  JSON-RPC messages → stdin
    │  JSON-RPC messages ← stdout
    │  log output        ← stderr
    ▼
search-mcp process
```

The server never writes anything other than JSON-RPC frames to stdout. All logging is unconditionally routed to stderr so that log output never corrupts the protocol stream.

---

## Project Structure

```
search-mcp/
├── docs/                    # documentation
├── src/
│   ├── index.ts             # entry point, CLI flags, transport setup
│   ├── server.ts            # McpServer creation and tool registration
│   ├── logger.ts            # pino logger (always writes to stderr)
│   ├── types.ts             # shared TypeScript types
│   ├── chunking.ts          # markdown chunker (atomic code fences, boilerplate heuristics)
│   ├── rag/                 # shared retrieval pipeline
│   │   ├── types.ts         # RagChunk, PreparedCorpus, RetrievalResponse, etc.
│   │   ├── pipeline.ts      # prepareCorpus() + retrieveCorpus()
│   │   ├── embedding.ts     # multi-provider dispatch (sidecar, ollama, transformers, openai)
│   │   ├── profiles.ts      # named retrieval profiles (balanced, lexical-heavy, etc.)
│   │   ├── metrics.ts       # counters, histograms, gauges
│   │   ├── instrumentation.ts # tracing spans, pipeline wrappers
│   │   ├── dedup.ts         # three-layer dedup
│   │   ├── constraints.ts   # hard + soft constraint filtering
│   │   ├── fusion.ts        # RRF + weighted linear fusion
│   │   ├── rerank.ts        # cross-encoder reranking (ONNX)
│   │   ├── corpusCache.ts   # SQLite-backed corpus cache
│   │   ├── contextualEmbedding.ts # LLM-based chunk enrichment
│   │   ├── jobRanking.ts    # weighted composite job scoring
│   │   ├── jobDedup.ts      # three-layer job dedup
│   │   ├── lexicalConstraint.ts # IDF-weighted soft token coverage
│   │   ├── adapters/        # source-specific chunk converters
│   │   │   ├── text.ts      # web pages → RagChunk[]
│   │   │   ├── transcript.ts# YouTube segments → RagChunk[]
│   │   │   ├── conversation.ts # Reddit/HN threads → RagChunk[]
│   │   │   ├── job.ts       # job listing HTML → JobListingMvp[]
│   │   │   └── code.ts      # source files → RagChunk[] via tree-sitter AST
│   │   └── code/            # tree-sitter parser helpers
│   │       ├── languages.ts # extension/shebang → language detection
│   │       ├── treeSitter.ts# lazy WASM grammar loader
│   │       └── symbols.ts   # AST symbol extraction (functions, classes, methods)
│   ├── utils/               # standalone utilities
│   │   ├── bm25.ts          # BM25+ full-text index
│   │   ├── fusion.ts        # RRF merge across ranked lists
│   │   ├── rerank.ts        # cross-encoder reranking (ONNX, dynamically imported)
│   │   ├── corpusCache.ts   # SQLite-backed corpus cache
│   │   ├── githubCorpus.ts  # GitHub API file collector (dynamically imported)
│   │   ├── lexicalConstraint.ts # IDF-weighted soft token coverage
│   │   ├── cookieBanner.ts    # cookie-banner page detection
│   │   ├── crawlBudget.ts     # response-size budget (preflight + in-flight)
│   │   ├── sitemap.ts       # XML sitemap parser
│   │   ├── url.ts           # URL dedup
│   │   ├── rescore.ts       # score normalization
│   │   ├── embedding.ts     # provider dispatch
│   │   ├── ollamaEmbedding.ts # Ollama local embedding
│   │   ├── transformersEmbedding.ts # Transformers.js in-process
│   │   ├── domainTrust.ts          # domain reputation & typosquat detection
│   │   ├── elementHelpers.ts     # element utilities
│   │   ├── elementTruncation.ts  # truncation logic
│   │   ├── embedding.ts          # provider dispatch
│   │   ├── externalRecovery.ts   # Wayback Machine & Google Cache fallbacks
│   │   ├── extractionConfig.ts   # extraction config schema
│   │   ├── extractionQuality.ts  # quality thresholds
│   │   ├── extractionStats.ts    # self-improvement outcome tracking
│   │   ├── fusion.ts             # RRF merge across ranked lists
│   │   ├── githubCorpus.ts       # GitHub API file collector (dynamically imported)
│   │   ├── htmlElements.ts       # HTML element types
│   │   ├── lexicalConstraint.ts  # IDF-weighted soft token coverage
│   │   ├── llmSummarizer.ts      # LLM summarization
│   │   ├── markdownElements.ts   # markdown element types
│   │   ├── ollamaEmbedding.ts    # Ollama local embedding
│   │   ├── ragAnythingClient.ts  # RAG-Anything bridge client
│   │   ├── renderRecovery.ts     # placeholder content recovery
│   │   ├── rescore.ts            # score normalization
│   │   ├── searchMerge.ts        # cross-backend search result merging
│   │   ├── semanticResponse.ts   # response compaction
│   │   ├── sitemap.ts            # XML sitemap parser
│   │   ├── contentScrubber.ts      # threat detection & redaction
│   │   ├── smartExtraction.ts    # quality-based escalation
│   │   ├── transformersEmbedding.ts # Transformers.js in-process
│   │   └── url.ts                # URL dedup
│   └── tools/               # tool registration (26 tools: 10 standalone + 6 family + 10 KG)
│       ├── standalone/      # standalone tools
│       │   ├── webSearch.ts
│       │   ├── webRead.ts
│       │   ├── webCrawl.ts
│       │   ├── semanticCrawl.ts
│       │   ├── semanticCrawlListCorpora.ts
│       │   ├── semanticJobs.ts
│       │   ├── fetchFocus.ts
│       │   ├── semanticCrawlInspectCorpus.ts
│       │   └── healthCheck.ts
│       ├── families/        # family tools (action-discriminated)
│       │   ├── youtube.ts
│       │   ├── reddit.ts
│       │   ├── github.ts
│       │   ├── packages.ts
│       │   ├── research.ts
│       │   └── browser.ts
│       ├── deepResearch.ts  # job/poll protocol deep research
│       ├── graph-*.ts       # knowledge graph tools (opt-in)
│       ├── family-*.ts      # family management
│       ├── run-*.ts         # run management
│       ├── registry.ts      # registerFamily() helper
│       ├── response.ts      # shared response helpers
│       └── queryExpansion.ts # rule-based query variation generation
├── services/               # Python bridge services
│   └── rag-anything-bridge/  # multimodal document extraction
├── sidecar/                # local service sidecars
│   ├── embedding/          # FastAPI embedding server
│   └── openai-embedding-proxy/
├── eval/                   # evaluation framework
│   └── golden-queries/     # query datasets
├── docker-compose.yml      # full-stack deployment
├── Dockerfile              # container image
├── package.json
├── tsconfig.json
└── eslint.config.js
```

### `src/index.ts`

The process entry point. Responsibilities:

- Parse CLI flags (currently `--json`)
- Instantiate the pino logger with the appropriate formatter
- Create the `McpServer` (from `server.ts`)
- Attach a `StdioServerTransport` and call `server.connect(transport)`

### `src/server.ts`

Creates the `McpServer` instance (via `@modelcontextprotocol/sdk`) and registers every tool by calling each tool module's registration function. Keeping tool registration centralised here means `index.ts` stays thin and each tool file is independently testable.

### `src/logger.ts`

Wraps pino and forces all output to `process.stderr`. This module is imported by every part of the codebase that needs logging. Nothing else writes to stderr directly.

### `src/types.ts`

Shared TypeScript interfaces and type aliases used across tool files (e.g. result shapes, common option types). Centralising types here prevents circular imports and keeps tool files focused on logic.

### `src/rag/`

Shared retrieval pipeline for semantic tools. The pipeline separates corpus preparation from retrieval:

- adapters turn source documents into chunks (`text`, `transcript`, `conversation`, `job`, and `code`)
- `prepareCorpus()` builds a typed `PreparedCorpus`
- `retrieveCorpus()` runs BM25/vector fusion and returns ranked chunks with score details
- profiles such as `balanced`, `lexical-heavy`, `semantic-heavy`, and `high-precision` keep retrieval tuning stable at the API boundary
- `metrics.ts` provides counters, histograms, gauges with label support
- `instrumentation.ts` provides `spanSync`/`spanAsync` wrappers, run tracking, and `InstrumentedPipeline`
- `dedup.ts` implements three-layer dedup (exact URL, source+id, company+title)
- `constraints.ts` implements hard filter rules and constraint scoring

The code adapter lives under `src/rag/adapters/code.ts` with parser helpers under `src/rag/code/`. It uses lazy-loaded tree-sitter WASM grammars so non-code users do not pay parser startup cost. Supported code languages are TypeScript, JavaScript, Python, Go, and Rust; unsupported files fall back to text chunking.

Code retrieval defaults to `lexical-heavy` because identifiers, function names, and import paths are often more precise than prose-like semantic similarity. If `EMBEDDING_CODE_MODEL` is not configured, code tools warn that they are falling back to the prose embedding model. This warning is intentional: identifier searches remain useful through BM25, but conceptual code queries can degrade without a code-tuned embedding model.

### Embedding Providers

Embedding provider dispatch lives in `src/utils/embedding.ts`. Provider selection via `EMBEDDING_PROVIDER` env var (default `sidecar`):

- **`sidecar`** (default): FastAPI server at `sidecar/embedding/`, with OpenAI-compatible proxy at `sidecar/openai-embedding-proxy/`
- **`ollama`**: Local embeddings via `src/utils/ollamaEmbedding.ts`, defaults to `http://localhost:11434` with `nomic-embed-text`
- **`transformers`**: In-process ONNX embeddings via `src/utils/transformersEmbedding.ts`, no external service needed
- **`openai`**: OpenAI-compatible API via `src/utils/embedding.ts`, supports any OpenAI-compatible endpoint

### Docker Compose Deployment

Full-stack `docker-compose.yml` with four services:

- `search-mcp` — MCP server (port 8050 stdio HTTP proxy)
- `search-mcp-crawl4ai` — Crawl4AI browser service (port 8051)
- `search-mcp-embedding` — Embedding sidecar (host port 8001 mapped to container port 8000; `8001:8000` in `docker-compose.yml`)
- `search-mcp-searxng` — SearXNG meta-search (port 8081)

Start: `docker compose up -d`

### Evaluation Framework

`src/rag/__tests__/eval/` provides golden query datasets across academic, general, job, and QA domains. Supports precision/recall/nDCG scoring with a batch runner across retrieval profiles.

### `src/tools/`

Tool registration follows two patterns:
- **Standalone tools** (`standalone/`) — one file per tool, exports a `register*` function
- **Family tools** (`families/`) — one file per family, uses `registerFamily()` for action-discriminated tools (e.g. `youtube` with `search | transcript | semantic` actions)

Knowledge graph tools (`graph-*.ts`, `family-*.ts`, `run-*.ts`) are conditionally registered when `knowledgeGraph.enabled` is set.

Splitting tools into separate files keeps each file small, makes individual tools easy to find and modify, and avoids merge conflicts when multiple tools are developed in parallel.

---

## Shared Reddit Transport

Both `reddit_search` and `reddit_comments` route all HTTP through the shared client in `src/tools/redditClient.ts` (built by `createRedditClient`), which picks the transport based on config:

- **No credentials configured** (`REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` both unset): requests go to `https://www.reddit.com/... .json` with no `Authorization` header. Quota is Reddit's unauthenticated limit (~10 QPM, bot-detection-prone).
- **Both credentials configured**: the client uses the `client_credentials` grant against `https://www.reddit.com/api/v1/access_token`, caches the token in memory (see `src/tools/redditAuth.ts`), and routes content requests to `https://oauth.reddit.com/...` with `Authorization: bearer <token>`. A 401 mid-session clears the cached token and retries once. Quota is 100 QPM per app.
- **Partially configured** (exactly one of the two credentials set): the server still starts successfully. `loadConfig()` records `reddit.oauthConfigValid = false` and emits a `logger.warn`. `health_check` reports the synthesized `reddit_oauth` entry as `degraded` with remediation text. The first call to either Reddit tool throws `VALIDATION_ERROR` — there is no silent fallback to the public path when credentials are partial or broken.

Runtime OAuth failures (bad credentials, token refresh failure, content-request transport errors) surface as tool-local errors, never as startup crashes. The rate-limit tracker for the `reddit` backend is shared between `reddit_search` and `reddit_comments`, so a 429 observed by one tool gates subsequent calls from either.

---

## The `--json` Flag

By default (development mode), log lines are piped through `pino-pretty` so they are human-readable in a terminal:

```
[12:34:56.789] INFO  server: tool registered name=web_search
```

When `--json` is passed, pino emits raw newline-delimited JSON:

```json
{ "level": 30, "time": 1711234567890, "msg": "tool registered", "name": "web_search" }
```

Use `--json` in production or when feeding logs into a log aggregation system (Datadog, Loki, CloudWatch, etc.). The flag has no effect on the JSON-RPC protocol stream on stdout.

---

## Tool Response Shape

Every tool handler returns an object with two top-level keys:

```ts
{
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
}
```

- `content[0].text` — a JSON string. Required by the base MCP spec; all clients can read this.
- `structuredContent` — the same data as a plain object. MCP clients that support the structured-content extension (e.g. newer versions of Claude Desktop) receive this directly without needing to parse a string.

Both fields always contain the same data. This dual-encoding ensures compatibility with both old and new MCP client implementations.

---

## Error Handling

The philosophy is: **errors are loud**.

| Layer                         | Behaviour                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unhandled / unexpected errors | Thrown normally; `@modelcontextprotocol/sdk` catches them and returns a JSON-RPC protocol-level error (`code`, `message`) to the client.                |
| Expected tool-level errors    | Returned as a successful JSON-RPC response but with `isError: true` and the error message in `content[0].text`.                                         |
| Debug mode                    | Stack traces are included in tool-level error responses so the AI client (or the developer inspecting logs) can see exactly where the failure occurred. |

Swallowing errors silently would make it impossible for the AI client to recover gracefully or report a useful message to the user. Loud errors surface problems immediately.

---

## Dependencies

| Package                     | Purpose                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | Official TypeScript SDK for MCP. Handles the JSON-RPC framing, tool registration, schema validation, and stdio transport so the server only needs to implement handler logic.       |
| `zod`                       | Runtime schema validation and TypeScript type inference for tool input parameters. Used by `@modelcontextprotocol/sdk` to validate incoming arguments before the handler is called. |
| `pino`                      | High-performance structured logger. Writes to stderr only. Low overhead compared to alternatives; native JSON output makes log aggregation straightforward.                         |
| `@mozilla/readability`      | Port of Firefox Reader View. Strips navigation, ads, and boilerplate from a fetched HTML page and returns the main article content. Used by `web_read`.                             |
| `jsdom`                     | Parses raw HTML into a DOM tree that `@mozilla/readability` can traverse. Used alongside `@mozilla/readability` in `web_read`.                                                      |
| `cheerio`                   | Fast server-side jQuery-style HTML parsing. Used by `github_trending` to scrape the GitHub trending page, which has no official API.                                                |
| `youtube-transcript`        | Fetches the auto-generated or manual caption transcript for a YouTube video. Used by `youtube_transcript`.                                                                          |
| `better-sqlite3`            | Synchronous SQLite bindings. Used by `src/utils/corpusCache.ts` to persist prepared corpora across server restarts.                                                                 |
| `web-tree-sitter`           | WebAssembly port of the tree-sitter parsing library. Used by the code adapter for AST-aware symbol extraction. Grammars load lazily on first use per language.                      |
| `tree-sitter-wasms`         | Pre-compiled WASM grammar bundles for TypeScript, JavaScript, Python, Go, Rust, and others. Required by `web-tree-sitter` at runtime; not imported at startup.                      |
