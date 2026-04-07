# search-mcp Quickstart

An MCP server that gives AI clients tools for web search, web reading, GitHub, YouTube transcripts, and Reddit — running entirely on your machine.

---

## Prerequisites

- Node.js 18+
- The project built: `cd ~/search-mcp && npm run build`

---

## Running the server

### Development (human-readable logs)

```bash
cd ~/search-mcp && npm run dev
```

Logs are pretty-printed to stderr via pino-pretty. Restart on file changes automatically.

### Production (structured JSON logs)

```bash
cd ~/search-mcp && npm start
```

### Structured JSON logs (for piping / log aggregation)

```bash
node ~/search-mcp/dist/index.js --json
```

### Stop the server

The server runs in the foreground. Press `Ctrl+C` to stop it.

If running in the background:

```bash
pkill -f "node.*search-mcp"
```

---

## Connecting to Claude Desktop

**1. Build the server** (if not already done):

```bash
cd ~/search-mcp && npm run build
```

**2. Open the Claude Desktop config file:**

```bash
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

If the file doesn't exist yet, create it.

**3. Add the server entry:**

```json
{
  "mcpServers": {
    "search-mcp": {
      "command": "node",
      "args": ["/Users/rhinesharar/search-mcp/dist/index.js"]
    }
  }
}
```

If you already have other servers in the file, add `search-mcp` inside the existing `"mcpServers"` object.

**4. Restart Claude Desktop.** The tools will appear in Claude's tool list automatically.

To verify: ask Claude "what tools do you have?" and you should see `web_search`, `web_read`, `github_repo`, `github_trending`, `youtube_transcript`, and `reddit_search`.

---

## Connecting to other MCP clients

The server uses **stdio transport** — it reads JSON-RPC from stdin and writes responses to stdout. Any MCP-compatible client can connect by running:

```
node /Users/rhinesharar/search-mcp/dist/index.js
```

### Cursor

Add to your Cursor MCP config (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "search-mcp": {
      "command": "node",
      "args": ["/Users/rhinesharar/search-mcp/dist/index.js"]
    }
  }
}
```

### Cline / Continue / other VS Code extensions

Each extension has its own MCP config location but the same structure — `command: "node"`, `args: ["/Users/rhinesharar/search-mcp/dist/index.js"]`.

---

## Available tools

| Tool                 | What it does                                                     |
| -------------------- | ---------------------------------------------------------------- |
| `web_search`         | Web search (Brave / SearXNG), returns titles + URLs + snippets   |
| `web_read`           | Fetch a URL and extract clean article text (Mozilla Readability) |
| `github_repo`        | Stars, forks, license, topics, latest release, optional README   |
| `github_trending`    | Today's / this week's / this month's trending repos              |
| `youtube_transcript` | Full transcript from any YouTube video (by ID or URL)            |
| `reddit_search`      | Search posts across all of Reddit or within a subreddit          |

Full parameter details: see `docs/tools.md`.

---

## Environment variables

| Variable    | Default | Description                                                        |
| ----------- | ------- | ------------------------------------------------------------------ |
| `LOG_LEVEL` | `info`  | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `NODE_ENV`  | —       | Set to `production` to force JSON log output                       |

Example — verbose debug logs:

```bash
LOG_LEVEL=debug node ~/search-mcp/dist/index.js
```

---

## Rebuilding after changes

```bash
cd ~/search-mcp
npm run build        # compile TypeScript
npm run lint         # check for lint errors
npm run typecheck    # type check without emitting
npm run format       # auto-format with Prettier
```

Then restart Claude Desktop (or your client) to pick up the new build.

---

## Troubleshooting

**Tools not appearing in Claude Desktop**

- Make sure the config file is valid JSON (no trailing commas)
- Confirm the path `/Users/rhinesharar/search-mcp/dist/index.js` exists: `ls ~/search-mcp/dist/index.js`
- Restart Claude Desktop fully (quit from the menu bar, not just close the window)

**`dist/index.js` not found**

- Run `cd ~/search-mcp && npm run build` first

**Search backend errors**

- If Brave returns errors, check that `BRAVE_API_KEY` is set and valid.
- If SearXNG returns errors, verify your `SEARXNG_BASE_URL` is reachable.
- The fallback chain will try the remaining backend automatically.

**YouTube transcript unavailable**

- Some videos have transcripts disabled by the uploader
- Try a different language code (e.g. `language: "en-US"` instead of `"en"`)

**GitHub 403 / rate limit**

- Unauthenticated GitHub API: 60 requests/hour
- Slow down or wait for the window to reset

**Viewing server logs while connected to Claude Desktop**

- Claude Desktop swallows stderr by default; run the server manually in a terminal with `LOG_LEVEL=debug` to see logs while testing
