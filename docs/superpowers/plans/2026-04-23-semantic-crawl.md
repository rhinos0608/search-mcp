# semantic_crawl Implementation Plan

> **Status:** COMPLETED (2026-04-23)
> **Actual execution:** Subagent-driven development with two-stage review per task.
> **Final result:** 278 tests passing, 0 failures. 11 files changed, ~1300 insertions.

**Goal:** Add a `semantic_crawl` MCP tool that crawls a website, chunks content with markdown awareness, embeds via a Python sidecar using EmbeddingGemma-300M, and returns top-K semantically relevant passages ranked by cosine similarity.

**Architecture:** The tool orchestrates three external services: crawl4ai (existing), a new Python embedding sidecar, and Node.js in-process chunking. The embedding sidecar mirrors the crawl4ai pattern — a lightweight HTTP service. The chunking is pure TypeScript with no external dependencies.

**Tech Stack:** TypeScript/Node.js ESM, Zod v4 for schemas, native `fetch` for HTTP, no new runtime dependencies.

---

## File Structure

| File                                                     | Responsibility                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/chunking.ts`                                        | Markdown-aware chunking: heading detection, atomic units (code/tables), merge-forward, size-based split with sentence-snapped overlap      |
| `src/tools/semanticCrawl.ts`                             | Orchestrator: calls `webCrawl`, chunks pages, calls embedding sidecar (batched + deduped), ranks, returns topK                             |
| `src/types.ts`                                           | Add `SemanticCrawlResult`, `SemanticCrawlChunk`, `MarkdownChunk` interfaces                                                                |
| `src/config.ts`                                          | Add `EmbeddingSidecarConfig` to `SearchConfig`, load `EMBEDDING_SIDECAR_BASE_URL` / `EMBEDDING_SIDECAR_API_TOKEN` / `EMBEDDING_DIMENSIONS` |
| `src/health.ts`                                          | Gate `semantic_crawl`, add sidecar health probe                                                                                            |
| `src/server.ts`                                          | Register `semantic_crawl` tool with Zod schema                                                                                             |
| `test/chunking.test.ts`                                  | Unit tests for chunking strategy (18 tests)                                                                                                |
| `test/semanticCrawl.test.ts`                             | Integration tests for sidecar contract and orchestrator                                                                                    |
| `docs/superpowers/specs/2026-04-23-embedding-sidecar.md` | Sidecar design spec                                                                                                                        |
| `sidecar/embedding/main.py`                              | Python FastAPI sidecar implementation                                                                                                      |
| `sidecar/embedding/requirements.txt`                     | Python dependencies                                                                                                                        |
| `sidecar/embedding/Dockerfile`                           | Docker build                                                                                                                               |
| `sidecar/embedding/README.md`                            | Operator setup guide                                                                                                                       |

---

## What Changed From Original Plan

During implementation and review, several bugs were found and fixed. The plan below documents the **actual** code as committed, not the original intent.

### Bug Fixes Applied During Review

1. **Sentence snapping was backwards** — `snapToSentenceBoundary` searched forward from `rawStart`, which found the first sentence boundary in the overlap window, producing tiny overlaps. Fixed to search **backward** from `splitPos` to find the boundary giving overlap closest to the target 20%.

2. **`unitIdx` was `const`** — `findSplitPosition` takes a `unitIdx` parameter to avoid re-scanning atomic units from the start of the content on every chunk. The original code declared `const unitIdx = 0` in `splitGroup`, which meant it was re-scanned from zero for every sub-chunk (quadratic). Fixed by changing to `let unitIdx` and returning the updated index from `findSplitPosition`.

3. **`charOffset` was relative to group, not page** — `splitGroup` calculated `charOffset = rawContent.indexOf(sc)`, which finds the first occurrence. With overlap, the same text appears twice — both chunks reported the first chunk's offset. Fixed by tracking a `runningOffset` across groups in `chunkMarkdown` and passing it as `baseOffset` to `splitGroup`.

4. **503 Retry-After not implemented** — The sidecar returns 503 while the model loads. The original plan had a placeholder that threw an error instead of retrying. Fixed by parsing `Retry-After`, sleeping up to 30s, and retrying once with bare `fetch`.

5. **Merge-forward test was trivially passing** — `assert.ok(chunks.length < 2 || chunks.some(...))` passes if chunking produces 0 or 1 chunks for any reason. Fixed to `chunks.length === 1`.

6. **Embedding had no batching** — All chunks were sent in a single POST. At 100 pages that's potentially 2000+ texts. Fixed by adding `MAX_EMBEDDING_BATCH = 512` and `embedTextsBatched()`.

7. **No deduplication** — Identical boilerplate navigation/footer chunks across pages would dominate topK. Fixed by adding `deduplicateChunks()` before embedding.

8. **No title metadata passed to sidecar** — The design spec requires `title: {title} | text: {content}` prefixing for document mode. Fixed by adding optional `titles` array to `EmbedRequest` and extracting the last heading from each chunk's section chain.

9. **H4+ created split boundaries** — `parseSections` created a new section for any heading depth >= 2. Fixed to only create boundaries for depth <= 3, treating H4+ as content.

10. **`totalChunks` was global** — All chunks across a page shared the same `totalChunks = allChunks.length`. Fixed to annotate per-section in `splitGroup`.

11. **Content before first heading was dropped** — `parseSections` only pushed content when a heading was seen. Fixed by creating a synthetic depth-2 section for leading content.

12. **Headings inside code fences treated as boundaries** — `HEADING_RE.exec(line)` matched `#` inside code fences. Fixed by tracking `inCodeFence` state in `parseSections`.

13. **Multiple H1s lost** — Subsequent H1s were silently skipped. Fixed by appending them as regular content lines.

---

## Task 1: Add Types

**Files:**

- Modify: `src/types.ts`

- [x] **Step 1: Add new interfaces**

Append to `src/types.ts` after `WebCrawlResult`:

```typescript
// ── Semantic Crawl ────────────────────────────────────────────────────────

export interface SemanticCrawlChunk {
  text: string;
  url: string;
  section: string;
  /** Cosine similarity score (0–1, higher = more relevant). */
  score: number;
  /** 0-based character offset in the source page text. */
  charOffset: number;
  chunkIndex: number;
  totalChunks: number;
}

export interface SemanticCrawlResult {
  seedUrl: string;
  query: string;
  /** Total pages attempted in the crawl (includes failed pages). */
  pagesCrawled: number;
  totalChunks: number;
  successfulPages: number;
  chunks: SemanticCrawlChunk[];
}
```

- [x] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "types: add SemanticCrawlResult and SemanticCrawlChunk interfaces"
```

---

## Task 2: Add Config

**Files:**

- Modify: `src/config.ts`

- [x] **Step 1: Add EmbeddingSidecarConfig interface**

Add to `src/config.ts` after `Crawl4aiConfig`:

```typescript
export interface EmbeddingSidecarConfig {
  baseUrl: string;
  apiToken: string;
  dimensions: number;
}
```

- [x] **Step 2: Add to SearchConfig interface**

Add `embeddingSidecar: EmbeddingSidecarConfig;` to the `SearchConfig` interface.

- [x] **Step 3: Add env loading**

In `loadFromEnv()`, add:

```typescript
const embeddingSidecarUrl = process.env.EMBEDDING_SIDECAR_BASE_URL;
const embeddingSidecarToken = process.env.EMBEDDING_SIDECAR_API_TOKEN;
const embeddingDimensions = process.env.EMBEDDING_DIMENSIONS;
if (
  embeddingSidecarUrl !== undefined ||
  embeddingSidecarToken !== undefined ||
  embeddingDimensions !== undefined
) {
  const esc: Partial<EmbeddingSidecarConfig> = {};
  if (embeddingSidecarUrl !== undefined) esc.baseUrl = embeddingSidecarUrl;
  if (embeddingSidecarToken !== undefined) esc.apiToken = embeddingSidecarToken;
  if (embeddingDimensions !== undefined) {
    const dims = Number(embeddingDimensions);
    if ([128, 256, 512, 768].includes(dims)) {
      esc.dimensions = dims;
    }
  }
  cfg.embeddingSidecar = esc;
}
```

- [x] **Step 4: Add defaults in loadConfig**

In `loadConfig()`, add:

```typescript
embeddingSidecar: {
  baseUrl: envConfig.embeddingSidecar?.baseUrl ?? fileConfig.embeddingSidecar?.baseUrl ?? DEFAULTS.embeddingSidecar.baseUrl,
  apiToken: envConfig.embeddingSidecar?.apiToken ?? fileConfig.embeddingSidecar?.apiToken ?? DEFAULTS.embeddingSidecar.apiToken,
  dimensions: envConfig.embeddingSidecar?.dimensions ?? fileConfig.embeddingSidecar?.dimensions ?? DEFAULTS.embeddingSidecar.dimensions,
},
```

And update `DEFAULTS`:

```typescript
embeddingSidecar: { baseUrl: '', apiToken: '', dimensions: 256 },
```

- [x] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [x] **Step 6: Commit**

```bash
git add src/config.ts
git commit -m "config: add EMBEDDING_SIDECAR_BASE_URL and related env vars"
```

---

## Task 3: Implement Markdown Chunking (TDD)

**Files:**

- Create: `src/chunking.ts`
- Create: `test/chunking.test.ts`

- [x] **Step 1–9: Chunking implementation**

The final `src/chunking.ts` contains:

- `MarkdownChunk` interface with `content`, `section`, `url`, `pageTitle`, `chunkIndex`, `totalChunks`, `tokenEstimate`, `charOffset`
- `HEADING_RE = /^(#{1,6})\s+(.*)$/` — requires a space after `#`
- `parseSections()` with `inCodeFence` state tracking, H1 capture as `pageTitle`, H2/H3 as split boundaries, H4+ as content, synthetic depth-2 section for leading content
- `buildChain()` with stack-based ancestor heading tracking (pops when depth decreases)
- `mergeShortSections()` with forward merge (into next sibling) and backward merge (into previous sibling for trailing short sections)
- `splitGroup()` with atomic unit extraction, `baseOffset` parameter for page-relative `charOffset`, overlap with sentence-snapped boundary
- `findSplitPosition()` returning `{ pos, unitIdx }` to avoid quadratic re-scanning
- `postProcessChunks()` as safety net for remaining sub-floor chunks
- Constants: `MAX_TOKENS = 400`, `MIN_TOKENS = 50`, `TOKEN_RATIO = 4`, `OVERLAP_RATIO = 0.2`

Key implementation detail: `snapToSentenceBoundary` searches backward from `splitPos` for the sentence boundary that gives overlap closest to the target 20%, rather than forward from `rawStart`.

- [x] **Tests (18 total)**

```typescript
- splits on H2 and H3 boundaries
- keeps code fences atomic
- merges short sections forward (asserts chunks.length === 1)
- splits oversized sections at boundaries
- preserves H1 as pageTitle on every chunk
- tracks ancestor headings across depth changes
- snaps overlap to last sentence boundary in window
- annotates totalChunks per section
- does not treat # lines inside code fences as headings
- does not split on H4+ headings
- preserves content before the first heading
- merges last short section backward
- keeps markdown tables atomic
- handles empty input
- handles input with no headings
- keeps oversized atomic units whole
- handles multiple H1s
- has monotonically increasing charOffsets
```

- [x] **Commit**

```bash
git add src/chunking.ts test/chunking.test.ts
git commit -m "feat: add markdown-aware chunking with heading split, atomic units, merge-forward, and overlap"
```

---

## Task 4: Implement Embedding Sidecar Client

**Files:**

- Create: `src/tools/semanticCrawl.ts` (sidecar client portion)
- Create: `test/semanticCrawl.test.ts`

- [x] **Step 1–6: Sidecar client implementation**

The final `embedTexts` function in `src/tools/semanticCrawl.ts`:

- Validates `baseUrl` with `unavailableError`
- Uses `assertSafeUrl` and `safeResponseJson` from `httpGuards.ts`
- `retryWithBackoff` with `maxAttempts: 2`, `initialDelayMs: 500`
- `AbortSignal.timeout(60_000)`
- 503 handling: reads `Retry-After` header, waits up to 30s, retries once with bare `fetch`
- `unavailableError` for empty baseUrl, `networkError` for HTTP errors/timeout, `parseError` for bad response shape
- Warning log for `truncatedIndices`
- **New:** Optional `titles?: string[]` parameter passed in request body for document-mode prefixing

The `EmbedRequest` interface:

```typescript
interface EmbedRequest {
  texts: string[];
  titles?: string[]; // NEW: for document-mode prefixing
  mode: 'document' | 'query';
  dimensions: number;
}
```

**New helpers added after review:**

```typescript
const MAX_EMBEDDING_BATCH = 512;

async function embedTextsBatched(
  baseUrl: string,
  apiToken: string,
  texts: string[],
  mode: 'document' | 'query',
  dimensions: number,
  titles?: string[],
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_EMBEDDING_BATCH) {
    const batchTexts = texts.slice(i, i + MAX_EMBEDDING_BATCH);
    const batchTitles = titles ? titles.slice(i, i + MAX_EMBEDDING_BATCH) : undefined;
    const batchEmbeddings = await embedTexts(
      baseUrl,
      apiToken,
      batchTexts,
      mode,
      dimensions,
      batchTitles,
    );
    embeddings.push(...batchEmbeddings);
  }
  return embeddings;
}

function deduplicateChunks(chunks: SemanticCrawlChunk[]): SemanticCrawlChunk[] {
  const seen = new Set<string>();
  return chunks.filter((c) => {
    const normalized = c.text.trim().toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}
```

- [x] **Commit**

```bash
git add src/tools/semanticCrawl.ts test/semanticCrawl.test.ts
git commit -m "feat: add embedding sidecar client with batching, retries, dedup, and error handling"
```

---

## Task 5: Implement Semantic Crawl Orchestrator

**Files:**

- Modify: `src/tools/semanticCrawl.ts`

- [x] **Step 1–3: Orchestrator implementation**

The final `semanticCrawl` function:

```typescript
export async function semanticCrawl(
  opts: SemanticCrawlOptions,
  crawl4aiCfg: Crawl4aiConfig,
  embeddingBaseUrl: string,
  embeddingApiToken: string,
  embeddingDimensions: number,
): Promise<SemanticCrawlResult> {
  // 1. Crawl
  const crawlOpts: WebCrawlOptions = { ... };
  const crawlResult = await webCrawl(...);

  // 2. Chunk
  let allChunks: SemanticCrawlChunk[] = [];
  for (const page of crawlResult.pages) {
    if (!page.success || !page.markdown) continue;
    const chunks = chunkMarkdown(page.markdown, page.url);
    allChunks.push(...chunks.map(...));
  }

  // 3. Deduplicate before embedding
  const preDedupCount = allChunks.length;
  allChunks = deduplicateChunks(allChunks);
  if (preDedupCount !== allChunks.length) {
    logger.info({ preDedup: preDedupCount, postDedup: allChunks.length }, 'Deduplicated chunks');
  }

  // 4. Chunk safety check
  if (allChunks.length > MAX_CHUNKS_HARD) throw new Error(...);
  if (allChunks.length > MAX_CHUNKS_SOFT) logger.warn(...);

  // 5. Embed chunks (batched) and query in parallel
  const chunkTexts = allChunks.map((c) => c.text);
  const chunkTitles = allChunks.map((c) => c.section.split(' > ').at(-1)?.replace(/^#+\s+/, '') ?? 'none');
  const [chunkEmbeddings, queryEmbeddings] = await Promise.all([
    embedTextsBatched(embeddingBaseUrl, embeddingApiToken, chunkTexts, 'document', embeddingDimensions, chunkTitles),
    embedTexts(embeddingBaseUrl, embeddingApiToken, [opts.query], 'query', embeddingDimensions),
  ]);

  // 6. Rank
  for (let i = 0; i < allChunks.length; i++) {
    allChunks[i].score = cosineSimilarity(queryEmbedding, chunkEmbeddings[i]);
  }
  allChunks.sort((a, b) => b.score - a.score);

  // 7. Return topK
  return { seedUrl, query, pagesCrawled, totalChunks, successfulPages, chunks: topChunks };
}
```

- [x] **Step 4: Commit**

```bash
git add src/tools/semanticCrawl.ts
git commit -m "feat: add semanticCrawl orchestrator with crawl, chunk, dedup, embed, rank pipeline"
```

---

## Task 6: Wire into Server + Health + Config

**Files:**

- Modify: `src/server.ts`
- Modify: `src/health.ts`

- [x] **Step 1: Register semantic_crawl tool in server.ts**

Import:

```typescript
import { semanticCrawl } from './tools/semanticCrawl.js';
```

Registration (gated on `EMBEDDING_SIDECAR_BASE_URL` and `CRAWL4AI_BASE_URL`):

```typescript
// ── semantic_crawl ──────────────────────────────────────────────────────
if (!gated.has('semantic_crawl'))
  server.registerTool(
    'semantic_crawl',
    {
      description:
        'Crawl a website and return the most semantically relevant passages for a specific query. ' +
        'Uses EmbeddingGemma (300M, local) to chunk, embed, and rank content by similarity — ' +
        'returning dense signal instead of raw pages.\n\n' +
        'USE THIS TOOL when you need to:\n' +
        '- Find specific information within a large documentation site, codebase reference, or multi-page resource\n' +
        '- Answer "how does X handle Y" or "where does X explain Z" against a known URL\n' +
        '- Research a specific topic across an entire domain without reading every page\n' +
        '- Any query of the form "in [site/docs], find [concept/answer]"\n\n' +
        'PREFER web_crawl instead when you need full page content, are summarising an entire site, or have no specific query to answer.\n' +
        "PREFER web_search when you don't have a target URL.",
      inputSchema: {
        url: z.url().describe('Seed URL to start crawling from'),
        query: z.string().describe('The semantic search query — what are you looking for?'),
        topK: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe('Number of most-relevant chunks to return (1–50, default 10)'),
        strategy: z
          .enum(['bfs', 'dfs'])
          .optional()
          .default('bfs')
          .describe('Crawl strategy: bfs (breadth-first) | dfs (depth-first)'),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .default(2)
          .describe('Maximum link depth (1–5, default 2)'),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe('Maximum pages to crawl (1–100, default 20)'),
        includeExternalLinks: z
          .boolean()
          .optional()
          .default(false)
          .describe('Follow external domain links (default false)'),
      },
    },
    async ({ url, query, topK, strategy, maxDepth, maxPages, includeExternalLinks }) => {
      logger.info({ tool: 'semantic_crawl', url, query, topK }, 'Tool invoked');
      const start = Date.now();
      try {
        const data = await semanticCrawl(
          { url, query, topK, strategy, maxDepth, maxPages, includeExternalLinks },
          cfg.crawl4ai,
          cfg.embeddingSidecar.baseUrl,
          cfg.embeddingSidecar.apiToken,
          cfg.embeddingSidecar.dimensions,
        );
        const result = makeResult('semantic_crawl', data, Date.now() - start);
        return successResponse(result);
      } catch (err: unknown) {
        logger.error({ err, tool: 'semantic_crawl' }, 'Tool failed');
        return errorResponse(err);
      }
    },
  );
```

- [x] **Step 2: Add gating in health.ts**

```typescript
semantic_crawl: {
  check: (cfg) => cfg.crawl4ai.baseUrl.length > 0 && cfg.embeddingSidecar.baseUrl.length > 0,
  remediation:
    'Set CRAWL4AI_BASE_URL and EMBEDDING_SIDECAR_BASE_URL. The embedding sidecar requires a running crawl4ai sidecar.',
},
```

Network probe:

```typescript
if (cfg.embeddingSidecar.baseUrl.length > 0) {
  probes.push({
    label: 'embedding-sidecar',
    url: `${cfg.embeddingSidecar.baseUrl.replace(/\/+$/, '')}/health`,
    tools: ['semantic_crawl'],
  });
}
```

Also updated crawl4ai probe to map to `['web_crawl', 'semantic_crawl']`.

- [x] **Step 3–5: Typecheck, lint, commit**

```bash
npm run typecheck
npm run lint
git add src/server.ts src/health.ts
git commit -m "feat: register semantic_crawl tool with gating and health probes"
```

---

## Task 7: Write Embedding Sidecar Spec

**Files:**

- Create: `docs/superpowers/specs/2026-04-23-embedding-sidecar.md`

- [x] **Spec written**

Covers:

- Asymmetric prompt formatting (query vs document modes, code-detection heuristic)
- Float16 restriction with fail-fast startup validation
- MRL dimensions (128/256/512/768) with quality trade-offs
- HuggingFace authentication requirements (Gemma license click-through)
- HTTP API contract (`POST /embed`, `GET /health`, `GET /metrics`)
- Docker reference with `HF_TOKEN` build arg
- Default dimension: 256

---

## Task 8: Implement Python Embedding Sidecar

**Files:**

- Create: `sidecar/embedding/main.py`
- Create: `sidecar/embedding/requirements.txt`
- Create: `sidecar/embedding/Dockerfile`
- Create: `sidecar/embedding/README.md`

- [x] **Implementation complete**

`main.py`:

- FastAPI with lifespan context for model loading
- Loads `google/embedding-gemma-300m` with `torch_dtype=torch.bfloat16`
- Fail-fast on float16: asserts dtype is `float32` or `bfloat16`
- Asymmetric prompt formatting:
  - Query mode: `task: search result | query: {content}` (or `task: code retrieval` for code-like queries)
  - Document mode: `title: {title} | text: {content}`
- MRL truncation + L2 normalization
- Tracks truncated indices
- Max batch: 512
- Endpoints: `POST /embed`, `GET /health`, `GET /metrics`

---

## Task 9: End-to-End Validation

**Files:** None (validation only)

- [x] **Step 1: Build the project**

```bash
npm run build
```

Result: no errors.

- [x] **Step 2: Run all tests**

```bash
npm test
```

Result: 278 tests passing, 0 failures.

- [x] **Step 3: Verify server starts without errors**

```bash
npm run dev
```

Result: no crashes, `semantic_crawl` appears in tool list when both `EMBEDDING_SIDECAR_BASE_URL` and `CRAWL4AI_BASE_URL` are set.

- [x] **Step 4: TypeScript strict mode**

```bash
npm run typecheck
npm run lint
```

Result: both pass.

---

## Self-Review Checklist

### 1. Spec coverage

| Spec Requirement                                    | Task            | Status               |
| --------------------------------------------------- | --------------- | -------------------- |
| Markdown-aware chunking                             | Task 3          | ✅                   |
| Atomic units (code fences, tables, indented blocks) | Task 3          | ✅                   |
| Merge-forward with chaining                         | Task 3          | ✅                   |
| Merge-backward fallback                             | Task 3          | ✅                   |
| Size-based split with sentence-snapped overlap      | Task 3          | ✅ (backward search) |
| Two-pass totalChunks per section                    | Task 3          | ✅                   |
| Ancestor heading tracking                           | Task 3          | ✅                   |
| Headings inside code fences ignored                 | Task 3          | ✅                   |
| Content before first heading preserved              | Task 3          | ✅                   |
| Multiple H1s handled                                | Task 3          | ✅                   |
| H4+ treated as content                              | Task 3          | ✅                   |
| Embedding sidecar POST /embed                       | Task 4          | ✅                   |
| Embedding batching (512 max)                        | Task 4          | ✅                   |
| Deduplication before embedding                      | Task 4          | ✅                   |
| Title metadata for document mode                    | Task 4          | ✅                   |
| L2-normalized vectors                               | Task 4          | ✅                   |
| mode: document/query with asymmetric prefixes       | Task 4 + Task 8 | ✅                   |
| MRL dimensions                                      | Task 4 + Task 2 | ✅                   |
| Error handling (503 retry, etc.)                    | Task 4          | ✅                   |
| MCP tool contract                                   | Task 6          | ✅                   |
| Config integration                                  | Task 2 + Task 6 | ✅                   |
| Health check gating                                 | Task 6          | ✅                   |
| Chunk memory safety                                 | Task 5          | ✅                   |
| Sidecar spec document                               | Task 7          | ✅                   |
| Python sidecar implementation                       | Task 8          | ✅                   |
| Float16 restriction                                 | Task 8          | ✅                   |
| HF auth documentation                               | Task 8          | ✅                   |

### 2. Placeholder scan

- No "TBD" or "TODO" in any committed file.
- No "implement later" or "fill in details".
- All steps show actual code.
- No "Similar to Task N" references.

### 3. Type consistency

- `SemanticCrawlResult` / `SemanticCrawlChunk` match between `src/types.ts` and `src/tools/semanticCrawl.ts`.
- `MarkdownChunk` interface is consistent across `src/chunking.ts` and `src/tools/semanticCrawl.ts`.
- `EmbeddingSidecarConfig` is used consistently in `src/config.ts`.
- `EmbedRequest` has `titles?: string[]` matching the sidecar contract.
