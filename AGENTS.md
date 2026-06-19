# AGENTS.md

Guidance for AI coding agents working in this repository.

## Purpose

MCP server over stdio exposing web search/extract/crawl, semantic RAG, GitHub, YouTube, Reddit, academic research, Hacker News, Stack Overflow, npm, PyPI, jobs, browser automation, agentic browsing, knowledge graph, and deep research.

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

- `src/server.ts` is the composition root: loads config, registers tools (via family modules), starts server. No inline schemas or handlers.
- `src/tools/registry.ts` provides `registerFamily()` for registering a single MCP tool with a discriminated-union `action` field. Each action has its own schema, handler, and optional config check.
- `src/tools/families/` contain consolidated tool families: e.g. `youtube.ts` with actions `search | transcript | semantic`. Family tools are always registered; unavailable actions return actionable errors at runtime. Health reporting surfaces per-action availability.
- `src/tools/response.ts` provides shared `makeResult`, `errorResponse`, `successResponse` helpers.
- `src/index.ts` Entry point. Creates `McpServer`, attaches `StdioServerTransport`, calls `server.connect()`.
- `src/logger.ts` routes pino logs to stderr. Never write non-JSON-RPC output to stdout.
- `src/config.ts` resolves config in this order: encrypted config → env vars → defaults, then caches it.
- Tool handlers return `ToolResult<T>` as JSON text content. Errors are sanitized and returned with `isError: true`.

## Main Tools (17 tools, 73 actions)

> **Config-gated tools**: Some tools are only registered when their required config/env vars are set. If the config is missing, the tool does not appear in the tool list at all — it is not silently registered with a broken handler. Gated tools: `web_crawl` (Crawl4AI URL), `semantic_crawl` + `semantic_crawl_list_corpora` + `semantic_crawl_inspect_corpus` (Crawl4AI URL + embedding sidecar), `semantic_jobs` (embedding sidecar + search backend), `deep_research` (`DEEP_RESEARCH_ENABLED=true`), `browser` (`BROWSER_ENABLED=true`), `knowledge_graph` (`KG_ENABLED=true`). Individual family actions may also be gated (e.g. `github.code_search` requires `GITHUB_TOKEN` + embedding sidecar; `youtube.search` requires `YOUTUBE_API_KEY`). Unavailable actions return actionable errors at runtime.

### Search/Read/Crawl

- `web_search`: Exa, Brave, or SearXNG with fallback chain, optional query expansion and cross-backend merging.
- `web_crawl`: Crawl4AI multi-page crawl; timeout = `30s + 15s * maxPages`, capped at 5 min. Includes external recovery (Wayback Machine, Google Cache) when crawl fails.
- `semantic_crawl`: primary crawl RAG entry point. Supports `url`, `sitemap`, `search`, `github`, and `cached` sources. Supports contextual chunk embeddings, content scrubbing, domain trust filtering, and self-improvement extraction stats.
- `semantic_crawl_list_corpora`: list cached corpora.
- `semantic_crawl_inspect_corpus`: inspect a specific cached corpus.

### Semantic/RAG

- `semantic_jobs`: job search/extraction for SEEK, Indeed, Jora with dedup, constraints, and weighted ranking.

### GitHub

- `github` (family tool with `action` discriminator):
  - `repo` — repository metadata + README
  - `file` — read a file, supports line/byte ranges
  - `list_dir` — list immediate directory contents (non-recursive)
  - `tree` — recursive directory listing with monorepo detection
  - `search` — GitHub code search API
  - `trending` — trending repos (cheerio scrape, no auth needed)
  - `code_search` — AST-aware semantic code search via RAG

### Video/Social

- `youtube` (family tool with `action` discriminator):
  - `search` — search videos by keyword
  - `transcript` — fetch captions, works without API key
  - `semantic` — search + transcript + RAG ranking
- `reddit` (family tool with `action` discriminator):
  - `search` — search posts by keyword, free API
  - `comments` — fetch comment tree with nested post locator (`url | permalink | id`)
  - `semantic` — search + comments + RAG ranking

### Research/Discovery

- `research` (family tool with `action` discriminator):
  - `academic` — ArXiv + Semantic Scholar with automatic cross-backend fallback
  - `pubmed` — search PubMed for medical/biomedical literature
  - `wikipedia` — search Wikipedia for background knowledge
  - `arxiv` — direct ArXiv search with category/date filtering
  - `hackernews` — Algolia HN search
  - `stackoverflow` — Stack Exchange API (degraded without `STACKEXCHANGE_API_KEY`)
  - `openalex` — search OpenAlex scholarly works
  - `crossref` — search Crossref DOI metadata
  - `datacite` — search DataCite research data DOIs
  - `ror` — look up research organizations via ROR
  - `semantic_scholar` — direct Semantic Scholar paper search
  - `gdelt` — search GDELT global news/events
  - `wikidata` — search Wikidata structured entities
  - `auto` — auto-route to best backend based on query hints (DOI, arXiv ID, biomedical keywords, etc.)
- `deep_research` — Standalone deep multi-source research via a job/poll protocol (requires `DEEP_RESEARCH_ENABLED=true`):
  - Actions: `start`, `run`, `poll`, `list`, `cancel`, `save`
  - `start` returns a jobId immediately; research runs asynchronously in background
  - `poll` blocks up to 60s waiting for completion, returns partial progress or full result
  - `save` persists a completed result as a JSON file to a configurable path
  - Results held in memory for 24 hours after completion; explicit save for durable persistence
  - Control loop (orchestrator): `State → Evaluate → Decide → Act → Update State`
  - Phases: decomposition → discovery → extraction → gap analysis → audit → synthesis
  - Model routing: orchestrator model (planning, evaluation, audit, synthesis) + worker model (extraction)
  - 3D confidence: evidence quality × extraction reliability × source consistency
  - Falls back to rule-based when LLM is not configured
  - Depth profiles: `quick` | `standard` | `deep` | `exhaustive` | `tree`

### Packages/Products

- `packages` (family tool with `action` discriminator):
  - `npm` — search npm registry
  - `pypi` — search Python Package Index

### Browser

- `browser` (family tool with `action` discriminator, gated by `BROWSER_ENABLED`):
  - `navigate` — navigate to a URL
  - `snapshot` — capture page structure as accessible elements
  - `click` / `type` — interact with page elements
  - `evaluate` — run JavaScript on the page
  - `screenshot` — capture page images
  - `extract` — pull structured data
  - `act` — natural-language instructions (requires `LLM_PROVIDER`)
  - `wait` — wait for time/text/selector/loadState
  - `wait_for` — wait for compound conditions (visible/gone/has-text/count)
  - `dialog_handle` — handle alert/confirm/prompt
  - `iframe_context` — switch frames
  - `scroll_to_load` — infinite scroll
  - `paginate` — walk paginated content
  - `download` — intercept file downloads
  - `table_extract` — structured tables
  - `network_intercept` — block/inject/modify requests
  - `resource_timing` — performance data
  - `diff` — DOM change detection
  - `pdf` — save page as PDF
  - `storage` — manage browser storage state
  - `network` — network interception/monitoring
  - `tabs` — tab management
  - `session` — browser session lifecycle
  - Backends: Playwright + CDP (stealth mode), optional CloakBrowser

### Agentic Browse

- `agentic_browse` (family tool with `action` discriminator):
  - `browse` — fetch URL and store in-memory document store
  - `present` — format stored document for display (requires prior `browse`)
  - `read` — one-shot fetch + extract
  - `focus` — deep research on a document (requires `CRAWL4AI_BASE_URL` + `DEEP_RESEARCH_BASE_URL` + `DEEP_RESEARCH_MODEL`)
- `fetch_focus` ⚠️ deprecated standalone alias — use `agentic_browse.focus` instead. Scheduled for removal in next major release.

### Knowledge Graph (opt-in via `KG_ENABLED`)

- `knowledge_graph` (family tool with `action` discriminator):
  - `ingest` — text or URL → entities and relationships via LLM pipeline
  - `query` — full-text search, entity lookup, traversal
  - `entity_lookup_batch` — resolve up to 100 entity IDs
  - `status` — event count, projection stats, storage size
  - `rebuild` — rebuild projection tables from event store
  - `family_list` — list families with node counts and merge candidates
  - `family_get` — retrieve family detail with entities and runs
  - `family_merge` — merge one family into another (one-way, irreversible)
  - `run_list` — list extraction runs with filters and pagination
  - `run_rollback` — roll back a run with compensation plan preview

### System

- `health_check`: verify server status, config health, backend connectivity.

## RAG Modules

`src/rag/` contains the reusable retrieval system:

- `types.ts`: shared RAG types.
- `pipeline.ts`: `prepareCorpus`, `retrieveCorpus`, `prepareAndRetrieve`.
- `embedding.ts`: embedding provider dispatch (sidecar, ollama, transformers, openai).
- `profiles.ts`: retrieval profiles including `balanced`, `lexical-heavy`, `semantic-heavy`, `high-precision`, `fast`, `precision`, `recall`.
- `bm25.ts`: BM25+ scoring implementation.
- `fusion.ts`: RRF + weighted linear fusion.
- `lexicalConstraint.ts`: soft lexical constraint matching.
- `uncertainty.ts`: uncertainty tags for retrieval confidence.
- `adapters/text.ts`: crawl pages to chunks.
- `adapters/transcript.ts`: YouTube transcripts to chunks.
- `adapters/conversation.ts`: Reddit comment trees to chunks.
- `adapters/job.ts`: HTML to structured job listings.
- `adapters/code.ts`: source files to AST-aware code chunks.
- `adapters/academic.ts`: academic paper metadata to chunks.
- `adapters/qa.ts`: Q&A content to chunks.
- `adapters/index.ts`: adapter registry.
- `code/*`: language detection, tree-sitter loading, symbol extraction.
- `dedup.ts`: three-layer deduplication (URL, source+id, company+title).
- `constraints.ts`: hard + soft constraint filtering for job search.
- `metrics.ts`: counters, histograms, gauges for observability.
- `instrumentation.ts`: tracing spans, run tracking, pipeline wrappers.
- `rerank.ts`: optional cross-encoder reranking (ONNX, dynamically imported).
- `corpusCache.ts`: SQLite-backed persistent corpus cache.
- `jobRanking.ts`, `jobDedup.ts`, `jobPipeline.ts`, `types/job.ts`, `types/jobGraph.ts`, `sources/jobSources.ts`: job search support.
- `quality/`: boilerplate detection, country eligibility, entry-level classification, occupation classification, page intent, quality gating, SERP guard.

## Deep Research Modules

`src/research/` implements the deep research orchestration engine. The tool (`deep_research`) uses a job/poll protocol — `start` returns a jobId immediately, research runs asynchronously, and `poll` retrieves progress or the final result. Results are held in memory for 24 hours, and the `save` action persists them to disk.

### Job Protocol

```
start  → returns jobId, research runs in background
poll   → blocks up to 60s, returns snapshot or full result
list   → lightweight summary of all known jobs
cancel → aborts a running job
save   → writes full result to a JSON file on disk
```

Jobs follow this lifecycle: `queued → running → complete | failed | cancelled → expired (24h TTL)`.

### Orchestrator Control Flow

The orchestrator runs inside the detached research promise. It has two paths:

**Standard path** (quick/standard/deep/exhaustive):

```
1. Decomposition   → rule-based query → sub-questions
2. Discovery       → multi-backend search (web, academic, Reddit, HN, GitHub, SO)
3. Taxonomy        → rule-based revision after first discovery pass
4. Extraction      → LLM (worker model) or regex fallback
5. EDA Loop        → Evaluate (gaps + LLM assessment)
                    → Decide (LLM or rule-based heuristics)
                    → Act (extract, fill_gaps, discover, contradiction_scan)
                    → Update State (loop until budget exhausted or all gaps resolved)
6. Audit           → LLM (orchestrator) + rule-based, merged with dedup
7. Synthesis       → LLM (orchestrator) or rule-based ResearchSynthesizer
```

**Tree path** (tree depth):

- Breadth×depth recursive exploration (4 sub-queries × 2 levels)
- Parallel discovery and extraction per level via `DeepTreeResearchEngine`
- Bypasses Phases 2–5, uses tree expansion instead

### Model Routing

| Model                                 | Role                                                    | Default Temperature |
| ------------------------------------- | ------------------------------------------------------- | ------------------- |
| `DEEP_RESEARCH_MODEL` (orchestrator)  | Planning, evaluation, decision-making, audit, synthesis | 0.7                 |
| `DEEP_RESEARCH_WORKER_MODEL` (worker) | Extraction from source content, classification          | 0.3                 |

Both use the same OpenAI-compatible base URL (`DEEP_RESEARCH_BASE_URL`). When LLM is not configured, all phases fall back to rule-based implementations.

### Key Modules

| File                 | Purpose                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `llm/chat.ts`        | OpenAI-compatible HTTP client with model routing, token tracking, retry logic                                              |
| `llm/prompts.ts`     | 16 system prompts (orchestrator evaluate, decide, synthesis_v2; worker extract, classify, rewrite, cluster, quality, etc.) |
| `llm/schemas.ts`     | Zod schemas for LLM response validation                                                                                    |
| `llm/synthesis.ts`   | Orchestrator-based narrative report generation                                                                             |
| `orchestrator.ts`    | Control loop: state machine, budget tracking, model routing; tree engine dispatch                                          |
| `jobManager.ts`      | In-memory job registry with TTL cleanup, max-active limit, AbortSignal propagation. Singleton `researchJobManager`         |
| `compaction.ts`      | Multi-layer result compaction for MCP transport (trim timeline, cap findings, write full result to file, hard size guard)  |
| `treeEngine.ts`      | `DeepTreeResearchEngine` — breadth×depth recursive exploration for `tree` depth profile                                    |
| `workerAgent.ts`     | Distributed worker pool for parallel extraction across sources                                                             |
| `state.ts`           | Durable research state (sources, findings, contradictions, gaps, diary, language profile)                                  |
| `decomposer.ts`      | Rule-based sub-question decomposition; LLM-powered variant with search-result seeding                                      |
| `discovery.ts`       | Multi-backend source discovery with scoring/dedup; optional LLM query rewriting                                            |
| `extraction.ts`      | Rule-based extraction (fallback path)                                                                                      |
| `knowledge.ts`       | Knowledge store — conversation-pair format findings for LLM-native context injection                                       |
| `gapAnalysis.ts`     | Rule-based gap detection (fallback path); `GapFiller`, `GapAnalyzer`                                                       |
| `audit.ts`           | Rule-based state audit with 7 checks (fallback path)                                                                       |
| `synthesizer.ts`     | Rule-based synthesis (fallback path)                                                                                       |
| `actionGates.ts`     | Per-step action disable flags — blocks `discover` after enough sources, `extract` after low yield, etc.                    |
| `agenda.ts`          | Structured agenda management: ordered action queue with priority, dedup, and progress tracking                             |
| `taxonomy.ts`        | Taxonomy revision after first discovery pass — reclassifies sub-questions based on real results                            |
| `language.ts`        | Language auto-detection (ISO 639-1) and style profile; parameterizes prompts for non-English queries                       |
| `sourceQuality.ts`   | Per-source quality scoring (freshness, authority, relevance)                                                               |
| `sourceRanking.ts`   | Multi-signal URL ranking: frequency boost, domain authority, path structure, hostname diversity                            |
| `trace.ts`           | Structured trace events — step-level action logging for streaming and replay                                               |
| `progress.ts`        | Progress tracker — emits typed `ResearchProgress` events through the MCP progress callback                                 |
| `researchTools.ts`   | Shared tool utilities: `createResearchTools()` factory for orchestrator dependencies                                       |
| `extractSentence.ts` | Sentence-level extraction utility — splits content into atomic claim-sized units                                           |

### 3D Confidence Model

Separates three distinct confidence dimensions instead of collapsing them:

1. **Evidence confidence** — source authority (by type), freshness (by date), corroboration count
2. **Extraction confidence** — method reliability (LLM=0.8, regex=0.5, direct=0.9), content quality, risk score
3. **Consistency confidence** — agreement ratio among sources, contradiction status

Aggregate: `Math.min(evidence.score, extraction.score, consistency.score)` (conservative)

### Failures / Fallbacks

- LLM failure at any phase → rule-based fallback
- Budget exhaustion → `synthesizePartial()` with whatever state exists
- Per-source extraction failures isolated (one failure doesn't block others)
- Degenerate loop protection: max iterations per budget profile, confidence plateau detection
- Job max runtime timeout per depth profile (60s quick → 600s exhaustive); enforced via AbortController
- In-memory jobs auto-expire 24h after terminal state; stale running jobs force-expired after 2× max runtime
- A single `ResearchJobManager` singleton manages concurrency (max 5 active jobs) and lifecycle

## Embedding Providers

Provider selection via `EMBEDDING_PROVIDER` env var (default `sidecar`):

| Provider       | Description                | Required Env Vars                                            |
| -------------- | -------------------------- | ------------------------------------------------------------ |
| `sidecar`      | FastAPI embedding sidecar  | `EMBEDDING_SIDECAR_BASE_URL`                                 |
| `ollama`       | Ollama local server        | `EMBEDDING_OLLAMA_BASE_URL` (default http://localhost:11434) |
| `transformers` | Transformers.js in-process | —                                                            |
| `openai`       | OpenAI-compatible API      | `EMBEDDING_OPENAI_API_KEY`                                   |

Code search may use `EMBEDDING_CODE_MODEL` for a code-tuned model endpoint.

## V3.3+ Features (contextual embeddings, query expansion, content scrubbing)

### Contextual Embeddings (`src/rag/contextualEmbedding.ts`)

Optional LLM-based chunk enrichment for `semantic_crawl`. When `useContextualEmbeddings: true` and LLM config is present, each chunk is prefixed with a short LLM-generated context string before embedding. Original chunk text is preserved for display; enriched text is used only for embedding. Gracefully degrades to raw chunks if the LLM call fails.

### Query Expansion (`src/tools/queryExpansion.ts`)

Rule-based query variation generator: concept/synonym expansion, question form, scope adjustment, opposition pairs. Wired into `web_search` via `expandQuery` param (default `true`). ~60-entry concept map, no LLM calls.

### External Recovery (`src/utils/externalRecovery.ts`)

When Crawl4AI returns placeholder/empty content, attempts Wayback Machine CDX API and Google Cache as fallbacks. Recovered content tagged with `recoverySource` metadata. Bounded timeout and size limits.

### Content Scrubbing (`src/utils/contentScrubber.ts`)

Regex-based detection of prompt injection, data exfiltration, impersonation, and XSS patterns. Redacts with `[REDACTED]` tags. Returns risk score and threat summary. Opt-in via `SCRUB_CONTENT=true`.

### Cross-Backend Search Merging (`src/utils/searchMerge.ts`)

When both Brave and SearXNG are configured, queries both in parallel and merges results by normalized URL. Scoring: engine agreement (40%), domain authority (30%), position (30%). Wired into `web_search` via `mergeSearchBackends` param (default `true`).

### Domain Trust (`src/utils/domainTrust.ts`)

Evaluates domain reputation: established-domain allowlist, suspicious TLDs, HTTPS enforcement, Levenshtein typosquat detection. Opt-in via `DOMAIN_TRUST_ENABLED=true`.

### Extraction Stats (`src/utils/extractionStats.ts`)

Tracks per-domain crawl success rates in-memory. Surfaces via health endpoint. Can short-circuit known-failing domains. Prunes by TTL, max 10k entries.

### Code Example Extraction (`src/chunking.ts`)

Detects fenced code blocks >=300 chars during chunking, attaches language and offset metadata to nearest section.

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
SEARCH_BACKEND            # 'brave' | 'searxng' | 'exa' | 'tavily'
TAVILY_API_KEY

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

# LLM (for contextual embeddings, browser.act, deep research — OpenAI-compatible endpoint, API key optional)
LLM_PROVIDER                # model name (e.g. 'gpt-4o-mini', 'llama3'), passed as-is to /v1/chat/completions
LLM_API_TOKEN               # optional — omit for local servers without auth
LLM_BASE_URL                # base URL for /v1/chat/completions (required)

# Security (opt-in, off by default)
DOMAIN_TRUST_ENABLED        # 'true' | 'false' (default: false)
TRUSTED_DOMAINS             # comma-separated trusted domains
BLOCKED_DOMAINS             # comma-separated blocked domains
SCRUB_CONTENT               # 'true' | 'false' (default: false)

# RAG-Anything Bridge (multimodal document extraction)
RAGA_ENABLED                # 'true' | 'false' (default: false)
RAGA_BRIDGE_URL             # default http://localhost:8000
RAGA_DEFAULT_PARSER         # 'auto' | 'docling' | 'paddleocr' | 'mineru'
RAGA_TIMEOUT_MS             # default 30000

# Browser/CDP (optional, disabled by default)
BROWSER_ENABLED            # 'true' | 'false' (default: false)
BROWSER_ENGINE             # 'playwright' | 'cloak' (CloakBrowser optional package)
BROWSER_MODE               # 'stealth' | 'user' | 'profile'
BROWSER_PROFILE_DIR        # persistent profile path/name for profile mode
CLOAKBROWSER_HUMANIZE      # 'true' | 'false' for wrapper-level human-like actions
CLOAKBROWSER_HUMAN_PRESET  # 'default' | 'careful'
CLOAKBROWSER_LOCALE        # optional locale flag, e.g. en-US
CLOAKBROWSER_TIMEZONE      # optional timezone flag, e.g. America/New_York
CLOAKBROWSER_GEOIP         # 'true' | 'false' to infer locale/timezone from proxy IP
CLOAKBROWSER_STEALTH_ARGS  # 'true' | 'false' to include default CloakBrowser stealth flags

# Deep Research (opt-in, off by default)
DEEP_RESEARCH_ENABLED       # 'true' | 'false' (default: false)
DEEP_RESEARCH_BASE_URL      # OpenAI-compatible base URL for LLM calls
DEEP_RESEARCH_MODEL         # Main orchestrator model (e.g. 'gpt-4o', 'claude-sonnet-4')
DEEP_RESEARCH_WORKER_MODEL  # Worker model for cheap tasks (e.g. 'gpt-4o-mini', 'llama3')
DEEP_RESEARCH_DEFAULT_DEPTH # 'quick' | 'standard' | 'deep' | 'exhaustive' | 'tree'

# Knowledge Graph (opt-in, off by default)
KG_ENABLED                  # 'true' | 'false' (default: false)

# Persistence
DATABASE_PATH               # default under ~/.cache/search-mcp/semantic-crawl/
```

Reddit OAuth is optional, but `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` must be set together. If only one is present, config is degraded and Reddit tools throw `VALIDATION_ERROR` when used.

## Sidecars & Services

- `sidecar/embedding/`: FastAPI embedding service exposing `POST /embed` with `{ texts, mode, dimensions }`.
- `sidecar/openai-embedding-proxy/`: OpenAI-compatible embeddings proxy to the sidecar.
- `sidecar/jobspy/`: Python sidecar for job scraping via JobSpy.
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

`src/rag/__tests__/eval/` provides a golden-query evaluation harness:

- Golden query datasets covering academic, general, job, and QA domains
- Scoring: precision, recall, nDCG
- Runner script for batch evaluation (`scripts/eval-retrieval.ts`)
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
- Adapter types include `job`, `code`, `text`, `transcript`, `conversation`, `academic`, `qa`.
- Structured warnings use typed union codes (`SemanticCrawlWarning`), not strings.
