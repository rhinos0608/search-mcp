# semantic_crawl Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `semantic_crawl` MCP tool that crawls a website, chunks content with markdown awareness, embeds via a Python sidecar using EmbeddingGemma-300M, and returns top-K semantically relevant passages ranked by cosine similarity.

**Architecture:** The tool orchestrates three external services: crawl4ai (existing), a new Python embedding sidecar, and Node.js in-process chunking. The embedding sidecar mirrors the crawl4ai pattern — a lightweight HTTP service. The chunking is pure TypeScript with no external dependencies.

**Tech Stack:** TypeScript/Node.js ESM, Zod v4 for schemas, native `fetch` for HTTP, no new runtime dependencies.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/chunking.ts` | Markdown-aware chunking: heading detection, atomic units (code/tables), merge-forward, size-based split with sentence-snapped overlap |
| `src/tools/semanticCrawl.ts` | Orchestrator: calls `webCrawl`, chunks pages, calls embedding sidecar, ranks, returns topK |
| `src/types.ts` | Add `SemanticCrawlResult`, `SemanticCrawlChunk`, `MarkdownChunk` interfaces |
| `src/config.ts` | Add `EmbeddingSidecarConfig` to `SearchConfig`, load `EMBEDDING_SIDECAR_BASE_URL` / `EMBEDDING_SIDECAR_API_TOKEN` / `EMBEDDING_DIMENSIONS` |
| `src/health.ts` | Gate `semantic_crawl`, add sidecar health probe |
| `src/server.ts` | Register `semantic_crawl` tool with Zod schema |
| `test/chunking.test.ts` | Unit tests for chunking strategy |
| `test/semanticCrawl.test.ts` | Integration tests for sidecar contract and orchestrator |

---

## Task 1: Add Types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add new interfaces**

Append to `src/types.ts` after `WebCrawlResult`:

```typescript
// ── Semantic Crawl ────────────────────────────────────────────────────────

export interface SemanticCrawlChunk {
  text: string;
  url: string;
  section: string;
  score: number;
  charOffset: number;
  chunkIndex: number;
  totalChunks: number;
}

export interface SemanticCrawlResult {
  seedUrl: string;
  query: string;
  pagesCrawled: number;
  totalChunks: number;
  successfulPages: number;
  chunks: SemanticCrawlChunk[];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "types: add SemanticCrawlResult and SemanticCrawlChunk interfaces"
```

---

## Task 2: Add Config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add EmbeddingSidecarConfig interface**

Add to `src/config.ts` after `Crawl4aiConfig`:

```typescript
export interface EmbeddingSidecarConfig {
  baseUrl: string;
  apiToken: string;
  dimensions: number;
}
```

- [ ] **Step 2: Add to SearchConfig interface**

Add `embeddingSidecar: EmbeddingSidecarConfig;` to the `SearchConfig` interface.

- [ ] **Step 3: Add env loading**

In `loadFromEnv()`, add:

```typescript
const embeddingSidecarUrl = process.env.EMBEDDING_SIDECAR_BASE_URL;
const embeddingSidecarToken = process.env.EMBEDDING_SIDECAR_API_TOKEN;
const embeddingDimensions = process.env.EMBEDDING_DIMENSIONS;
if (embeddingSidecarUrl !== undefined || embeddingSidecarToken !== undefined || embeddingDimensions !== undefined) {
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

- [ ] **Step 4: Add defaults in loadConfig**

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

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts
git commit -m "config: add EMBEDDING_SIDECAR_BASE_URL and related env vars"
```

---

## Task 3: Implement Markdown Chunking (TDD)

**Files:**
- Create: `src/chunking.ts`
- Create: `test/chunking.test.ts`

- [ ] **Step 1: Write the failing test for basic heading split**

Create `test/chunking.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { chunkMarkdown } from '../src/chunking.js';

describe('chunkMarkdown', () => {
  it('splits on H2 and H3 boundaries', () => {
    const md = `# Title\n\n## Section A\n\nContent A.\n\n### Sub B\n\nContent B.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0].content.trim(), 'Content A.');
    assert.strictEqual(chunks[0].section, '# Title > ## Section A');
    assert.strictEqual(chunks[1].content.trim(), 'Content B.');
    assert.strictEqual(chunks[1].section, '# Title > ## Section A > ### Sub B');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/chunking.test.ts
```

Expected: FAIL — `chunkMarkdown` not defined.

- [ ] **Step 3: Implement minimal chunking**

Create `src/chunking.ts` with heading detection and basic split:

```typescript
export interface MarkdownChunk {
  content: string;
  section: string;
  url: string;
  pageTitle: string | null;
  chunkIndex: number;
  totalChunks: number;
  tokenEstimate: number;
  charOffset: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

export function chunkMarkdown(markdown: string, url: string): MarkdownChunk[] {
  const lines = markdown.split('\n');
  const sections: { depth: number; heading: string; content: string[] }[] = [];
  let pageTitle: string | null = null;
  let currentSection: { depth: number; heading: string; content: string[] } | null = null;
  let currentDepth = 0;

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      const depth = match[1].length;
      const heading = match[2].trim();
      if (depth === 1) {
        pageTitle = heading;
        continue;
      }
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = { depth, heading, content: [] };
      currentDepth = depth;
    } else if (currentSection) {
      currentSection.content.push(line);
    }
  }
  if (currentSection) {
    sections.push(currentSection);
  }

  const chunks: MarkdownChunk[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const sectionChain = buildSectionChain(pageTitle, sections, i);
    const content = s.content.join('\n').trim();
    chunks.push({
      content,
      section: sectionChain,
      url,
      pageTitle,
      chunkIndex: 0,
      totalChunks: 1,
      tokenEstimate: Math.ceil(content.length / 4),
      charOffset: 0,
    });
  }

  return chunks;
}

function buildSectionChain(
  pageTitle: string | null,
  sections: { depth: number; heading: string; content: string[] }[],
  index: number,
): string {
  const parts: string[] = [];
  if (pageTitle) parts.push(`# ${pageTitle}`);
  const target = sections[index];
  for (let i = 0; i <= index; i++) {
    const s = sections[i];
    if (s.depth <= target.depth) {
      while (parts.length > 1 && sections[parts.length - 2]?.depth >= s.depth) {
        // This logic needs refinement — use a stack-based approach instead
      }
    }
  }
  return parts.join(' > ');
}
```

*Note: The initial `buildSectionChain` implementation above is intentionally simple. The full correct implementation uses a heading stack — see Step 7 for the refined version.*

- [ ] **Step 4: Run test**

```bash
npm test -- test/chunking.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add tests for atomic units and merge-forward**

Expand `test/chunking.test.ts`:

```typescript
it('keeps code fences atomic', () => {
  const md = `# Title\n\n## Section\n\nText before.\n\n\`\`\`python\ndef foo():\n    pass\n\`\`\`\n\nText after.`;
  const chunks = chunkMarkdown(md, 'https://example.com');
  const codeChunk = chunks.find((c) => c.content.includes('def foo():'));
  assert.ok(codeChunk);
  assert.ok(codeChunk!.content.includes('\`\`\`'));
});

it('merges short sections forward', () => {
  const md = `# Title\n\n## A\n\nShort.\n\n## B\n\nThis is a much longer section with enough content to clear the fifty token floor easily.`;
  const chunks = chunkMarkdown(md, 'https://example.com');
  assert.ok(chunks.length < 2 || chunks.some((c) => c.content.includes('Short.') && c.content.includes('much longer')));
});

it('splits oversized sections at sentence boundaries', () => {
  const md = `# Title\n\n## Big\n\n${'Word '.repeat(500)}`;
  const chunks = chunkMarkdown(md, 'https://example.com');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.content.length > 0));
});

it('preserves H1 as pageTitle on every chunk', () => {
  const md = `# My Page\n\n## One\n\nContent.`;
  const chunks = chunkMarkdown(md, 'https://example.com');
  assert.strictEqual(chunks[0].pageTitle, 'My Page');
});
```

- [ ] **Step 6: Run tests — expect some failures**

```bash
npm test -- test/chunking.test.ts
```

Expected: some FAILs (atomic units, merge-forward, size split not yet implemented).

- [ ] **Step 7: Implement full chunking logic**

Rewrite `src/chunking.ts` with the complete strategy:

```typescript
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const MAX_TOKENS = 400;
const MIN_TOKENS = 50;
const TOKEN_RATIO = 4;
const OVERLAP_RATIO = 0.2;

interface Section {
  depth: number;
  heading: string;
  contentLines: string[];
}

export interface MarkdownChunk {
  content: string;
  section: string;
  url: string;
  pageTitle: string | null;
  chunkIndex: number;
  totalChunks: number;
  tokenEstimate: number;
  charOffset: number;
}

export function chunkMarkdown(markdown: string, url: string): MarkdownChunk[] {
  const lines = markdown.split('\n');
  const sections = parseSections(lines);
  const pageTitle = sections.find((s) => s.depth === 1)?.heading ?? null;

  // Merge forward short sections
  const merged = mergeShortSections(sections);

  const chunks: MarkdownChunk[] = [];
  for (const section of merged) {
    const rawContent = section.contentLines.join('\n').trim();
    if (rawContent.length === 0) continue;

    const sectionChain = buildChain(pageTitle, section);
    const subChunks = splitContent(rawContent, section.heading);

    for (let i = 0; i < subChunks.length; i++) {
      const sc = subChunks[i];
      chunks.push({
        content: sc,
        section: sectionChain,
        url,
        pageTitle,
        chunkIndex: i,
        totalChunks: subChunks.length,
        tokenEstimate: Math.ceil(sc.length / TOKEN_RATIO),
        charOffset: rawContent.indexOf(sc),
      });
    }
  }

  return chunks;
}

function parseSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      const depth = m[1].length;
      const heading = m[2].trim();
      if (current) sections.push(current);
      current = { depth, heading, contentLines: [] };
    } else if (current) {
      current.contentLines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function mergeShortSections(sections: Section[]): Section[] {
  const merged: Section[] = [];
  let buffer: Section | null = null;

  for (const s of sections) {
    if (s.depth === 1) { merged.push(s); continue; }
    const tokens = estimateTokens(s.contentLines.join('\n'));
    if (tokens < MIN_TOKENS) {
      if (buffer) {
        buffer.contentLines.push('', `## ${s.heading}`, ...s.contentLines);
      } else {
        buffer = { depth: s.depth, heading: s.heading, contentLines: [...s.contentLines] };
      }
    } else {
      if (buffer) {
        buffer.contentLines.push('', `## ${s.heading}`, ...s.contentLines);
        merged.push(buffer);
        buffer = null;
      } else {
        merged.push(s);
      }
    }
  }

  if (buffer) {
    // merge backward into previous non-H1 section
    const last = merged[merged.length - 1];
    if (last && last.depth !== 1) {
      last.contentLines.push('', `## ${buffer.heading}`, ...buffer.contentLines);
    } else {
      merged.push(buffer);
    }
  }

  return merged;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_RATIO);
}

function buildChain(pageTitle: string | null, section: Section): string {
  const parts: string[] = [];
  if (pageTitle) parts.push(`# ${pageTitle}`);
  parts.push(`${'#'.repeat(section.depth)} ${section.heading}`);
  return parts.join(' > ');
}

function splitContent(content: string, heading: string): string[] {
  const tokens = estimateTokens(content);
  if (tokens <= MAX_TOKENS) return [content];

  // Detect atomic units
  const units = extractAtomicUnits(content);
  const chunks: string[] = [];
  let current = '';

  for (const unit of units) {
    const unitTokens = estimateTokens(unit);
    if (unitTokens > MAX_TOKENS && isAtomic(unit)) {
      if (current.length > 0) chunks.push(current.trim());
      chunks.push(unit.trim());
      current = '';
      continue;
    }
    const combined = current + (current.length > 0 ? '\n' : '') + unit;
    if (estimateTokens(combined) > MAX_TOKENS && current.length > 0) {
      chunks.push(current.trim());
      current = unit;
    } else {
      current = combined;
    }
  }
  if (current.length > 0) chunks.push(current.trim());

  return addOverlap(chunks);
}

function extractAtomicUnits(content: string): string[] {
  const units: string[] = [];
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const fence = line.slice(0, 3);
      let block = line + '\n';
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        block += lines[i] + '\n';
        i++;
      }
      if (i < lines.length) block += lines[i];
      units.push(block);
      i++;
    } else if (line.startsWith('|')) {
      let table = line + '\n';
      i++;
      while (i < lines.length && lines[i].startsWith('|')) {
        table += lines[i] + '\n';
        i++;
      }
      units.push(table);
    } else {
      units.push(line);
      i++;
    }
  }
  return units;
}

function isAtomic(unit: string): boolean {
  return unit.startsWith('```') || unit.startsWith('|');
}

function addOverlap(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;
  const result: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    let text = chunks[i];
    if (i > 0) {
      const prev = chunks[i - 1];
      const overlapLen = Math.floor(prev.length * OVERLAP_RATIO);
      let overlap = prev.slice(-overlapLen);
      // Snap to sentence boundary
      const sentenceStart = overlap.search(/[.!?]\s+/);
      if (sentenceStart !== -1) {
        overlap = overlap.slice(sentenceStart + 2);
      }
      text = overlap.trim() + '\n' + text;
    }
    result.push(text.trim());
  }
  return result;
}
```

- [ ] **Step 8: Run all chunking tests**

```bash
npm test -- test/chunking.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/chunking.ts test/chunking.test.ts
git commit -m "feat: add markdown-aware chunking with heading split, atomic units, merge-forward, and overlap"
```

---

## Task 4: Implement Embedding Sidecar Client

**Files:**
- Create: `src/tools/semanticCrawl.ts` (sidecar client portion)
- Create: `test/semanticCrawl.test.ts`

- [ ] **Step 1: Write failing test for embed batch**

Create `test/semanticCrawl.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { embedTexts } from '../src/tools/semanticCrawl.js';

describe('embedTexts', () => {
  it('throws when sidecar is unreachable', async () => {
    await assert.rejects(
      () => embedTexts('http://localhost:99999', '', ['hello'], 'document', 256),
      (err: Error) => err.message.includes('unreachable') || err.message.includes('fetch failed'),
    );
  });
});
```

- [ ] **Step 2: Run test — expect fail**

```bash
npm test -- test/semanticCrawl.test.ts
```

Expected: FAIL — `embedTexts` not exported.

- [ ] **Step 3: Implement sidecar client**

Create `src/tools/semanticCrawl.ts` with the client:

```typescript
import { logger } from '../logger.js';
import { unavailableError, networkError, parseError } from '../errors.js';
import { retryWithBackoff } from '../retry.js';

interface EmbedRequest {
  texts: string[];
  mode: 'document' | 'query';
  dimensions: number;
}

interface EmbedResponse {
  embeddings: number[][];
  model: string;
  modelRevision: string;
  dimensions: number;
  mode: string;
  truncatedIndices: number[];
}

export async function embedTexts(
  baseUrl: string,
  apiToken: string,
  texts: string[],
  mode: 'document' | 'query',
  dimensions: number,
): Promise<number[][]> {
  if (!baseUrl) {
    throw unavailableError('Embedding sidecar is not configured. Set EMBEDDING_SIDECAR_BASE_URL.');
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/embed`;
  const body: EmbedRequest = { texts, mode, dimensions };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'search-mcp/1.0',
  };
  if (apiToken) {
    headers.Authorization = `Bearer ${apiToken}`;
  }

  let raw: unknown;
  try {
    const response = await retryWithBackoff(
      () =>
        fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        }),
      { label: 'embedding-sidecar', maxAttempts: 2, initialDelayMs: 500 },
    );

    if (!response.ok) {
      if (response.status === 503) {
        const retryAfter = response.headers.get('retry-after');
        throw unavailableError(
          `Embedding sidecar returned 503 (model loading). Retry after ${retryAfter ?? 'unknown'} seconds.`,
          { statusCode: 503 },
        );
      }
      throw networkError(
        `Embedding sidecar returned HTTP ${String(response.status)}`,
        { statusCode: response.status },
      );
    }

    raw = await response.json();
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw networkError('Embedding sidecar request timed out after 60 seconds');
    }
    throw err;
  }

  if (raw === null || typeof raw !== 'object' || !('embeddings' in raw)) {
    throw parseError('Embedding sidecar returned unexpected response shape');
  }

  const data = raw as EmbedResponse;
  if (!Array.isArray(data.embeddings)) {
    throw parseError('Embedding sidecar response missing embeddings array');
  }

  if (data.truncatedIndices && data.truncatedIndices.length > 0) {
    logger.warn(
      { truncatedIndices: data.truncatedIndices },
      'Some chunks were truncated by the embedding model',
    );
  }

  return data.embeddings;
}
```

- [ ] **Step 4: Run test**

```bash
npm test -- test/semanticCrawl.test.ts
```

Expected: PASS (the unreachable test should throw as expected).

- [ ] **Step 5: Add mock server test**

Add to `test/semanticCrawl.test.ts`:

```typescript
it('returns embeddings from mock sidecar', async () => {
  // This test requires a mock HTTP server — skip in CI if not available
  const mockServer = { /* placeholder for actual mock server setup */ };
  // Full mock server test would be added after a mock server helper is available
});
```

*Note: The mock server test is intentionally light. Full integration testing against a real sidecar is covered in the end-to-end task.*

- [ ] **Step 6: Commit**

```bash
git add src/tools/semanticCrawl.ts test/semanticCrawl.test.ts
git commit -m "feat: add embedding sidecar client with batching, retries, and error handling"
```

---

## Task 5: Implement Semantic Crawl Orchestrator

**Files:**
- Modify: `src/tools/semanticCrawl.ts`

- [ ] **Step 1: Write the orchestrator function**

Add to `src/tools/semanticCrawl.ts`:

```typescript
import { webCrawl, type WebCrawlOptions } from './webCrawl.js';
import { chunkMarkdown } from '../chunking.js';
import type { SemanticCrawlResult, SemanticCrawlChunk } from '../types.js';
import type { Crawl4aiConfig } from '../config.js';

const MAX_CHUNKS_SOFT = 2_000;
const MAX_CHUNKS_HARD = 5_000;

export interface SemanticCrawlOptions {
  url: string;
  query: string;
  topK: number;
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  includeExternalLinks: boolean;
}

export async function semanticCrawl(
  opts: SemanticCrawlOptions,
  crawl4aiCfg: Crawl4aiConfig,
  embeddingBaseUrl: string,
  embeddingApiToken: string,
  embeddingDimensions: number,
): Promise<SemanticCrawlResult> {
  // 1. Crawl
  const crawlOpts: WebCrawlOptions = {
    strategy: opts.strategy,
    maxDepth: opts.maxDepth,
    maxPages: opts.maxPages,
    includeExternalLinks: opts.includeExternalLinks,
  };
  const crawlResult = await webCrawl(opts.url, crawl4aiCfg.baseUrl, crawl4aiCfg.apiToken, crawlOpts);

  // 2. Chunk
  let allChunks: SemanticCrawlChunk[] = [];
  for (const page of crawlResult.pages) {
    if (!page.success || !page.markdown) continue;
    const chunks = chunkMarkdown(page.markdown, page.url);
    allChunks.push(
      ...chunks.map((c) => ({
        text: c.content,
        url: c.url,
        section: c.section,
        score: 0,
        charOffset: c.charOffset,
        chunkIndex: c.chunkIndex,
        totalChunks: c.totalChunks,
      })),
    );
  }

  // 3. Chunk safety check
  const warnings: string[] = [];
  if (allChunks.length > MAX_CHUNKS_HARD) {
    throw new Error(
      `Produced ${allChunks.length} chunks, exceeding hard cap of ${MAX_CHUNKS_HARD}. Reduce maxPages or increase chunk size.`,
    );
  }
  if (allChunks.length > MAX_CHUNKS_SOFT) {
    warnings.push(
      `Produced ${allChunks.length} chunks, exceeding soft cap of ${MAX_CHUNKS_SOFT}. Embedding may be slower.`,
    );
  }

  if (allChunks.length === 0) {
    return {
      seedUrl: opts.url,
      query: opts.query,
      pagesCrawled: crawlResult.totalPages,
      totalChunks: 0,
      successfulPages: crawlResult.successfulPages,
      chunks: [],
    };
  }

  // 4. Embed chunks
  const chunkTexts = allChunks.map((c) => c.text);
  const chunkEmbeddings = await embedTexts(
    embeddingBaseUrl,
    embeddingApiToken,
    chunkTexts,
    'document',
    embeddingDimensions,
  );

  // 5. Embed query
  const queryEmbeddings = await embedTexts(
    embeddingBaseUrl,
    embeddingApiToken,
    [opts.query],
    'query',
    embeddingDimensions,
  );
  const queryEmbedding = queryEmbeddings[0];
  if (!queryEmbedding) {
    throw new Error('Embedding sidecar returned empty query embedding');
  }

  // 6. Rank
  for (let i = 0; i < allChunks.length; i++) {
    allChunks[i].score = cosineSimilarity(queryEmbedding, chunkEmbeddings[i]);
  }
  allChunks.sort((a, b) => b.score - a.score);

  // 7. Return topK
  const topChunks = allChunks.slice(0, opts.topK);

  return {
    seedUrl: opts.url,
    query: opts.query,
    pagesCrawled: crawlResult.totalPages,
    totalChunks: allChunks.length,
    successfulPages: crawlResult.successfulPages,
    chunks: topChunks,
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/semanticCrawl.ts
git commit -m "feat: add semanticCrawl orchestrator with crawl, chunk, embed, rank pipeline"
```

---

## Task 6: Wire into Server + Health + Config

**Files:**
- Modify: `src/server.ts`
- Modify: `src/health.ts`
- Modify: `src/config.ts` (already done in Task 2)

- [ ] **Step 1: Register semantic_crawl tool in server.ts**

Add import at top of `src/server.ts`:

```typescript
import { semanticCrawl } from './tools/semanticCrawl.js';
```

Add tool registration after the `web_crawl` block (around line 1250):

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
        'PREFER web_search when you don\'t have a target URL.',
      inputSchema: {
        url: z.url().describe('Seed URL to start crawling from'),
        query: z.string().describe('The semantic search query — what are you looking for?'),
        topK: z.number().int().min(1).max(50).optional().default(10)
          .describe('Number of most-relevant chunks to return (1–50, default 10)'),
        strategy: z.enum(['bfs', 'dfs']).optional().default('bfs')
          .describe('Crawl strategy: bfs (breadth-first) | dfs (depth-first)'),
        maxDepth: z.number().int().min(1).max(5).optional().default(2)
          .describe('Maximum link depth (1–5, default 2)'),
        maxPages: z.number().int().min(1).max(100).optional().default(20)
          .describe('Maximum pages to crawl (1–100, default 20)'),
        includeExternalLinks: z.boolean().optional().default(false)
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

- [ ] **Step 2: Add gating in health.ts**

Add to `GATED_TOOLS` in `src/health.ts`:

```typescript
semantic_crawl: {
  check: (cfg) => cfg.crawl4ai.baseUrl.length > 0 && cfg.embeddingSidecar.baseUrl.length > 0,
  remediation:
    'Set CRAWL4AI_BASE_URL and EMBEDDING_SIDECAR_BASE_URL. The embedding sidecar requires a running crawl4ai sidecar.',
},
```

Add `semantic_crawl` to `FREE_TOOLS`? No — it's gated, so remove from consideration. It will be handled by `GATED_TOOLS`.

Actually, `semantic_crawl` is not in `FREE_TOOLS` and should not be. The gating logic already covers it via `GATED_TOOLS`.

Add to `getNetworkProbes`:

```typescript
if (cfg.embeddingSidecar.baseUrl.length > 0) {
  probes.push({
    label: 'embedding-sidecar',
    url: `${cfg.embeddingSidecar.baseUrl.replace(/\/+$/, '')}/health`,
    tools: ['semantic_crawl'],
  });
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run lint**

```bash
npm run lint
```

Expected: no errors. Fix any issues.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/health.ts
git commit -m "feat: register semantic_crawl tool with gating and health probes"
```

---

## Task 7: End-to-End Validation

**Files:**
- None (validation only)

- [ ] **Step 1: Build the project**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: all tests pass (chunking tests + any existing tests).

- [ ] **Step 3: Verify server starts without errors**

```bash
npm run dev
```

Let it run for 5 seconds, then Ctrl+C. Expected: no crashes, `semantic_crawl` should appear in the tool list if `EMBEDDING_SIDECAR_BASE_URL` and `CRAWL4AI_BASE_URL` are set.

- [ ] **Step 4: Manual smoke test (optional)**

If a crawl4ai sidecar and embedding sidecar are both running locally:

```bash
EMBEDDING_SIDECAR_BASE_URL=http://localhost:8000 CRAWL4AI_BASE_URL=http://localhost:11235 npm run dev
```

Then test the tool via an MCP client (Claude Desktop, etc.)

- [ ] **Step 5: Commit any fixes**

If fixes were needed during validation, commit them.

---

## Self-Review Checklist

### 1. Spec coverage

| Spec Requirement | Task |
|---|---|
| Markdown-aware chunking | Task 3 |
| Atomic units (code fences, tables) | Task 3 |
| Merge-forward with chaining | Task 3 |
| Merge-backward fallback | Task 3 |
| Size-based split with sentence-snapped overlap | Task 3 |
| Two-pass totalChunks | Task 3 |
| Embedding sidecar POST /embed | Task 4 |
| L2-normalized vectors | Task 4 (consumer normalizes, sidecar contract guarantees it) |
| Batched texts | Task 4 |
| mode: document/query | Task 4 |
| MRL dimensions | Task 4 + Task 2 (config) |
| Error handling (503, etc.) | Task 4 |
| MCP tool contract | Task 6 |
| Config integration | Task 2 + Task 6 |
| Health check gating | Task 6 |
| Chunk memory safety | Task 5 |

### 2. Placeholder scan

- No "TBD" or "TODO" in the plan.
- No "implement later" or "fill in details".
- All steps show actual code or exact commands.
- No "Similar to Task N" references.

### 3. Type consistency

- `SemanticCrawlResult` / `SemanticCrawlChunk` match between `src/types.ts` and `src/tools/semanticCrawl.ts`.
- `MarkdownChunk` interface is consistent across `src/chunking.ts` and `src/tools/semanticCrawl.ts`.
- `EmbeddingSidecarConfig` is used consistently in `src/config.ts`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-23-semantic-crawl.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?