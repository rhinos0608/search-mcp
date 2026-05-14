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

- **Providers** — configure search backends (Brave/Exa/SearXNG/GitHub/etc.), test connections
- **Overview** — copy the `/mcp` URL for your MCP client, rotate the API key
- **Access** — switch between localhost / Tailscale / manual external URL

### Connect an MCP client

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

Then in the dashboard: **Access** → select **tailscale** → click **"I configured it"**.

The Access page will show your shareable connection URL and auto-generated client config snippets with your real hostname and API key.

### Connect from the other device

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

For stdio-only clients (Claude Desktop, etc.), use [mcp-remote](https://github.com/geelen/mcp-remote):

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

Replace `<tailnet>` with your tailnet name (visible in `tailscale status` or at [tailscale.com/machines](https://tailscale.com/machines)). The dashboard **Access** page auto-populates these snippets with your actual values.

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
