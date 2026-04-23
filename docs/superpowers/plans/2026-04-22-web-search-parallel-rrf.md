# Parallel RRF web_search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sequential fallback in `web_search` with parallel execution of Brave and SearXNG, RRF-merged and deduped by normalized URL.

**Architecture:** Add a `src/utils/fusion.ts` utility module with `normalizeUrl` and `rrfMerge`. Rewrite `src/tools/webSearch.ts` to call both backends concurrently via `Promise.allSettled`, then fuse surviving results. Transparent to tool schema and callers.

**Tech Stack:** TypeScript, ESM, existing test runner (`node scripts/run-tests.cjs`).

---

## File Structure

| File                     | Responsibility                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/utils/fusion.ts`    | `normalizeUrl`, `rrfMerge` — pure utility, zero deps on other src files                          |
| `test/fusion.test.ts`    | Unit tests for normalizeUrl and rrfMerge                                                         |
| `src/tools/webSearch.ts` | Parallel fan-out and fallback to rrfMerge; exports internal `searchWithBackends` for testability |
| `test/webSearch.test.ts` | Mock-based unit tests for webSearch under single/dual/failure scenarios                          |

---

### Task 1: Write normalization and fusion utilities

**Files:**

- Create: `src/utils/fusion.ts`
- Test: `test/fusion.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/fusion.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, rrfMerge } from '../src/utils/fusion.js';

// --- normalizeUrl ---

test('normalizeUrl strips tracking params', () => {
  const result = normalizeUrl('https://example.com/article?utm_source=twitter&id=123');
  assert.ok(result.includes('?id=123'), 'Expected id param preserved');
  assert.ok(!result.includes('utm_source'), 'Expected utm param stripped');
});

test('normalizeUrl strips trailing slash and www', () => {
  const result = normalizeUrl('https://www.example.com/path/');
  assert.equal(result, 'https://example.com/path');
});

test('normalizeUrl lower-cases hostname', () => {
  const result = normalizeUrl('https://EXAMPLE.COM/path');
  assert.ok(
    result.startsWith('https://example.com/'),
    `Expected lowercase hostname, got ${result}`,
  );
});

test('normalizeUrl returns raw URL on malformed input', () => {
  const result = normalizeUrl('not-a-url');
  assert.equal(result, 'not-a-url');
});

test('normalizeUrl handles root path with trailing slash', () => {
  const result = normalizeUrl('https://www.example.com/');
  assert.equal(result, 'https://example.com');
});

// --- rrfMerge ---

test('rrfMerge with two rankings produces correct RRF scores', () => {
  const rankings = [
    [{ url: 'a' }, { url: 'b' }],
    [{ url: 'b' }, { url: 'c' }],
  ];
  const merged = rrfMerge(rankings as unknown as any[][], {
    k: 60,
    keyFn: (r) => (r as { url: string }).url,
  });
  assert.equal(merged.length, 3, `Expected 3 results, got ${merged.length}`);

  // score(b) = 1/(60+1) + 1/(60+1) = 2/61; score(a) = 1/61; score(c) = 1/62
  const b = merged.find((m) => (m.item as { url: string }).url === 'b');
  assert.ok(b, 'Expected b in merged results');
  assert.equal(merged[0].item.url, 'b', 'Expected b first (highest RRF score)');
  assert.ok(
    Math.abs(b.rrfScore - 2 / 61) < 1e-9,
    `Expected b rrfScore ≈ ${2 / 61}, got ${b.rrfScore}`,
  );

  const a = merged.find((m) => (m.item as { url: string }).url === 'a');
  assert.ok(a, 'Expected a in merged results');
  assert.ok(
    Math.abs(a.rrfScore - 1 / 61) < 1e-9,
    `Expected a rrfScore ≈ ${1 / 61}, got ${a.rrfScore}`,
  );

  const c = merged.find((m) => (m.item as { url: string }).url === 'c');
  assert.ok(c, 'Expected c in merged results');
  assert.ok(
    Math.abs(c.rrfScore - 1 / 62) < 1e-9,
    `Expected c rrfScore ≈ ${1 / 62}, got ${c.rrfScore}`,
  );
});

test('rrfMerge with one ranking preserves order and scores', () => {
  const rankings = [[{ url: 'x' }, { url: 'y' }]];
  const merged = rrfMerge(rankings as unknown as any[][], {
    k: 60,
    keyFn: (r) => (r as { url: string }).url,
  });
  assert.equal(merged.length, 2, 'Expected 2 results');
  assert.equal((merged[0].item as { url: string }).url, 'x');
  assert.equal((merged[1].item as { url: string }).url, 'y');

  assert.ok(
    Math.abs(merged[0].rrfScore - 1 / 61) < 1e-9,
    `Expected x rrfScore ≈ ${1 / 61}, got ${merged[0].rrfScore}`,
  );
  assert.ok(
    Math.abs(merged[1].rrfScore - 1 / 62) < 1e-9,
    `Expected y rrfScore ≈ ${1 / 62}, got ${merged[1].rrfScore}`,
  );
});

test('rrfMerge with duplicate items deduplicates', () => {
  const rankings = [[{ url: 'a' }], [{ url: 'a' }]];
  const merged = rrfMerge(rankings as unknown as any[][], {
    k: 60,
    keyFn: (r) => (r as { url: string }).url,
  });
  assert.equal(merged.length, 1, `Expected 1 deduped result, got ${merged.length}`);
  assert.ok(
    Math.abs(merged[0].rrfScore - 2 / 61) < 1e-9,
    `Expected deduped rrfScore ≈ ${2 / 61}, got ${merged[0].rrfScore}`,
  );
});

test('rrfMerge empty rankings returns empty array', () => {
  const merged = rrfMerge([], { k: 60, keyFn: () => 'x' });
  assert.equal(merged.length, 0);
});

test('rrfMerge with one empty ranking returns empty array', () => {
  const merged = rrfMerge([[]], { k: 60, keyFn: () => 'x' });
  assert.equal(merged.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test test/fusion.test.ts`
Expected: FAIL — module not found because `src/utils/fusion.ts` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/fusion.ts`:

```typescript
/** Strip common tracking and advertising query parameters from a URL. */
function stripTrackingParams(urlStr: string): string {
  const TRACKING = new Set([
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'fbclid',
    'gclid',
    'ref',
    'source',
  ]);

  try {
    const url = new URL(urlStr);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING.has(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return urlStr;
  }
}

/**
 * Normalize a URL for deduplication comparison.
 *
 * - Strip trailing slashes from the pathname.
 * - Strip 'www.' prefix from hostname.
 * - Strip common tracking parameters.
 * - Lower-case hostname.
 *
 * If the URL is malformed, returns the original string unchanged so data
 * is never silently dropped during fusion.
 */
export function normalizeUrl(original: string): string {
  try {
    const stripped = stripTrackingParams(original);
    const url = new URL(stripped);
    let hostname = url.hostname.toLowerCase();
    if (hostname.startsWith('www.')) hostname = hostname.slice(4);
    url.hostname = hostname;
    url.pathname = url.pathname.replace(/\/+$/, '');
    // remove trailing empty search string added by URL constructor
    return url.toString();
  } catch {
    return original;
  }
}

export interface RrfMergeResult<T> {
  item: T;
  rrfScore: number;
}

/**
 * Reciprocal Rank Fusion (RRF).
 *
 * Combines multiple ranked result lists into a single fused ranking. Items
 * appearing in multiple lists get a higher score (sum of reciprocal ranks).
 *
 * @param rankings  Ordered lists per source (best first in each).
 * @param opts.k    RRF constant (default 60).
 * @param opts.keyFn Dedupe key per item (default normalizeUrl applied to
 *                   a `{ url: string }` property — callers should override).
 */
export function rrfMerge<T>(
  rankings: T[][],
  opts?: { k?: number; keyFn?: (item: T) => string },
): RrfMergeResult<T>[] {
  const k = opts?.k ?? 60;

  const defaultKeyFn = (item: T): string => {
    const record = item as unknown as Record<string, unknown>;
    if (typeof record.url === 'string') return normalizeUrl(record.url);
    // Fallback: use JSON stringification.
    return JSON.stringify(item);
  };

  const keyFn = opts?.keyFn ?? defaultKeyFn;
  const scores = new Map<string, { item: T; score: number }>();

  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const item = ranking[i];
      const key = keyFn(item);
      const rank = i + 1; // 1-indexed
      const reciprocal = 1 / (k + rank);

      const existing = scores.get(key);
      if (existing) {
        existing.score += reciprocal;
      } else {
        scores.set(key, { item, score: reciprocal });
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((v) => ({ item: v.item, rrfScore: v.score }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test test/fusion.test.ts`
Expected: All 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/fusion.ts test/fusion.test.ts
git commit -m "feat: add normalizeUrl and rrfMerge utilities

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Integrate parallel fusion into webSearch

**Files:**

- Modify: `src/tools/webSearch.ts`
- Test: `test/webSearch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/webSearch.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWithBackends } from '../src/tools/webSearch.js';
import type { SearchResult } from '../src/types.js';

function makeResult(url: string, position: number): SearchResult {
  return {
    title: `Title for ${url}`,
    url,
    description: `Desc for ${url}`,
    position,
    domain: new URL(url.startsWith('http') ? url : `https://${url}`).hostname,
    source: 'brave' as const,
    age: null,
    extraSnippet: null,
    deepLinks: null,
  };
}

// ── Both backends succeed: merge and dedupe ──────────────────────────────

test('searchWithBackends merges and dedupes results from both backends', async () => {
  const braveResults: SearchResult[] = [
    makeResult('https://example.com/a', 1),
    makeResult('https://example.com/b', 2),
  ];
  const searxResults: SearchResult[] = [
    makeResult('https://example.com/b', 1),
    makeResult('https://example.com/c', 2),
  ];

  const results = await searchWithBackends(
    'test',
    2,
    'moderate',
    {
      braveSearch: async () => braveResults,
      searxngSearch: async () => searxResults,
    },
    ['brave', 'searxng'],
  );

  assert.equal(results.length, 2, `Expected 2 limited results, got ${results.length}`);
  // b appears in both, so it should win RRF and be first
  assert.equal(results[0].url, 'https://example.com/b');
  assert.equal(results[1].url, 'https://example.com/a');
});

// ── One backend fails: returns surviving results ───────────────────────────

test('searchWithBackends returns surviving results when one backend fails', async () => {
  const braveResults: SearchResult[] = [
    makeResult('https://example.com/x', 1),
    makeResult('https://example.com/y', 2),
  ];

  const results = await searchWithBackends(
    'test',
    2,
    'moderate',
    {
      braveSearch: async () => braveResults,
      searxngSearch: async () => {
        throw new Error('SearXNG unreachable');
      },
    },
    ['brave', 'searxng'],
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://example.com/x');
  assert.equal(results[1].url, 'https://example.com/y');
});

// ── Both backends fail: throws combined error ────────────────────────────

test('searchWithBackends throws when all backends fail', async () => {
  await assert.rejects(
    async () =>
      searchWithBackends(
        'test',
        2,
        'moderate',
        {
          braveSearch: async () => {
            throw new Error('Brave error');
          },
          searxngSearch: async () => {
            throw new Error('SearXNG error');
          },
        },
        ['brave', 'searxng'],
      ),
    /All search backends failed/,
  );
});

// ── Only one backend succeeds: valid.length === 1 shortcut ─────────────────
// This is already covered by the "one backend fails" test above, which
// exercises the `if (valid.length === 1) return valid[0].slice(0, limit)`
// code path via a thrown promise (rejected → not in `valid`).

// ── Result limit respected ───────────────────────────────────────────────

test('searchWithBackends limits results to requested count', async () => {
  const braveResults: SearchResult[] = [
    makeResult('https://example.com/1', 1),
    makeResult('https://example.com/2', 2),
    makeResult('https://example.com/3', 3),
  ];
  const searxResults: SearchResult[] = [
    makeResult('https://example.com/4', 1),
    makeResult('https://example.com/5', 2),
    makeResult('https://example.com/6', 3),
  ];

  const results = await searchWithBackends(
    'test',
    2,
    'moderate',
    {
      braveSearch: async () => braveResults,
      searxngSearch: async () => searxResults,
    },
    ['brave', 'searxng'],
  );

  assert.equal(results.length, 2, `Expected 2 results, got ${results.length}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test test/webSearch.test.ts`
Expected: FAIL — `searchWithBackends` not exported from `src/tools/webSearch.js`.

- [ ] **Step 3: Write minimal implementation**

Modify `src/tools/webSearch.ts`:

```typescript
import { logger } from '../logger.js';
import { loadConfig, type SearchBackend } from '../config.js';
import { braveSearch } from './braveSearch.js';
import { searxngSearch } from './searxngSearch.js';
import { normalizeUrl, rrfMerge } from '../utils/fusion.js';
import type { SearchResult } from '../types.js';

const FALLBACK_ORDER: SearchBackend[] = ['brave', 'searxng'];

function backendAvailable(backend: SearchBackend): boolean {
  const cfg = loadConfig();
  switch (backend) {
    case 'brave':
      return cfg.brave.apiKey.length > 0;
    case 'searxng':
      return cfg.searxng.baseUrl.length > 0;
  }
}

export interface WebSearchDeps {
  braveSearch: typeof import('./braveSearch.js').braveSearch;
  searxngSearch: typeof import('./searxngSearch.js').searxngSearch;
}

export async function searchWithBackends(
  query: string,
  limit: number,
  safeSearch: 'strict' | 'moderate' | 'off',
  deps: WebSearchDeps,
  /** Optionally override which backends to query (for testing). When omitted, backends are resolved from config. */
  overrideBackends?: SearchBackend[],
): Promise<SearchResult[]> {
  const cfg = loadConfig();
  const primary = cfg.searchBackend;
  const backends =
    overrideBackends ??
    [primary, ...FALLBACK_ORDER.filter((b) => b !== primary)].filter(backendAvailable);

  logger.info({ backends, query, limit, safeSearch }, 'Running parallel web search');

  const settled = await Promise.allSettled(
    backends.map(async (backend) => {
      const cfg2 = loadConfig();
      switch (backend) {
        case 'brave':
          return deps.braveSearch(query, cfg2.brave.apiKey, limit * 2, safeSearch);
        case 'searxng':
          return deps.searxngSearch(query, cfg2.searxng.baseUrl, limit * 2, safeSearch);
      }
    }),
  );

  const valid: SearchResult[][] = settled
    .filter((r): r is PromiseFulfilledResult<SearchResult[]> => r.status === 'fulfilled')
    .map((r) => r.value);

  const errors: string[] = [];
  settled.forEach((r, idx) => {
    if (r.status === 'rejected') {
      const backend = backends[idx];
      const msg = String(r.reason);
      logger.warn({ backend, err: msg }, 'Search backend failed');
      errors.push(`${backend}: ${msg}`);
    }
  });

  if (valid.length === 0) {
    throw new Error(
      `All search backends failed. Ensure at least one backend is configured (BRAVE_API_KEY or SEARXNG_BASE_URL).\n${errors.join('\n')}`,
    );
  }

  if (valid.length === 1) {
    return valid[0].slice(0, limit);
  }

  const merged = rrfMerge(valid, { k: 60, keyFn: (r) => normalizeUrl(r.url) });
  return merged.map((m) => m.item).slice(0, limit);
}

/** Public entry point — delegates to searchWithBackends with real backend implementations. */
export async function webSearch(
  query: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
): Promise<SearchResult[]> {
  return searchWithBackends(query, limit, safeSearch, {
    braveSearch,
    searxngSearch,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test test/webSearch.test.ts`
Expected: All 4 tests pass.

- [ ] **Step 5: Run lint and typecheck**

```bash
npm run typecheck
npm run lint
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/webSearch.ts test/webSearch.test.ts
git commit -m "feat: parallel RRF web_search replaces sequential fallback

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review Checklist

1. **Spec coverage:** Every spec requirement has a task:
   - `normalizeUrl` with tracking-param stripping → Task 1
   - `rrfMerge` with dedup and score computation → Task 1
   - Parallel fan-out in `webSearch` → Task 2
   - Single-backend graceful degradation → Task 2
   - All-backend failure preserved → Task 2
   - Schema unchanged → No changes needed (confirmed)
   - Warning log for failed backends → Task 2 Step 3 (via `logger.warn`)

2. **Placeholder scan:** No TBD/TODO/fill-in-details/Similar to Task N. All code is complete.

3. **Type consistency:** `SearchResult` type unchanged. `RrfMergeResult` used only inside `fusion.ts`. `normalizeUrl` signature consistent across files.
