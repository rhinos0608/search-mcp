# search-mcp vs. Alternatives

A feature comparison of search-mcp (v3.2.0) against other MCP search/retrieval servers.

## Feature Matrix

| Feature                 | **search-mcp**                   | Kindly | Vera | mcp-local-rag | mcp-crawl4ai-rag |
| ----------------------- | -------------------------------- | ------ | ---- | ------------- | ---------------- |
| **Total tools**         | **28**                           | 3      | 4    | 6             | 9                |
| **Web search**          | ✅ Exa, Brave, SearXNG           | ✅     | ✅   | ✅            | ✅               |
| **Web read/crawl**      | ✅ Crawl4AI deep crawl           | ✅     | ❌   | ✅            | ✅               |
| **Smart extraction**    | ✅ LLM + schema                  | ❌     | ❌   | ❌            | ❌               |
| **Semantic RAG**        | ✅ BM25+embed+RRF+rerank         | ❌     | ❌   | ✅ basic      | ❌               |
| **Academic search**     | ✅ ArXiv + Semantic Scholar      | ❌     | ❌   | ❌            | ❌               |
| **YouTube transcripts** | ✅ Search + transcripts + RAG    | ❌     | ❌   | ❌            | ❌               |
| **Reddit**              | ✅ Search + comments + RAG       | ❌     | ❌   | ❌            | ❌               |
| **GitHub**              | ✅ Repo + code search + trending | ❌     | ❌   | ❌            | ❌               |
| **Stack Overflow**      | ✅ Q&A search + code blocks      | ❌     | ❌   | ❌            | ❌               |
| **Hacker News**         | ✅                               | ❌     | ❌   | ❌            | ❌               |
| **Twitter/X**           | ✅                               | ❌     | ❌   | ❌            | ❌               |
| **Product Hunt**        | ✅                               | ❌     | ❌   | ❌            | ❌               |
| **npm/PyPI**            | ✅                               | ❌     | ❌   | ❌            | ❌               |
| **Patents**             | ✅                               | ❌     | ❌   | ❌            | ❌               |
| **Podcasts**            | ✅                               | ❌     | ❌   | ❌            | ❌               |
| **Job search**          | ✅ SEEK + Indeed + Jora          | ❌     | ❌   | ❌            | ❌               |
| **Knowledge graph**     | ✅ Corpus cache + SQLite         | ❌     | ❌   | ❌            | ❌               |
| **Dedup (3-layer)**     | ✅ URL + fingerprint + semantic  | ❌     | ❌   | ❌            | ❌               |
| **Constraint ranking**  | ✅ Hard + soft constraints       | ❌     | ❌   | ❌            | ❌               |
| **Evaluation harness**  | ✅ Golden queries + P/R/nDCG     | ❌     | ❌   | ❌            | ❌               |
| **Tracing/metrics**     | ✅ Instrumentation + counters    | ❌     | ❌   | ❌            | ❌               |
| **Docker Compose**      | ✅ Full stack (4 services)       | ❌     | ❌   | ❌            | ✅               |
| **Local embeddings**    | ✅ Ollama + Transformers.js      | ❌     | ❌   | ✅            | ❌               |
| **Privacy-first mode**  | ✅ No API keys (SearXNG)         | ❌     | ❌   | ✅ local      | ❌               |
| **MCP registry**        | Listed on mcp.so, FastMCP.market | ✅     | ✅   | ❌            | ❌               |

## When to Choose search-mcp

### ✅ Strong fits

- **All-in-one research**: Need to combine web, academic, code, social, and video sources in a single pipeline
- **Job market analysis**: Structured job extraction with salary/experience constraints
- **Competitive intelligence**: Multi-source search across Product Hunt, GitHub, patents, and news
- **Privacy-first deployment**: Run fully local with SearXNG + Ollama, no external API keys
- **Quality-sensitive retrieval**: Deduplication, constraint-aware ranking, and eval harness ensure measurable quality

### ❌ Consider alternatives when

- **You need only web search**: Kindly (3 tools) or mcp-crawl4ai-rag (9 tools) are lighter
- **You need only local RAG**: mcp-local-rag is simpler for small-scale local document querying
- **You want minimal setup**: A single web search tool is faster if you only need that

## Quick Decision Guide

| Need                                           | Recommended                       |
| ---------------------------------------------- | --------------------------------- |
| Just web search                                | Kindly, mcp-crawl4ai-rag          |
| Web + crawl + RAG                              | search-mcp, mcp-local-rag         |
| Multi-source research (academic, social, code) | **search-mcp**                    |
| Job search with structured data                | **search-mcp**                    |
| Fully local, no API keys                       | **search-mcp** + SearXNG + Ollama |
| Minimal resource usage                         | Kindly (3 tools)                  |

## MCP Directory Listings

- [search-mcp on mcp.so](https://mcp.so/server/search-mcp)
- [search-mcp on FastMCP.market](https://fastmcp.market/servers/search-mcp)

## Version

This comparison reflects search-mcp **v3.2.0**. Feature availability may vary by version.
