# search-mcp — Context-Efficient Search

Copy this file into your project as `CLAUDE.md` (Claude Code), `AGENTS.md` (Codex/OpenCode), `GEMINI.md` (Gemini/Antigravity), or your platform's routing file. It teaches the AI agent to use search-mcp tools without flooding its context window.

---

## Context Protection Rules

search-mcp returns rich search results from multiple backends. Every result enters your context window. These rules keep your context healthy.

## Think in Code — MANDATORY

When processing search results (> 3 results or > 5KB), **write code** via `ctx_execute(language, code)` and `console.log()` only the answer. Do NOT read raw search results into context to analyze manually. PROGRAM the analysis, not COMPUTE it.

## Tool Selection

| Priority | Tool | Use Case |
|----------|------|----------|
| 1. SEARCH | `web_search` | Primary web search with cross-backend merging |
| 2. READ | `web_read` | Fetch and extract single-page content |
| 3. CRAWL | `semantic_crawl` | Multi-page crawl with semantic ranking |
| 4. KNOWLEDGE | `knowledge_graph` (ingest | query | status | family_*) | Entity extraction and knowledge graph |
| 5. DEEP | `deep_research` | Multi-source research (job/poll protocol) |
| 6. PACKAGES | `packages` (npm/PyPI) | Package registry search |
| 7. GITHUB | `github` (repo/file/tree/search) | GitHub integration |
| 8. SOCIAL | `youtube` / `reddit` | Video transcripts and Reddit search |
| 9. HEALTH | `health_check` | Server status and output budget |

## Processing Patterns

### Filter search results
```
ctx_execute("javascript", `
  const results = JSON.parse(SEARCH_RESULT);
  const relevant = results.filter(r => r.score > 0.7);
  console.log(JSON.stringify(relevant, null, 2));
`);
```

### Compare across queries
```
ctx_execute("javascript", `
  const a = JSON.parse(RESULTS_A);
  const b = JSON.parse(RESULTS_B);
  const common = a.filter(ra => b.some(rb => rb.url === ra.url));
  console.log(\`Common URLs: \${common.length}\`);
`);
```

### Extract structured data
```
ctx_execute_file(path: "crawl_output.json", language: "javascript", code: `
  const parsed = JSON.parse(FILE_CONTENT);
  const headings = parsed.chunks.filter(c => c.title).map(c => c.title);
  console.log(headings.join('\\n'));
`);
```

## Output Budget

Every search-mcp response is tracked for context consumption:

```
health_check  →  Check output_budget section for per-tool byte counts
```

Tracked: total calls, bytes returned, cache hits, savings ratio, per-tool breakdown.

## Session Continuity

After `/clear` or `/compact`: previous `semantic_crawl` results in corpus cache. Re-query via `source: { type: 'cached', corpusId }`.

---

*Generated from search-mcp. Install with: `npm install -g search-mcp`*
