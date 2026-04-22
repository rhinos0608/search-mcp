# Crawl4AI Sidecar Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `web_crawl` MCP tool that proxies to a self-hosted crawl4ai HTTP sidecar, enabling JavaScript-rendered page reading and multi-page deep crawls.

**Architecture:** crawl4ai runs as a Docker sidecar (`unclecode/crawl4ai`) on port 11235. The TypeScript server calls its `/crawl` REST endpoint over HTTP, following the exact same "external service with URL config" pattern as SearXNG and Nitter. The tool is gated on `CRAWL4AI_BASE_URL` being set; `CRAWL4AI_API_TOKEN` is optional.

**Tech Stack:** TypeScript (strict ESM), Zod v4, existing `retryWithBackoff`, `assertSafeUrl`, `safeResponseJson`, pino logger. No new npm dependencies.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/config.ts` | Modify | Add `crawl4ai` config block + env loading |
| `src/types.ts` | Modify | Add `CrawlPageResult`, `WebCrawlResult` interfaces |
| `src/tools/webCrawl.ts` | Create | HTTP client + crawl4ai API logic |
| `src/health.ts` | Modify | Gate `web_crawl` on `CRAWL4AI_BASE_URL`; add network probe |
| `src/server.ts` | Modify | Register `web_crawl` tool (gated) |

---

## Task 1: Add crawl4ai to `SearchConfig`

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add the `Crawl4aiConfig` interface and extend `SearchConfig`**

In `src/config.ts`, after the `RedditConfig` interface (line 21), add:

```typescript
export interface Crawl4aiConfig {
  baseUrl: string;
  apiToken: string;
}
```

Then inside `SearchConfig` (currently ends at `reddit: RedditConfig;`), append:

```typescript
  crawl4ai: Crawl4aiConfig;
```

- [ ] **Step 2: Add defaults**

Inside the `DEFAULTS` object after the `reddit` block:

```typescript
  crawl4ai: { baseUrl: '', apiToken: '' },
```

- [ ] **Step 3: Load from env in `loadFromEnv()`**

At the end of `loadFromEnv()`, before `return cfg;`:

```typescript
  const crawl4aiUrl = process.env.CRAWL4AI_BASE_URL;
  const crawl4aiToken = process.env.CRAWL4AI_API_TOKEN;
  if (crawl4aiUrl !== undefined || crawl4aiToken !== undefined) {
    cfg.crawl4ai = {
      baseUrl: crawl4aiUrl ?? '',
      apiToken: crawl4aiToken ?? '',
    };
  }
```

Also add `crawl4ai?: Crawl4aiConfig;` to the `EnvConfig` type (the `Omit<Partial<SearchConfig>, 'reddit'>` union — since `crawl4ai` is a simple object, it is already covered by `Partial<SearchConfig>` once the field exists in `SearchConfig`; no extra work needed).

- [ ] **Step 4: Merge into cached config**

Inside `loadConfig()`, after the `reddit` merge line, add:

```typescript
    crawl4ai: {
      baseUrl:
        envConfig.crawl4ai?.baseUrl ?? fileConfig.crawl4ai?.baseUrl ?? DEFAULTS.crawl4ai.baseUrl,
      apiToken:
        envConfig.crawl4ai?.apiToken ??
        fileConfig.crawl4ai?.apiToken ??
        DEFAULTS.crawl4ai.apiToken,
    },
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts
git commit -m "feat: add crawl4ai config (CRAWL4AI_BASE_URL, CRAWL4AI_API_TOKEN)"
```

---

## Task 2: Add response types to `src/types.ts`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Append crawl4ai types at the end of the file**

```typescript
// ── Crawl4AI ───────────────────────────────────────────────────────────────

export interface CrawlPageResult {
  url: string;
  success: boolean;
  markdown: string;
  title: string | null;
  description: string | null;
  links: { href: string; text: string }[];
  statusCode: number | null;
  errorMessage: string | null;
}

export interface WebCrawlResult {
  seedUrl: string;
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  pages: CrawlPageResult[];
  totalPages: number;
  successfulPages: number;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add CrawlPageResult and WebCrawlResult types"
```

---

## Task 3: Implement `src/tools/webCrawl.ts`

**Files:**
- Create: `src/tools/webCrawl.ts`

- [ ] **Step 1: Create the file**

```typescript
import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, networkError, parseError } from '../errors.js';
import type { WebCrawlResult, CrawlPageResult } from '../types.js';

export interface WebCrawlOptions {
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  includeExternalLinks: boolean;
}

// crawl4ai API response shape (stable across v0.7.x and v0.8.x)
interface Crawl4aiPage {
  url?: string;
  success?: boolean;
  markdown?: string | { raw_markdown?: string; fit_markdown?: string } | null;
  metadata?: {
    title?: string;
    description?: string;
    status_code?: number;
  } | null;
  links?: {
    internal?: { href?: string; text?: string }[];
    external?: { href?: string; text?: string }[];
  } | null;
  error_message?: string | null;
}

interface Crawl4aiResponse {
  results?: Crawl4aiPage[];
  result?: Crawl4aiPage;
  success?: boolean;
  error?: string;
}

function extractMarkdown(raw: Crawl4aiPage['markdown']): string {
  if (typeof raw === 'string') return raw;
  if (raw !== null && raw !== undefined && typeof raw === 'object') {
    return raw.fit_markdown ?? raw.raw_markdown ?? '';
  }
  return '';
}

function normalizePage(page: Crawl4aiPage): CrawlPageResult {
  const internalLinks = (page.links?.internal ?? []).map((l) => ({
    href: l.href ?? '',
    text: l.text ?? '',
  }));
  const externalLinks = (page.links?.external ?? []).map((l) => ({
    href: l.href ?? '',
    text: l.text ?? '',
  }));

  return {
    url: page.url ?? '',
    success: page.success ?? false,
    markdown: extractMarkdown(page.markdown),
    title: page.metadata?.title ?? null,
    description: page.metadata?.description ?? null,
    links: [...internalLinks, ...externalLinks],
    statusCode: page.metadata?.status_code ?? null,
    errorMessage: page.error_message ?? null,
  };
}

export async function webCrawl(
  url: string,
  baseUrl: string,
  apiToken: string,
  opts: WebCrawlOptions,
): Promise<WebCrawlResult> {
  assertSafeUrl(url);

  if (!baseUrl) {
    throw unavailableError(
      'crawl4ai sidecar is not configured. Set CRAWL4AI_BASE_URL to enable web_crawl.',
    );
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/crawl`;
  assertSafeUrl(endpoint);

  const body = {
    urls: [url],
    crawler_config: {
      headless: true,
      remove_overlay_elements: true,
      deep_crawl_config:
        opts.maxDepth > 1
          ? {
              strategy: opts.strategy,
              max_depth: opts.maxDepth,
              max_pages: opts.maxPages,
              filter_external_links: !opts.includeExternalLinks,
            }
          : undefined,
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'search-mcp/1.0',
  };
  if (apiToken) {
    headers['Authorization'] = `Bearer ${apiToken}`;
  }

  let raw: unknown;
  try {
    const response = await retryWithBackoff(
      () =>
        fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        }),
      { label: 'crawl4ai', maxAttempts: 2, initialDelayMs: 500 },
    );

    if (!response.ok) {
      if (response.status === 503 || response.status === 502) {
        throw unavailableError(
          `crawl4ai sidecar returned HTTP ${String(response.status)} — is the Docker container running?`,
          { statusCode: response.status },
        );
      }
      throw networkError(
        `crawl4ai returned HTTP ${String(response.status)} for "${url}"`,
        { statusCode: response.status },
      );
    }

    raw = await safeResponseJson(response, endpoint);
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw networkError(`crawl4ai request timed out after 120 seconds for "${url}"`);
    }
    throw err;
  }

  const data = raw as Crawl4aiResponse;

  // crawl4ai may return either { results: [...] } (deep crawl) or { result: {...} } (single page)
  let pages: CrawlPageResult[];
  if (Array.isArray(data.results) && data.results.length > 0) {
    pages = data.results.map(normalizePage);
  } else if (data.result !== undefined) {
    pages = [normalizePage(data.result)];
  } else {
    throw parseError(
      `crawl4ai returned an unexpected response shape. Check that the sidecar version is v0.7.x or v0.8.x.`,
    );
  }

  logger.debug(
    { url, totalPages: pages.length, strategy: opts.strategy },
    'web_crawl complete',
  );

  return {
    seedUrl: url,
    strategy: opts.strategy,
    maxDepth: opts.maxDepth,
    maxPages: opts.maxPages,
    pages,
    totalPages: pages.length,
    successfulPages: pages.filter((p) => p.success).length,
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/webCrawl.ts
git commit -m "feat: implement webCrawl HTTP client for crawl4ai sidecar"
```

---

## Task 4: Gate `web_crawl` in `src/health.ts`

**Files:**
- Modify: `src/health.ts`

- [ ] **Step 1: Add `web_crawl` to `GATED_TOOLS`**

In `src/health.ts`, inside the `GATED_TOOLS` object (after the last entry, `podcast_search`):

```typescript
  web_crawl: {
    check: (cfg) => cfg.crawl4ai.baseUrl.length > 0,
    remediation:
      'Set CRAWL4AI_BASE_URL to point at a running crawl4ai sidecar (e.g. http://localhost:11235). Run: docker run -d -p 11235:11235 unclecode/crawl4ai:latest',
  },
```

- [ ] **Step 2: Add a network probe for crawl4ai**

In `getNetworkProbes()`, after the SearXNG conditional block:

```typescript
  if (cfg.crawl4ai.baseUrl.length > 0) {
    probes.push({
      label: 'crawl4ai',
      url: `${cfg.crawl4ai.baseUrl.replace(/\/+$/, '')}/health`,
      tools: ['web_crawl'],
    });
  }
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/health.ts
git commit -m "feat: gate web_crawl on CRAWL4AI_BASE_URL, add health probe"
```

---

## Task 5: Register `web_crawl` in `src/server.ts`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add the import**

At the top of `src/server.ts`, after the `newsSearch` import (line 26):

```typescript
import { webCrawl } from './tools/webCrawl.js';
```

- [ ] **Step 2: Register the tool**

After the `// ── news_search` block and before the `// ── health_check` block (around line 1093), add:

```typescript
  // ── web_crawl ────────────────────────────────────────────────────────────
  if (!gated.has('web_crawl'))
    server.registerTool(
      'web_crawl',
      {
        description:
          'Crawl a URL using a headless Playwright browser (via a crawl4ai sidecar). ' +
          'Unlike web_read, this handles JavaScript-rendered SPAs, React/Vue apps, consent popups, and shadow DOM. ' +
          'Returns clean LLM-ready Markdown with title, description, and extracted links for each crawled page. ' +
          'Supports deep crawling across multiple pages. Requires CRAWL4AI_BASE_URL env var (self-hosted Docker sidecar).',
        inputSchema: {
          url: z.url().describe('Seed URL to start crawling from'),
          strategy: z
            .enum(['bfs', 'dfs'])
            .optional()
            .default('bfs')
            .describe(
              'Crawl strategy: bfs (breadth-first, good for shallow wide coverage) | ' +
                'dfs (depth-first, good for deeply nested docs)',
            ),
          maxDepth: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .default(1)
            .describe(
              'Maximum link depth to follow from seed URL (1–5, default 1 = single page only)',
            ),
          maxPages: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .default(1)
            .describe('Maximum number of pages to crawl (1–100, default 1)'),
          includeExternalLinks: z
            .boolean()
            .optional()
            .default(false)
            .describe('Follow links to external domains (default false — stays on seed domain)'),
        },
      },
      async ({ url, strategy, maxDepth, maxPages, includeExternalLinks }) => {
        logger.info({ tool: 'web_crawl', url, strategy, maxDepth, maxPages }, 'Tool invoked');
        const start = Date.now();
        try {
          const data = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken, {
            strategy,
            maxDepth,
            maxPages,
            includeExternalLinks,
          });
          const result = makeResult('web_crawl', data, Date.now() - start);
          return successResponse(result);
        } catch (err: unknown) {
          logger.error({ err, tool: 'web_crawl' }, 'Tool failed');
          return errorResponse(err);
        }
      },
    );
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Lint**

```bash
npm run lint
```

Expected: no errors (fix any that appear before committing).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: register web_crawl MCP tool (gated on CRAWL4AI_BASE_URL)"
```

---

## Task 6: Build and smoke-test

**Files:** (none created, just verification)

- [ ] **Step 1: Build**

```bash
npm run build
```

Expected: exits 0, `dist/` updated with no TypeScript errors.

- [ ] **Step 2: Verify health_check lists web_crawl as unconfigured when env is unset**

```bash
CRAWL4AI_BASE_URL= node -e "
import('./dist/health.js').then(({ configHealth }) => {
  import('./dist/config.js').then(({ loadConfig }) => {
    const cfg = loadConfig();
    const h = configHealth(cfg);
    console.log(JSON.stringify(h.web_crawl, null, 2));
  });
});
"
```

Expected output:
```json
{
  "status": "unconfigured",
  "message": "Missing required configuration.",
  "remediation": "Set CRAWL4AI_BASE_URL to point at a running crawl4ai sidecar ..."
}
```

- [ ] **Step 3: Verify web_crawl is absent from registered tools when unconfigured**

Start the server and send a `tools/list` request:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | CRAWL4AI_BASE_URL= node dist/index.js 2>/dev/null
```

Expected: `web_crawl` is NOT in the `result.tools` array.

- [ ] **Step 4: Verify web_crawl appears when configured**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | CRAWL4AI_BASE_URL=http://localhost:11235 node dist/index.js 2>/dev/null
```

Expected: `web_crawl` IS in the `result.tools` array.

- [ ] **Step 5: Commit**

```bash
git commit --allow-empty -m "chore: verify web_crawl gating smoke test passed"
```

---

## Task 7: Docker sidecar reference (README update not required — for operator reference only)

The sidecar can be started with:

```bash
docker run -d \
  --name crawl4ai \
  -p 11235:11235 \
  unclecode/crawl4ai:latest
```

With optional auth token:

```bash
docker run -d \
  --name crawl4ai \
  -p 11235:11235 \
  -e CRAWL4AI_API_TOKEN=your-token \
  unclecode/crawl4ai:latest
```

Then configure the MCP server via env:

```bash
CRAWL4AI_BASE_URL=http://localhost:11235
CRAWL4AI_API_TOKEN=your-token   # optional
```

Verify the sidecar is running:

```bash
curl http://localhost:11235/health
```

Expected: `{"status":"ok"}` or similar.

If results are unexpectedly empty, probe the raw API shape to verify response fields match types:

```bash
curl -s -X POST http://localhost:11235/crawl \
  -H 'Content-Type: application/json' \
  -d '{"urls":["https://example.com"]}' | jq '{success,markdown_type: (.result.markdown | type)}'
```

The `extractMarkdown` helper in `webCrawl.ts` handles both `string` and `{ fit_markdown, raw_markdown }` object shapes.

---

## Self-Review

**Spec coverage:**
- ✅ Self-hosted HTTP API integration (Docker sidecar)
- ✅ Env-var config pattern (CRAWL4AI_BASE_URL, CRAWL4AI_API_TOKEN)
- ✅ Gated tool registration (not registered when unconfigured)
- ✅ Health check integration (configHealth + network probe)
- ✅ SSRF protection via `assertSafeUrl` on both `url` and `endpoint`
- ✅ `ToolResult<T>` response shape
- ✅ Standard error types (`unavailableError`, `networkError`, `parseError`)
- ✅ Deep crawl support (bfs/dfs strategy, maxDepth, maxPages, includeExternalLinks)
- ✅ Both markdown response shapes handled (string vs. object)
- ✅ `retryWithBackoff` with 120s timeout for slow renders

**Type consistency check:**
- `webCrawl()` returns `Promise<WebCrawlResult>` — defined in Task 2, used in Task 3 and Task 5 ✅
- `cfg.crawl4ai.baseUrl` and `cfg.crawl4ai.apiToken` — defined in Task 1, used in Task 5 ✅
- `gated.has('web_crawl')` — gate key matches `GATED_TOOLS` entry in Task 4 ✅
- `strategy` parameter type `'bfs' | 'dfs'` consistent across `WebCrawlOptions`, `WebCrawlResult`, and Zod schema ✅

**Placeholder scan:** No TBD/TODO/placeholder items found.
