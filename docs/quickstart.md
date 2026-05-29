# search-mcp Quickstart

An MCP server that gives AI assistants tools for web search, semantic RAG, GitHub, YouTube, Reddit, academic research, and more — running entirely on your machine.

---

## Prerequisites

- Node.js 18+
- npm or equivalent

## Install & Run

```bash
# Global install
npm install -g search-mcp

# Run (stdio transport)
search-mcp
```

Configure via environment variables (see [README](../README.md#environment-variables) for full list). At minimum you need a search backend:

```bash
# Privacy-first: self-hosted SearXNG
SEARXNG_BASE_URL=http://localhost:8888 search-mcp

# Or Brave Search API
BRAVE_API_KEY=your_key search-mcp

# Or Exa API
EXA_API_KEY=your_key search-mcp
```

### From Source

```bash
git clone https://github.com/rhinos0608/search-mcp.git
cd search-mcp
npm install
npm run build
npm start           # production mode (JSON logs)
npm run dev         # development mode (pretty-printed logs)
```

## Usage with Claude

**Claude Desktop:** Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "search-mcp": {
      "command": "search-mcp",
      "env": {
        "BRAVE_API_KEY": "your_brave_api_key",
        "YOUTUBE_API_KEY": "your_youtube_api_key"
      }
    }
  }
}
```

**Claude CLI:**

```bash
export BRAVE_API_KEY=your_key
claude --mcp 'search-mcp'
```

## Browser Modes

The `browser` tool family supports three modes selected via `BROWSER_MODE` (default: `user`):

- **user** — Connects to an existing browser via CDP (you start Chrome manually with `--remote-debugging-port=9222`)
- **stealth** — Launches an ephemeral Playwright browser with anti-detection patches
- **headless** — Runs stealth/Playwright without a visible window (`BROWSER_HEADLESS=true`)

To opt into automated scraping (old default):

```bash
export BROWSER_MODE=stealth
export BROWSER_HEADLESS=true   # already the default
```

Set explicitly in config:

```json
{ "browser": { "mode": "stealth", "stealthEnabled": true } }
```

See `docs/tools.md` for a full migration guide from stealth to user mode.

## HTTP Mode & Browser Dashboard

Set `HTTP_PORT` to enable an HTTP MCP endpoint and a React dashboard for managing providers and API keys without touching config files.

### Setup

```bash
# Install and build (one-time)
npm install
npm run install:dashboard   # installs dashboard/node_modules
npm run build:all           # compiles TypeScript + Vite dashboard

# Start
HTTP_PORT=8050 SEARCH_MCP_CONFIG_KEY="your-passphrase" npm start
```

Generate a strong passphrase with `openssl rand -base64 32`.

**First run only:** the server creates `config.enc` and prints the initial API key to stderr:

```text
{"level":"info","msg":"Generated initial mcpApiKey","key":"smcp_..."}
```
This is your dashboard login password and MCP Bearer token. Store it securely — it's only shown once.

### Use the dashboard

Open `http://localhost:8050/dashboard`, log in with the key above, then:

- **Overview** — auto-generated connection URLs (with embedded API key for instant paste), ready-to-copy client config snippets for HTTP / Stdio (npx) / Tailscale (mcp-remote), provider status, and API key rotation
- **Providers** — configure search backends (Brave/Exa/SearXNG/Tavily), Reddit, YouTube, GitHub, Stack Exchange, Crawl4AI, and embedding (sidecar/Ollama/OpenAI); test connections live
- **Access** — switch between localhost / Tailscale / manual external URL, auto-generated Tailscale connection snippets

### Connect an MCP client

The dashboard **Overview** page auto-generates ready-to-paste config snippets for every client type:

**HTTP (SSE)** — for Claude.ai, Cursor, and other HTTP-capable clients:
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

**Quick Connect URL** — enabled by default. The dashboard shows a single URL with your API key embedded that works in most clients (disable with `MCP_ALLOW_QUERY_KEY=false`):
```
http://localhost:8050/mcp?key=smcp_xxxxxxxxxxxx
```

**Stdio (npx)** — for Claude Desktop and other stdio-only clients:
```json
{
  "mcpServers": {
    "search-mcp": {
      "command": "npx",
      "args": ["-y", "search-mcp"],
      "env": {
        "BRAVE_API_KEY": "your_brave_key"
      }
    }
  }
}
```

**Remote (mcp-remote)** — bridge stdio → HTTP for remote servers:
```json
{
  "mcpServers": {
    "search-mcp": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://localhost:8050/mcp",
        "--header", "Authorization: Bearer smcp_..."
      ]
    }
  }
}
```

### Dev mode

```bash
# Terminal 1 — server
HTTP_PORT=8050 SEARCH_MCP_CONFIG_KEY="your-passphrase" npm run dev

# Terminal 2 — dashboard (Vite, proxies /dashboard/api to server)
cd dashboard && npm run dev
# dashboard available at http://localhost:5173/dashboard/
```

## Tailscale Access (connect from another device)

Tailscale Serve creates a named HTTPS service at `svc-mcp-server.<tailnet>.ts.net` — no port forwarding, no certificates to manage, separate from your machine's hostname.

### Setup (run on the host machine)

```bash
# 1. Start search-mcp in HTTP mode (if not already running)
HTTP_PORT=8050 SEARCH_MCP_CONFIG_KEY="your-passphrase" npm start

# 2. Create a named HTTPS service on your tailnet
tailscale serve --service=svc:mcp-server --https=443 http://localhost:8050

# Verify
tailscale serve status
```

Then in the dashboard:
- **Access** → select **tailscale** → click **"I configured it"** — the page auto-populates connection URLs and config snippets with your real hostname and API key.
- **Overview** → the **Tailscale Quick Connect** card shows a single copy-paste URL like `https://<machine>.<tailnet>.ts.net/mcp?key=smcp_...`

### Connect from the other device

The dashboard auto-generates all snippets with your real values. Typical formats:

**Quick Connect (Tavily-style URL)** — paste this single URL into any client that supports query-param auth:
```
https://<machine>.<tailnet>.ts.net/mcp?key=smcp_xxxxxxxxxxxx
```

**HTTP (SSE)** — for Claude.ai, Cursor, etc.:
```json
{
  "mcpServers": {
    "search-mcp": {
      "type": "http",
      "url": "https://<machine>.<tailnet>.ts.net/mcp",
      "headers": { "Authorization": "Bearer smcp_..." }
    }
  }
}
```

**Stdio via mcp-remote** — for Claude Desktop and other stdio-only clients:
```json
{
  "mcpServers": {
    "search-mcp": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<machine>.<tailnet>.ts.net/mcp",
        "--header", "Authorization: Bearer smcp_..."
      ]
    }
  }
}
```

### Optional: Tailscale Funnel (public internet)

Only use Funnel if you need clients **outside your tailnet** to connect and cannot use mcp-remote as a proxy:

```bash
tailscale funnel --service=svc:mcp-server --https=443 http://localhost:8050
```

In the dashboard: Access → **Advanced: Public Funnel** → **Enable Funnel…** → type `enable funnel`. The `/mcp` endpoint becomes publicly reachable; the dashboard remains protected unless you also enable "Allow dashboard access over Funnel".

> The Bearer token is the only auth gate for public Funnel access — use a strong key and rotate it if exposed.

## Docker Deployment

```bash
# Full stack (search-mcp + Crawl4AI + embedding sidecar + SearXNG)
docker compose up -d

# Services:
#   search-mcp       (port 8050)
#   embedding-sidecar (port 8001)
#   crawl4ai          (port 8051)
#   searxng           (port 8081)
```

## What You Can Do

| Tool                   | Example                                 |
| ---------------------- | --------------------------------------- |
| `web_search`           | Search the web with Exa/Brave/SearXNG   |
| `web_read`             | Extract article content from a URL      |
| `web_crawl`            | Deep-crawl a site with Crawl4AI         |
| `semantic_crawl`       | Crawl + chunk + embed + RAG-rank a site |
| `semantic_github_code` | AST-aware code search in a repo         |
| `youtube_transcript`   | Get video captions                      |
| `reddit_search`        | Search Reddit posts                     |
| `reddit_comments`      | Fetch comment trees                     |
| `academic_search`      | Search ArXiv + Semantic Scholar         |
| `hackernews_search`    | Search HN stories                       |
| `semantic_jobs`        | Extract structured job listings         |
| `health_check`         | Verify server status                    |

## Next Steps

- [Full Tool Reference](tools.md)
- [Architecture Overview](architecture.md)
