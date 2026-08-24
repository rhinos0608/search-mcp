# CLAUDE.md

> **Max 300 lines.** Keep this file concise. Details in AGENTS.md and source.

Guidance for Claude Code working in this repository. See [AGENTS.md](./AGENTS.md) for full tool catalog, RAG pipeline, config/env vars, and sidecar details.

## What This Is

MCP server over stdio/HTTP exposing **16 tools, 63 actions**: web search/crawl, semantic RAG, GitHub, YouTube, Reddit, academic research (14 backends), HN, Stack Overflow, npm, PyPI, jobs, browser automation, agentic browsing. Clients (Claude Desktop, Claude CLI) connect via stdin/stdout or HTTP.

V6.0.0 adds opt-in HTTP transport with React dashboard (`HTTP_PORT` to enable). ConfigManager with AES-256-GCM encrypted config. Dual-mode startup: stdio-only or HTTP+stdio.

## Commands

```bash
npm run dev              # hot-reload dev server (tsx watch)
npm run build            # TypeScript → dist/
npm start                # run compiled server
npm run lint / lint:fix  # ESLint
npm run format / format:check  # Prettier
npm run typecheck        # tsc --noEmit
npm run config:encrypt   # config.json → config.enc
npm run config:decrypt   # config.enc → config.json
npm run install:dashboard  # npm install inside dashboard/
npm run build:dashboard    # Vite build → dist-dashboard/
npm run build:all          # build + dashboard
```

Append `--json` via `dev:json` / `start:json` for structured JSON logging.

HTTP mode: `HTTP_PORT=8050 SEARCH_MCP_CONFIG_KEY="passphrase" npm start`. First run prints `mcpApiKey` to stderr.

## Architecture

- **Transport**: `HTTP_PORT` unset → stdio only (stdout = JSON-RPC exclusively). `HTTP_PORT` set → HTTP on that port (`/mcp` Bearer auth, `/dashboard`) **plus** stdio. Logging → stderr via pino.
- **Composition root**: `src/server.ts` — loads config, registers tools, starts server.
- **Family tools** (8): `src/tools/families/`, registered via `registerFamily()`. Discriminated-union `action` field per family.
- **Standalone tools** (10): `src/tools/standalone/`, direct `server.registerTool()`.
- **Config**: encrypted config (`config.enc` + `SEARCH_MCP_CONFIG_KEY`) → env vars → defaults. Cached after load.
- **Responses**: `ToolResult<T>` as JSON text. Errors: `isError: true`, sanitized (no stack traces).
- **HTTP safety**: `src/httpGuards.ts` — SSRF guard, 10MB response limit. Operator-configured sidecar URLs are not user input.

## Tool Summary

See AGENTS.md for full action lists. Config-gated tools: `web_crawl`, `semantic_crawl*`, `semantic_jobs`, `browser`.

**Standalone**: web_search, rss, web_crawl, semantic_crawl, semantic_crawl_list_corpora, semantic_crawl_inspect_corpus, semantic_jobs, health_check, fetch_focus (deprecated).

**Families**: github (7 actions), youtube (3), reddit (3), research (15), packages (2), browser (24), agentic_browse (4).

## RAG Pipeline (`src/rag/`)

Shared by semantic_crawl, youtube.semantic, reddit.semantic, semantic_jobs, github.code_search.

1. Crawl4AI → strip cookie banners → optional domain trust + scrubbing → `chunkMarkdown()` (~400 tokens, 20% overlap)
2. Contextual embeddings (opt-in): LLM context prefix per chunk
3. Response-size guard: preflight maxPages + in-flight byte accumulator
4. Batched embedding (max 512/batch), query in parallel
5. Hybrid ranking: cosine → BM25+ → RRF fusion
6. Post-filter: semantic coherence + soft lexical constraints
7. Optional cross-encoder rerank (ONNX, default off)
8. SQLite corpus cache, configurable TTL, LRU eviction

Key: `pipeline.ts`, `embedding.ts`, `profiles.ts`, `bm25.ts`, `fusion.ts`, `dedup.ts`, `corpusCache.ts`, `rerank.ts`, `adapters/` (text, transcript, conversation, job, code, academic, qa), `code/` (tree-sitter, symbol extraction).

## Key Constraints

- TypeScript strict: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- ESM-only. Local imports need `.js` extensions.
- Zod v4: `import { z } from "zod/v4"`
- `youtube-transcript`: ESM workaround with `@ts-expect-error`
- `rerank.ts`, `githubCorpus.ts`: dynamic imports for startup speed
- Corpus cache: persistent SQLite, survives restarts
- Adapter types: `job`, `code`, `text`, `transcript`, `conversation`, `academic`, `qa`
- Never commit `config.json`, `config.enc`, or API keys
- Embedding sidecar bypasses SSRF guard only for operator-configured URLs

## Commit Style

Conventional Commits. Scopes = subsystem, not version. Subjects imperative, ≤72 chars. `fix(security)` for security hardening. `chore(release): tag vX.Y.Z`. Squash noisy fixups.

## Evaluation

`src/rag/__tests__/eval/`: golden-query harness. Precision, recall, nDCG. Runner: `scripts/eval-retrieval.ts`.
