# Integration-Point Report: Full-Document Parsing Injection Points

## 1. `web_search` Pipeline — Content/Excerpt Flow

### How results get content

Every search backend (`braveSearch.ts`, `exaSearch.ts`, `tavilySearch.ts`, `searxngSearch.ts`, `duckduckgoSearch.ts`, `codexSearch.ts`, `ollamaSearch.ts`) returns `SearchResult` objects. The default `contentKind` is `'snippet'` — meaning all content is **provider excerpts**, never fetched page text.

**Exceptions:**

- **Exa** may emit `contentKind: 'full'` or `'summary'` depending on the `aiSummary` mode and the provider's response.
- **Tavily** may emit `contentKind: 'summary'` when `aiSummary` is enabled.
- A populated `generatedSummary` field does **not** change `contentKind` — `contentKind` reflects the primary content source (snippet vs full text), while `generatedSummary` is an AI-generated supplement. Deduplication and formatting logic should key on `contentKind`, not on the presence of `generatedSummary`.

**Key type:** `SearchResult` interface (`src/types.ts`):

- `description: string` — the main snippet text
- `extraSnippet: string | null` — additional snippet text
- `contentKind?: 'snippet' | 'full' | 'summary'` — default `'snippet'`; Exa may emit `'full'` or `'summary'`, Tavily may emit `'summary'`
- `generatedSummary?: string | null` — only Exa/Tavily in `aiSummary` modes

**Flow:**

1. `src/tools/standalone/webSearch.ts` (MCP tool registration) calls `webSearch()` from `src/tools/webSearch.ts`
2. `webSearch()` fans out to all configured backends in parallel via `searchWithBackends()`
3. `runBackend()` dispatches to each provider (braveSearch, exaSearch, etc.)
4. Each provider returns `SearchResult[]` with thin snippets
5. Results are merged via `mergeSearchResults()` or `rrfMerge()`, deduped by normalized URL keeping richest content
6. Optional semantic rerank via `semanticRerankSearchResults()` uses `title + description` as text
7. Final output formatted by `src/tools/webSearchResultFormatter.ts` into markdown with `[N-M]` citations

### Primary injection point for "fetch full document"

**Location:** `src/tools/webSearch.ts`, inside `searchWithBackends()`, **after the dedup/rerank loop returns `finalItems`** but **before** the return statement.

**Why here:** At this point, all results are ranked, deduped, and have `contentKind: 'snippet'`. A post-rank enrichment step could:

1. Identify results where `contentKind === 'snippet'` and `description` is short (e.g., arxiv abstract)
2. Fetch the full URL via `extractDocumentUrl()` (text docs) or a new document parser sidecar (binary docs like PDF)
3. Replace `description` with extracted content, upgrade `contentKind` to `'full'`

**Alternative:** Inside each individual backend provider (e.g., `src/tools/exaSearch.ts`), but this is provider-specific and duplicates logic.

**No existing fetch step exists.** The web_search tool never fetches URLs. Content comes entirely from search provider APIs.

---

## 2. Document Extraction Logic (commit `9ffa78a`)

### Files

- **`src/utils/documentExtraction.ts`** — The in-house extraction seam
- **`src/utils/extractionConfig.ts`** — Crawl4AI extraction config (CSS/XPath/regex/LLM strategies)
- **`src/utils/documentUtils.ts`** — URL detection + fallback URL generation

### What it currently handles

**`src/utils/documentExtraction.ts`** defines two sets:

**TEXT_EXTENSIONS** (handled in-process):
`.txt`, `.md`, `.markdown`, `.csv`, `.json`, `.xml`, `.yaml`, `.yml`, `.toml`, `.ini`, `.cfg`, `.conf`, `.log`, `.env`

**BINARY_EXTENSIONS** (return `unsupported: true`):
`.pdf`, `.doc`, `.docx`, `.ppt`, `.pptx`, `.xls`, `.xlsx`, `.odt`, `.ods`, `.odp`, `.rtf`, `.tex`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.tiff`, `.tif`, `.webp`, `.djvu`

### How it works

`extractDocumentUrl(url, options?)`:

1. Validates URL safety via `assertSafeUrl()`
2. Checks extension — binary → returns `{ unsupported: true }`
3. Non-document (no extension / unknown) → returns `{ unsupported: true }`
4. Text doc → plain `fetch()` with 30s timeout, returns raw text
5. `wrapAsMarkdown()` converts: CSV → markdown table, JSON → fenced code block, XML/YAML → fenced, plain → as-is

### What "Text-like document URLs are extracted in-process" means

**Confirmed in code:** The function uses native Node.js `fetch()` to download text files and converts them to markdown. There is **no server-side rendering, no browser, no parsing library** — just `response.text()` plus simple format-specific wrapping.

**Binary formats (PDF, Office, images) explicitly return `{ unsupported: true }`** so callers fall through to Crawl4AI (which also can't parse them) or document fallback URLs (arxiv PDF → abstract page, strip extension → HTML landing page).

### Where a parser sidecar would plug in

**`src/utils/documentExtraction.ts`** — Currently the binary branch:

```typescript
if (ext !== undefined && isBinaryExtension(url)) {
  logger.debug({ url, ext }, 'documentExtraction: binary format, unsupported');
  return { markdown: '', title: '', success: false, unsupported: true, warnings };
}
```

This is **the exact seam** where a parser sidecar would intercept. Instead of returning `unsupported`, the function would POST to a sidecar endpoint with the URL and get back markdown.

**Trust boundary:** When a parser sidecar resolves URLs, it must enforce the same SSRF protections as the main process: redirect limits, private-address restrictions (blocking loopback, link-local, and RFC 1918 ranges), response-size limits, and fetch timeouts. Prefer sending already-validated document bytes to the sidecar instead of a URL when URL resolution is unnecessary — this eliminates the sidecar's need to fetch and keeps the trust boundary at the caller.

---

## 3. `web_crawl` / Crawl4AI Integration

### Crawl4AI flow

1. **Entry:** `src/tools/standalone/webCrawl.ts` — MCP tool registration
2. **Document URL short-circuit:** If `isDocumentUrl(url)`, calls `extractDocumentUrl()` first. If successful, returns immediately without touching Crawl4AI.
3. **Crawl4AI path:** Calls `webCrawl()` from `src/tools/webCrawl.ts`
4. **`webCrawl()` builds middleware chain:**
   - `SentryGuardMiddleware` → `DomainTrustMiddleware` → `Crawl4aiClientMiddleware` → `ResponseQualityMiddleware` → `AggressiveRenderMiddleware` → `ExternalRecoveryMiddleware` → `StatsRecorderMiddleware`
5. **`Crawl4aiClientMiddleware.crawl()`** (`src/crawl/middlewares.ts`): POSTs to `{CRAWL4AI_BASE_URL}/crawl` with browser config, crawler config, optional extraction config
6. Response pages normalized to `CrawlPageResult` with `markdown`, `html`, `title`, `links`
7. Markdown cleaned by `cleanMarkdownContent()`, challenge pages filtered

### External Recovery

`src/utils/externalRecovery.ts`:

- Tries Wayback Machine CDX API → fetches snapshot HTML
- Falls back to Google Cache → fetches cached HTML
- Returns raw HTML string (not parsed to markdown)
- Used by `ExternalRecoveryMiddleware` when crawl quality is low

### Key URLs for integration

- `src/tools/webCrawl.ts` — `webCrawl()` function, requires `CRAWL4AI_BASE_URL`
- `src/crawl/middlewares.ts` — `Crawl4aiClientMiddleware`, the actual HTTP client
- `src/crawl/middlewares.ts` — endpoint: `${baseUrl}/crawl`
- `src/crawl/middlewares.ts` — `buildRequestBody()` constructs the Crawl4AI payload

---

## 4. RAG Ingestion Entry Points

### Content flow

1. **Adapters** (`src/rag/adapters/`): `text.ts`, `transcript.ts`, `conversation.ts`, `job.ts`, `code.ts`, `academic.ts`, `qa.ts`
2. Each adapter converts source data → `RawDocument[]` (text + url + metadata) or `RagChunk[]`
3. `src/rag/adapters/text.ts` — `documentsFromTextPages()` / `chunksFromTextPages()`: takes `TextPage[]` (url + markdown), creates `RawDocument` with `adapter: 'text'`
4. **Pipeline** (`src/rag/pipeline.ts`): `prepareCorpus()` takes `PrepareCorpusOptions` with `documents` or `chunks`, optionally applies dedup
5. **Chunking** happens in `src/chunking.ts` — `chunkMarkdown()` splits markdown into ~400 token chunks with 20% overlap, atomic code blocks/tables
6. **Embedding** via `src/rag/embedding.ts` — `embedTexts()` dispatches to configured provider (sidecar/ollama/transformers/openai)
7. **Retrieval** via `retrieveCorpus()` — BM25 + vector cosine → RRF fusion → optional rerank

### Multimodal attachment points

**`RawDocument` interface** (`src/rag/types.ts`):

```typescript
export interface RawDocument {
  id: string;
  adapter: AdapterType;
  text: string; // ← markdown text only, no image/figure refs
  url: string;
  title?: string | null;
  metadata?: Record<string, unknown>; // ← THIS is where multimodal data would attach
}
```

**`RagChunk` interface** (`src/rag/types.ts`):

```typescript
export interface RagChunk extends Omit<CorpusChunk, never> {
  metadata?: Record<string, unknown>; // ← same extension point
  scores?: SemanticCrawlChunk['scores'];
}
```

**`metadata?: Record<string, unknown>`** is the open extension point. Images/tables/figures could be stored as:

- `metadata.images: [{ url, altText, base64 }]`
- `metadata.tables: [{ html, markdown }]`
- `metadata.figures: [{ url, caption, description }]`

The chunking pipeline (`src/chunking.ts`) would need a new adapter or mode to handle multimodal content during ingestion.

### Semantic crawl as primary RAG ingestion path

`src/tools/semanticCrawl.ts` — The `crawlSeeds()` function:

1. Checks `isDocumentUrl()` → `extractDocumentUrl()` (in-process text extraction)
2. Falls back to `webCrawl()` → Crawl4AI sidecar
3. Pages → chunks via `chunkMarkdown()`
4. Embeds chunks → retrieval

---

## 5. Config/Env Plumbing Pattern

### Pattern: Config-gated capability via env vars

**Step-by-step pattern** (using Crawl4AI as canonical example):

**A. Interface** (`src/config.ts`):

```typescript
export interface Crawl4aiConfig {
  baseUrl: string;
  apiToken?: string;
}
```

**B. Default** (`src/config.ts`):

```typescript
crawl4ai: { baseUrl: '', apiToken: '' },
```

**C. Env loading** (`src/config.ts`):

```typescript
const crawl4aiUrl = process.env.CRAWL4AI_BASE_URL;
const crawl4aiToken = process.env.CRAWL4AI_API_TOKEN;
if (crawl4aiUrl !== undefined || crawl4aiToken !== undefined) {
  const crawl4aiCfg: Partial<Crawl4aiConfig> = {};
  if (crawl4aiUrl !== undefined) crawl4aiCfg.baseUrl = crawl4aiUrl;
  if (crawl4aiToken !== undefined) crawl4aiCfg.apiToken = crawl4aiToken;
  cfg.crawl4ai = crawl4aiCfg;
}
```

**D. Merge** (`src/config.ts`):

```typescript
crawl4ai: {
    baseUrl: envConfig.crawl4ai?.baseUrl ?? fileConfig.crawl4ai?.baseUrl ?? DEFAULTS.crawl4ai.baseUrl,
    apiToken: envConfig.crawl4ai?.apiToken ?? fileConfig.crawl4ai?.apiToken ?? DEFAULTS.crawl4ai.apiToken ?? '',
},
```

**E. Feature gate** (`src/config.ts`):

```typescript
web_crawl: {
    required: ['CRAWL4AI_BASE_URL'],
    isConfigured: (cfg) => cfg.crawl4ai.baseUrl.length > 0,
},
```

**F. Runtime check** (e.g., `src/tools/webCrawl.ts`):

```typescript
if (!baseUrl) {
  throw unavailableError(
    'crawl4ai sidecar is not configured. Set CRAWL4AI_BASE_URL to enable web_crawl.',
  );
}
```

### To add a new parser sidecar, follow this pattern:

1. Add interface: `ParserSidecarConfig { baseUrl: string; apiToken?: string; enabled: boolean; }`
2. Add to `SearchConfig` type
3. Add defaults: `{ baseUrl: '', apiToken: '', enabled: false }`
4. Add env loading: `PARSER_SIDECAR_BASE_URL`, `PARSER_SIDECAR_API_TOKEN`, `PARSER_SIDECAR_ENABLED`
5. Add merge block
6. Add feature gate: `{ required: ['PARSER_SIDECAR_BASE_URL'], isConfigured: (cfg) => cfg.parserSidecar.enabled && cfg.parserSidecar.baseUrl.length > 0 }`

---

## 6. Sidecar Pattern

### Directory structure

```
sidecar/
  embedding/          # Python FastAPI embedding service
    main.py           # FastAPI app, POST /embed, GET /health
    Dockerfile
    requirements.txt
  openai-embedding-proxy/  # OpenAI-compatible proxy to embedding sidecar
    main.py
    Dockerfile
  jobspy/             # Python FastAPI job scraping
    main.py           # FastAPI app, POST /search, auth middleware
```

### Embedding sidecar (`sidecar/embedding/main.py`)

- FastAPI app with `POST /embed` endpoint
- Request: `{ texts: string[], mode: "document"|"query", dimensions: int, titles?: string[] }`
- Response: `{ embeddings: number[][], model, modelRevision, dimensions, mode, truncatedIndices }`
- Health: `GET /health`
- Model loaded at startup via lifespan handler
- Auth: optional `Authorization: Bearer {apiToken}`

### JobSpy sidecar (`sidecar/jobspy/main.py`)

- FastAPI app with `POST /search` endpoint
- Auth via `X-API-Key` header
- Rate limiting in-memory
- Request/Response via Pydantic models

### How sidecars are called from Node.js

**Embedding:** `src/rag/embedding.ts` — `embedWithSidecar()`:

```typescript
const endpoint = `${baseUrl.replace(/\/+$/u, '')}/embed`;
const headers = { 'Content-Type': 'application/json', 'User-Agent': getUserAgent() };
if (request.apiToken) headers.Authorization = `Bearer ${request.apiToken}`;
const response = await fetch(endpoint, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60_000),
});
```

**Crawl4AI:** `src/crawl/middlewares.ts` — `Crawl4aiClientMiddleware.crawl()`:

```typescript
const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/crawl`;
const headers = { 'Content-Type': 'application/json', 'User-Agent': getUserAgent() };
if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(this.buildRequestBody(req)),
    signal: AbortSignal.timeout(computeCrawlTimeout(...)),
});
```

### docker-compose.yml

**Embedding sidecar service:**

```yaml
embedding-sidecar:
  build: ./sidecar/embedding/
  ports:
    - '8001:8000'
  healthcheck:
    test: ['CMD', 'curl', '-f', 'http://localhost:8000/health']
    interval: 30s
    timeout: 10s
    retries: 5
  restart: unless-stopped
  networks:
    - search-mcp-net
```

**MCP server wiring:**

```yaml
- EMBEDDING_SIDECAR_BASE_URL=http://embedding-sidecar:8000
- CRAWL4AI_BASE_URL=http://crawl4ai:8050
```

---

## Summary: Concrete Seams for Document/Multimodal Parser

| #   | Integration Point                                   | File                               | Reference                                                                    | Priority                                                   |
| --- | --------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | **Binary doc extraction in `extractDocumentUrl()`** | `src/utils/documentExtraction.ts`  | binary branch (`isBinaryExtension`)                                          | **HIGH** — Replace `unsupported` return with sidecar call  |
| 2   | **Post-rank enrichment in `web_search`**            | `src/tools/webSearch.ts`           | `searchWithBackends()` after `finalItems`                                    | **HIGH** — Add fetch+parse step for snippet-only results   |
| 3   | **Config pattern for parser sidecar**               | `src/config.ts`                    | Follow Crawl4AI pattern (`Crawl4aiConfig`, `DEFAULTS`, `loadFromEnv`, merge) | **MEDIUM**                                                 |
| 4   | **Sidecar invocation pattern**                      | `src/rag/embedding.ts`             | `embedWithSidecar()`                                                         | **MEDIUM** — Reuse HTTP client pattern                     |
| 5   | **docker-compose service**                          | `docker-compose.yml`               | Follow `embedding-sidecar` service                                           | **MEDIUM**                                                 |
| 6   | **RAG multimodal attachment**                       | `src/rag/types.ts`                 | `RawDocument.metadata`                                                       | **LOW** — Future extension                                 |
| 7   | **Semantic crawl document path**                    | `src/tools/semanticCrawl.ts`       | `crawlSeeds()` `isDocumentUrl` check                                         | **MEDIUM** — Same `isDocumentUrl` check, extend for binary |
| 8   | **web_crawl document short-circuit**                | `src/tools/standalone/webCrawl.ts` | `isDocumentUrl` short-circuit                                                | **MEDIUM** — Same pattern as semantic crawl                |
