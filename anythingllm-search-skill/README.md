# AnythingLLM Search MCP Skill

An AnythingLLM custom agent skill that exposes every tool from the [search-mcp](https://github.com/rhinesharar/search-mcp) server.

## Tools Available

- `web_search` — Multi-backend web search (Brave / SearXNG)
- `web_read` — Fetch and extract article content from any URL
- `github_repo` — Repository metadata, stars, forks, README
- `github_trending` — Trending repositories by language and time range
- `youtube_transcript` — Video captions / transcripts
- `reddit_search` — Search Reddit posts by subreddit or globally
- `reddit_comments` — Fetch a post and its full comment tree
- `twitter_search` — Search Twitter/X via Nitter
- `producthunt_search` — Product Hunt launches and tools
- `patent_search` — USPTO patents via PatentsView
- `podcast_search` — Podcast episodes via ListenNotes
- `academic_search` — ArXiv + Semantic Scholar papers
- `hackernews_search` — Hacker News stories and comments
- `youtube_search` — YouTube video discovery
- `arxiv_search` — Fast ArXiv-only search with date/category filters
- `stackoverflow_search` — Stack Overflow questions
- `npm_search` — npm package registry search
- `pypi_search` — PyPI package search
- `news_search` — Recent news articles via GDELT
- `health_check` — Live health check of all configured tools

## Installation

1. Build the MCP server (from the search-mcp repo root):

   ```bash
   npm install
   npm run build
   ```

2. Copy this skill folder into your AnythingLLM storage directory:

   ```bash
   # Docker / local
   cp -r anythingllm-search-skill <STORAGE_DIR>/plugins/agent-skills/

   # Desktop
   cp -r anythingllm-search-skill ~/Library/Application\ Support/anythingllm/storage/plugins/agent-skills/
   ```

3. Reload the AnythingLLM page (or restart the instance).

## Configuration

The skill needs to locate the compiled MCP server (`dist/index.js`). By default it looks two directories above the skill folder (`../../dist/index.js`), which works if the skill is copied inside the search-mcp repository.

If your search-mcp repo lives elsewhere, set one of these environment variables before starting AnythingLLM:

| Variable | Description |
|----------|-------------|
| `SEARCH_MCP_PATH` | Full path to `dist/index.js` |
| `SEARCH_MCP_CWD` | Working directory for the MCP server process |

### Example

```bash
export SEARCH_MCP_PATH=/home/user/search-mcp/dist/index.js
export SEARCH_MCP_CWD=/home/user/search-mcp
```

## Required MCP Configuration

The underlying MCP server reads API keys from environment variables or an encrypted config file. See the search-mcp `CLAUDE.md` for the full list. Common ones:

- `BRAVE_API_KEY` or `SEARXNG_BASE_URL` for web search
- `YOUTUBE_API_KEY` for YouTube search
- `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` for Reddit OAuth (optional)
- `NITTER_BASE_URL` for Twitter search
- `PRODUCTHUNT_API_TOKEN` for Product Hunt
- `PATENTSVIEW_API_KEY` for patents
- `LISTENNOTES_API_KEY` for podcasts
- `STACKEXCHANGE_API_KEY` for Stack Overflow (optional, higher rate limits)

## Usage in AnythingLLM

Once loaded, the agent can invoke any of the exported functions. Examples:

- `web_search({ query: "latest TypeScript features", limit: 10 })`
- `github_repo({ owner: "microsoft", repo: "vscode" })`
- `reddit_search({ query: "MCP server", subreddit: "LocalLLaMA", limit: 5 })`
- `academic_search({ query: "transformer architecture", limit: 10 })`

All functions return a JSON string. The LLM can parse the `data` array inside the returned object.
