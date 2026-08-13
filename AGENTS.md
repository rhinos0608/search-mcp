# AGENTS.md

> **Max 300 lines.** Keep this file concise. Details belong in source or dedicated docs.

MCP server over stdio/HTTP exposing 18 tools (77 actions): web search/crawl, RSS/Atom, semantic RAG, GitHub, YouTube, Reddit, academic/community research (15 backends), HN, Stack Overflow, npm, PyPI, jobs, browser automation, agentic browsing, knowledge graph, deep research.

## Commands

```bash
npm run dev              # hot-reload dev server
npm run build            # compile TypeScript to dist/
npm start                # run compiled server
npm run dev:json         # dev with JSON logging
npm run start:json       # production with JSON logging
npm run lint / lint:fix  # ESLint
npm run format / format:check  # Prettier
npm run typecheck        # tsc --noEmit
npm run config:encrypt   # config.json → config.enc
npm run config:decrypt   # config.enc → config.json
npm run install:dashboard  # npm install inside dashboard/
npm run build:dashboard    # Vite build → dist-dashboard/
npm run build:all          # build + dashboard build
```

HTTP mode: `HTTP_PORT=8050 SEARCH_MCP_CONFIG_KEY="passphrase" npm start`. First run prints `mcpApiKey` to stderr (dashboard login + MCP Bearer token).

## Architecture

- **Transport**: Dual-mode. `HTTP_PORT` unset → stdio only (stdout = JSON-RPC only, nothing else). `HTTP_PORT` set → HTTP server (`/mcp` + `/dashboard` at `/dashboard`) **and** stdio transport. All logging → stderr via pino.
- **Composition root**: `src/server.ts`. Loads config, registers tools, starts server.
- **Family tools** (8): `src/tools/families/`, registered via `registerFamily()` from `src/tools/registry.ts`. Single MCP tool per family with discriminated-union `action` field. Unavailable actions return actionable errors at runtime.
- **Standalone tools** (9): `src/tools/standalone/`, call `server.registerTool()` directly.
- **Config**: `src/config.ts` — encrypted config (`config.enc` + `SEARCH_MCP_CONFIG_KEY`) → env vars → defaults. Cached after first load.
- **Tool responses**: `ToolResult<T>` as JSON text content. Errors sanitized, returned with `isError: true`.
- **HTTP safety**: `src/httpGuards.ts` — SSRF guard blocks private IPs, localhost, cloud metadata. 10MB response limit. Operator-configured sidecar URLs are not user input.

## Tools

Config-gated: `web_crawl` (Crawl4AI), `semantic_crawl*` (Crawl4AI + embedding), `semantic_jobs` (embedding + search), `deep_research` (`DEEP_RESEARCH_ENABLED`), `knowledge_graph` (`KG_ENABLED`). Family actions may also be individually gated.

`browser` is enabled by default — auto-discovers existing Chrome on CDP ports (9222/9223/9229) or spins up a headless instance. Set `BROWSER_ENABLED=false` to disable.

### Standalone

| Tool                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web_search`                    | ChatGPT/Codex main source (CODEX_ACCESS_TOKEN or ~/.codex/auth.json); all configured Exa/Brave/SearXNG/DuckDuckGo/Tavily/Ollama backends fan out, URL-dedupe keeping the richest clean representation (source = provider of chosen content, `engines` union discoveries, Codex gets only a bounded preference so rich Exa/Tavily results are not starved), optional semantic rerank with a source-credibility floor; excerpt-only by default (Exa/Tavily request highlights/snippets, never full page text); output = one bare-Markdown block per result (cleaned markdown content with a stable `[N-M]` citation per prose sentence / indivisible code-table block) with a deterministic 192 KiB output budget and an adaptive per-document budget that scales with result count between an 8 KiB floor and a 24 KiB ceiling (data-rich documents get more room when few results share the total); aiSummary no/yes/only controls native provider summaries: `yes` enables URL-attributable provider summaries (currently Exa) rendered under a separate `### AI summary` section (Tavily returns only a query-level answer with no per-URL grounding, so it contributes none in `yes`); `only` restricts fanout to Exa/Tavily summary-only (Tavily `only` = per-result ultra-fast NLP summary) |
| `rss`                           | RSS/Atom parse, search, and multi-feed monitor (free, no key)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `web_crawl`                     | Crawl4AI multi-page crawl (timeout 30s+15s×maxPages, cap 5min). Wayback/Google Cache recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `semantic_crawl`                | RAG pipeline over crawled corpus. Sources: url, sitemap, search, github, cached                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `semantic_crawl_list_corpora`   | List cached corpora                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `semantic_crawl_inspect_corpus` | Inspect specific cached corpus                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `semantic_jobs`                 | SEEK/Indeed/Jora job search with dedup, constraints, weighted ranking                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `health_check`                  | Server status, config health, backend connectivity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `deep_research`                 | Async job/poll protocol. Actions: start, run, poll, list, cancel, save. Phases: decomposition → discovery → extraction → gap analysis → audit → synthesis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `fetch_focus`                   | ⚠️ deprecated — use `agentic_browse.focus`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Family tools

| Tool              | Actions                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github`          | repo, file, list_dir, tree, search, trending, code_search (AST-aware)                                                                                                                                                                                                                                  |
| `youtube`         | search (API), transcript (free), semantic (search+transcript+RAG)                                                                                                                                                                                                                                      |
| `reddit`          | search (free), comments (nested tree), semantic (search+comments+RAG)                                                                                                                                                                                                                                  |
| `research`        | academic, pubmed, wikipedia, arxiv, hackernews, stackoverflow, openalex, crossref, datacite, ror, semantic_scholar, gdelt, wikidata, v2ex, auto                                                                                                                                                        |
| `packages`        | npm, pypi                                                                                                                                                                                                                                                                                              |
| `browser`         | navigate, snapshot, click, type, evaluate, screenshot, extract, act, wait, wait_for, dialog_handle, iframe_context, scroll_to_load, paginate, download, table_extract, network_intercept, resource_timing, diff, pdf, storage, network, tabs, session. Backends: Playwright+CDP, optional CloakBrowser |
| `agentic_browse`  | browse, present, read, focus (in-memory doc store + optional deep research)                                                                                                                                                                                                                            |
| `knowledge_graph` | ingest, query, entity_lookup_batch, status, rebuild, family_list, family_get, family_merge, run_list, run_rollback                                                                                                                                                                                     |

## RAG Pipeline (`src/rag/`)

Shared by `semantic_crawl`, `youtube.semantic`, `reddit.semantic`, `semantic_jobs`, `github.code_search`.

1. **Ingestion**: Crawl4AI → strip cookie banners → optional domain trust + content scrubbing → `chunkMarkdown()` (~400 tokens, 20% overlap, atomic code blocks/tables). Code blocks ≥300 chars extracted with language metadata.
2. **Contextual embeddings** (opt-in): LLM-generated context prefix per chunk before embedding.
3. **Response-size guard**: preflight maxPages cap + in-flight byte accumulator. Emits `SemanticCrawlWarning` typed objects.
4. **Embedding**: batched via sidecar (max 512/batch). Query embedded in parallel.
5. **Hybrid ranking**: bi-encoder cosine → BM25+ → RRF fusion.
6. **Post-filtering**: semantic coherence filter → soft lexical constraints.
7. **Optional reranking**: cross-encoder via ONNX (default off).
8. **Corpus cache**: SQLite (`better-sqlite3`), configurable TTL, LRU eviction. Re-query via `source: { type: 'cached', corpusId }`.

Key modules: `pipeline.ts` (prepareCorpus/retrieveCorpus), `embedding.ts` (multi-provider dispatch), `profiles.ts` (balanced/lexical-heavy/semantic-heavy/high-precision/fast/precision/recall), `bm25.ts`, `fusion.ts` (RRF), `dedup.ts` (URL/source+id/company+title), `corpusCache.ts`, `rerank.ts`, `adapters/` (text, transcript, conversation, job, code, academic, qa), `code/` (language detection, tree-sitter, symbol extraction).

## Deep Research (`src/research/`)

Job/poll protocol: `start` → jobId (async), `poll` (blocks 60s), `list`, `cancel`, `save` (JSON to disk). Jobs: queued → running → complete|failed|cancelled → expired (24h TTL).

**Orchestrator**: Standard path (quick/standard/deep/exhaustive): Decomposition → Discovery → Taxonomy → Extraction → EDA loop (Evaluate→Decide→Act→Update) → Audit → Synthesis. Tree path (tree depth): breadth×depth recursive exploration (4×2), bypasses phases 2–5.

**Model routing**: orchestrator model (planning/eval/audit/synthesis, temp 0.7) + worker model (extraction, temp 0.3). Both OpenAI-compatible. Falls back to rule-based when LLM unconfigured.

**3D confidence**: evidence quality × extraction reliability × source consistency. Aggregate = min of all three.

Key modules: `orchestrator.ts`, `jobManager.ts` (singleton, max 5 active), `workerAgent.ts`, `state.ts`, `decomposer.ts`, `discovery.ts`, `extraction.ts`, `gapAnalysis.ts`, `audit.ts`, `synthesizer.ts`, `llm/chat.ts`, `llm/prompts.ts`, `llm/schemas.ts`, `compaction.ts`, `treeEngine.ts`, `actionGates.ts`, `agenda.ts`, `taxonomy.ts`, `language.ts`, `sourceQuality.ts`, `sourceRanking.ts`, `trace.ts`, `progress.ts`.

Failures: LLM failure → rule-based fallback. Budget exhaustion → partial synthesis. Per-source failures isolated. Stale jobs force-expired at 2× max runtime.

## Embedding Providers

`EMBEDDING_PROVIDER` env var (default `sidecar`): `sidecar` (FastAPI, `EMBEDDING_SIDECAR_BASE_URL`), `ollama` (`EMBEDDING_OLLAMA_BASE_URL`), `transformers` (in-process ONNX), `openai` (`EMBEDDING_OPENAI_API_KEY`). Optional `EMBEDDING_CODE_MODEL` for code-tuned endpoint.

## V3.3+ Features

- **Contextual embeddings** (`src/rag/contextualEmbedding.ts`): LLM chunk enrichment before embedding. Degrades to raw on failure.
- **Query expansion** (`src/tools/queryExpansion.ts`): rule-based synonym/concept expansion. ~60-entry concept map, no LLM.
- **External recovery** (`src/utils/externalRecovery.ts`): Wayback Machine + Google Cache fallback when Crawl4AI fails.
- **Content scrubbing** (`src/utils/contentScrubber.ts`): regex threat detection + redaction. Opt-in `SCRUB_CONTENT=true`.
- **Domain trust** (`src/utils/domainTrust.ts`): reputation, typosquat detection. Opt-in `DOMAIN_TRUST_ENABLED=true`.
- **Cross-backend merging** (`src/utils/searchMerge.ts`): parallel Brave+SearXNG, merged by URL. Scoring: engine agreement 40%, domain authority 30%, position 30%.
- **Extraction stats** (`src/utils/extractionStats.ts`): per-domain crawl success tracking, short-circuit known-failing domains.

## Config / Env Vars

```bash
# Search (at least one)
EXA_API_KEY, BRAVE_API_KEY, SEARXNG_BASE_URL, SEARCH_BACKEND (brave|searxng|exa|duckduckgo|ollama-search|tavily|codex), TAVILY_API_KEY
CODEX_ACCESS_TOKEN, CODEX_ACCOUNT_ID (optional), CODEX_HOME (default ~/.codex)  # Codex/ChatGPT default search backend; limited support
# Social
NITTER_BASE_URL, REDDIT_CLIENT_ID+SECRET (must pair), REDDIT_USER_AGENT, YOUTUBE_API_KEY
# Research
LISTENNOTES_API_KEY, PRODUCTHUNT_API_TOKEN, PATENTSVIEW_API_KEY, STACKEXCHANGE_API_KEY, GITHUB_TOKEN
# Crawl
CRAWL4AI_BASE_URL, CRAWL4AI_API_TOKEN
# Embedding
EMBEDDING_PROVIDER, EMBEDDING_SIDECAR_BASE_URL, EMBEDDING_SIDECAR_API_TOKEN, EMBEDDING_DIMENSIONS (768), EMBEDDING_CODE_MODEL, EMBEDDING_OLLAMA_BASE_URL, EMBEDDING_OPENAI_API_KEY
# LLM (contextual embeddings, browser.act, deep research — OpenAI-compatible)
LLM_PROVIDER (model name), LLM_API_TOKEN (optional), LLM_BASE_URL (required)
# Document extraction
Text-like document URLs are extracted in-process; binary parser adapters are not configured by default.

# Document & multimodal parsing (on by default; auto-discovers pdf-parse/officeparser, degrades gracefully if absent; multimodal VLM tier remains opt-in)
DOCUMENT_PARSING_ENABLED (default true), DOCUMENT_PARSING_MULTIMODAL (VLM figure/table enrichment, opt-in), DOCUMENT_PARSING_MAX_ENRICH (cap, default 3)
# Browser
BROWSER_ENABLED (default true), BROWSER_ENGINE (playwright|cloak), BROWSER_MODE (stealth|user|profile), BROWSER_AUTO_CONNECT (default true), BROWSER_CDP_PORT, BROWSER_PROFILE_DIR, CLOAKBROWSER_HUMANIZE, CLOAKBROWSER_HUMAN_PRESET, CLOAKBROWSER_LOCALE, CLOAKBROWSER_TIMEZONE, CLOAKBROWSER_GEOIP, CLOAKBROWSER_STEALTH_ARGS
# Deep Research
DEEP_RESEARCH_ENABLED, DEEP_RESEARCH_BASE_URL, DEEP_RESEARCH_MODEL, DEEP_RESEARCH_WORKER_MODEL, DEEP_RESEARCH_DEFAULT_DEPTH (quick|standard|deep|exhaustive|tree)
# Knowledge Graph
KG_ENABLED
# Security (opt-in)
DOMAIN_TRUST_ENABLED, TRUSTED_DOMAINS, BLOCKED_DOMAINS, SCRUB_CONTENT
# Persistence
DATABASE_PATH (default ~/.cache/search-mcp/semantic-crawl/)
```

Reddit: `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` must both be set. One only → degraded, tools throw `VALIDATION_ERROR`.

## Sidecars & Services

- `sidecar/embedding/`: FastAPI embedding service, `POST /embed` with `{ texts, mode, dimensions }`.
- `sidecar/openai-embedding-proxy/`: OpenAI-compatible proxy to sidecar.
- `sidecar/jobspy/`: Python sidecar for job scraping via JobSpy.

## Docker

```bash
docker compose up -d
# Services: search-mcp (8050), crawl4ai (8051), embedding (8001), searxng (8081)
```

## Key Constraints

- TypeScript strict mode: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`.
- ESM-only. Local imports need `.js` extensions.
- Zod v4: `import { z } from "zod/v4"`.
- `youtube-transcript`: ESM workaround via `youtube-transcript/dist/youtube-transcript.esm.js` with `@ts-expect-error`.
- `rerank.ts`, `githubCorpus.ts`: dynamically imported for fast startup.
- Corpus cache: persistent SQLite, survives restarts.
- Adapter types: `job`, `code`, `text`, `transcript`, `conversation`, `academic`, `qa`.
- Structured warnings: typed union `SemanticCrawlWarning`, not strings.
- Never commit `config.json`, `config.enc`, or API keys.

## Commit Style

Conventional Commits. Scopes = subsystem (`rag`, `crawl`, `github`, `server`), not version. Subjects imperative, ≤72 chars. Use `fix(security)` for security hardening. Tag releases: `chore(release): tag vX.Y.Z`. Squash noisy fixups. Keep meaningful fixes visible.

```
feat(rag): add persistent corpus cache
fix(crawl): enforce page budget before extraction
fix(security): block SSRF targets in smart extraction
```

## Evaluation

`src/rag/__tests__/eval/`: golden-query harness (academic, general, job, QA domains). Scoring: precision, recall, nDCG. Runner: `scripts/eval-retrieval.ts`.
