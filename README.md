# search-mcp

[![npm version](https://img.shields.io/npm/v/search-mcp.svg)](https://www.npmjs.com/package/search-mcp)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green)](https://modelcontextprotocol.io)

> **14 MCP tools** (7 standalone + 6 family tools + 1 deep research job-poll tool) for web search, semantic RAG, code analysis, job search, academic research, social media, and browser automation — all in one MCP server.

## Features at a Glance

| Category | Tools |
|---|---|
| **Web** | `web_search` (Exa/Brave/SearXNG/DuckDuckGo/Tavily/Ollama Search), `web_read`, `web_crawl` |
| **Semantic RAG** | `semantic_crawl` (URL/sitemap/search/github/cached sources, BM25+embedding+RRF), `fetch_focus` |
| **GitHub** | `github` family: `repo`, `file`, `tree`, `search`, `trending`, `code_search` |
| **Video/Social** | `youtube` family (search/transcript/semantic), `reddit` family (search/comments/semantic) |
| **Research** | `research` family (academic/arxiv/hackernews/stackoverflow/pubmed/wikipedia), `deep_research` (agent/pipeline/tree via job-poll protocol) |
| **Packages** | `packages` family (npm/pypi) |
| **Jobs** | `semantic_jobs` — structured extraction from 20+ boards (SEEK, Indeed, LinkedIn, etc.) with constraint filtering and weighted ranking |
| **Browser** | `browser` family (navigate/snapshot/click/type/evaluate/screenshot/extract/act/wait/pdf/storage/network/tabs/session) with CDP stealth or CloakBrowser backend |
| **System** | `health_check` — live probe of all backends |

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

### Search Backend (choose one or more)

| Variable | Description |
|---|---|
| `SEARCH_BACKEND` | Primary backend: `brave`, `searxng`, `exa`, `duckduckgo`, `ollama-search`, or `tavily` |
| `SEARXNG_BASE_URL` | SearXNG instance URL (privacy-first, no API key needed) |
| `BRAVE_API_KEY` | Brave Search API key |
| `EXA_API_KEY` | Exa Search API key |
| `TAVILY_API_KEY` | Tavily Search API key (tavily.com) |
| `SEARCH_DUCKDUCKGO_REGION` | DuckDuckGo region code (default `us-en`) |
| `SEARCH_DUCKDUCKGO_SAFESEARCH` | DuckDuckGo safe search (default `moderate`) |
| `SEARCH_OLLAMA_BASE_URL` | Ollama web-search base URL (distinct from embedding Ollama) |
| `SEARCH_OLLAMA_API_KEY` | Ollama web-search API key (optional) |

### Crawl

| Variable | Description |
|---|---|
| `CRAWL4AI_BASE_URL` | Crawl4AI browser service URL (required for web_crawl, web_read, semantic_crawl) |
| `CRAWL4AI_API_TOKEN` | Crawl4AI API token (optional) |

### Embedding (choose one provider)

| Variable | Default | Description |
|---|---|---|
| `EMBEDDING_PROVIDER` | `sidecar` | `sidecar`, `ollama`, `transformers`, or `openai` |
| `EMBEDDING_SIDECAR_BASE_URL` | — | Sidecar endpoint |
| `EMBEDDING_SIDECAR_API_TOKEN` | — | Sidecar authentication token |
| `EMBEDDING_DIMENSIONS` | `768` | Embedding vector dimensions (128, 256, 512, or 768) |
| `EMBEDDING_CODE_MODEL` | — | Optional code-tuned embedding model for code_search |
| `EMBEDDING_OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `EMBEDDING_OLLAMA_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `EMBEDDING_TRANSFORMERS_MODEL` | `Xenova/all-MiniLM-L6-v2` | Transformers.js model (in-process) |
| `EMBEDDING_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API base URL |
| `EMBEDDING_OPENAI_MODEL` | `text-embedding-3-small` | OpenAI embedding model |
| `EMBEDDING_OPENAI_API_KEY` | — | OpenAI API key |

### LLM (for contextual embeddings & fetch_focus)

| Variable | Description |
|---|---|
| `LLM_PROVIDER` | Model name for contextual embeddings (e.g. `gpt-4o-mini`, `llama3`) |
| `LLM_BASE_URL` | Base URL for `/v1/chat/completions` endpoint |
| `LLM_API_TOKEN` | Optional API token |

### RAG-Anything Bridge (multimodal document extraction)

| Variable | Default | Description |
|---|---|---|
| `RAGA_ENABLED` | `false` | Enable RAG-Anything bridge (`true`/`false`) |
| `RAGA_BRIDGE_URL` | `http://localhost:8000` | RAG-Anything bridge URL |
| `RAGA_DEFAULT_PARSER` | `auto` | Parser selection: `auto`, `docling`, `paddleocr`, `mineru` |
| `RAGA_TIMEOUT_MS` | `30000` | Bridge request timeout in ms |
| `RAGA_MAX_RETRIES` | `2` | Max retries on bridge failure |
| `RAGA_CACHE_ENABLED` | `true` | Cache extraction results |

### Social / Video

| Variable | Description |
|---|---|
| `YOUTUBE_API_KEY` | YouTube Data API key (optional — transcript action works without it) |
| `REDDIT_CLIENT_ID` | Reddit OAuth app ID (optional — search works without auth) |
| `REDDIT_CLIENT_SECRET` | Reddit OAuth app secret |
| `REDDIT_USER_AGENT` | Reddit User-Agent header |
| `STACKEXCHANGE_API_KEY` | Stack Exchange API key (optional — degrades gracefully) |
| `GITHUB_TOKEN` | GitHub personal access token (higher API rate limits) |

### Browser / CDP (V5.2)

| Variable | Default | Description |
|---|---|---|
| `BROWSER_ENABLED` | `false` | Enable interactive browser/CDP tools |
| `BROWSER_MODE` | `stealth` | Browser mode: `stealth`, `user`, or `profile` |
| `BROWSER_ENGINE` | `playwright` | Launch backend: `playwright` or `cloak` (requires `npm install cloakbrowser playwright-core`) |
| `BROWSER_EXECUTABLE_PATH` | — | Path to custom browser binary |
| `BROWSER_HEADLESS` | `true` | Run headless |
| `BROWSER_VIEWPORT_WIDTH` | `1280` | Viewport width in px |
| `BROWSER_VIEWPORT_HEIGHT` | `720` | Viewport height in px |
| `BROWSER_USER_AGENT` | — | Custom User-Agent string |
| `BROWSER_PROXY_SERVER` | — | Proxy server URL |
| `BROWSER_CDP_ENDPOINT` | — | CDP endpoint URL (user mode) |
| `BROWSER_CDP_PORT` | `9222` | CDP port for user-browser mode |
| `BROWSER_PROFILE_DIR` | — | Persistent profile directory path |
| `BROWSER_TIMEOUT` | `300000` | Max session time in ms |
| `BROWSER_STEALTH_ENABLED` | `true` | Enable CDP stealth patches |
| `BROWSER_REBROWSER` | `false` | Enable ReBrowser stealth |
| `BROWSER_BYPASS_CSP` | `false` | Bypass Content-Security-Policy |
| `BROWSER_AUTO_CONNECT` | `false` | Auto-connect on startup (user mode) |
| `BROWSER_CREDENTIALS` | — | JSON with `{ "domain": { "username", "password", "totpSecret?" } }` |
| `CLOAKBROWSER_HUMANIZE` | `false` | Enable CloakBrowser human-like input |
| `CLOAKBROWSER_HUMAN_PRESET` | `default` | Humanization preset: `default` or `careful` |
| `CLOAKBROWSER_LOCALE` | — | Locale flag (e.g. `en-US`) |
| `CLOAKBROWSER_TIMEZONE` | — | Timezone flag (e.g. `America/New_York`) |
| `CLOAKBROWSER_GEOIP` | `false` | Auto-detect locale/timezone from proxy IP |
| `CLOAKBROWSER_STEALTH_ARGS` | `true` | Include CloakBrowser default stealth fingerprint flags |

### Deep Research (V4.0.0 — opt-in)

| Variable | Default | Description |
|---|---|---|
| `DEEP_RESEARCH_ENABLED` | `false` | Enable deep research tool |
| `DEEP_RESEARCH_BASE_URL` | — | OpenAI-compatible base URL for orchestrator LLM (without `/v1`) |
| `DEEP_RESEARCH_WORKER_BASE_URL` | — | Optional separate base URL for worker LLM |
| `DEEP_RESEARCH_MODEL` | — | Orchestrator model (e.g. `gpt-4o`, `claude-sonnet-4`) |
| `DEEP_RESEARCH_WORKER_MODEL` | — | Worker model (e.g. `gpt-4o-mini`, `llama-3.1-8b`) |
| `DEEP_RESEARCH_API_TOKEN` | — | Optional API token for authenticated LLM endpoints |
| `DEEP_RESEARCH_DEFAULT_DEPTH` | `standard` | Depth profile: `quick`, `standard`, `deep`, `exhaustive`, `tree` |
| `DEEP_RESEARCH_AGENT_MAX_ITERATIONS` | `30` | Max top-level ReAct steps |
| `DEEP_RESEARCH_AGENT_MAX_SUB_ITERATIONS` | `8` | Max per-subtopic agent steps |
| `DEEP_RESEARCH_AGENT_DEFAULT_FETCH_MODE` | `summary_focus_query` | Fetch mode: `full`, `summary_focus_query`, or `disabled` |

### Security / Content

| Variable | Default | Description |
|---|---|---|
| `DOMAIN_TRUST_ENABLED` | `false` | Enable domain trust and typosquat detection |
| `TRUSTED_DOMAINS` | — | Comma-separated domains to always trust |
| `BLOCKED_DOMAINS` | — | Comma-separated domains to always block |
| `SCRUB_CONTENT` | `false` | Enable content scrubbing for prompt injection detection |

### Semantic Crawl Limits

| Variable | Default | Description |
|---|---|---|
| `SEMANTIC_CRAWL_DEFAULT_MAX_BYTES` | `52428800` | Default max bytes per crawl (50 MB) |
| `SEMANTIC_CRAWL_MAX_MAX_BYTES` | `52428800` | Hard cap on max bytes (50 MB) |

### Misc

| Variable | Default | Description |
|---|---|---|
| `DATABASE_PATH` | `~/.cache/search-mcp/semantic-crawl/` | SQLite corpus cache path |
| `SEARCH_MCP_CONFIG_KEY` | — | Password for decrypting `config.enc` |
| `CHALLENGE_LATENCY_THRESHOLD` | `5000` | Latency threshold in ms for challenge detection |

## HTTP Mode & Browser Dashboard (V6.0)

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

| Variable | Required | Description |
|---|---|---|
| `HTTP_PORT` | Yes | Port to bind (e.g. `8050`). Unset = stdio-only mode. |
| `SEARCH_MCP_CONFIG_KEY` | Yes | Passphrase for `config.enc` encryption. |
| `SESSION_TTL_HOURS` | No | Dashboard session lifetime (default: `12`). |
| `MCP_ALLOW_QUERY_KEY` | No | Allow `?key=` auth on `/mcp` (not recommended, may leak in logs). |

### stdio-only mode (original, unchanged)

Leave `HTTP_PORT` unset. The server reads config from `config.enc` (with `SEARCH_MCP_CONFIG_KEY`), `config.json`, or environment variables — same as before V6.0.

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


See the [Full Tool Reference](docs/tools.md) for the full tool reference.

## Documentation

- [Full Tool Reference](docs/tools.md) — Detailed docs for all 14 tools
- [Architecture Overview](docs/architecture.md) — System architecture and data flow
- [Quick Start Guide](docs/quickstart.md) — Getting started with examples

## License

MIT
