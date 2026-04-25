# V3.3.0 — Extraction Resilience & Search Recall

**Status**: Spec  
**Priority**: High  
**Depends On**: V3.2.0

**Research Sources**:

- [brcrusoe72/agent-search](https://github.com/brcrusoe72/agent-search) (MIT, Python) — 9-strategy kill chain, domain trust, query expansion, content scrubbing, cross-engine dedup, self-improvement loop
- [coleam00/mcp-crawl4ai-rag](https://github.com/coleam00/mcp-crawl4ai-rag) (MIT, Python) — Contextual embeddings, code example extraction, persistent Supabase/pgvector, hybrid search

**Design Principle**: These features are drawn from production-tested external codebases but adapted to search-mcp's architecture (TypeScript, stdio MCP, sidecar-based). Each stage is independently shippable.

---

## Stage 1: Contextual Embeddings

**Source**: mcp-crawl4ai-rag `src/utils.py` — `generate_contextual_embedding()`

### Problem

Chunks are embedded as-is. For technical documentation, the same term can mean different things in different sections (e.g., "pipeline" in CI/CD vs. data processing). Raw chunk embeddings lose this disambiguating context.

### Proposed Behavior

- New optional parameter `useContextualEmbeddings: boolean` (default `false`) on `semantic_crawl`
- When enabled, each chunk is enriched with a short LLM-generated context string before embedding
- The LLM call uses the existing `cfg.llm` config (already configured for `extractionConfig.type === 'llm'`)
- Context is prepended to the chunk as `"${context}\n---\n${chunk}"` before embedding
- Original (un-enriched) chunk text is preserved in `CorpusChunk.text` for display
- Enriched text is used only for embedding, stored in `CorpusChunk.embedText`

### Constraints

- Requires `LLM_PROVIDER` + `LLM_API_TOKEN` (or `LLM_BASE_URL` for local providers) — same config surface as existing LLM extraction
- 2-3x indexing latency per chunk (bounded concurrency with semaphore)
- Graceful degradation: if LLM call fails for a chunk, fall back to raw chunk embedding
- No new external dependencies — calls LLM via OpenAI-compatible API

### Tool Changes

- `semantic_crawl` gains `useContextualEmbeddings?: boolean`

### New Files

- `src/rag/contextualEmbedding.ts` — LLM-based chunk enrichment

### Existing Files Modified

- `src/tools/semanticCrawl.ts` — wire contextual embedding into `pagesToCorpus` path
- `src/rag/types.ts` — add `embedText?: string` to `CorpusChunk`
- `src/server.ts` — new Zod parameter
- `src/types.ts` — update `SemanticCrawlOptions`

---

## Stage 2: Domain Trust & Typosquat Detection

**Source**: agent-search `app/domain_trust.py` (311 lines) — `evaluate_trust()`, `detect_lookalike()`

### Problem

Crawled URLs may be typosquats of legitimate domains. In semantic_crawl, this is a security and data-integrity risk — especially when crawling external links from a seed page.

### Proposed Behavior

- New utility `src/utils/domainTrust.ts` with `evaluateDomainTrust(url)` → `DomainTrustResult`
- Checks:
  1. Exact match against an established-domain allowlist (arxiv.org, github.com, wikipedia.org, etc.)
  2. Suspicious TLD detection (`.tk`, `.ml`, `.ga`, `.cf`, `.gq`, `.buzz`, `.top`, `.xyz`, etc.)
  3. HTTPS enforcement
  4. Levenshtein-distance typosquat detection against known brands (google, github, openai, anthropic, etc.)
- Trust tiers: `trusted`, `standard`, `suspicious`, `blocked`
- Integration points:
  - `semantic_crawl` logs warnings for `suspicious` URLs; drops `blocked` URLs before crawling
  - `web_crawl` logs warnings
  - Trust result optionally exposed in `CrawlPageResult.metadata.trust`
- New env var `BLOCKED_DOMAINS` (comma-separated) for operator-controlled blocklist

### Constraints

- No external dependencies (Levenshtein implemented inline, ~20 lines)
- Trust evaluation is CPU-only, no network calls (no WHOIS — too slow)
- Allowlist is hardcoded but configurable via `TRUSTED_DOMAINS` env var
- Backward compatible: default behavior unchanged (no URLs dropped unless operator opts in)

### New Files

- `src/utils/domainTrust.ts` — trust evaluation, typosquat detection

### Existing Files Modified

- `src/tools/semanticCrawl.ts` — filter URLs after `filterSafeUrls`
- `src/tools/webCrawl.ts` — log warnings
- `src/types.ts` — `DomainTrustResult` type, optional `trust` on `CrawlPageResult.metadata`
- `src/config.ts` — new env vars

---

## Stage 3: Query Expansion for web_search

**Source**: agent-search `app/query_expansion.py` (201 lines) — `generate_query_variations()`

### Problem

Single-query search misses results that alternative phrasings would surface. Users who query "best LLM caching strategies" miss results found by "semantic cache for language models" or "prompt caching techniques".

### Proposed Behavior

- New optional parameter `expandQuery: boolean` (default `false`) on `web_search`
- When enabled, generates 2-4 query variations using rule-based strategies:
  1. Concept/synonym expansion (e.g., "llm" → "large language model", "foundation model")
  2. Question form (statement → question)
  3. Scope adjustment (broader or narrower)
- Each variation is searched via the configured backend (Brave or SearXNG)
- Results are deduplicated by URL, keeping the best snippet
- No LLM calls — purely rule-based

### Constraints

- Multiplies API calls by 2-4x (rate limit implications)
- Concept map is hardcoded (~60 entries) — good enough for English tech queries
- Deduplication by normalized URL
- Backward compatible: `expandQuery: false` (default) = no change

### Tool Changes

- `web_search` gains `expandQuery?: boolean`

### New Files

- `src/tools/queryExpansion.ts` — concept map, variation generators

### Existing Files Modified

- `src/tools/webSearch.ts` — wire expansion into search flow
- `src/server.ts` — new Zod parameter

---

## Stage 4: External Content Recovery Fallbacks

**Source**: agent-search `app/killchain.py` (954 lines) — Wayback Machine, Google Cache strategies

### Problem

Current render recovery (`renderRecovery.ts`) retries within Crawl4AI with aggressive JS-render options. But some failures are not rendering problems — they're dead pages (404), blocked pages (403/Cloudflare), or sites that serve shell-only HTML to all crawlers.

### Proposed Behavior

- After the existing Crawl4AI aggressive-retry path fails, attempt external recovery:
  1. **Wayback Machine** — CDX API lookup for latest snapshot, fetch archived HTML, extract content via Readability
  2. **Google Cache** — fetch from `webcache.googleusercontent.com`, extract via Readability
- Only triggered when baseline crawl returns placeholder/empty content AND aggressive Crawl4AI retry also fails
- Recovery attempts are bounded: max 1 external fallback attempt per URL
- Recovered content tagged with `recoverySource: 'wayback' | 'google-cache'` in page metadata

### Constraints

- External fetches add 1-3s latency per failed URL
- Wayback CDX API is rate-limited but free (no API key)
- Google Cache availability is unreliable (often blocked)
- Both fallbacks use existing `webRead.ts` Readability extraction path
- Backward compatible: recovery only kicks in on explicit failure

### New Files

- `src/utils/externalRecovery.ts` — Wayback CDX lookup, Google Cache fetch, content extraction

### Existing Files Modified

- `src/tools/webCrawl.ts` — add external recovery after aggressive Crawl4AI retry
- `src/types.ts` — `recoverySource` field on `CrawlPageResult`

---

## Stage 5: Content Scrubbing

**Source**: agent-search `app/scrubber.py` (539 lines) — 70+ injection/exfiltration patterns

### Problem

Crawled content may contain prompt injection attempts, data exfiltration hooks, or impersonation markers. When this content is returned to an LLM agent, it can manipulate the agent's behavior.

### Proposed Behavior

- New utility `src/utils/contentScrubber.ts` with `scrubContent(content: string): ScrubResult`
- Detection categories:
  1. Prompt injection (ignore previous instructions, system prompt leakage, jailbreak patterns)
  2. Data exfiltration (credential fishing, API key requests, environment variable access)
  3. Impersonation (authority claims, fake system messages)
  4. XSS / HTML injection markers
- Scrubbing: replace detected patterns with `[REDACTED]` tags
- Result includes: `clean: boolean`, `threats: ThreatDetection[]`, `riskScore: number`, `redactions: number`
- Integration:
  - Applied to all markdown content before chunking in `semantic_crawl`
  - Threat summary optionally included in warnings
  - Applied to `web_read` output

### Constraints

- Pattern matching only (regex) — no LLM calls for scrubbing
- False positives possible on legitimate security documentation
- Risk score is advisory only — content is still returned (just redacted)
- Operator can disable via `SCRUB_CONTENT=false` env var

### New Files

- `src/utils/contentScrubber.ts` — detection patterns, scrubbing logic

### Existing Files Modified

- `src/tools/semanticCrawl.ts` — apply scrubbing before chunking
- `src/tools/webRead.ts` — apply to output
- `src/config.ts` — `SCRUB_CONTENT` env var

---

## Stage 6: Cross-Backend Search Merging

**Source**: agent-search `app/dedup.py` — `deduplicate_with_scoring()`

### Problem

`web_search` currently uses sequential fallback (primary → secondary backend). When both backends are healthy, running them in parallel and merging results improves coverage and ranking quality.

### Proposed Behavior

- When both `BRAVE_API_KEY` and `SEARXNG_BASE_URL` are configured, query both backends in parallel
- Deduplicate by normalized URL
- Score by: engine agreement (40%), domain authority (30%), position rank (30%)
- Domain authority table: hardcoded baseline scores for ~15 high-value domains
- Results from both engines are merged into a single ranked list
- Falls back to sequential behavior when only one backend is configured

### Constraints

- Doubles API call volume when both backends are available
- Domain authority table is static (not dynamic)
- Requires both backends to be healthy for parallel mode
- Backward compatible: single-backend configuration unchanged

### New Files

- `src/utils/searchMerge.ts` — URL normalization, dedup, scoring

### Existing Files Modified

- `src/tools/webSearch.ts` — parallel backend queries + merge
- `src/types.ts` — `SearchResult.engines: string[]` field
- `src/server.ts` — response shape includes `engines` per result

---

## Stage 7: Code Example Extraction & Summarization

**Source**: mcp-crawl4ai-rag `src/utils.py` — `extract_code_blocks()`, `generate_code_example_summary()`

### Problem

Code blocks in documentation are chunked as regular text. They lose their language metadata and surrounding context, making targeted code search imprecise.

### Proposed Behavior

- During chunking (`src/chunking.ts`), detect fenced code blocks ≥300 chars
- Extract with: language (from fence header), code content, context before/after (up to 1000 chars each)
- Store as `CodeChunk` type extending `CorpusChunk` with `language`, `contextBefore`, `contextAfter`
- Optional LLM summarization: when `useContextualEmbeddings` is enabled and LLM is configured, generate a 2-3 sentence summary of each code block
- Summaries are stored in `CorpusChunk.metadata.codeSummary`

### Constraints

- No new tools — enhancement to existing `semantic_crawl` output
- Code-aware chunking preserves code block integrity (already partially implemented)
- LLM summarization is optional and gated on `useContextualEmbeddings`
- Backward compatible: `CorpusChunk` shape gains optional fields

### Existing Files Modified

- `src/chunking.ts` — detect and tag code blocks with metadata
- `src/rag/types.ts` — `CodeChunkMetadata` interface

---

## Stage 8: Extraction Self-Improvement Tracking

**Source**: agent-search `app/evolver.py` (301 lines) — `Evolver` class

### Problem

Extraction failures are logged but not analyzed. No mechanism exists to learn from patterns (e.g., "domain X always fails Crawl4AI, skip it").

### Proposed Behavior

- Track extraction outcomes per URL in a lightweight in-memory store (pruned by TTL)
- Aggregate statistics: per-domain success rate, per-strategy effectiveness
- Surface stats via health endpoint or `meta` on tool responses
- Use stats to short-circuit known-failing domains in `semantic_crawl`
- No LLM calls — pure counting

### Constraints

- In-memory only (same process lifetime as corpus cache)
- Operator can view stats but automatic adaptation is limited to domain skip-list
- Minimal overhead: single Map lookup per crawl attempt
- No new dependencies

### New Files

- `src/utils/extractionStats.ts` — outcome tracking, aggregation, domain skip-list

### Existing Files Modified

- `src/tools/webCrawl.ts` — record outcomes
- `src/tools/semanticCrawl.ts` — check skip-list before crawling
- `src/health.ts` — expose stats in health response

---

## Implementation Priority

| Order | Stage                         | Effort | Value                              | Dependencies                |
| ----- | ----------------------------- | ------ | ---------------------------------- | --------------------------- |
| 1     | **Contextual Embeddings**     | Medium | Very High                          | LLM config (already exists) |
| 2     | **Domain Trust**              | Low    | High                               | None                        |
| 3     | **External Recovery**         | Medium | High                               | Existing render recovery    |
| 4     | **Content Scrubbing**         | Medium | High for multi-tenant              | None                        |
| 5     | **Query Expansion**           | Low    | High                               | None                        |
| 6     | **Cross-Backend Merging**     | Medium | High when both backends configured | None                        |
| 7     | **Code Example Extraction**   | Low    | Medium                             | None                        |
| 8     | **Self-Improvement Tracking** | Low    | Medium                             | None                        |

---

## Out of Scope

- **Knowledge Graph / Neo4j hallucination detection** — too specialized, requires new infrastructure (Neo4j)
- **Supabase/pgvector persistence** — search-mcp already has disk-backed corpus cache; adding a database dependency is a separate infrastructure decision
- **UA rotation** — Crawl4AI handles this internally; adding it externally would conflict
- **Batch URL processing** — `web_crawl` already handles multi-page crawl; separate batch API is premature
- **Source library / curated domain registry** — useful but high-maintenance; defer to operator configuration
