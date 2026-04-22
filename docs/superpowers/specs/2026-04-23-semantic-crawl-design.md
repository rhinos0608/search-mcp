# Design: `semantic_crawl` Tool

**Date:** 2026-04-23
**Status:** Approved

## Overview

`semantic_crawl` is a new MCP tool that crawls a website and returns the most semantically relevant passages for a specific query, rather than full page documents. It uses a lightweight Python embedding sidecar (mirroring the existing crawl4ai sidecar pattern) running Google's EmbeddingGemma-300M to embed chunked content and rank it by cosine similarity.

The key insight driving this feature: a 50-page crawl at ~2k tokens per page produces ~100k tokens of raw markdown that an LLM must process wholesale, most of it irrelevant. Semantic chunking + retrieval moves the filtering earlier in the pipeline — we return dense signal instead of raw bulk.

## Goals

- Return ranked, relevant text chunks from a crawled domain instead of full pages.
- Be a genuine differentiator in the MCP ecosystem — no existing tool packages "crawl + semantic retrieval" as a single-shot operation.
- Maintain acceptable latency: Playwright crawl + embedding 500 chunks should be well under 30 seconds for a local model.
- Keep the architecture consistent with the existing crawl4ai sidecar pattern.

## Non-Goals

- Persistent index / session state (the natural evolution, but out of scope for v1).
- Real-time streaming of chunks during crawl.
- Support for non-markdown content types.

## Architecture

### High-level pipeline

```
1. Crawl pages via crawl4ai (existing `webCrawl` function)
2. Extract structured text from each page's markdown
3. Chunk text using markdown-aware strategy (see Chunking Strategy)
4. Send all chunk texts to Python embedding sidecar in ONE batched request
5. Embed the query in a separate `mode: "query"` call
6. Compute cosine similarity between query embedding and all chunk embeddings
7. Return topK chunks with full provenance
```

### Components

| Component | Location | Purpose |
|---|---|---|
| `semanticCrawl` handler | `src/tools/semanticCrawl.ts` | Orchestrates the full pipeline |
| `chunkMarkdown` | `src/chunking.ts` | Markdown-aware chunking |
| Embedding sidecar | External Python service | Loads EmbeddingGemma, exposes `/embed` |
| Sidecar registration | `src/server.ts` | New tool registration + gating |

## Chunking Strategy

### Heading boundary rules

- **H1** is captured as the `pageTitle` and prepended to every chunk's section chain as the root, but is **never** a split boundary.
- **Default split boundaries:** H2 and H3. Configurable via internal param `splitOn: ('h2' | 'h3' | 'h4')[]`.
- **H4+** only splits if explicitly configured.
- **Heading detection regex:** `^#{1,6}\s+` — requires a space after `#` to handle malformed headings.

### Heading chain

```
"# Page Title > ## Installation > ### Python"
```

H1 is always prepended as root. Every chunk carries this full chain.

### Atomic content units (never split inside)

1. **Code fences** (` ```...``` `)
2. **Indented code blocks**
3. **Markdown tables** (lines starting with `|` through the closing blank line or next non-table line)

These are kept whole even if they exceed the size threshold.

### Merge-forward with chaining

1. Walk sections in document order.
2. If a section is below the **50-token floor**, merge it forward into the next sibling.
3. If two (or more) consecutive tiny sections together still don't clear the floor, keep chaining them together.
4. If the **last section(s)** in the document remain below the floor with no next sibling, merge them **backward** into the previous sibling.
5. Result: every emitted chunk clears the floor, or the entire document is one chunk.

### Size-based fallback split

When a section exceeds **~400 tokens** and is not an atomic unit:

1. **First priority:** split at the nearest blank line that is **outside** an atomic unit.
2. **Second priority:** if no suitable blank line exists, split at the next sentence boundary (`. ` or `\n`).
3. **Overlap:** 20% of chunk size, but snap the overlap start to the next sentence boundary — never mid-sentence.

### Two-pass totalChunks annotation

1. Chunk a section → collect all sub-chunks into a temporary array.
2. Once the section is fully chunked, annotate each sub-chunk with `totalChunks = array.length`.
3. Then emit. Prevents placeholder `-1` bugs.

### Chunk interface

```typescript
interface MarkdownChunk {
  content: string;        // chunk text
  section: string;      // "# Page Title > ## Installation > ### Python"
  url: string;            // source page URL
  pageTitle: string | null;      // H1 title, or null if page has no headings
  chunkIndex: number;     // position within this section path
  totalChunks: number;    // total sub-chunks in this section path
  tokenEstimate: number;  // approximate token count
  charOffset: number;      // character offset within the source page
}
```

## Python Embedding Sidecar Contract

### Single endpoint: `POST /embed`

**Request body:**

```json
{
  "texts": ["chunk1 text", "chunk2 text", "..."],
  "mode": "document" | "query",
  "dimensions": 768 | 512 | 256 | 128
}
```

- `texts`: all texts in one batch. **Max recommended: 512**. Empty array `[]` → `200` with `"embeddings": []`.
- `mode`: `"document"` for chunk embeddings, `"query"` for the user query.
- `dimensions`: MRL output size. **Default 256** (good balance of quality vs. memory).

**Response body:**

```json
{
  "embeddings": [
    [0.023, -0.041, 0.012, "..."]
  ],
  "model": "google/embedding-gemma-300m",
  "modelRevision": "abc1234",
  "dimensions": 256,
  "mode": "document",
  "truncatedIndices": [2, 5]
}
```

- `embeddings`: **L2-normalized float vectors**. Callers can use dot product directly for cosine similarity.
- `modelRevision`: git hash or version tag of the loaded weights. Detects silent model updates.
- `truncatedIndices`: indices of texts that exceeded the model's context window and were silently truncated. Empty array `[]` if none.
- If the loaded model is not asymmetric (no separate query/document prefixes), `mode` is silently ignored and an `X-Embedding-Warning` header is returned.

**Error contract:**

| Status | Meaning |
|---|---|
| `400` | Invalid `mode`, `dimensions`, or non-array `texts` |
| `503` | Model not loaded yet. `Retry-After: <seconds>` header (integer seconds) |
| `500` | Internal error |

**Additional endpoints:**

- `GET /health` → `{ "status": "ok", "modelLoaded": true, "model": "...", "dimensions": 256 }`
- `GET /metrics` → Prometheus-style text for latency p50/p99, queue depth, total requests

**Note on JSON serialization:** `embeddings` are `float32` vectors serialized as JSON numbers (IEEE 64-bit double precision). Callers building large in-memory vector stores should cast to `Float32Array` after deserialization.

## MCP Tool Contract

### Tool: `semantic_crawl`

**Description:**

> Crawl a website and return the most semantically relevant passages for a specific query. Uses EmbeddingGemma (300M, local) to chunk, embed, and rank content by similarity — returning dense signal instead of raw pages.
>
> USE THIS TOOL when you need to:
> - Find specific information within a large documentation site, codebase reference, or multi-page resource
> - Answer "how does X handle Y" or "where does X explain Z" against a known URL
> - Research a specific topic across an entire domain without reading every page
> - Any query of the form "in [site/docs], find [concept/answer]"
>
> PREFER `web_crawl` instead when you need full page content, are summarising an entire site, or have no specific query to answer.
> PREFER `web_search` when you don't have a target URL.

**Input schema:**

```typescript
{
  url: z.url().describe('Seed URL to start crawling from'),
  query: z.string().describe('The semantic search query — what are you looking for?'),
  topK: z.number().int().min(1).max(50).optional().default(10)
    .describe('Number of most-relevant chunks to return (1-50, default 10)'),
  strategy: z.enum(['bfs', 'dfs']).optional().default('bfs')
    .describe('Crawl strategy: bfs (breadth-first) | dfs (depth-first)'),
  maxDepth: z.number().int().min(1).max(5).optional().default(2)
    .describe('Maximum link depth (1-5, default 2)'),
  maxPages: z.number().int().min(1).max(100).optional().default(20)
    .describe('Maximum pages to crawl (1-100, default 20)'),
  includeExternalLinks: z.boolean().optional().default(false)
    .describe('Follow external domain links (default false)'),
}
```

**Output schema:**

```typescript
{
  seedUrl: string;
  query: string;
  pagesCrawled: number;
  totalChunks: number;
  successfulPages: number;
  chunks: Array<{
    text: string;
    url: string;
    section: string;            // heading chain
    score: number;                 // cosine similarity, 0-1
    charOffset: number;
    chunkIndex: number;            // position within section
    totalChunks: number;           // total in this section path
  }>;
}
```

## Config Integration

### New env vars

| Env Var | Required | Default | Description |
|---|---|---|---|
| `EMBEDDING_SIDECAR_BASE_URL` | Yes (for registration) | — | Base URL of the embedding sidecar |
| `EMBEDDING_SIDECAR_API_TOKEN` | No | — | Bearer token for sidecar auth |
| `EMBEDDING_DIMENSIONS` | No | `256` | Default MRL output dimension |

### Gating

`semantic_crawl` is **gated** — it is only registered if `EMBEDDING_SIDECAR_BASE_URL` is set. It also requires `CRAWL4AI_BASE_URL` since it delegates to `webCrawl`. If crawl4ai is missing, `semantic_crawl` should be unconfigured with a clear remediation message.

### Health check

Add `semantic_crawl` to the health probe system:
- Config layer: checks `EMBEDDING_SIDECAR_BASE_URL` and `CRAWL4AI_BASE_URL`.
- Network probe: pings `GET /health` on the sidecar.

## Error Handling

| Scenario | Behavior |
|---|---|
| Crawl fails entirely | Return error response with `isError: true` |
| Some pages fail | Continue with successful pages, include warning |
| Sidecar unreachable | `unavailableError` with remediation |
| Sidecar returns 503 | Retry once after `Retry-After`, then fail |
| All chunks truncated | Return empty chunks array with warning |
| No chunks produced | Return empty result with `pagesCrawled: N`, `totalChunks: 0` |

## Testing Strategy

1. **Unit tests for `chunkMarkdown`** — feed known markdown, assert chunk boundaries, atomic unit preservation, merge-forward behavior, and totalChunks correctness.
2. **Integration tests for sidecar contract** — mock the sidecar HTTP server, verify batching, normalization, error handling.
3. **End-to-end test** — use a small static site (e.g., a local HTTP server with 3 pages), crawl it, query it, assert relevant chunk is in topK.

## Future Work (out of scope for v1)

- Persistent index: crawl once, query multiple times (session state / caching).
- Streaming chunks during crawl.
- Adjacent chunk reassembly: when a retrieved chunk looks mid-explanation, fetch `chunkIndex-1` and `chunkIndex+1` for context.
- Multi-query support: rank chunks against multiple queries and return the best match per query.

## Open Questions (none remaining)

All design decisions have been resolved through the brainstorming process.
