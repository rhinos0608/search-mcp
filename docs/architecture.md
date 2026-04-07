# Architecture

## What is MCP?

Model Context Protocol (MCP) is an open standard that lets AI assistants (clients) call external tools and access resources through a defined JSON-RPC interface. An MCP server exposes a set of named tools; the client discovers them, sends structured call requests, and receives structured responses.

`search-mcp` is a stdio-transport MCP server. Communication follows this flow:

```
AI client (e.g. Claude Desktop, claude CLI)
    │
    │  JSON-RPC messages → stdin
    │  JSON-RPC messages ← stdout
    │  log output        ← stderr
    ▼
search-mcp process
```

The server never writes anything other than JSON-RPC frames to stdout. All logging is unconditionally routed to stderr so that log output never corrupts the protocol stream.

---

## Project Structure

```
search-mcp/
├── docs/                    # documentation
├── src/
│   ├── index.ts             # entry point, CLI flags, transport setup
│   ├── server.ts            # McpServer creation and tool registration
│   ├── logger.ts            # pino logger (always writes to stderr)
│   ├── types.ts             # shared TypeScript types
│   └── tools/               # one file per tool
│       ├── webSearch.ts
│       ├── webRead.ts
│       ├── githubRepo.ts
│       ├── githubTrending.ts
│       ├── youtubeTranscript.ts
│       └── redditSearch.ts
├── package.json
├── tsconfig.json
└── eslint.config.js
```

### `src/index.ts`

The process entry point. Responsibilities:

- Parse CLI flags (currently `--json`)
- Instantiate the pino logger with the appropriate formatter
- Create the `McpServer` (from `server.ts`)
- Attach a `StdioServerTransport` and call `server.connect(transport)`

### `src/server.ts`

Creates the `McpServer` instance (via `@modelcontextprotocol/sdk`) and registers every tool by calling each tool module's registration function. Keeping tool registration centralised here means `index.ts` stays thin and each tool file is independently testable.

### `src/logger.ts`

Wraps pino and forces all output to `process.stderr`. This module is imported by every part of the codebase that needs logging. Nothing else writes to stderr directly.

### `src/types.ts`

Shared TypeScript interfaces and type aliases used across tool files (e.g. result shapes, common option types). Centralising types here prevents circular imports and keeps tool files focused on logic.

### `src/tools/`

One file per MCP tool. Each file exports a single registration function that accepts the `McpServer` instance and calls `server.tool(name, schema, handler)`. Splitting tools into separate files keeps each file small, makes individual tools easy to find and modify, and avoids merge conflicts when multiple tools are developed in parallel.

---

## The `--json` Flag

By default (development mode), log lines are piped through `pino-pretty` so they are human-readable in a terminal:

```
[12:34:56.789] INFO  server: tool registered name=web_search
```

When `--json` is passed, pino emits raw newline-delimited JSON:

```json
{ "level": 30, "time": 1711234567890, "msg": "tool registered", "name": "web_search" }
```

Use `--json` in production or when feeding logs into a log aggregation system (Datadog, Loki, CloudWatch, etc.). The flag has no effect on the JSON-RPC protocol stream on stdout.

---

## Tool Response Shape

Every tool handler returns an object with two top-level keys:

```ts
{
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
}
```

- `content[0].text` — a JSON string. Required by the base MCP spec; all clients can read this.
- `structuredContent` — the same data as a plain object. MCP clients that support the structured-content extension (e.g. newer versions of Claude Desktop) receive this directly without needing to parse a string.

Both fields always contain the same data. This dual-encoding ensures compatibility with both old and new MCP client implementations.

---

## Error Handling

The philosophy is: **errors are loud**.

| Layer                         | Behaviour                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unhandled / unexpected errors | Thrown normally; `@modelcontextprotocol/sdk` catches them and returns a JSON-RPC protocol-level error (`code`, `message`) to the client.                |
| Expected tool-level errors    | Returned as a successful JSON-RPC response but with `isError: true` and the error message in `content[0].text`.                                         |
| Debug mode                    | Stack traces are included in tool-level error responses so the AI client (or the developer inspecting logs) can see exactly where the failure occurred. |

Swallowing errors silently would make it impossible for the AI client to recover gracefully or report a useful message to the user. Loud errors surface problems immediately.

---

## Dependencies

| Package                     | Purpose                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | Official TypeScript SDK for MCP. Handles the JSON-RPC framing, tool registration, schema validation, and stdio transport so the server only needs to implement handler logic.       |
| `zod`                       | Runtime schema validation and TypeScript type inference for tool input parameters. Used by `@modelcontextprotocol/sdk` to validate incoming arguments before the handler is called. |
| `pino`                      | High-performance structured logger. Writes to stderr only. Low overhead compared to alternatives; native JSON output makes log aggregation straightforward.                         |
| `@mozilla/readability`      | Port of Firefox Reader View. Strips navigation, ads, and boilerplate from a fetched HTML page and returns the main article content. Used by `web_read`.                             |
| `jsdom`                     | Parses raw HTML into a DOM tree that `@mozilla/readability` can traverse. Used alongside `@mozilla/readability` in `web_read`.                                                      |
| `cheerio`                   | Fast server-side jQuery-style HTML parsing. Used by `github_trending` to scrape the GitHub trending page, which has no official API.                                                |
| `youtube-transcript`        | Fetches the auto-generated or manual caption transcript for a YouTube video. Used by `youtube_transcript`.                                                                          |
