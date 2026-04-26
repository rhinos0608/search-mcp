# Competitive Analysis Research Document

**Date**: 2026-04-26
**Author**: Claude Code
**Purpose**: Comprehensive competitive analysis of local-first MCP servers for web search, crawling, and RAG

---

## Executive Summary

search-mcp is the **most architecturally mature** local-first MCP server for web search, crawling, and RAG. However, the competitive landscape has evolved with new entrants targeting specific niches. This document catalogs all findings and proposes integration opportunities.

---

## Part 1: Competitive Landscape

### Full Competitive Table

| Project                         | ⭐ Stars | 🍴 Forks | 📝 Commits | 🏗️ LOC | 🧪 Tests | 🔧 Tools | Status         | Key Differentiator                                     |
| ------------------------------- | -------- | -------- | ---------- | ------ | -------- | -------- | -------------- | ------------------------------------------------------ |
| **search-mcp**                  | —        | —        | 185        | 21,554 | 78       | 36       | 🟢 Active      | Full RAG pipeline, SQLite caching, multi-source        |
| **mcp-crawl4ai-rag** (coleam00) | 2,143    | 572      | ~20        | ~1,500 | ~2       | 9        | 🟡 Fork of     | Supabase vector DB, knowledge graph, Docker            |
| **crawl4ai-rag-mcp** (ToKiDoO)  | 38       | 8        | ~15        | ~1,500 | ~2       | 9        | 🟡 Fork of     | SearXNG integration, Docker Compose bundle             |
| **mcp-local-rag** (shinpr)      | 237      | 42       | 187        | ~3,000 | 10+      | 7        | 🟢 Very Active | Pure local, LanceDB, Transformers.js, CLI              |
| **web-search-mcp** (stalled)    | 807      | 157      | ~25        | ~800   | 0        | 8        | 🔴 Stalled     | Tavily aggregator, no commits since Aug 2025           |
| **Kindly Web Search**           | 294      | 16       | ~50        | ~1,000 | 0        | 2        | 🟢 Active      | StackOverflow/GitHub API integration, browser fallback |
| **one-search-mcp**              | 107      | 26       | ~40        | ~500   | 0        | 5        | 🟡 Active      | Multi-provider aggregator                              |
| **Vera** (lemon07r)             | 66       | 7        | ~100       | ~5,000 | 1        | 4        | 🟢 Active      | Rust code search, BM25+vector+rerank, 65 languages     |
| **Yagami** (ahkohd)             | 25       | 2        | ~30        | ~2,000 | 0        | 8        | 🟢 Active      | Local-first agent, Pi extension                        |
| **searxng-mcp**                 | 1        | —        | 70+        | ~400   | 0        | 3        | 🟢 Burst       | SearXNG integration, fast development                  |
| **apify/mcp-server**            | 204      | 29       | ~30        | ~200   | 0        | 3        | 🔴 Deprecated  | Cloud-based, migrated to mcp.apify.com                 |
| **sadiuysal/crawl4ai-mcp**      | 82       | 10       | 15         | ~800   | 0        | 4        | 🟡 Active      | Lightweight Crawl4AI wrapper, Docker                   |
| **doITmagic/rag-code-mcp**      | 36       | 6        | ~40        | ~2,000 | ?        | 5        | 🟢 Active      | Code-focused, multi-language AST, Go                   |
| **WEB-SCRAPING-MCP**            | 27       | 5        | ~10        | ~300   | 0        | 5        | 🟡 New         | Simple web scraping                                    |
| **searxng-crawl4ai-mcp**        | 16       | 0        | 4          | ~200   | 0        | 2        | 🔴 Abandoned   | Combined SearXNG + Crawl4AI                            |
| **webcrawl-mcp**                | 9        | 0        | ~10        | ~150   | 0        | 3        | 🟡 New         | Simple crawl wrapper                                   |

---

## Part 2: Tier Analysis

### 🏆 Tier 1: Comprehensive RAG Solutions

#### 1. **search-mcp** (THIS PROJECT)

- **Strengths**: Full RAG pipeline, 36 tools, SQLite corpus cache, AST-aware chunking, tree-sitter, multi-source (YouTube, Reddit, academic, jobs, patents, podcasts)
- **Weaknesses**: Complex setup requiring sidecar service, 72KB server.ts maintainability concern, no Docker Compose bundle, no Ollama/local embedding option
- **Best for**: Researchers, power users needing multi-source search with RAG

#### 2. **Kindly Web Search** (NEW ENTRANT)

- **Stars**: 294, **Active**: Yes
- **Strengths**: StackOverflow/GitHub/Wikipedia/arXiv API integration, nodriver browser automation, structured error messages, diagnostic emitters, multi-transport support
- **Weaknesses**: Only 2 tools (web_search, get_content), no RAG, no vector storage, no corpus caching
- **Best for**: AI coding assistants needing "full conversation" retrieval from StackOverflow/GitHub

#### 3. **mcp-crawl4ai-rag** (coleam00)

- **Strengths**: 2,143 stars, knowledge graph, Docker support, Supabase integration, contextual embeddings, agentic RAG
- **Weaknesses**: Requires OpenAI API + Supabase (not free), complex setup
- **Best for**: AI coding assistants with budget for cloud services

#### 4. **crawl4ai-rag-mcp** (ToKiDoO fork)

- **Strengths**: Docker Compose bundle (one-command deploy), SearXNG included
- **Weaknesses**: Same limitations as parent (OpenAI + Supabase required)
- **Best for**: Users wanting zero-config deployment

---

### 🔧 Tier 2: Specialized Solutions

#### 5. **mcp-local-rag** (shinpr)

- **Stars**: 237, **Commits**: 187
- **Strengths**: Pure local, LanceDB, Transformers.js, CLI + MCP, semantic chunking, keyword boost hybrid search
- **Weaknesses**: Local files only, not for web search
- **Best for**: Privacy-focused local document search
- **Key innovation**: Semantic chunking + keyword boost hybrid search

#### 6. **Vera** (lemon07r, Rust)

- **Stars**: 66, **Commits**: ~100
- **Strengths**: BM25 + vector similarity + cross-encoder reranking (MRR@10 = 0.91), 65 languages, tree-sitter parsing, eval harness with benchmarks, agent skills system, output budget management
- **Weaknesses**: Code-focused only, not for web search
- **Best for**: Code repository navigation with high precision

#### 7. **doITmagic/rag-code-mcp** (Go)

- **Stars**: 36, **Forks**: 6
- **Strengths**: Multi-language AST (Go, PHP, Python, JS/TS), Qdrant vector DB, Ollama, knowledge graph for hallucination detection
- **Weaknesses**: Code-focused only, Go-based setup
- **Best for**: Code repository navigation with Neo4j hallucination detection

#### 8. **sadiuysal/crawl4ai-mcp-server**

- **Stars**: 82, **Forks**: 10
- **Strengths**: Lightweight, Docker image available, 4 tools (scrape, crawl, crawl_site, crawl_sitemap)
- **Weaknesses**: Basic, no RAG, no vector storage
- **Best for**: Simple scraping without vector storage

---

### 🔄 Tier 3: Aggregators

#### 9. **one-search-mcp**

- **Stars**: 107
- **Strengths**: Multi-provider (Tavily, Brave, DuckDuckGo)
- **Weaknesses**: Just routes to external APIs
- **Best for**: Users wanting unified interface to paid services

#### 10. **web-search-mcp** (stalled)

- **Stars**: 807 (historical popularity)
- **Weaknesses**: Stalled since Aug 2025, Tavily-only
- **Best for**: Historical reference, not current use

---

### ⚡ Tier 4: Fast-Moving New Entrants

#### 11. **searxng-mcp**

- **Stars**: 1, **Commits**: 70+
- **Strengths**: Pure SearXNG, fast development
- **Weaknesses**: New, unproven, 1 star
- **Best for**: Watching for rapid development

#### 12. **Yagami** (ahkohd)

- **Stars**: 25, **Active**: Yes (pushed 2 days ago)
- **Strengths**: Local-first agent, Pi extension (`@ahkohd/pi-yagami-search`), npm published, Qwen3.5-9b integration
- **Weaknesses**: New, limited documentation
- **Best for**: Pi coding agent users

---

## Part 3: Code Architecture Patterns

### Pattern Analysis Matrix

| Pattern                        | Kindly | Vera     | Yagami | search-mcp     | Integration Value |
| ------------------------------ | ------ | -------- | ------ | -------------- | ----------------- |
| **Resolver/Handler Router**    | ✅     | ❌       | ❌     | ❌             | **High**          |
| **FastMCP SDK**                | ✅     | ❌ (raw) | ❌     | ❌ (raw MCP)   | Medium            |
| **Multi-source content fetch** | ✅     | ❌       | ❌     | ⚠️ (basic)     | **High**          |
| **Structured error messages**  | ✅     | ⚠️       | ❌     | ⚠️             | **High**          |
| **BM25+Vector+Rerank**         | ❌     | ✅       | ❌     | ⚠️ (partial)   | Medium            |
| **Tree-sitter AST**            | ❌     | ✅       | ❌     | ✅             | Already done      |
| **Agent Skills/SKILL.md**      | ❌     | ✅       | ❌     | ⚠️ (AGENTS.md) | Medium            |
| **Benchmark suite**            | ❌     | ✅       | ❌     | ❌             | High              |
| **Eval harness**               | ❌     | ✅       | ❌     | ⚠️ (planned)   | High              |
| **Output budget management**   | ✅     | ✅       | ❌     | ⚠️             | **High**          |
| **Multi-query search**         | ❌     | ✅       | ❌     | ❌             | Medium            |
| **Intent parameter**           | ❌     | ✅       | ❌     | ❌             | Medium            |

---

### Pattern 1: Multi-Source Resolver Pattern (Kindly)

**File**: `src/kindly_web_search_mcp_server/content/resolver.py`

**Architecture**:

```python
async def resolve_page_content_markdown(url):
    # Stage 1: StackExchange API
    if is_stackexchange_url(url):
        return fetch_stackexchange_via_api(url)
    # Stage 2: GitHub Issue GraphQL API
    if is_github_issue_url(url):
        return fetch_github_issue_via_graphql(url)
    # Stage 3: Wikipedia MediaWiki API
    if is_wikipedia_url(url):
        return fetch_wikipedia_api(url)
    # Stage 4: arXiv Atom API + PDF
    if is_arxiv_url(url):
        return fetch_arxiv_with_pdf_extraction(url)
    # Stage 5: Universal HTML fallback (nodriver)
    return load_url_as_markdown(url)
```

**Why it's effective**:

- Specialized handlers use native APIs (better than scraping)
- StackExchange returns structured Q&A with answers + comments
- GitHub GraphQL returns full issue thread with reactions
- Graceful fallback to headless browser

**Vera benchmarks confirm**: Reranking lifts MRR@10 from 0.28 to 0.60. Better content quality from APIs vs scraping compounds this.

---

### Pattern 2: Output Budget Management (Kindly + Vera)

**Kindly (Python)**:

```python
KINDLY_TOOL_TOTAL_TIMEOUT_SECONDS = 120  # default
KINDLY_TOOL_TOTAL_TIMEOUT_MAX_SECONDS = 600  # cap
KINDLY_WEB_SEARCH_MAX_CONCURRENCY = 3  # capped at 5
```

**Vera (Rust)**:

```rust
const MCP_OUTPUT_BUDGET: usize = 20_000;  // chars

fn truncate_to_budget(content: &str, allowed: usize) -> Cow<'_, str> {
    if content.len() <= allowed {
        return Cow::Borrowed(content);
    }
    // Break at line boundary, not char
    let break_at = content[..end].rfind('\n').unwrap_or(end);
    // ... truncate with "[...truncated]" marker
}
```

**Current search-mcp**: Has `crawlBudget.ts` but the 314MB crash proves budget enforcement needs refinement.

---

### Pattern 3: Agent Skills System (Vera)

**File**: `skills/vera/SKILL.md`

**Structure**:

```markdown
---
name: vera
description: Semantic code search tool for AI agents...
---

# Vera

## Workflow

1. Ensure installed
2. Index: `vera index .`
3. Search: `vera search "query"`

## When to Use

- Conceptual queries: "how does auth work"
- NOT: exact strings, regex (use `vera grep`)

## Query Strategy

- Be specific: "OAuth token refresh" not "auth"
- Use multiple queries: ["OAuth", "JWT", "auth middleware"]
- Add --intent for ambiguous queries
```

**Current search-mcp**: Has `AGENTS.md` but it's generic. Tool descriptions in server.ts could be upgraded.

---

### Pattern 4: Eval Harness + Benchmarks (Vera)

**File**: `eval/corpus.toml`, `docs/benchmarks.md`

**Benchmark Results**:
| Metric | ripgrep | cocoindex | ColGREP (149M) | Vera |
|--------|---------|-----------|----------------|------|
| Recall@5 | 0.28 | 0.37 | 0.67 | **0.78** |
| MRR@10 | 0.26 | 0.35 | 0.62 | **0.91** |
| nDCG@10 | 0.29 | 0.52 | 0.56 | **0.84** |

**Current search-mcp**: V3 roadmap mentions eval harness but not shipped.

---

### Pattern 5: Diagnostic Emitters (Kindly)

**File**: `src/kindly_web_search_mcp_server/utils/diagnostics.py`

```python
class Diagnostics:
    def emit(self, event: str, message: str, data: dict):
        if self.enabled:
            print(json.dumps({
                "timestamp": time.time(),
                "event": event,
                "message": message,
                "data": data
            }), file=self.stream)

# Usage
diagnostics.emit("web_search.start", "Starting", {"query": query})
diagnostics.emit("resolver.route", "Matched StackOverflow", {"handler": "stackexchange"})
```

**Current search-mcp**: Has `corpusStatus.warnings` but not per-event diagnostics.

---

## Part 4: Integration Opportunities

### Priority Matrix

| Priority | Pattern                                                | Effort | Impact   | File to Create               |
| -------- | ------------------------------------------------------ | ------ | -------- | ---------------------------- |
| **1**    | Resolver for StackOverflow/GitHub/Wikipedia/arXiv APIs | Medium | **High** | `src/utils/urlResolver.ts`   |
| **2**    | Output budget enforcement                              | Low    | **High** | `src/utils/budgetManager.ts` |
| **3**    | Structured error notes                                 | Low    | Medium   | `src/utils/errorNotes.ts`    |
| **4**    | Agent Skills directory                                 | Medium | Medium   | `skills/search-mcp/SKILL.md` |
| **5**    | Eval harness + benchmarks                              | High   | **High** | `eval/`                      |
| **6**    | Diagnostic emitters                                    | Medium | Medium   | `src/utils/diagnostics.ts`   |
| **7**    | Multi-query search                                     | Medium | Medium   | `src/rag/multiQuery.ts`      |
| **8**    | TTY detection guard                                    | Low    | Low      | `src/server.ts`              |

---

## Part 5: Market Positioning

### Where search-mcp Wins

| Feature              | search-mcp            | Kindly           | Vera           | mcp-local-rag |
| -------------------- | --------------------- | ---------------- | -------------- | ------------- |
| Web search           | ✅ Exa/Brave/SearXNG  | ✅ Serper/Tavily | ❌             | ❌            |
| Deep crawling        | ✅ Crawl4AI           | ❌               | ❌             | ❌            |
| Full RAG pipeline    | ✅ SQLite cache       | ❌               | ❌             | ✅ LanceDB    |
| Multi-source         | ✅ 14+ tools          | ❌ (2 tools)     | ❌ (code only) | ❌            |
| Academic search      | ✅ ArXiv + SemScholar | ⚠️ (arXiv only)  | ❌             | ❌            |
| Job search           | ✅ Indeed/SEEK/Jora   | ❌               | ❌             | ❌            |
| Podcast/Patent       | ✅ ListenNotes/USPTO  | ❌               | ❌             | ❌            |
| AST-aware chunking   | ✅ tree-sitter        | ❌               | ✅             | ❌            |
| Cross-encoder rerank | ✅ (optional)         | ❌               | ✅             | ❌            |
| GitHub corpus        | ✅ AST-aware          | ⚠️ (issues only) | ❌             | ❌            |
| Eval benchmarks      | ❌                    | ❌               | ✅             | ❌            |

### Where You're Vulnerable

1. **Setup complexity**: Requires sidecar + Crawl4AI server
2. **No Docker Compose bundle**: Users must configure everything manually
3. **72KB server.ts**: Maintainability concern
4. **No knowledge graph**: mcp-crawl4ai-rag has Neo4j hallucination detection
5. **Missing Ollama support**: mcp-local-rag runs fully local

---

## Part 6: Reddit Community Insights

### Key Discussions Found

1. **"Most MCP servers make eval scores worse"** (Vera author):
   - Tested 9 MCP tools, found most hurt agent performance
   - Only Claude Context + Vera performed well
   - Action: Publish eval results to differentiate

2. **SearXNG MCP gap exists**:
   - Users explicitly asked for it but found "mostly unmaintained projects"
   - Action: Market your SearXNG support more loudly

3. **Kindly targets "full conversation" retrieval**:
   - "The accepted answer is often a fossil wearing a crown"
   - "I want the GitHub Issue with all the comments"
   - Action: Your semantic_github_code already does this — lean into it

4. **Yagami has Pi integration**:
   - `@ahkohd/pi-yagami-search` npm package
   - "replaces Exa in my Pi coding sessions"

---

## Part 7: Strategic Recommendations

### Short-term (0-3 months)

1. **Add Docker Compose bundle** (like ToKiDoO's approach) with embedded SearXNG
2. **Add Ollama embedding option** for fully local operation
3. **Add URL Resolver** for StackOverflow/GitHub/Wikipedia/arXiv APIs

### Medium-term (3-6 months)

1. **Publish to mcp.so and FastMCP.market** for discoverability
2. **Write comparison blog post**: "search-mcp vs Tavily/Exa: When to self-host"
3. **Ship eval harness with benchmarks** comparing to Kindly and Vera

### Long-term (6-12 months)

1. **Add agentic RAG mode** (like coleam00's `USE_AGENTIC_RAG`)
2. **Consider knowledge graph** for repository-level code analysis
3. **Split server.ts** into smaller modules for maintainability

---

## Part 8: Findings Summary

### Finding 1: Resolver Pattern

- **Source**: Kindly Web Search
- **File**: `src/kindly_web_search_mcp_server/content/resolver.py`
- **Value**: API-based content fetch beats scraping
- **PR**: #resolver-pattern

### Finding 2: Output Budget

- **Source**: Kindly + Vera
- **Files**: `crawlBudget.ts`, `truncate_to_budget()`
- **Value**: Prevents MCP response size crashes
- **PR**: #output-budget

### Finding 3: Structured Errors

- **Source**: Kindly
- **Pattern**: `_Failed to retrieve content: Error_\n\nSource: {url}`
- **Value**: Better UX for AI tools
- **PR**: #structured-errors

### Finding 4: Agent Skills

- **Source**: Vera
- **File**: `skills/vera/SKILL.md`
- **Value**: Better AI assistant usage guidance
- **PR**: #agent-skills

### Finding 5: Eval Harness

- **Source**: Vera
- **Files**: `eval/`, `docs/benchmarks.md`
- **Value**: Market differentiation through benchmarks
- **PR**: #eval-harness

### Finding 6: Diagnostics

- **Source**: Kindly
- **Pattern**: Per-event JSON logging to stderr
- **Value**: Debugging support without reading source
- **PR**: #diagnostics

### Finding 7: Multi-Query + Intent

- **Source**: Vera
- **Pattern**: `queries: string[]` + `intent: string` for reranking
- **Value**: Better precision for ambiguous queries
- **PR**: #multi-query

### Finding 8: TTY Guard

- **Source**: Kindly
- **Pattern**: Refuse stdio when stdin is TTY
- **Value**: Prevents user confusion
- **PR**: #tty-guard

---

_Document generated by competitive analysis research. See ROADMAP.md for integration timeline._
