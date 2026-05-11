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
