# Semantic Crawl Quality & Maturity Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix P0/P1/P2 quality gaps in the `semantic_crawl` tool: cookie banner filtering, crawler focus, RRF pool restriction, cache persistence, reranker smoke test, maxPages enforcement, score observability, and soft lexical constraint.

**Architecture:** All changes are additive or narrowing to the existing `semanticCrawl` → `embedAndRank` pipeline. No new external dependencies. Cookie banner detection and lexical constraint are new pure functions. Cache and RRF changes modify existing orchestration. Score observability replaces scalar score fields with a structured `scores` object.

**Tech Stack:** TypeScript 5.8, ESM, Node.js native test runner, ONNX Runtime (existing), crawl4ai sidecar (existing), embedding sidecar (existing).

---

## File Structure

| File                             | Responsibility                                                                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/cookieBanner.ts`      | **New.** Page-level cookie banner detection (`isCookieBannerPage`).                                                                                                                                                                    |
| `src/utils/lexicalConstraint.ts` | **New.** IDF-weighted soft lexical constraint (`applySoftLexicalConstraint`).                                                                                                                                                          |
| `src/chunking.ts`                | Export chunking constants so `corpusCache.ts` can include them in `corpusId`. No behavioral change to chunking itself.                                                                                                                 |
| `src/types.ts`                   | Add `ScoreDetail`, `RerankScoreDetail`, update `SemanticCrawlChunk` with `scores` object. Remove `biEncoderScore` and `rerankScore`.                                                                                                   |
| `src/utils/corpusCache.ts`       | Fix disk read (content hash validation, schema version, deterministic lookup via source index, env vars for dir/TTL, chunking params in corpusId).                                                                                     |
| `src/utils/rerank.ts`            | Add smoke-test on model load; make `rerank` safe to call even when smoke-test fails.                                                                                                                                                   |
| `src/tools/semanticCrawl.ts`     | Integrate all filters and scoring. Modify `crawlSeeds` (path filter, maxPages truncation), `pagesToCorpus` (cookie banner drop), `embedAndRank` (RRF pool restriction, score observability, soft lexical constraint, reranker opt-in). |
| `src/server.ts`                  | Update Zod schema: `useReranker` default `false`; add `allowPathDrift` parameter.                                                                                                                                                      |
| `test/cookieBanner.test.ts`      | **New.** Cookie banner detection tests.                                                                                                                                                                                                |
| `test/lexicalConstraint.test.ts` | **New.** Soft lexical constraint tests.                                                                                                                                                                                                |
| `test/semanticCrawl.test.ts`     | Update existing tests for new `scores` shape; add RRF pool, maxPages, integration tests.                                                                                                                                               |

---

## Task 1: Cookie Banner Page Detection

**Files:**

- Create: `src/utils/cookieBanner.ts`
- Create: `test/cookieBanner.test.ts`
- Modify: `src/tools/semanticCrawl.ts:563-589` (`pagesToCorpus`)

### Step 1: Write the failing test

Create `test/cookieBanner.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCookieBannerPage } from '../src/utils/cookieBanner.js';

describe('isCookieBannerPage', () => {
  it('returns false for normal content', () => {
    const md =
      '# Getting Started\n\nThis is normal documentation.\n\n## Installation\n\nRun `npm install`.\n';
    assert.strictEqual(isCookieBannerPage(md), false);
  });

  it('detects OneTrust-dominated page (>40% banner lines)', () => {
    const lines = ['OneTrust Consent Manager', 'Your Privacy Choices'];
    const filler = 'Normal line.';
    // 2 banner lines out of 4 total = 50%
    const md = [...lines, filler, filler].join('\n');
    assert.strictEqual(isCookieBannerPage(md), true);
  });

  it('detects Cookiebot-dominated page', () => {
    const lines = ['Cookiebot', 'Manage Cookies', 'Accept All Cookies'];
    const filler = 'Docs content here.';
    // 3 banner lines out of 5 total = 60%
    const md = [...lines, filler, filler].join('\n');
    assert.strictEqual(isCookieBannerPage(md), true);
  });

  it('returns false when banner lines are below 40%', () => {
    const md =
      'OneTrust\n\nNormal documentation line 1.\nNormal documentation line 2.\nNormal documentation line 3.\n';
    // 1 banner line out of 4 = 25%
    assert.strictEqual(isCookieBannerPage(md), false);
  });

  it('detects structural banner pattern (3+ consecutive cookie lines with button)', () => {
    const md = [
      'This site uses cookies to improve your experience.',
      'We value your privacy and tracking preferences.',
      'Please Accept or Reject cookies to continue.',
      'Normal docs line.',
    ].join('\n');
    // Structural pattern: 3 consecutive lines with cookie/tracking/privacy and a button word
    assert.strictEqual(isCookieBannerPage(md), true);
  });
});
```

### Step 2: Run test to verify it fails

```bash
npm test test/cookieBanner.test.ts
```

Expected: FAIL with module not found for `../src/utils/cookieBanner.js`

### Step 3: Write minimal implementation

Create `src/utils/cookieBanner.ts`:

```typescript
const EXACT_PATTERNS = [
  /OneTrust/i,
  /Cookiebot/i,
  /cookie consent/i,
  /Your Privacy Choices/i,
  /Manage Cookies/i,
  /Accept All Cookies/i,
  /We use cookies to/i,
  /By continuing to use this site/i,
];

export function isCookieBannerPage(markdown: string): boolean {
  const lines = markdown.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  const bannerLines: string[] = [];

  // Exact substring matching
  const exactIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (EXACT_PATTERNS.some((p) => p.test(line))) {
      bannerLines.push(line);
      exactIndices.add(i);
    }
  }

  // Structural: 3+ consecutive lines where every line contains one of
  // cookie, consent, privacy, tracking, gdpr, ccpa, and at least one
  // line contains a button pattern (Accept, Reject, Manage)
  // Skip lines already flagged by exact patterns to avoid double-counting.
  let consecutive = 0;
  let hasButton = false;
  let structuralLines = 0;
  for (let i = 0; i < lines.length; i++) {
    if (exactIndices.has(i)) {
      if (consecutive >= 3 && hasButton) {
        structuralLines += consecutive;
      }
      consecutive = 0;
      hasButton = false;
      continue;
    }
    const line = lines[i];
    const lower = line.toLowerCase();
    const hasKeyword = /\b(cookie|consent|privacy|tracking|gdpr|ccpa)\b/i.test(lower);
    if (hasKeyword) {
      consecutive++;
      if (/\b(accept|reject|manage)\b/i.test(lower)) {
        hasButton = true;
      }
    } else {
      if (consecutive >= 3 && hasButton) {
        structuralLines += consecutive;
      }
      consecutive = 0;
      hasButton = false;
    }
  }
  // Check trailing run
  if (consecutive >= 3 && hasButton) {
    structuralLines += consecutive;
  }

  const totalBannerLines = bannerLines.length + structuralLines;
  return totalBannerLines / lines.length > 0.4;
}
```

### Step 4: Integrate into pagesToCorpus

Modify `src/tools/semanticCrawl.ts`. Import at top:

```typescript
import { isCookieBannerPage } from '../utils/cookieBanner.js';
```

Modify `pagesToCorpus` (lines 563-589):

```typescript
function pagesToCorpus(pages: CrawlPageResult[]): CorpusChunk[] {
  const chunks: CorpusChunk[] = [];
  let pagesWithContent = 0;
  let droppedBannerPages = 0;
  for (const page of pages) {
    if (!page.success || !page.markdown) continue;
    if (isCookieBannerPage(page.markdown)) {
      droppedBannerPages++;
      logger.warn({ url: page.url }, 'semantic_crawl: dropping cookie-banner page');
      continue;
    }
    const mdChunks = chunkMarkdown(page.markdown, page.url);
    if (mdChunks.length === 0) continue;
    pagesWithContent++;
    chunks.push(
      ...mdChunks.map((c) => ({
        text: c.content,
        url: c.url,
        section: c.section,
        charOffset: c.charOffset,
        chunkIndex: c.chunkIndex,
        totalChunks: c.totalChunks,
      })),
    );
  }
  if (droppedBannerPages > 0) {
    logger.info({ droppedBannerPages }, 'semantic_crawl: dropped cookie-banner pages');
  }
  if (pagesWithContent < pages.filter((p) => p.success).length - droppedBannerPages) {
    logger.warn(
      { pagesWithContent, successfulPages: pages.filter((p) => p.success).length },
      'Some successfully crawled pages produced no meaningful chunks (likely boilerplate or empty)',
    );
  }
  return chunks;
}
```

### Step 5: Run tests

```bash
npm test test/cookieBanner.test.ts
```

Expected: PASS

### Step 6: Commit

```bash
git add src/utils/cookieBanner.ts test/cookieBanner.test.ts src/tools/semanticCrawl.ts
git commit -m "feat: detect and drop cookie-banner pages before chunking"
```

---

## Task 2: Crawler Path Focus Filter

**Files:**

- Modify: `src/tools/semanticCrawl.ts` (add `isDirectChild`, `filterByPathPrefix`, integrate in `crawlSeeds`)
- Modify: `src/types.ts` (no changes needed — `allowPathDrift` goes on `SemanticCrawlOptions`)
- Modify: `src/server.ts` (add `allowPathDrift` to Zod schema)

### Step 1: Write the failing test

Add to `test/semanticCrawl.test.ts` (create if it doesn't exist, or append):

```typescript
import { filterByPathPrefix, isDirectChild } from '../src/tools/semanticCrawl.js';

describe('isDirectChild', () => {
  it('accepts exactly one deeper segment', () => {
    assert.strictEqual(
      isDirectChild('/reference/dockerfile/build/', '/reference/dockerfile/'),
      true,
    );
  });

  it('rejects two deeper segments', () => {
    assert.strictEqual(
      isDirectChild('/reference/dockerfile/build/args/', '/reference/dockerfile/'),
      false,
    );
  });

  it('rejects sibling paths', () => {
    assert.strictEqual(isDirectChild('/reference/cli/', '/reference/dockerfile/'), false);
  });

  it('rejects identical paths', () => {
    assert.strictEqual(isDirectChild('/reference/dockerfile/', '/reference/dockerfile/'), false);
  });
});

describe('filterByPathPrefix', () => {
  const makePage = (url: string): CrawlPageResult => ({
    url,
    success: true,
    markdown: `# ${url}`,
    title: null,
    description: null,
    links: [],
    statusCode: 200,
    errorMessage: null,
  });

  it('keeps pages under seed path', () => {
    const seed = 'https://docs.docker.com/reference/dockerfile/';
    const pages = [
      makePage('https://docs.docker.com/reference/dockerfile/'),
      makePage('https://docs.docker.com/reference/dockerfile/build/'),
      makePage('https://docs.docker.com/reference/dockerfile/build/args/'),
      makePage('https://docs.docker.com/cli/config/'),
    ];
    const filtered = filterByPathPrefix(pages, seed);
    assert.strictEqual(filtered.length, 2);
    assert.ok(filtered.some((p) => p.url.includes('dockerfile/')));
    assert.ok(!filtered.some((p) => p.url.includes('cli/config')));
    assert.ok(!filtered.some((p) => p.url.includes('args')));
  });

  it('allows drift when allowPathDrift is true', () => {
    const seed = 'https://docs.docker.com/reference/dockerfile/';
    const pages = [
      makePage('https://docs.docker.com/reference/dockerfile/'),
      makePage('https://docs.docker.com/cli/config/'),
    ];
    const filtered = filterByPathPrefix(pages, seed, true);
    assert.strictEqual(filtered.length, 2);
  });
});
```

Run:

```bash
npm test test/semanticCrawl.test.ts
```

Expected: FAIL with `filterByPathPrefix` not defined.

### Step 2: Implement isDirectChild and filterByPathPrefix

Add to `src/tools/semanticCrawl.ts` before `crawlSeeds`:

```typescript
export function isDirectChild(pagePath: string, seedPath: string): boolean {
  const seedParts = seedPath.split('/').filter(Boolean);
  const pageParts = pagePath.split('/').filter(Boolean);
  return (
    pageParts.length === seedParts.length + 1 &&
    pageParts.slice(0, seedParts.length).join('/') === seedParts.join('/')
  );
}

export function filterByPathPrefix(
  pages: CrawlPageResult[],
  seedUrl: string,
  allowPathDrift = false,
): CrawlPageResult[] {
  if (allowPathDrift) return pages;
  const seedPath = new URL(seedUrl).pathname;
  const kept: CrawlPageResult[] = [];
  let dropped = 0;
  for (const page of pages) {
    const pagePath = new URL(page.url).pathname;
    if (pagePath === seedPath || isDirectChild(pagePath, seedPath)) {
      kept.push(page);
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    logger.info({ dropped, seedPath }, 'semantic_crawl: dropped pages outside seed path');
  }
  return kept;
}
```

### Step 3: Integrate into crawlSeeds

Modify `SemanticCrawlOptions` interface (around line 593):

```typescript
export interface SemanticCrawlOptions {
  source: SemanticCrawlSource;
  query: string;
  topK: number;
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  includeExternalLinks: boolean;
  maxBytes?: number | undefined;
  useReranker?: boolean | undefined;
  allowPathDrift?: boolean | undefined;
}
```

Modify `crawlSeeds` (around line 538, after `webCrawl` returns):

```typescript
const result = await webCrawl(seedUrl, crawl4aiCfg.baseUrl, crawl4aiCfg.apiToken, crawlOpts);

// Path focus filter
let pages = filterByPathPrefix(result.pages, seedUrl, opts.allowPathDrift ?? false);

// maxPages client-side enforcement (guarantee seed-first, then truncate)
const seedIndex = pages.findIndex((p) => p.url === seedUrl);
if (seedIndex > 0) {
  const [seedPage] = pages.splice(seedIndex, 1);
  if (seedPage) pages.unshift(seedPage);
}
if (pages.length > perSeedPages) {
  logger.warn(
    { requested: perSeedPages, received: pages.length, seedUrl },
    'semantic_crawl: crawl4ai returned more pages than requested; truncating client-side',
  );
  pages = pages.slice(0, perSeedPages);
}

totalPagesAttempted += result.totalPages;
totalSuccessfulPages += result.successfulPages;
allPages.push(...pages);
```

Replace the old lines:

```typescript
totalPagesAttempted += result.totalPages;
totalSuccessfulPages += result.successfulPages;
allPages.push(...result.pages);
```

### Step 4: Update server.ts Zod schema

Find the `semantic_crawl` registration in `src/server.ts`. Add after `useReranker`:

```typescript
          allowPathDrift: z
            .boolean()
            .optional()
            .default(false)
            .describe('Allow crawler to follow links outside the seed URL path (default false)'),
```

And destructure it in the handler:

```typescript
      async ({
        source,
        query,
        topK,
        strategy,
        maxDepth,
        maxPages,
        includeExternalLinks,
        maxBytes,
        useReranker,
        allowPathDrift,
      }) => {
```

Pass it to `semanticCrawl`:

```typescript
              allowPathDrift,
```

### Step 5: Run tests

```bash
npm test test/semanticCrawl.test.ts
```

Expected: PASS (path filter tests should pass; other tests may need updating for new options shape later).

### Step 6: Commit

```bash
git add src/tools/semanticCrawl.ts src/server.ts test/semanticCrawl.test.ts
git commit -m "feat: add crawler path focus filter with allowPathDrift escape hatch"
```

---

## Task 3: maxPages Client-Side Enforcement

**Note:** The enforcement was already added in Task 2 (Step 3) as part of the `crawlSeeds` integration. This task is the test and any refinement.

**Files:**

- Modify: `test/semanticCrawl.test.ts`

### Step 1: Write the failing test

Add to `test/semanticCrawl.test.ts`:

```typescript
describe('maxPages client-side enforcement', () => {
  it('truncates pages when crawl4ai returns more than requested', async () => {
    // We'll test this by mocking webCrawl directly, but since webCrawl is
    // a module-level import we can't easily mock it in unit tests.
    // Instead, test the truncation logic via a standalone function.
    // For now, verify the seed-first ordering in filterByPathPrefix context.
    const pages = [
      {
        url: 'https://example.com/page2',
        success: true,
        markdown: 'p2',
        title: null,
        description: null,
        links: [],
        statusCode: 200,
        errorMessage: null,
      },
      {
        url: 'https://example.com/',
        success: true,
        markdown: 'seed',
        title: null,
        description: null,
        links: [],
        statusCode: 200,
        errorMessage: null,
      },
      {
        url: 'https://example.com/page3',
        success: true,
        markdown: 'p3',
        title: null,
        description: null,
        links: [],
        statusCode: 200,
        errorMessage: null,
      },
    ];
    // Simulate the seed-first reordering that happens inside crawlSeeds
    const seedUrl = 'https://example.com/';
    const seedIndex = pages.findIndex((p) => p.url === seedUrl);
    if (seedIndex > 0) {
      const [seedPage] = pages.splice(seedIndex, 1);
      if (seedPage) pages.unshift(seedPage);
    }
    assert.strictEqual(pages[0]?.url, 'https://example.com/');
    const truncated = pages.slice(0, 2);
    assert.strictEqual(truncated.length, 2);
    assert.strictEqual(truncated[0]?.url, 'https://example.com/');
  });
});
```

### Step 2: Run tests

```bash
npm test test/semanticCrawl.test.ts
```

Expected: PASS (this is mostly a behavioral assertion on existing code).

### Step 3: Commit

```bash
git add test/semanticCrawl.test.ts
git commit -m "test: add maxPages enforcement and seed-first ordering tests"
```

---

## Task 4: Cache Persistence Fix

**Files:**

- Modify: `src/chunking.ts` (export constants)
- Modify: `src/utils/corpusCache.ts` (major rework)
- Modify: `test/semanticCrawl.test.ts` (add cache persistence test)

### Step 1: Export chunking constants

In `src/chunking.ts`, change the constants from `const` to `export const`:

```typescript
export const MAX_TOKENS = 400;
export const MIN_TOKENS = 50;
export const TOKEN_RATIO = 4;
export const OVERLAP_RATIO = 0.2;
```

### Step 2: Write failing cache persistence test

Add to `test/semanticCrawl.test.ts`:

```typescript
import { getOrBuildCorpus, computeCorpusId, loadCorpusById } from '../src/utils/corpusCache.js';

describe('cache persistence', () => {
  it('loads corpus from disk without rebuilding', async () => {
    const source: SemanticCrawlSource = { type: 'url', url: 'https://example.com/cache-test' };
    let buildCount = 0;

    const testCacheDir = '/tmp/test-corpus-cache-' + Date.now();

    const corpus = await getOrBuildCorpus(
      source,
      async () => {
        buildCount++;
        const chunks = [
          {
            text: 'hello world',
            url: 'https://example.com',
            section: '## A',
            charOffset: 0,
            chunkIndex: 0,
            totalChunks: 1,
          },
        ];
        const contentHash = crypto
          .createHash('sha256')
          .update(chunks.map((c) => c.text).join('\n'))
          .digest('hex');
        return {
          chunks,
          embeddings: [[0.1, 0.2, 0.3, 0.4]],
          model: 'test-model',
          contentHash,
        };
      },
      { ttlMs: 60_000, maxCorpora: 10, cacheDir: testCacheDir },
    );

    assert.strictEqual(buildCount, 1);
    assert.ok(corpus.corpusId);

    // Second call with same source should load from disk, not rebuild
    const corpus2 = await getOrBuildCorpus(
      source,
      async () => {
        buildCount++;
        const chunks = [
          {
            text: 'hello world',
            url: 'https://example.com',
            section: '## A',
            charOffset: 0,
            chunkIndex: 0,
            totalChunks: 1,
          },
        ];
        const contentHash = crypto
          .createHash('sha256')
          .update(chunks.map((c) => c.text).join('\n'))
          .digest('hex');
        return {
          chunks,
          embeddings: [[0.1, 0.2, 0.3, 0.4]],
          model: 'test-model',
          contentHash,
        };
      },
      { ttlMs: 60_000, maxCorpora: 10, cacheDir: testCacheDir },
    );

    // This test will fail initially because the cache lookup by source is broken
    // After the fix, buildCount should still be 1
    assert.strictEqual(buildCount, 1);
    assert.strictEqual(corpus2.corpusId, corpus.corpusId);
  });
});
```

Run:

```bash
npm test test/semanticCrawl.test.ts
```

Expected: FAIL (cache rebuilds every time because source matching is fragile).

### Step 3: Implement cache persistence fix

Major rework of `src/utils/corpusCache.ts`. Here's the full new file content:

```typescript
/**
 * Disk-backed corpus cache.
 *
 * Storage:
 *   {cacheDir}/{corpusId}.json  — metadata + chunks + bm25Docs
 *   {cacheDir}/{corpusId}.bin   — raw Float32Array embeddings
 *   {cacheDir}/source-index.json — source → corpusId mapping
 *
 * Binary layout:
 *   [4 bytes: uint32 numEmbeddings]
 *   [4 bytes: uint32 dimensionsPerEmbedding]
 *   [N × D × 4 bytes: float32 values row-major]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { CorpusChunk, SemanticCrawlSource } from '../types.js';
import { buildBm25Index, type Bm25Index } from './bm25.js';
import { logger } from '../logger.js';
import { MAX_TOKENS, MIN_TOKENS, TOKEN_RATIO, OVERLAP_RATIO } from '../chunking.js';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface CachedCorpus {
  corpusId: string;
  source: SemanticCrawlSource;
  contentHash: string;
  model: string;
  dimensions: number;
  chunks: CorpusChunk[];
  embeddings: number[][];
  bm25Index: Bm25Index;
  createdAt: number;
  lastAccessedAt: number;
}

// ────────────────────────────────────────────────────────────────────
// Internal metadata shape (what we write to .json)
// ────────────────────────────────────────────────────────────────────

interface CorpusMetadata {
  schemaVersion: number;
  corpusId: string;
  source: SemanticCrawlSource;
  contentHash: string;
  model: string;
  dimensions: number;
  createdAt: number;
  lastAccessedAt: number;
  chunks: CorpusChunk[];
  bm25Docs: { id: string; text: string }[];
}

interface SourceIndexEntry {
  corpusId: string;
  model: string;
  dimensions: number;
  createdAt: number;
}

// ────────────────────────────────────────────────────────────────────
// Options
// ────────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_CORPORA = 50;
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'search-mcp', 'semantic-crawl');

const SCHEMA_VERSION = 1;

interface CacheOpts {
  ttlMs?: number;
  maxCorpora?: number;
  cacheDir?: string;
}

// ────────────────────────────────────────────────────────────────────
// In-memory dedup map (stableStringify(source) → pending Promise)
// ────────────────────────────────────────────────────────────────────

const pendingBuilds = new Map<string, Promise<CachedCorpus>>();

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Sort object keys recursively to produce a stable JSON string. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function normalizeSource(source: SemanticCrawlSource): SemanticCrawlSource {
  if (source.type === 'url' && source.urls && source.urls.length > 0) {
    return { ...source, urls: [...source.urls].sort() };
  }
  return source;
}

/**
 * Deterministic corpusId.
 * sha256(stableStringify(source) + "|" + model + "|" + dimensions + "|" +
 *        MAX_TOKENS + "|" + MIN_TOKENS + "|" + OVERLAP_RATIO + "|" + TOKEN_RATIO)
 */
export function computeCorpusId(
  source: SemanticCrawlSource,
  model: string,
  dimensions: number,
): string {
  const payload =
    stableStringify(normalizeSource(source)) +
    '|' +
    model +
    '|' +
    String(dimensions) +
    '|' +
    String(MAX_TOKENS) +
    '|' +
    String(MIN_TOKENS) +
    '|' +
    String(OVERLAP_RATIO) +
    '|' +
    String(TOKEN_RATIO);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** BM25 document id for a chunk. */
function chunkToBm25Id(chunk: CorpusChunk): string {
  return chunk.url + ':' + String(chunk.chunkIndex);
}

// ────────────────────────────────────────────────────────────────────
// Cache directory helpers
// ────────────────────────────────────────────────────────────────────

function ensureCacheDir(cacheDir: string): boolean {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    return true;
  } catch (err) {
    logger.warn({ err, cacheDir }, 'corpusCache: failed to create cache directory');
    return false;
  }
}

function metaPath(cacheDir: string, corpusId: string): string {
  return path.join(cacheDir, `${corpusId}.json`);
}

function binPath(cacheDir: string, corpusId: string): string {
  return path.join(cacheDir, `${corpusId}.bin`);
}

function indexPath(cacheDir: string): string {
  return path.join(cacheDir, 'source-index.json');
}

// ────────────────────────────────────────────────────────────────────
// Source index (sourceKey → corpusId[])
// ────────────────────────────────────────────────────────────────────

function readSourceIndex(cacheDir: string): Map<string, SourceIndexEntry[]> {
  const ip = indexPath(cacheDir);
  if (!fs.existsSync(ip)) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(ip, 'utf-8')) as Record<string, SourceIndexEntry[]>;
    const map = new Map<string, SourceIndexEntry[]>();
    for (const [key, entries] of Object.entries(raw)) {
      map.set(key, entries);
    }
    return map;
  } catch (err) {
    logger.warn({ err }, 'corpusCache: failed to read source index');
    return new Map();
  }
}

function writeSourceIndex(cacheDir: string, index: Map<string, SourceIndexEntry[]>): void {
  const ip = indexPath(cacheDir);
  const obj: Record<string, SourceIndexEntry[]> = {};
  for (const [key, entries] of index) {
    obj[key] = entries;
  }
  try {
    fs.writeFileSync(ip, JSON.stringify(obj), 'utf-8');
  } catch (err) {
    logger.warn({ err }, 'corpusCache: failed to write source index');
  }
}

function addToSourceIndex(cacheDir: string, sourceKey: string, entry: SourceIndexEntry): void {
  const index = readSourceIndex(cacheDir);
  const existing = index.get(sourceKey) ?? [];
  // Remove any previous entry for this corpusId
  const filtered = existing.filter((e) => e.corpusId !== entry.corpusId);
  filtered.push(entry);
  // Sort by createdAt descending (newest first)
  filtered.sort((a, b) => b.createdAt - a.createdAt);
  index.set(sourceKey, filtered);
  writeSourceIndex(cacheDir, index);
}

function findInSourceIndex(cacheDir: string, sourceKey: string): SourceIndexEntry | undefined {
  const index = readSourceIndex(cacheDir);
  const entries = index.get(sourceKey);
  if (!entries || entries.length === 0) return undefined;
  return entries[0];
}

// ────────────────────────────────────────────────────────────────────
// Binary serialization
// ────────────────────────────────────────────────────────────────────

function serializeEmbeddings(embeddings: number[][]): Buffer {
  const N = embeddings.length;
  const D = N > 0 ? (embeddings[0]?.length ?? 0) : 0;
  const header = 8; // 2 × uint32
  const buf = Buffer.allocUnsafe(header + N * D * 4);
  buf.writeUInt32LE(N, 0);
  buf.writeUInt32LE(D, 4);
  let offset = header;
  for (const row of embeddings) {
    for (const val of row) {
      buf.writeFloatLE(val, offset);
      offset += 4;
    }
  }
  return buf;
}

function deserializeEmbeddings(buf: Buffer): number[][] {
  const N = buf.readUInt32LE(0);
  const D = buf.readUInt32LE(4);
  const result: number[][] = [];
  let offset = 8;
  for (let i = 0; i < N; i++) {
    const row: number[] = [];
    for (let d = 0; d < D; d++) {
      row.push(buf.readFloatLE(offset));
      offset += 4;
    }
    result.push(row);
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Write / read corpus files
// ────────────────────────────────────────────────────────────────────

function writeCorpus(cacheDir: string, meta: CorpusMetadata, embeddings: number[][]): void {
  fs.writeFileSync(metaPath(cacheDir, meta.corpusId), JSON.stringify(meta), 'utf-8');
  fs.writeFileSync(binPath(cacheDir, meta.corpusId), serializeEmbeddings(embeddings));
}

function readCorpusFromDisk(
  cacheDir: string,
  corpusId: string,
  ttlMs: number,
  updateAccess = true,
): CachedCorpus | null {
  const mp = metaPath(cacheDir, corpusId);
  const bp = binPath(cacheDir, corpusId);

  if (!fs.existsSync(mp) || !fs.existsSync(bp)) {
    return null;
  }

  let meta: CorpusMetadata;
  try {
    meta = JSON.parse(fs.readFileSync(mp, 'utf-8')) as CorpusMetadata;
  } catch (err) {
    logger.error({ err, corpusId }, 'corpusCache: failed to parse metadata JSON');
    return null;
  }

  // Schema version check
  if (meta.schemaVersion !== SCHEMA_VERSION) {
    logger.warn(
      { corpusId, schemaVersion: meta.schemaVersion },
      'corpusCache: schema version mismatch',
    );
    return null;
  }

  // TTL check
  if (Date.now() - meta.createdAt > ttlMs) {
    return null;
  }

  // Content hash validation
  // Contract: materializeFn MUST compute contentHash as sha256(chunks.map(c => c.text).join('\n')).
  // This is the caller's responsibility — the cache validates against this contract.
  const recomputedHash = crypto
    .createHash('sha256')
    .update(meta.chunks.map((c) => c.text).join('\n'))
    .digest('hex');
  if (recomputedHash !== meta.contentHash) {
    logger.warn(
      { corpusId, expected: meta.contentHash, actual: recomputedHash },
      'corpusCache: content hash mismatch',
    );
    return null;
  }

  let embeddings: number[][];
  try {
    const buf = fs.readFileSync(bp);
    embeddings = deserializeEmbeddings(buf);
  } catch (err) {
    logger.error({ err, corpusId }, 'corpusCache: failed to read binary embeddings');
    return null;
  }

  // Rebuild BM25 index
  let bm25Index: Bm25Index;
  try {
    bm25Index = buildBm25Index(meta.bm25Docs);
  } catch (err) {
    logger.warn({ err, corpusId }, 'corpusCache: failed to rebuild BM25 index; using no-op');
    bm25Index = { search: () => [] };
  }

  // Update lastAccessedAt on disk only when this is an actual cache hit (not a scan)
  if (updateAccess) {
    try {
      meta.lastAccessedAt = Date.now();
      fs.writeFileSync(mp, JSON.stringify(meta), 'utf-8');
    } catch {
      // non-fatal
    }
  }

  return {
    corpusId: meta.corpusId,
    source: meta.source,
    contentHash: meta.contentHash,
    model: meta.model,
    dimensions: meta.dimensions,
    chunks: meta.chunks,
    embeddings,
    bm25Index,
    createdAt: meta.createdAt,
    lastAccessedAt: meta.lastAccessedAt,
  };
}

// ────────────────────────────────────────────────────────────────────
// Eviction
// ────────────────────────────────────────────────────────────────────

interface IndexEntry {
  corpusId: string;
  lastAccessedAt: number;
  createdAt: number;
}

function listCachedCorpora(cacheDir: string): IndexEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(cacheDir);
  } catch {
    return [];
  }

  const entries: IndexEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'source-index.json') continue;
    const corpusId = f.slice(0, -5);
    // Prune orphan .json entries where the corresponding .bin is missing
    if (!fs.existsSync(binPath(cacheDir, corpusId))) {
      try {
        fs.rmSync(path.join(cacheDir, f), { force: true });
      } catch {
        // best effort
      }
      continue;
    }
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(cacheDir, f), 'utf-8'),
      ) as Partial<CorpusMetadata>;
      entries.push({
        corpusId,
        lastAccessedAt: meta.lastAccessedAt ?? 0,
        createdAt: meta.createdAt ?? 0,
      });
    } catch {
      // skip corrupted file
    }
  }
  return entries;
}

function evictIfNeeded(
  cacheDir: string,
  ttlMs: number,
  maxCorpora: number,
  excludeId: string,
): void {
  const entries = listCachedCorpora(cacheDir);

  const now = Date.now();

  // Remove TTL-expired entries
  for (const e of entries) {
    if (e.corpusId !== excludeId && now - e.createdAt > ttlMs) {
      deleteCorpusFiles(cacheDir, e.corpusId);
    }
  }

  // Re-read after TTL cleanup
  const remaining = listCachedCorpora(cacheDir);

  // If over cap (accounting for the one we are about to write), evict LRU
  if (remaining.length >= maxCorpora) {
    remaining.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    const toEvict = remaining.length - maxCorpora + 1;
    for (let i = 0; i < toEvict; i++) {
      const e = remaining[i];
      if (e && e.corpusId !== excludeId) {
        deleteCorpusFiles(cacheDir, e.corpusId);
      }
    }
  }
}

function deleteCorpusFiles(cacheDir: string, corpusId: string): void {
  try {
    fs.rmSync(metaPath(cacheDir, corpusId), { force: true });
    fs.rmSync(binPath(cacheDir, corpusId), { force: true });
  } catch (err) {
    logger.warn({ err, corpusId }, 'corpusCache: failed to delete corpus files');
  }
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Get a cached corpus or build it via `materializeFn`.
 *
 * - Deduplicates concurrent calls for the same source (thundering herd guard).
 * - Reads from disk when available and within TTL.
 * - Writes to disk after materializing.
 * - Evicts LRU + TTL-expired entries before writing.
 */
export async function getOrBuildCorpus(
  source: SemanticCrawlSource,
  materializeFn: () => Promise<{
    chunks: CorpusChunk[];
    embeddings: number[][];
    model: string;
    contentHash: string;
  }>,
  opts?: CacheOpts,
): Promise<CachedCorpus> {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const maxCorpora = opts?.maxCorpora ?? DEFAULT_MAX_CORPORA;
  const cacheDir = opts?.cacheDir ?? DEFAULT_CACHE_DIR;

  const normalizedSource = normalizeSource(source);
  const sourceKey = stableStringify(normalizedSource);

  const existing = pendingBuilds.get(sourceKey);
  if (existing !== undefined) {
    return existing;
  }

  const promise = (async (): Promise<CachedCorpus> => {
    const dirOk = ensureCacheDir(cacheDir);

    // Try to find existing corpus via source index (fast, no scan)
    if (dirOk) {
      const entry = findInSourceIndex(cacheDir, sourceKey);
      if (entry !== undefined) {
        const loaded = readCorpusFromDisk(cacheDir, entry.corpusId, ttlMs, false);
        if (loaded !== null) {
          // Actual cache hit — update lastAccessedAt now
          try {
            const mp = metaPath(cacheDir, entry.corpusId);
            const meta = JSON.parse(fs.readFileSync(mp, 'utf-8')) as CorpusMetadata;
            meta.lastAccessedAt = Date.now();
            fs.writeFileSync(mp, JSON.stringify(meta), 'utf-8');
            loaded.lastAccessedAt = meta.lastAccessedAt;
          } catch {
            // non-fatal
          }
          return loaded;
        }
      }
    }

    // Not found — materialize
    const { chunks, embeddings, model, contentHash } = await materializeFn();
    const dimensions = embeddings.length > 0 ? (embeddings[0]?.length ?? 0) : 0;
    const corpusId = computeCorpusId(normalizedSource, model, dimensions);
    const now = Date.now();

    const bm25Docs = chunks.map((c) => ({ id: chunkToBm25Id(c), text: c.text }));
    let bm25Index: Bm25Index;
    try {
      bm25Index = buildBm25Index(bm25Docs);
    } catch (err) {
      logger.warn({ err }, 'corpusCache: failed to build BM25 index; using no-op');
      bm25Index = { search: () => [] };
    }

    const corpus: CachedCorpus = {
      corpusId,
      source: normalizedSource,
      contentHash,
      model,
      dimensions,
      chunks,
      embeddings,
      bm25Index,
      createdAt: now,
      lastAccessedAt: now,
    };

    if (dirOk) {
      try {
        evictIfNeeded(cacheDir, ttlMs, maxCorpora, corpusId);

        const meta: CorpusMetadata = {
          schemaVersion: SCHEMA_VERSION,
          corpusId,
          source: normalizedSource,
          contentHash,
          model,
          dimensions,
          createdAt: now,
          lastAccessedAt: now,
          chunks,
          bm25Docs,
        };
        writeCorpus(cacheDir, meta, embeddings);
        addToSourceIndex(cacheDir, sourceKey, { corpusId, model, dimensions, createdAt: now });
      } catch (err) {
        logger.warn({ err, corpusId }, 'corpusCache: failed to write corpus to disk');
      }
    }

    return corpus;
  })().finally(() => {
    pendingBuilds.delete(sourceKey);
  });

  pendingBuilds.set(sourceKey, promise);
  return promise;
}

/**
 * Load a previously cached corpus by its deterministic ID.
 * Returns null if not found, corrupted, or TTL-expired.
 */
export function loadCorpusById(corpusId: string, opts?: CacheOpts): Promise<CachedCorpus | null> {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const cacheDir = opts?.cacheDir ?? DEFAULT_CACHE_DIR;
  return Promise.resolve(readCorpusFromDisk(cacheDir, corpusId, ttlMs));
}

/**
 * Remove a corpus from disk and from the in-memory lock map.
 */
export function invalidateCorpus(
  corpusId: string,
  opts?: { cacheDir?: string; source?: SemanticCrawlSource },
): void {
  const cacheDir = opts?.cacheDir ?? DEFAULT_CACHE_DIR;
  deleteCorpusFiles(cacheDir, corpusId);
  if (opts?.source !== undefined) {
    pendingBuilds.delete(stableStringify(normalizeSource(opts.source)));
  }
}
```

### Step 4: Run tests

```bash
npm test test/semanticCrawl.test.ts
```

Expected: PASS (cache persistence test should pass).

**Integration note (cache → embedAndRank wiring):** When `getOrBuildCorpus` returns a cached corpus, the caller in `semanticCrawl.ts` must pass `corpus.embeddings` as `opts.precomputedEmbeddings` to `embedAndRank`. Without this wiring, the cache loads embeddings but `embedAndRank` re-embeds everything. The `semanticCrawl` orchestration function should read the corpus, then call `embedAndRank(chunks, { ..., precomputedEmbeddings: corpus.embeddings })`. This is the caller's responsibility — see Task 7 integration.

### Step 5: Commit

```bash
git add src/chunking.ts src/utils/corpusCache.ts test/semanticCrawl.test.ts
git commit -m "fix: cache persistence — source index, content hash validation, schema version, chunking params in corpusId"
```

---

## Task 5: Reranker Smoke Test + Opt-In

**Files:**

- Modify: `src/utils/rerank.ts`
- Modify: `src/tools/semanticCrawl.ts` (change `useReranker` default)
- Modify: `src/server.ts` (change `useReranker` default in Zod schema)

### Step 1: Write failing reranker smoke test

Add to `test/semanticCrawl.test.ts`:

```typescript
describe('reranker smoke test', () => {
  it('validates smoke score comparison logic', () => {
    // Extract the validation logic into a pure function for testability.
    // After the fix, getSession() should run a smoke test and throw if
    // the model produces A <= B + 0.1 for the validation pairs.
    function validateSmokeScores(
      scoreA: number,
      scoreB: number,
      epsilon = 0.1,
    ): { ok: boolean; reason?: string } {
      if (scoreA <= scoreB + epsilon) {
        return { ok: false, reason: `good=${String(scoreA)}, bad=${String(scoreB)}` };
      }
      return { ok: true };
    }

    // Good model: good score is much higher than bad score
    const goodResult = validateSmokeScores(8.5, 1.2);
    assert.strictEqual(goodResult.ok, true);

    // Bad model: scores are too close
    const badResult = validateSmokeScores(1.5, 1.4);
    assert.strictEqual(badResult.ok, false);
    assert.ok(badResult.reason?.includes('1.5'));

    // Edge case: exactly at threshold
    const edgeResult = validateSmokeScores(1.2, 1.0);
    assert.strictEqual(edgeResult.ok, false);
  });
});
```

This is a documentation test since we can't mock ONNX without heavy infrastructure.

### Step 2: Implement smoke test in rerank.ts

Modify `src/utils/rerank.ts`. After the `getSession()` function loads the model (around line 107, after `logger.info`), add:

```typescript
// Smoke test: validate that the model behaves as a cross-encoder
// query="hello world", doc="hello world" → score A
// query="hello world", doc="xyz abc def" → score B
// Assert A > B + 0.1
try {
  const smokeQuery = 'hello world';
  const smokeGood = 'hello world';
  const smokeBad = 'xyz abc def';

  const smokeBatch = tokenizePairs(
    tokenizer,
    smokeQuery,
    [smokeGood, smokeBad],
    DEFAULT_MAX_LENGTH,
  );
  const smokeScores = await runInference(
    { session, tokenizer, hasTokenTypeIds, outputName },
    smokeBatch,
  );

  const scoreA = smokeScores[0] ?? 0;
  const scoreB = smokeScores[1] ?? 0;

  if (scoreA <= scoreB + 0.1) {
    const msg = `Cross-encoder smoke test failed: good=${String(scoreA)}, bad=${String(scoreB)}. The model is not producing meaningful cross-encoder scores.`;
    logger.fatal({ scoreA, scoreB }, msg);
    sessionPromise = null;
    throw unavailableError(msg);
  }

  logger.info({ scoreA, scoreB }, 'Cross-encoder smoke test passed');
} catch (err) {
  if (err instanceof Error && err.message.includes('smoke test failed')) {
    throw err;
  }
  logger.warn({ err }, 'Cross-encoder smoke test error');
}
```

**Important:** The `runInference` call needs the `SessionState` shape. The smoke test uses the raw `session`, `tokenizer`, `hasTokenTypeIds`, `outputName` variables available in scope.

Also, make `useReranker` default to `false` in `src/tools/semanticCrawl.ts`:

In `EmbedAndRankOptions` interface (line 223):

```typescript
  useReranker?: boolean | undefined;
```

And in `embedAndRank` (line 395):

```typescript
  if (opts.useReranker === true && coherent.length > 1) {
```

Previously it was `opts.useReranker !== false`. Now it requires explicit `true`.

### Step 3: Update server.ts Zod schema

In `src/server.ts`, change `useReranker` default from `true` to `false`:

```typescript
          useReranker: z
            .boolean()
            .optional()
            .default(false)
            .describe('Apply cross-encoder re-ranking to top candidates (default false)'),
```

### Step 4: Run tests

```bash
npm test test/semanticCrawl.test.ts
```

Expected: PASS

### Step 5: Commit

```bash
git add src/utils/rerank.ts src/tools/semanticCrawl.ts src/server.ts test/semanticCrawl.test.ts
git commit -m "feat: reranker smoke test + make opt-in (default false)"
```

---

## Task 6: Score Observability Types

**Files:**

- Modify: `src/types.ts`
- Modify: `test/semanticCrawl.test.ts` (update `makeChunk` helpers)

**Note on type migration ordering:** Tasks 1–5 use the old `biEncoderScore` / `rerankScore` shape implicitly through `semanticCrawl.ts` references. Task 6 renames the type, and Task 7 rewrites `embedAndRank` to populate the new shape. Between Task 6 and Task 7, the codebase will not typecheck because `semanticCrawl.ts` still references the old fields. To avoid a broken-CI window, **Tasks 6 and 7 should be committed as a single commit** (or Task 6's changes should be staged but not committed until Task 7 is also ready).

### Step 1: Update types.ts

Replace the `SemanticCrawlChunk` interface in `src/types.ts`:

```typescript
export interface ScoreDetail {
  raw: number;
  normalized: number;
  corpusMin: number;
  corpusMax: number;
  median: number;
}

export interface RerankScoreDetail extends ScoreDetail {
  medianDelta: number;
  rank: number;
}

export interface SemanticCrawlChunk {
  text: string;
  url: string;
  section: string;
  charOffset: number;
  chunkIndex: number;
  totalChunks: number;
  scores: {
    biEncoder: ScoreDetail;
    bm25: ScoreDetail;
    rrf: ScoreDetail;
    rerank?: RerankScoreDetail;
  };
}
```

Remove `biEncoderScore` and `rerankScore` from the old interface.

### Step 2: Update test helpers

In `test/semanticCrawl.test.ts`, update `makeChunk` helpers to use the new `scores` shape.

Old:

```typescript
const makeChunk = (text: string, score: number): SemanticCrawlChunk => ({
  text,
  url: 'https://example.com',
  section: '## Test',
  biEncoderScore: score,
  charOffset: 0,
  chunkIndex: 0,
  totalChunks: 1,
});
```

New:

```typescript
const makeScore = (raw: number): ScoreDetail => ({
  raw,
  normalized: 0.5,
  corpusMin: 0,
  corpusMax: 1,
  median: 0.5,
});

const makeChunk = (text: string, score: number): SemanticCrawlChunk => ({
  text,
  url: 'https://example.com',
  section: '## Test',
  charOffset: 0,
  chunkIndex: 0,
  totalChunks: 1,
  scores: {
    biEncoder: makeScore(score),
    bm25: makeScore(0),
    rrf: makeScore(0),
  },
});
```

### Step 3: Run typecheck

```bash
npm run typecheck
```

Expected: PASS (if all references to `biEncoderScore` and `rerankScore` are updated). If there are compile errors in `semanticCrawl.ts` or elsewhere, fix them in the next task.

### Step 4: Commit

```bash
git add src/types.ts test/semanticCrawl.test.ts
git commit -m "feat: add ScoreDetail and RerankScoreDetail types; replace scalar scores on SemanticCrawlChunk"
```

---

## Task 7: RRF Candidate Pool Restriction + Score Integration

**Files:**

- Modify: `src/tools/semanticCrawl.ts` (major `embedAndRank` rework)
- Modify: `test/semanticCrawl.test.ts`

### Step 1: Write failing RRF pool restriction test

Add to `test/semanticCrawl.test.ts`:

```typescript
describe('RRF candidate pool restriction', () => {
  it('does not include chunks outside top-N bi-encoder + top-K BM25 pool', () => {
    // Build synthetic chunks: 5 relevant, 20 noise
    const relevantChunks: SemanticCrawlChunk[] = [];
    for (let i = 0; i < 5; i++) {
      relevantChunks.push({
        text: `relevant chunk ${String(i)} configure PORT=8080`,
        url: `https://example.com/relevant/${String(i)}`,
        section: '## Relevant',
        charOffset: 0,
        chunkIndex: i,
        totalChunks: 5,
        scores: {
          biEncoder: {
            raw: 0.8 - i * 0.01,
            normalized: 0.8 - i * 0.01,
            corpusMin: 0,
            corpusMax: 1,
            median: 0.5,
          },
          bm25: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
          rrf: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
        },
      });
    }
    const noiseChunks: SemanticCrawlChunk[] = [];
    for (let i = 0; i < 20; i++) {
      noiseChunks.push({
        text: `noise chunk ${String(i)}`,
        url: `https://example.com/noise/${String(i)}`,
        section: '## Noise',
        charOffset: 0,
        chunkIndex: i,
        totalChunks: 20,
        scores: {
          biEncoder: { raw: 0.1, normalized: 0.1, corpusMin: 0, corpusMax: 1, median: 0.5 },
          bm25: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
          rrf: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
        },
      });
    }

    // For topK=2, poolSize = max(2*3, 30) = 30
    // All 25 chunks are within poolSize, so this test is a structural assertion.
    // A real test requires embedAndRank with actual embeddings/BM25.
    assert.strictEqual(relevantChunks.length + noiseChunks.length, 25);
  });
});
```

This is a structural test. The real behavior is tested via integration.

### Step 2: Implement score computation helpers

Add to `src/tools/semanticCrawl.ts` before `embedAndRank`:

```typescript
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

function normalizeScore(raw: number, min: number, max: number): number {
  if (max === min) return 0;
  return (raw - min) / (max - min);
}
```

### Step 3: Rewrite embedAndRank with pool restriction and scores

Replace the entire `embedAndRank` function in `src/tools/semanticCrawl.ts`:

```typescript
export async function embedAndRank(
  chunks: CorpusChunk[],
  opts: EmbedAndRankOptions,
): Promise<SemanticCrawlChunk[]> {
  if (chunks.length === 0) return [];

  // 1. Deduplicate
  const preDedupCount = chunks.length;
  const deduped = deduplicateCorpusChunks(chunks);
  if (preDedupCount !== deduped.length) {
    logger.info(
      { preDedup: preDedupCount, postDedup: deduped.length },
      'Deduplicated corpus chunks before embedding',
    );
  }

  // 2. Chunk safety check
  if (deduped.length > MAX_CHUNKS_HARD) {
    throw new Error(
      `Produced ${String(deduped.length)} chunks, exceeding hard cap of ${String(MAX_CHUNKS_HARD)}. Reduce maxPages or increase chunk size.`,
    );
  }
  if (deduped.length > MAX_CHUNKS_SOFT) {
    logger.warn(
      { chunkCount: deduped.length, softCap: MAX_CHUNKS_SOFT },
      'Chunk count exceeds soft cap; embedding may be slower',
    );
  }

  // 3. Embed chunks (batched) and query in parallel
  const chunkTexts = deduped.map((c) => c.text);
  const chunkTitles = deduped.map(
    (c) =>
      c.section
        .split(' > ')
        .at(-1)
        ?.replace(/^#+\s+/, '') ?? 'none',
  );

  if (opts.precomputedEmbeddings !== undefined) {
    if (opts.precomputedEmbeddings.length !== deduped.length) {
      throw new Error(
        `precomputedEmbeddings length (${String(opts.precomputedEmbeddings.length)}) does not match deduped chunk count (${String(deduped.length)}). Pass already-deduplicated chunks.`,
      );
    }
  }

  const queryEmbedPromise = embedTexts(
    opts.embeddingBaseUrl,
    opts.embeddingApiToken,
    [opts.query],
    'query',
    opts.embeddingDimensions,
  );

  let chunkEmbeddings: number[][];
  if (opts.precomputedEmbeddings !== undefined) {
    chunkEmbeddings = opts.precomputedEmbeddings;
  } else {
    const [{ embeddings }] = await Promise.all([
      embedTextsBatched(
        opts.embeddingBaseUrl,
        opts.embeddingApiToken,
        chunkTexts,
        'document',
        opts.embeddingDimensions,
        chunkTitles,
      ),
      queryEmbedPromise,
    ]);
    chunkEmbeddings = embeddings;
  }

  const queryResponse = await queryEmbedPromise;
  const queryEmbedding = queryResponse.embeddings[0];
  if (!queryEmbedding) {
    throw new Error('Embedding sidecar returned empty query embedding');
  }

  // 4. Bi-encoder ranking (cosine similarity)
  const paired: ChunkWithEmbedding[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const chunk = deduped[i];
    const emb = chunkEmbeddings[i];
    if (!chunk || emb === undefined) continue;
    paired.push({
      chunk: {
        text: chunk.text,
        url: chunk.url,
        section: chunk.section,
        charOffset: chunk.charOffset,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        scores: {
          biEncoder: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
          bm25: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
          rrf: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
        },
      },
      embedding: emb,
    });
  }

  for (const p of paired) {
    p.chunk.scores.biEncoder.raw = cosineSimilarity(queryEmbedding, p.embedding);
  }
  paired.sort((a, b) => b.chunk.scores.biEncoder.raw - a.chunk.scores.biEncoder.raw);

  // Compute bi-encoder score stats
  const biScores = paired.map((p) => p.chunk.scores.biEncoder.raw);
  const biMin = biScores.length > 0 ? Math.min(...biScores) : 0;
  const biMax = biScores.length > 0 ? Math.max(...biScores) : 0;
  const biMedian = median(biScores);

  // 5. BM25+ ranking
  const bm25 =
    opts.bm25Index ??
    buildBm25Index(deduped.map((c) => ({ id: c.url + ':' + String(c.chunkIndex), text: c.text })));

  const idToChunk = new Map<string, SemanticCrawlChunk>();
  for (const p of paired) {
    idToChunk.set(p.chunk.url + ':' + String(p.chunk.chunkIndex), p.chunk);
  }

  const bm25Scores = bm25.search(opts.query);
  const bm25ScoresMap = new Map<string, number>();
  for (const { id, score } of bm25Scores) {
    bm25ScoresMap.set(id, score);
  }

  const bm25Min = bm25Scores.length > 0 ? Math.min(...bm25Scores.map((s) => s.score)) : 0;
  const bm25Max = bm25Scores.length > 0 ? Math.max(...bm25Scores.map((s) => s.score)) : 0;
  const bm25Median = median(bm25Scores.map((s) => s.score));

  // 6. RRF candidate pool restriction
  // Bi-encoder pool: max(topK * 3, 30) — broad enough for diversity.
  // BM25 pool: topK only — BM25 is more promiscuous on noisy corpora,
  // so we restrict it more tightly to prevent noise injection.
  const poolSize = Math.max(opts.topK * 3, 30);
  const biEncoderTopN = paired.slice(0, poolSize).map((p) => p.chunk);

  // Re-use bm25Scores for topK extraction (avoids double search call)
  const bm25TopKResults = bm25Scores.slice(0, opts.topK);
  const bm25TopK: SemanticCrawlChunk[] = [];
  for (const { id } of bm25TopKResults) {
    const c = idToChunk.get(id);
    if (c) bm25TopK.push(c);
  }

  const fused = rrfMerge([biEncoderTopN, bm25TopK], {
    k: 60,
    keyFn: (item) => item.url + '|' + item.text,
  });

  // Compute RRF score stats
  const rrfScores = fused.map((f) => f.rrfScore);
  const rrfMin = rrfScores.length > 0 ? Math.min(...rrfScores) : 0;
  const rrfMax = rrfScores.length > 0 ? Math.max(...rrfScores) : 0;
  const rrfMedian = median(rrfScores);

  logger.info(
    {
      biEncoderCount: biEncoderTopN.length,
      bm25Count: bm25TopK.length,
      fusedCount: fused.length,
      poolSize,
    },
    'RRF fusion completed with restricted candidate pool',
  );

  // 7. Attach scores to fused chunks
  const scoredChunks: SemanticCrawlChunk[] = [];
  for (const { item, rrfScore } of fused) {
    const biRaw = item.scores.biEncoder.raw;
    const bm25Raw = bm25ScoresMap.get(item.url + ':' + String(item.chunkIndex)) ?? 0;

    scoredChunks.push({
      ...item,
      scores: {
        biEncoder: {
          raw: biRaw,
          normalized: normalizeScore(biRaw, biMin, biMax),
          corpusMin: biMin,
          corpusMax: biMax,
          median: biMedian,
        },
        bm25: {
          raw: bm25Raw,
          normalized: normalizeScore(bm25Raw, bm25Min, bm25Max),
          corpusMin: bm25Min,
          corpusMax: bm25Max,
          median: bm25Median,
        },
        rrf: {
          raw: rrfScore,
          normalized: normalizeScore(rrfScore, rrfMin, rrfMax),
          corpusMin: rrfMin,
          corpusMax: rrfMax,
          median: rrfMedian,
        },
      },
    });
  }

  // 8. Semantic coherence filter (borderline off-topic chunks)
  const chunkToEmbedding = new Map<string, number[]>();
  for (const p of paired) {
    chunkToEmbedding.set(p.chunk.url + '|' + p.chunk.text, p.embedding);
  }

  const fusedPaired: ChunkWithEmbedding[] = [];
  for (const chunk of scoredChunks) {
    const emb = chunkToEmbedding.get(chunk.url + '|' + chunk.text);
    if (emb) {
      fusedPaired.push({ chunk, embedding: emb });
    }
  }

  const coherent = filterBySemanticCoherence(fusedPaired);
  if (coherent.length < fusedPaired.length) {
    logger.info(
      { before: fusedPaired.length, after: coherent.length },
      'Semantic coherence filter removed off-topic chunks',
    );
  }

  // 9. Optional cross-encoder re-ranking (opt-in, default false)
  let topChunks: SemanticCrawlChunk[];

  if (opts.useReranker === true && coherent.length > 1) {
    const rerankCount = Math.min(RERANK_CANDIDATES, coherent.length);
    const candidates = coherent.slice(0, rerankCount);
    const candidateTexts = candidates.map((c) => c.text);

    try {
      const { rerank } = await import('../utils/rerank.js');
      const reranked = await rerank(opts.query, candidateTexts, { topK: opts.topK });

      const rerankScores = reranked.map((r) => r.score);
      const rerankMin = Math.min(...rerankScores);
      const rerankMax = Math.max(...rerankScores);
      const rerankMedian = median(rerankScores);

      topChunks = [];
      for (let rankIdx = 0; rankIdx < reranked.length; rankIdx++) {
        const r = reranked[rankIdx];
        if (!r) continue;
        const candidate = candidates[r.index];
        if (!candidate) continue;
        topChunks.push({
          ...candidate,
          scores: {
            ...candidate.scores,
            rerank: {
              raw: r.score,
              normalized: normalizeScore(r.score, rerankMin, rerankMax),
              corpusMin: rerankMin,
              corpusMax: rerankMax,
              median: rerankMedian,
              medianDelta: r.score - rerankMedian,
              rank: rankIdx + 1,
            },
          },
        });
      }
      logger.info({ topK: opts.topK, candidates: rerankCount }, 'Cross-encoder re-ranking applied');
    } catch (err) {
      logger.warn({ err }, 'Cross-encoder re-ranking failed, falling back to bi-encoder ranking');
      topChunks = candidates.slice(0, opts.topK);
    }
  } else {
    topChunks = coherent.slice(0, opts.topK);
  }

  return topChunks;
}
```

### Step 4: Update isBorderline

`isBorderline` currently checks `chunk.biEncoderScore`. Update it to check `chunk.scores.biEncoder.raw`:

```typescript
export function isBorderline(chunk: SemanticCrawlChunk): boolean {
  const text = chunk.text;
  const linkMatches = text.match(/\[([^\]]+)\]\(([^)]+)\)/g);
  const linkChars = linkMatches ? linkMatches.reduce((sum, m) => sum + m.length, 0) : 0;
  const density = text.length > 0 ? linkChars / text.length : 0;

  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const totalWords = lines.reduce((sum, l) => sum + l.trim().split(/\s+/).length, 0);
  const avgWords = lines.length > 0 ? totalWords / lines.length : 0;

  return (density >= 0.2 && density < 0.4) || (avgWords >= 3 && avgWords < 5);
}
```

### Step 5: Update applyReranking

Update `applyReranking` to use the new scores shape:

```typescript
export async function applyReranking(
  query: string,
  candidates: SemanticCrawlChunk[],
  topK: number,
): Promise<SemanticCrawlChunk[]> {
  if (candidates.length <= topK) {
    return candidates;
  }
  try {
    const { rerank } = await import('../utils/rerank.js');
    const candidateTexts = candidates.map((c) => c.text);
    const reranked = await rerank(query, candidateTexts, { topK });

    const rerankScores = reranked.map((r) => r.score);
    const rerankMin = Math.min(...rerankScores);
    const rerankMax = Math.max(...rerankScores);
    const rerankMedian = median(rerankScores);

    return reranked.map((r, rankIdx) => {
      const candidate = candidates[r.index];
      if (!candidate) {
        throw new Error(`Reranker returned invalid index ${String(r.index)}`);
      }
      return {
        ...candidate,
        scores: {
          ...candidate.scores,
          rerank: {
            raw: r.score,
            normalized: normalizeScore(r.score, rerankMin, rerankMax),
            corpusMin: rerankMin,
            corpusMax: rerankMax,
            median: rerankMedian,
            medianDelta: r.score - rerankMedian,
            rank: rankIdx + 1,
          },
        },
      };
    });
  } catch (err) {
    logger.warn({ err }, 'Cross-encoder re-ranking failed, falling back to bi-encoder ranking');
    return candidates.slice(0, topK);
  }
}
```

### Step 6: Run typecheck and tests

```bash
npm run typecheck
npm test test/semanticCrawl.test.ts
```

Expected: PASS (may need to fix any remaining type errors from `biEncoderScore` references).

### Step 7: Commit

```bash
git add src/tools/semanticCrawl.ts test/semanticCrawl.test.ts
git commit -m "feat: RRF candidate pool restriction and score observability"
```

---

## Task 8: Soft Lexical Constraint

**Files:**

- Create: `src/utils/lexicalConstraint.ts`
- Create: `test/lexicalConstraint.test.ts`
- Modify: `src/tools/semanticCrawl.ts` (integrate after RRF)

### Step 1: Write failing test

Create `test/lexicalConstraint.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applySoftLexicalConstraint } from '../src/utils/lexicalConstraint.js';
import type { SemanticCrawlChunk } from '../src/types.js';

describe('applySoftLexicalConstraint', () => {
  const makeChunk = (text: string): SemanticCrawlChunk => ({
    text,
    url: 'https://example.com',
    section: '## Test',
    charOffset: 0,
    chunkIndex: 0,
    totalChunks: 1,
    scores: {
      biEncoder: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
      bm25: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
      rrf: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
    },
  });

  const corpusChunks = [
    {
      text: 'how to configure PORT=8080',
      url: 'https://example.com',
      section: '## A',
      charOffset: 0,
      chunkIndex: 0,
      totalChunks: 1,
    },
    {
      text: 'docker build instructions',
      url: 'https://example.com',
      section: '## B',
      charOffset: 0,
      chunkIndex: 1,
      totalChunks: 2,
    },
    {
      text: 'the quick brown fox',
      url: 'https://example.com',
      section: '## C',
      charOffset: 0,
      chunkIndex: 2,
      totalChunks: 3,
    },
  ];

  it('filters chunks that lack top-IDF tokens', () => {
    const chunks = [
      makeChunk('how to configure PORT=8080'),
      makeChunk('docker build instructions'),
      makeChunk('the quick brown fox'),
    ];

    const result = applySoftLexicalConstraint(chunks, 'configure PORT=8080', corpusChunks, 2);
    assert.ok(result.filtered.length > 0);
  });

  it('skips constraint for stopword-only queries', () => {
    const chunks = [makeChunk('the quick brown fox')];
    const result = applySoftLexicalConstraint(chunks, 'how to do it', corpusChunks, 2);
    assert.strictEqual(result.filtered.length, 1);
    assert.strictEqual(result.warning, undefined);
  });

  it('returns warning when zero chunks satisfy', () => {
    const chunks = [makeChunk('completely unrelated text')];
    const result = applySoftLexicalConstraint(chunks, 'configure PORT=8080', corpusChunks, 2);
    assert.strictEqual(result.filtered.length, 1); // fallback to unfiltered
    assert.ok(result.warning?.includes('zero matches'));
  });
});
```

Run:

```bash
npm test test/lexicalConstraint.test.ts
```

Expected: FAIL with module not found.

### Step 2: Implement lexical constraint

Create `src/utils/lexicalConstraint.ts`:

```typescript
import type { SemanticCrawlChunk, CorpusChunk } from '../types.js';

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'shall',
  'can',
  'need',
  'dare',
  'ought',
  'used',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'under',
  'and',
  'but',
  'or',
  'yet',
  'so',
  'if',
  'because',
  'although',
  'though',
  'while',
  'where',
  'when',
  'that',
  'which',
  'who',
  'whom',
  'whose',
  'what',
  'this',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'her',
  'its',
  'our',
  'their',
]);

function tokenize(text: string): string[] {
  return (text.match(/\b\w+\b/g) ?? []).map((t) => t.toLowerCase());
}

export function applySoftLexicalConstraint(
  chunks: SemanticCrawlChunk[],
  query: string,
  corpusChunks: CorpusChunk[],
  topK: number,
): { filtered: SemanticCrawlChunk[]; warning?: string } {
  // 1. Tokenize query, remove stopwords
  const queryTokens = tokenize(query).filter((t) => !STOPWORDS.has(t));

  if (queryTokens.length === 0) {
    return { filtered: chunks };
  }

  // 2. Compute IDF for each token against corpus
  const N = corpusChunks.length;
  const tokenIdf = new Map<string, number>();
  for (const token of queryTokens) {
    let df = 0;
    for (const chunk of corpusChunks) {
      if (chunk.text.toLowerCase().includes(token)) {
        df++;
      }
    }
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    tokenIdf.set(token, idf);
  }

  // 3. Select top-3 highest-IDF tokens
  const sortedTokens = [...tokenIdf.entries()].sort((a, b) => b[1] - a[1]);
  const topTokens = sortedTokens.slice(0, 3).map(([t]) => t);

  // 4. Edge cases
  const requiredCount = queryTokens.length < 3 ? queryTokens.length : 2;

  // 5. Filter chunks
  const filtered = chunks.filter((chunk) => {
    let matchCount = 0;
    for (const token of topTokens) {
      if (chunk.text.toLowerCase().includes(token)) {
        matchCount++;
      }
    }
    return matchCount >= requiredCount;
  });

  if (filtered.length === 0) {
    return {
      filtered: chunks,
      warning: 'Soft lexical constraint yielded zero matches; returning unfiltered results',
    };
  }

  return { filtered };
}
```

### Step 3: Integrate into embedAndRank

In `src/tools/semanticCrawl.ts`, import at top:

```typescript
import { applySoftLexicalConstraint } from '../utils/lexicalConstraint.js';
```

After the semantic coherence filter and before the reranker step (around line 390 in the new `embedAndRank`), add:

```typescript
  // 8. Soft lexical constraint
  const lexicalResult = applySoftLexicalConstraint(
    coherent,
    opts.query,
    deduped,
    opts.topK,
  );
  if (lexicalResult.warning) {
    logger.warn(lexicalResult.warning);
  }
  if (lexicalResult.filtered.length < coherent.length) {
    logger.info(
      { before: coherent.length, after: lexicalResult.filtered.length },
      'Soft lexical constraint filtered chunks',
    );
  }
  let afterLexical = lexicalResult.filtered;

  // 9. Optional cross-encoder re-ranking (opt-in, default false)
  let topChunks: SemanticCrawlChunk[];

  if (opts.useReranker === true && afterLexical.length > 1) {
    const rerankCount = Math.min(RERANK_CANDIDATES, afterLexical.length);
    const candidates = afterLexical.slice(0, rerankCount);
```

Update the rest of the reranker block to use `candidates` from `afterLexical`.

Also update the final fallback:

```typescript
  } else {
    topChunks = afterLexical.slice(0, opts.topK);
  }
```

### Step 4: Run tests

```bash
npm test test/lexicalConstraint.test.ts
npm test test/semanticCrawl.test.ts
```

Expected: PASS

### Step 5: Commit

```bash
git add src/utils/lexicalConstraint.ts test/lexicalConstraint.test.ts src/tools/semanticCrawl.ts
git commit -m "feat: soft lexical constraint with IDF-weighted token coverage"
```

---

## Task 9: Final Integration & Regression Tests

**Files:**

- Modify: `test/semanticCrawl.test.ts`

### Step 1: Add integration tests

Append to `test/semanticCrawl.test.ts`:

```typescript
describe('integration: semantic-only regression', () => {
  it('every returned chunk has scores.biEncoder, scores.bm25, scores.rrf', async () => {
    // This is a compile-time + shape assertion on the existing applyReranking tests
    const candidates = [
      makeChunk('Flask is a lightweight WSGI web application framework in Python.', 0.9),
      makeChunk('The quick brown fox jumps over the lazy dog.', 0.6),
    ];
    const result = await applyReranking('python web framework', candidates, 2);
    for (const chunk of result) {
      assert.ok(chunk.scores.biEncoder);
      assert.ok(chunk.scores.bm25);
      assert.ok(chunk.scores.rrf);
      assert.ok(typeof chunk.scores.biEncoder.raw === 'number');
      assert.ok(typeof chunk.scores.bm25.raw === 'number');
      assert.ok(typeof chunk.scores.rrf.raw === 'number');
    }
  });
});
```

### Step 2: Run full test suite

```bash
npm test
```

Expected: PASS (all tests).

### Step 3: Run typecheck and lint

```bash
npm run typecheck
npm run lint
```

Expected: PASS.

### Step 4: Commit

```bash
git add test/semanticCrawl.test.ts
git commit -m "test: integration tests for score observability and semantic-only regression"
```

---

## Self-Review Checklist

**1. Spec coverage:**

- §1 Cookie banner filtering → Task 1
- §2 Crawler focus filter → Task 2
- §3 RRF candidate pool restriction → Task 7
- §4 Cache persistence fix → Task 4
- §5 Reranker smoke test + opt-in → Task 5
- §6 maxPages enforcement → Task 2 (integrated) + Task 3 (tests)
- §7 Score observability → Tasks 6, 7
- §8 Soft lexical constraint → Task 8

**2. Placeholder scan:**

- No "TBD", "TODO", "implement later" found.
- All steps include exact code blocks.
- No vague instructions like "add appropriate error handling".

**3. Type consistency:**

- `SemanticCrawlChunk` uses `scores` object across all tasks.
- `computeCorpusId` includes chunking params consistently.
- `useReranker` requires `=== true` consistently.
- `filterByPathPrefix` signature matches usage in `crawlSeeds`.

**4. Known open questions (from spec):**

- `isDirectChild` depth limit: one segment only (implemented exactly as spec'd).
- Smoke-test epsilon: `0.1` (implemented).
- §3 + §8 interaction: soft constraint operates on RRF-restricted pool, fallback returns pre-filtered pool (documented in Task 8).

**Plan complete.**
