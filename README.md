# search-mcp

[![npm version](https://img.shields.io/npm/v/search-mcp.svg)](https://www.npmjs.com/package/search-mcp)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green)](https://modelcontextprotocol.io)

> MCP acquisition and search tools for web search, RSS/Atom feeds, semantic RAG, code analysis, job search, academic research, social media, browser automation, and agentic browsing.
>
> **New in v3.3+:** All-provider parallel fanout with Codex-first dedup, source credibility tiering (institutional domain registry), bare-Markdown result formatting with per-block `[N-M]` citations, overflow artifacts, in-process PDF/Office document parsing with opt-in multimodal VLM tier, auto-enrichment of thin document snippets, and `aiSummary` modes for Exa/Tavily native summaries.

## Features at a Glance

| Category         | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web**          | `web_search` (Codex main source; all configured Exa/Brave/SearXNG/DuckDuckGo/Tavily/Ollama backends fan out in parallel; URL-dedupe keeping richest representation; bare-Markdown output with per-block `[N-M]` citations and 192 KiB budget; excerpt-only by default; `aiSummary` no/yes/only for Exa/Tavily native summaries; optional semantic rerank with source-credibility floor; auto-enrich thin document snippets via in-process PDF/Office parsing), `rss` (RSS/Atom parse/search/monitor), `web_crawl` ⚙️, `agentic_browse` family (`browse`/`present`/`read`/`focus`) |
| **Semantic RAG** | `semantic_crawl` ⚙️ (URL/sitemap/search/github/cached sources, BM25+embedding+RRF), `semantic_crawl_list_corpora` ⚙️, `semantic_crawl_inspect_corpus` ⚙️                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **GitHub**       | `github` family: `repo`, `file`, `list_dir`, `tree`, `search`, `trending`, `code_search`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Video/Social** | `youtube` family (search/transcript/semantic), `reddit` family (search/comments/semantic)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Research**     | `research` family (academic/arxiv/hackernews/stackoverflow/pubmed/wikipedia/openalex/crossref/datacite/ror/semantic_scholar/gdelt/wikidata/v2ex/auto)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Packages**     | `packages` family (npm/pypi)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Jobs**         | `semantic_jobs` ⚙️ — structured extraction from 20+ boards (SEEK, Indeed, LinkedIn, etc.) with constraint filtering and weighted ranking                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Browser**      | `browser` ⚙️ family (navigate/snapshot/click/type/evaluate/screenshot/extract/act/wait/pdf/storage/network/tabs/session/wait_for/dialog_handle/iframe_context/scroll_to_load/paginate/download/table_extract/network_intercept/resource_timing/diff) with CDP stealth or CloakBrowser backend                                                                                                                                                                                                                                                                                     |
| **System**       | `health_check` — live probe of all backends with tool tiers, active backend, and missing config hints                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

> ⚙️ = **config-gated**: tool is only registered when its required env vars are set. If config is missing, the tool does not appear at all — no silent failures, no broken handlers. See [Configuration](#configuration) for required vars per tool.

## Migration notes

`deep_research` and `knowledge_graph` tools were removed. Deep research orchestration migrated to the Trellis project; search-mcp is now a pure acquisition/search system.

## Quick Start

```bash
# Install
npm install -g search-mcp

# Run with stdio transport (default MCP mode)
search-mcp

# Or with Docker (full stack including SearXNG, Crawl4AI, embedding sidecar)
docker compose up -d
```

## Configuration

The server loads config from three sources (resolution order):

1. **`config.enc`** (encrypted via `SEARCH_MCP_CONFIG_KEY`) — most secure
2. **`config.json`** (plain JSON, never commit) — local development
3. **Environment variables** — CI/deployment

Copy [`config.example.json`](config.example.json) to `config.json` and fill in your values. All fields are also settable via the env vars documented below.

> `config.example.json` intentionally does **not** set `searchBackend`; Codex is main source and every configured available backend runs in parallel. Matching URLs deduplicate against Codex results. `SEARCH_BACKEND` sets fallback ordering only; it does not limit provider scope. Plain legacy `"searchBackend": "searxng"` stays non-explicit, but all configured providers still run.

### Search Backend (choose one or more)

| Variable                       | Description                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `SEARCH_BACKEND`               | Fallback preference: `brave`, `searxng`, `exa`, `duckduckgo`, `ollama-search`, `tavily`, or `codex`; all configured providers run |
| `SEARXNG_BASE_URL`             | SearXNG instance URL (privacy-first, no API key needed)                                                                           |
| `BRAVE_API_KEY`                | Brave Search API key                                                                                                              |
| `EXA_API_KEY`                  | Exa Search API key                                                                                                                |
| `TAVILY_API_KEY`               | Tavily Search API key (tavily.com)                                                                                                |
| `CODEX_ACCESS_TOKEN`           | ChatGPT/Codex access token — enables default Codex web search                                                                     |
| `CODEX_ACCOUNT_ID`             | Optional ChatGPT account ID for Codex search                                                                                      |
| `CODEX_HOME`                   | Codex config dir (default `~/.codex`) — `auth.json` is auto-discovered                                                            |
| `SEARCH_DUCKDUCKGO_REGION`     | DuckDuckGo region code (default `us-en`)                                                                                          |
| `SEARCH_DUCKDUCKGO_SAFESEARCH` | DuckDuckGo safe search (default `moderate`)                                                                                       |
| `SEARCH_OLLAMA_BASE_URL`       | Ollama web-search base URL (distinct from embedding Ollama)                                                                       |
| `SEARCH_OLLAMA_API_KEY`        | Ollama web-search API key (optional)                                                                                              |

**Codex (ChatGPT) web search — limited support:** Codex is main source when `CODEX_ACCESS_TOKEN`, or `tokens.access_token` in `$CODEX_HOME/auth.json` / `~/.codex/auth.json`, is available. Every configured available backend runs in parallel; matching URLs deduplicate while retaining Codex provenance. When embedding provider is configured, unique results are semantically reranked against query. Uses fixed `https://chatgpt.com/backend-api/codex/alpha/search` endpoint (no override). Endpoint undocumented; may change, rate-limit, or be unavailable by account; NOT official OpenAI integration. `SEARCH_BACKEND` only controls fallback ordering.

### Crawl

| Variable             | Description                                                           |
| -------------------- | --------------------------------------------------------------------- |
| `CRAWL4AI_BASE_URL`  | Crawl4AI browser service URL (required for web_crawl, semantic_crawl) |
| `CRAWL4AI_API_TOKEN` | Crawl4AI API token (optional)                                         |

### Embedding (choose one provider)

| Variable                       | Default                     | Description                                         |
| ------------------------------ | --------------------------- | --------------------------------------------------- |
| `EMBEDDING_PROVIDER`           | `sidecar`                   | `sidecar`, `ollama`, `transformers`, or `openai`    |
| `EMBEDDING_SIDECAR_BASE_URL`   | —                           | Sidecar endpoint                                    |
| `EMBEDDING_SIDECAR_API_TOKEN`  | —                           | Sidecar authentication token                        |
| `EMBEDDING_DIMENSIONS`         | `768`                       | Embedding vector dimensions (128, 256, 512, or 768) |
| `EMBEDDING_CODE_MODEL`         | —                           | Optional code-tuned embedding model for code_search |
| `EMBEDDING_OLLAMA_BASE_URL`    | `http://localhost:11434`    | Ollama server URL                                   |
| `EMBEDDING_OLLAMA_MODEL`       | `nomic-embed-text`          | Ollama embedding model                              |
| `EMBEDDING_TRANSFORMERS_MODEL` | `Xenova/all-MiniLM-L6-v2`   | Transformers.js model (in-process)                  |
| `EMBEDDING_OPENAI_BASE_URL`    | `https://api.openai.com/v1` | OpenAI-compatible API base URL                      |
| `EMBEDDING_OPENAI_MODEL`       | `text-embedding-3-small`    | OpenAI embedding model                              |
| `EMBEDDING_OPENAI_API_KEY`     | —                           | OpenAI API key                                      |

### LLM (for contextual embeddings, browser.act, deep research & `agentic_browse.focus`)

| Variable        | Description                                                         |
| --------------- | ------------------------------------------------------------------- |
| `LLM_PROVIDER`  | Model name for contextual embeddings (e.g. `gpt-4o-mini`, `llama3`) |
| `LLM_BASE_URL`  | Base URL for `/v1/chat/completions` endpoint                        |
| `LLM_API_TOKEN` | Optional API token                                                  |

### Document extraction

Document URLs are handled in-process for text-like formats (`.txt`, `.md`, `.csv`, `.json`, `.xml`, `.yaml`, `.toml`, `.ini`, `.log`, `.env`). PDF and Office files (`.pdf`, `.docx`, `.pptx`, `.xlsx`) are parsed in-process via a tiered pipeline:

1. **HTML-first:** arxiv HTML twins and stripped-extension landing pages are fetched and converted to markdown via Readability.
2. **PDF:** `pdf-parse` v2 extracts paragraph-aware text, embedded images, and best-effort tables as markdown.
3. **Office:** `officeparser` extracts text from modern Office formats.

Parsers auto-discover `pdf-parse`/`officeparser` and degrade gracefully (a warning) if absent. An opt-in **multimodal VLM tier** (`DOCUMENT_PARSING_MULTIMODAL=true`) sends extracted figures and rasterized pages to the configured LLM vision endpoint for figure/table descriptions.

`web_search` auto-enriches thin document-snippet results (e.g. arxiv abstracts) by discovering same-site PDF links and parsing the full document, capped to top-N results (`DOCUMENT_PARSING_MAX_ENRICH`, default 3).

| Variable                      | Default | Description                                                  |
| ----------------------------- | ------- | ------------------------------------------------------------ |
| `DOCUMENT_PARSING_ENABLED`    | `true`  | Enable in-process document parsing                           |
| `DOCUMENT_PARSING_MULTIMODAL` | `false` | Enable VLM figure/table descriptions (requires LLM config)   |
| `DOCUMENT_PARSING_MAX_ENRICH` | `3`     | Max results to enrich with full-text parsing in `web_search` |

### Social / Video

| Variable                | Description                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| `YOUTUBE_API_KEY`       | YouTube Data API key (optional — transcript action works without it) |
| `REDDIT_CLIENT_ID`      | Reddit OAuth app ID (optional — search works without auth)           |
| `REDDIT_CLIENT_SECRET`  | Reddit OAuth app secret                                              |
| `REDDIT_USER_AGENT`     | Reddit User-Agent header                                             |
| `STACKEXCHANGE_API_KEY` | Stack Exchange API key (optional — degrades gracefully)              |
| `GITHUB_TOKEN`          | GitHub personal access token (higher API rate limits)                |

### Browser / CDP

| Variable                    | Default      | Description                                                                                   |
| --------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `BROWSER_ENABLED`           | `false`      | Enable interactive browser/CDP tools                                                          |
| `BROWSER_MODE`              | `user`       | Browser mode: `user`, `stealth`, or `profile`                                                 |
| `BROWSER_ENGINE`            | `playwright` | Launch backend: `playwright` or `cloak` (requires `npm install cloakbrowser playwright-core`) |
| `BROWSER_EXECUTABLE_PATH`   | —            | Path to custom browser binary                                                                 |
| `BROWSER_HEADLESS`          | `true`       | Run headless                                                                                  |
| `BROWSER_VIEWPORT_WIDTH`    | `1280`       | Viewport width in px                                                                          |
| `BROWSER_VIEWPORT_HEIGHT`   | `720`        | Viewport height in px                                                                         |
| `BROWSER_USER_AGENT`        | —            | Custom User-Agent string                                                                      |
| `BROWSER_PROXY_SERVER`      | —            | Proxy server URL                                                                              |
| `BROWSER_CDP_ENDPOINT`      | —            | CDP endpoint URL (user mode)                                                                  |
| `BROWSER_CDP_PORT`          | `9222`       | CDP port for user-browser mode                                                                |
| `BROWSER_PROFILE_DIR`       | —            | Persistent profile directory path                                                             |
| `BROWSER_TIMEOUT`           | `300000`     | Max session time in ms                                                                        |
| `BROWSER_STEALTH_ENABLED`   | `true`       | Enable CDP stealth patches                                                                    |
| `BROWSER_REBROWSER`         | `false`      | Enable ReBrowser stealth                                                                      |
| `BROWSER_BYPASS_CSP`        | `false`      | Bypass Content-Security-Policy                                                                |
| `BROWSER_AUTO_CONNECT`      | `false`      | Auto-connect on startup (user mode)                                                           |
| `BROWSER_CREDENTIALS`       | —            | JSON with `{ "domain": { "username", "password", "totpSecret?" } }`                           |
| `CLOAKBROWSER_HUMANIZE`     | `false`      | Enable CloakBrowser human-like input                                                          |
| `CLOAKBROWSER_HUMAN_PRESET` | `default`    | Humanization preset: `default` or `careful`                                                   |
| `CLOAKBROWSER_LOCALE`       | —            | Locale flag (e.g. `en-US`)                                                                    |
| `CLOAKBROWSER_TIMEZONE`     | —            | Timezone flag (e.g. `America/New_York`)                                                       |
| `CLOAKBROWSER_GEOIP`        | `false`      | Auto-detect locale/timezone from proxy IP                                                     |
| `CLOAKBROWSER_STEALTH_ARGS` | `true`       | Include CloakBrowser default stealth fingerprint flags                                        |

### LLM (content extraction)

| Variable        | Default | Description                             |
| --------------- | ------- | --------------------------------------- |
| `LLM_PROVIDER`  | —       | Model name (e.g. `gpt-4o-mini`)         |
| `LLM_MODEL`     | —       | Model override (falls back to provider) |
| `LLM_BASE_URL`  | —       | OpenAI-compatible base URL              |
| `LLM_API_TOKEN` | —       | Optional API token                      |

### Security / Content

| Variable               | Default | Description                                             |
| ---------------------- | ------- | ------------------------------------------------------- |
| `DOMAIN_TRUST_ENABLED` | `false` | Enable domain trust and typosquat detection             |
| `TRUSTED_DOMAINS`      | —       | Comma-separated domains to always trust                 |
| `BLOCKED_DOMAINS`      | —       | Comma-separated domains to always block                 |
| `SCRUB_CONTENT`        | `false` | Enable content scrubbing for prompt injection detection |

### Semantic Crawl Limits

| Variable                           | Default    | Description                         |
| ---------------------------------- | ---------- | ----------------------------------- |
| `SEMANTIC_CRAWL_DEFAULT_MAX_BYTES` | `52428800` | Default max bytes per crawl (50 MB) |
| `SEMANTIC_CRAWL_MAX_MAX_BYTES`     | `52428800` | Hard cap on max bytes (50 MB)       |

### Misc

| Variable                      | Default                               | Description                                     |
| ----------------------------- | ------------------------------------- | ----------------------------------------------- |
| `DATABASE_PATH`               | `~/.cache/search-mcp/semantic-crawl/` | SQLite corpus cache path                        |
| `SEARCH_MCP_CONFIG_KEY`       | —                                     | Password for decrypting `config.enc`            |
| `CHALLENGE_LATENCY_THRESHOLD` | `5000`                                | Latency threshold in ms for challenge detection |

## HTTP Mode & Browser Dashboard

Set `HTTP_PORT` to enable an HTTP MCP transport and a React browser dashboard for managing API keys and provider configuration.

### Quick setup

```bash
# 1. Build server + dashboard
npm install
npm run install:dashboard
npm run build:all

# 2. Start in HTTP mode (generates config.enc on first run)
HTTP_PORT=8050 SEARCH_MCP_CONFIG_KEY="your-passphrase" npm start
```

On first run the server prints the initial MCP API key to stderr **once**:

```text
{"level":"info","msg":"Generated initial mcpApiKey","key":"smcp_..."}
```

```text
# 3. Open the dashboard
open http://localhost:8050/dashboard
```

Log in with the API key from step 2. Then:

- **Providers page** — enter search backend keys, test connections
- **Overview page** — copy the MCP connection URL, rotate the API key
- **Access page** — configure external access (localhost / Tailscale / manual URL)

### Connect an MCP client (HTTP mode)

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "search-mcp": {
      "type": "http",
      "url": "http://localhost:8050/mcp",
      "headers": { "Authorization": "Bearer smcp_..." }
    }
  }
}
```

### Dev mode (hot reload)

```bash
# Terminal 1 — server with hot reload
HTTP_PORT=8050 SEARCH_MCP_CONFIG_KEY="your-passphrase" npm run dev

# Terminal 2 — dashboard Vite dev server (proxies /dashboard/api → port 8050)
cd dashboard && npm run dev
```

### Environment variables (HTTP mode)

| Variable                | Required | Description                                                       |
| ----------------------- | -------- | ----------------------------------------------------------------- |
| `HTTP_PORT`             | Yes      | Port to bind (e.g. `8050`). Unset = stdio-only mode.              |
| `SEARCH_MCP_CONFIG_KEY` | Yes      | Passphrase for `config.enc` encryption.                           |
| `SESSION_TTL_HOURS`     | No       | Dashboard session lifetime (default: `12`).                       |
| `MCP_ALLOW_QUERY_KEY`   | No       | Allow `?key=` auth on `/mcp` (not recommended, may leak in logs). |

### stdio-only mode (original, unchanged)

Leave `HTTP_PORT` unset. The server reads config from `config.enc` (with `SEARCH_MCP_CONFIG_KEY`), `config.json`, or environment variables.

## Tailscale Access

Connect to search-mcp from any device on your tailnet — no port forwarding, automatic HTTPS via MagicDNS. This creates a named service at `svc-mcp-server.<tailnet>.ts.net` separate from your machine's hostname.

### On the host machine

```bash
# 1. Start search-mcp in HTTP mode
HTTP_PORT=8050 SEARCH_MCP_CONFIG_KEY="your-passphrase" npm start

# 2. Create a named HTTPS service on your tailnet
tailscale serve --service=svc:mcp-server --https=443 http://localhost:8050

# Verify
tailscale serve status
```

Then open the dashboard → **Access** → select **tailscale** → **"I configured it"**.

The dashboard shows your shareable connection URL:

```text
https://svc-mcp-server.<tailnet>.ts.net/mcp
```

### On the connecting device

For clients that support HTTP (Claude.ai, Cursor, etc.):

```json
{
  "mcpServers": {
    "search-mcp": {
      "type": "http",
      "url": "https://svc-mcp-server.<tailnet>.ts.net/mcp",
      "headers": { "Authorization": "Bearer <api-key>" }
    }
  }
}
```

For stdio-only clients, use [mcp-remote](https://github.com/geelen/mcp-remote) as a proxy:

```json
{
  "mcpServers": {
    "search-mcp": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://svc-mcp-server.<tailnet>.ts.net/mcp",
        "--header",
        "Authorization: Bearer <api-key>"
      ]
    }
  }
}
```

Your tailnet name is shown in `tailscale status` or at [tailscale.com/machines](https://tailscale.com/machines). The dashboard **Access** page auto-generates the full snippet with your real hostname and API key.

### Public internet via Funnel (advanced)

```bash
tailscale funnel --service=svc:mcp-server --https=443 http://localhost:8050
```

Only use Funnel if you need non-Tailscale clients to reach the server. It exposes `/mcp` to the public internet — anyone with the URL can attempt to connect. Dashboard → Access → Advanced → **Enable Funnel…**.

## Docker Deployment

```bash
# Clone and start all services
git clone https://github.com/rhinos0608/search-mcp.git
cd search-mcp
docker compose up -d

# Services:
#   search-mcp (port 8050)
#   embedding-sidecar (port 8001)
#   crawl4ai (port 8051)
#   searxng (port 8081)
```

See the [Full Tool Reference](docs/tools.md) for the complete tool reference.

## Web Search Pipeline

`web_search` runs every configured backend in parallel, then merges results through a multi-stage pipeline:

1. **Parallel fanout:** All configured backends (Codex, Exa, Brave, SearXNG, DuckDuckGo, Tavily, Ollama) execute simultaneously. `SEARCH_BACKEND` controls fallback ordering only — it does not limit provider scope.
2. **Richness-aware dedup:** Matching URLs are deduplicated, keeping the richest representation (full text > summary > snippet). Codex gets only a bounded tiebreak preference on near-equal scores — rich Exa/Tavily results are never starved by thin Codex snippets.
3. **Source credibility tiering:** Each result is assigned a deterministic `quality` tier (`high`/`medium`/`low`) with an explainable basis — institutional domains (`.gov`, `.edu`, research organizations from the ROR registry), known technical authorities, and user-generated platforms are scored via suffix-aware domain matching.
4. **Semantic rerank (optional):** When an embedding provider is configured, unique results are semantically reranked against the query with a source-credibility floor — low-quality sources can only outrank higher-quality ones within a narrow relevance band.
5. **Document enrichment:** Thin snippet results (e.g. arxiv abstracts) are auto-enriched by discovering same-site PDF links and parsing the full document in-process.
6. **Bare-Markdown output:** Results are formatted as clean Markdown with `## [N] Title` sections, compact `via`/`published`/`quality` metadata, and stable per-block `[N-M]` citations. A 192 KiB total budget with adaptive per-document allocation (8–24 KiB) ensures deterministic output size.
7. **Overflow artifacts:** When more usable candidates exist than the requested limit, the complete sanitized result set is written to a private per-invocation artifact file (absolute path returned inline) that an agent can read.

### Source Credibility Tiers

| Tier     | Basis                                                                | Examples                                                       |
| -------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| `high`   | Institutional domain (`.gov`, `.edu`, ROR registry), known authority | `arxiv.org`, `ieee.org`, `github.com`, `developer.mozilla.org` |
| `medium` | Established technical source, news organization, official docs       | `medium.com`, `dev.to`, `techcrunch.com`                       |
| `low`    | User-generated platform, self-hosted commercial, publishing platform | `reddit.com`, `wordpress.com`, personal blogs                  |

The tier is a ranking signal, never a truth claim. The [Domain Facts Registry](docs/domain-facts-registry.md) documents the provenance-pinned external data sources (CISA dotgov-data, ROR) that feed institutional domain matching.

## Documentation

- [Full Tool Reference](docs/tools.md) — Detailed docs for all tools
- [Architecture Overview](docs/architecture.md) — System architecture and data flow
- [Quick Start Guide](docs/quickstart.md) — Getting started with examples
- [Domain Facts Registry](docs/domain-facts-registry.md) — Institutional domain data sources and provenance
- [Integration Points](docs/integration-points.md) — Injection points for document parsing and enrichment

## License

MIT
