# search-mcp

[![npm version](https://img.shields.io/npm/v/search-mcp.svg)](https://www.npmjs.com/package/search-mcp)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green)](https://modelcontextprotocol.io)

> **36 tools** for web search, semantic RAG, code analysis, job search, academic research, and social media — all in one MCP server.

## Features at a Glance

| Category | Tools |
|---|---|
| **Web** | Search (Exa/Brave/SearXNG), Read, Extract, Crawl |
| **Semantic RAG** | Text/YouTube/Reddit/GitHub/Jobs with BM25+embedding+RRF |
| **Search** | GitHub, YouTube, Reddit, Hacker News, Twitter/X, Product Hunt |
| **Research** | Academic (ArXiv + Semantic Scholar), Patents, News, Stack Overflow |
| **Packages** | npm, PyPI |
| **Jobs** | SEEK, Indeed, LinkedIn, Jora with structured extraction |
| **Specialist** | Podcasts, Stack Exchange Q&A, GitHub trending |

## Quick Start

```bash
# Install
npm install -g search-mcp

# Run with stdio transport (default MCP mode)
search-mcp

# Or with Docker (full stack including SearXNG, Crawl4AI, embedding sidecar)
docker compose up -d
```

## Environment Variables

### Required (at least one search backend)
| Variable | Description |
|---|---|
| `SEARXNG_BASE_URL` | SearXNG instance URL (privacy-first, no API key needed) |
| `BRAVE_API_KEY` | Brave Search API key |
| `EXA_API_KEY` | Exa Search API key |

### Embedding (choose one)
| Variable | Default | Description |
|---|---|---|
| `EMBEDDING_PROVIDER` | `sidecar` | `sidecar`, `ollama`, `transformers`, or `openai` |
| `EMBEDDING_SIDECAR_BASE_URL` | — | Sidecar endpoint |
| `EMBEDDING_OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `EMBEDDING_OLLAMA_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `EMBEDDING_TRANSFORMERS_MODEL` | `Xenova/all-MiniLM-L6-v2` | Transformers.js model (in-process) |
| `EMBEDDING_DIMENSIONS` | `768` | Embedding vector dimensions |

### Optional
| Variable | Description |
|---|---|
| `CRAWL4AI_BASE_URL` | Crawl4AI browser service URL |
| `YOUTUBE_API_KEY` | YouTube Data API key |
| `REDDIT_CLIENT_ID` | Reddit OAuth app ID |
| `REDDIT_CLIENT_SECRET` | Reddit OAuth app secret |
| `GITHUB_TOKEN` | GitHub personal access token |
| `LISTENNOTES_API_KEY` | ListenNotes API key (podcasts) |
| `PRODUCTHUNT_API_TOKEN` | Product Hunt API token |
| `STACKEXCHANGE_API_KEY` | Stack Exchange API key |
| `EMBEDDING_SIDECAR_API_TOKEN` | Sidecar authentication token |

## Docker Deployment

```bash
# Clone and start all services
git clone https://github.com/your-org/search-mcp.git
cd search-mcp
docker compose up -d

# Services:
#   search-mcp (port 8050)
#   embedding-sidecar (port 8001)
#   crawl4ai (port 8051)
#   searxng (port 8081)
```

See [docs/comparison.md](docs/comparison.md) for a full feature comparison with other MCP servers.

## Documentation

- [Full Tool Reference](docs/tools.md) — Detailed docs for all 36 tools
- [Architecture Overview](docs/architecture.md) — System architecture and data flow
- [Quick Start Guide](docs/quickstart.md) — Getting started with examples
- [Feature Comparison](docs/comparison.md) — search-mcp vs. alternatives
- [Changelog](CHANGELOG.md) — Release history

## License

MIT
