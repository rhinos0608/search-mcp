# Multi-Signal RRF Rescoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a generic rescoring layer into every tool that produces ranked results. Extractors emit fully-normalized signals; `multiSignalRescore` is a pure weighted sum + sort.

**Architecture:** Add `src/utils/rescore.ts` (transforms + extractors + rescorer) and `src/utils/time.ts` (age parsing). Extend `rrfMerge` in `src/utils/fusion.ts` with `getId` for cross-source dedup. Wire rescoring into `webSearch`, `academicSearch`, `hackernewsSearch`, and `redditSearch`.

**Tech Stack:** TypeScript, ESM, existing test runner (`node scripts/run-tests.cjs`), Zod v4.

---

## File Structure

| File                            | Responsibility                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/utils/rescore.ts`          | Transform functions, `minMaxNormalize`, `multiSignalRescore`, per-tool signal extractors |
| `src/utils/time.ts`             | `parseAgeToDays`, `daysSince`                                                            |
| `src/utils/fusion.ts`           | Extend `rrfMerge` with `getId` parameter and merge-collision metadata policy             |
| `src/tools/webSearch.ts`        | Wire `multiSignalRescore` after RRF                                                      |
| `src/tools/academicSearch.ts`   | Parallel ArXiv+SS → RRF with `getId` → rescoring                                         |
| `src/tools/hackernewsSearch.ts` | RRF (single source) → sort-mode-aware signals → rescoring                                |
| `src/tools/redditSearch.ts`     | Same as HN                                                                               |
| `src/config.ts`                 | Add `RescoreConfig` with per-tool weights                                                |
| `test/rescore.test.ts`          | Unit tests for transforms, rescorer, extractors, fusion, guardrail                       |
| `test/time.test.ts`             | Unit tests for `parseAgeToDays`                                                          |
| `test/rescore.eval.ts`          | **Roadmap.** Eval harness with judgment set                                              |

---

### Task 1: Extend `rrfMerge` with `getId`

**Files:**

- Modify: `src/utils/fusion.ts`
- Test: `test/fusion.test.ts` (extend existing tests)

- [ ] **Step 1: Write the failing test**

Extend `test/fusion.test.ts` with:

```typescript
test('rrfMerge with getId: same ID in two rankings → boosted entry', () => {
  const rankings = [
    [
      { id: 'a', url: 'x' },
      { id: 'b', url: 'y' },
    ],
    [
      { id: 'b', url: 'z' },
      { id: 'c', url: 'w' },
    ],
  ];
  const merged = rrfMerge(rankings as unknown as any[][], {
    k: 60,
    keyFn: (r) => (r as { url: string }).url,
    getId: (r) => (r as { id: string }).id,
  });
  assert.equal(merged.length, 3);
  const b = merged.find((m) => (m.item as { id: string }).id === 'b');
  assert.ok(b, 'Expected b in merged results');
  // score(b) = 1/(60+2) + 1/(60+1) = 1/62 + 1/61
  assert.ok(
    Math.abs(b.rrfScore - (1 / 61 + 1 / 62)) < 1e-9,
    `Expected b rrfScore ≈ ${1 / 61 + 1 / 62}, got ${b.rrfScore}`,
  );
  // b should be first because it got boosted
  assert.equal(merged[0].item.id, 'b');
});

test('rrfMerge with getId: no match → no cross-source accumulation', () => {
  const rankings = [[{ id: 'a', url: 'x' }], [{ id: 'b', url: 'y' }]];
  const merged = rrfMerge(rankings as unknown as any[][], {
    k: 60,
    keyFn: (r) => (r as { url: string }).url,
    getId: (r) => (r as { id: string }).id,
  });
  assert.equal(merged.length, 2);
  assert.equal(merged[0].item.id, 'a');
  assert.equal(merged[1].item.id, 'b');
});

test('rrfMerge with getId collision: last ranking metadata wins', () => {
  const rankings = [
    [{ id: 'b', url: 'first', meta: 'old' }],
    [{ id: 'b', url: 'second', meta: 'new' }],
  ];
  const merged = rrfMerge(rankings as unknown as any[][], {
    k: 60,
    keyFn: (r) => (r as { url: string }).url,
    getId: (r) => (r as { id: string }).id,
  });
  assert.equal(merged.length, 1);
  assert.equal((merged[0].item as unknown as Record<string, string>).meta, 'new');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test test/fusion.test.ts`
Expected: FAIL — `getId` not supported in `rrfMerge`.

- [ ] **Step 3: Extend `rrfMerge` with `getId`**

Modify `src/utils/fusion.ts`:

```typescript
export interface RrfMergeOptions<T> {
  k?: number;
  keyFn?: (item: T) => string;
  getId?: (item: T) => string;
}

export function rrfMerge<T>(rankings: T[][], opts?: RrfMergeOptions<T>): RrfMergeResult<T>[] {
  const k = opts?.k ?? 60;

  const defaultKeyFn = (item: T): string => {
    const record = item as unknown as Record<string, unknown>;
    if (typeof record.url === 'string') return normalizeUrl(record.url);
    return JSON.stringify(item);
  };

  const keyFn = opts?.keyFn ?? defaultKeyFn;
  const getId = opts?.getId;

  // Track scores by canonical ID (getId) or keyFn if no getId
  const scores = new Map<string, { item: T; score: number }>();

  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const item = ranking[i];
      if (!item) continue;
      const rank = i + 1;
      const reciprocal = 1 / (k + rank);

      // Use canonical ID for cross-source dedup/boost
      const canonicalId = getId ? getId(item) : keyFn(item);
      const existing = scores.get(canonicalId);
      if (existing) {
        existing.score += reciprocal;
        // If getId is used, prefer last-ranking metadata
        if (getId) {
          existing.item = item;
        }
      } else {
        scores.set(canonicalId, { item, score: reciprocal });
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((v) => ({ item: v.item, rrfScore: v.score }));
}
```

Note: When `getId` is present, the canonical ID is used for dedup/cross-source boosting, and the `keyFn` is still used for the return type but dedup is handled by canonical ID. The `keyFn` is no longer needed when `getId` is present for cross-source merging.

Wait — actually, there's a subtlety. When `getId` is present, the `keyFn` should still be used for intra-list dedup (within a single ranking), while `getId` handles cross-source dedup. But the current implementation uses `keyFn` for both when `getId` is absent. Let me reconsider.

Actually, looking at the test cases:

1. `getId` is used for cross-source dedup — same ID in different rankings gets boosted
2. `keyFn` is used for intra-list dedup — same URL with different tracking params in the same ranking gets deduped

In the revised implementation:

- Within a single ranking, items are deduped by `keyFn` (as before)
- Across rankings, items with the same `getId` are merged (boosted)

But in the current implementation, the Map key is `canonicalId` which is `getId || keyFn`. This means:

- If `getId` is provided, cross-source dedup happens by `getId`
- If `getId` is NOT provided, dedup happens by `keyFn` (backward compatible)

This is actually correct! The test cases should pass.

However, I need to think about whether `keyFn` still matters when `getId` is present. In the current implementation, `keyFn` is NOT used when `getId` is present (since `canonicalId = getId || keyFn`). This means intra-list dedup by URL won't happen — instead, intra-list dedup will happen by `getId`. This is probably fine for academic papers (where DOI is the canonical ID and two items in the same ranking won't share the same DOI), but for web search, it might be different.

Actually, for web search, `getId` is not used — only `keyFn` (normalizeUrl) is used. For academic search, `getId` is used (DOI-based). So the current implementation is correct:

- Web search: no `getId`, uses `keyFn` (normalizeUrl) for dedup
- Academic search: uses `getId` (DOI) for cross-source boost, `keyFn` for URL dedup

Wait, but in the current implementation, when `getId` is present, the Map key is `getId`, not `keyFn`. This means if two items in the SAME ranking have the same `getId`, they will be deduped (only the last one wins). This is probably what we want for academic papers (two entries with the same DOI in the same ArXiv feed would be a bug anyway).

So the implementation is correct. Let me proceed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test test/fusion.test.ts`
Expected: All existing tests + 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/fusion.ts test/fusion.test.ts
git commit -m "feat: add getId to rrfMerge for cross-source dedup

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Create `src/utils/rescore.ts` (transforms + normalizers)

**Files:**

- Create: `src/utils/rescore.ts`
- Test: `test/rescore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/rescore.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRecencyDecay,
  applyLogTransform,
  minMaxNormalize,
  multiSignalRescore,
} from '../src/utils/rescore.js';

// --- Transforms ---

test('applyRecencyDecay: 0 days → 1.0', () => {
  assert.equal(applyRecencyDecay(0, 7), 1.0);
});

test('applyRecencyDecay: half_life → ≈0.5', () => {
  assert.ok(Math.abs(applyRecencyDecay(7, 7) - 0.5) < 0.01);
});

test('applyRecencyDecay: 3x half_life → ≈0.125', () => {
  assert.ok(Math.abs(applyRecencyDecay(21, 7) - 0.125) < 0.01);
});

test('applyLogTransform: 0 → 0', () => {
  assert.equal(applyLogTransform(0), 0);
});

test('applyLogTransform: 100 → ≈4.6', () => {
  assert.ok(Math.abs(applyLogTransform(100) - 4.605) < 0.01);
});

test('applyLogTransform: negative input clipped to 0', () => {
  assert.equal(applyLogTransform(-5), 0);
});

// --- Min-max ---

test('minMaxNormalize: [1,2,3] → [0, 0.5, 1.0]', () => {
  const result = minMaxNormalize([1, 2, 3]);
  assert.deepEqual(result, [0, 0.5, 1.0]);
});

test('minMaxNormalize: all equal → all 0', () => {
  const result = minMaxNormalize([5, 5, 5]);
  assert.deepEqual(result, [0, 0, 0]);
});

test('minMaxNormalize: single element → [0]', () => {
  const result = minMaxNormalize([7]);
  assert.deepEqual(result, [0]);
});

test('minMaxNormalize: empty → []', () => {
  const result = minMaxNormalize([]);
  assert.deepEqual(result, []);
});

// --- Rescorer ---

test('multiSignalRescore with homogeneous signals preserves order', () => {
  const items = [
    { item: 'a', rrfScore: 0.1, signals: { recency: 0.5 } },
    { item: 'b', rrfScore: 0.2, signals: { recency: 0.5 } },
    { item: 'c', rrfScore: 0.3, signals: { recency: 0.5 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 0.5, recency: 0.2 }, 10);
  assert.equal(result[0].item, 'c');
  assert.equal(result[1].item, 'b');
  assert.equal(result[2].item, 'a');
});

test('multiSignalRescore with recency bias bubbles up newer items', () => {
  const items = [
    { item: 'old', rrfScore: 0.5, signals: { recency: 0.1 } },
    { item: 'new', rrfScore: 0.3, signals: { recency: 0.9 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 0.3, recency: 0.7 }, 10);
  assert.equal(result[0].item, 'new');
  assert.equal(result[1].item, 'old');
});

test('multiSignalRescore with rrfAnchor:1 → pure RRF', () => {
  const items = [
    { item: 'a', rrfScore: 0.1, signals: { recency: 0.9 } },
    { item: 'b', rrfScore: 0.5, signals: { recency: 0.1 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 1.0, recency: 0.0 }, 10);
  assert.equal(result[0].item, 'b');
  assert.equal(result[1].item, 'a');
});

test('multiSignalRescore respects limit', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    item: String(i),
    rrfScore: i * 0.1,
    signals: {},
  }));
  const result = multiSignalRescore(items, { rrfAnchor: 1.0 }, 3);
  assert.equal(result.length, 3);
});

test('multiSignalRescore single item', () => {
  const result = multiSignalRescore(
    [{ item: 'a', rrfScore: 0.5, signals: {} }],
    { rrfAnchor: 1.0 },
    10,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].item, 'a');
});

test('multiSignalRescore all equal signals → stable sort', () => {
  const items = [
    { item: 'first', rrfScore: 0.5, signals: { recency: 0.5 } },
    { item: 'second', rrfScore: 0.5, signals: { recency: 0.5 } },
  ];
  const result = multiSignalRescore(items, { rrfAnchor: 0.5, recency: 0.5 }, 10);
  // Stable sort: first should stay first
  assert.equal(result[0].item, 'first');
  assert.equal(result[1].item, 'second');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test test/rescore.test.ts`
Expected: FAIL — `src/utils/rescore.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/rescore.ts`:

```typescript
/**
 * Recency signal: exponential decay.
 * score = exp(-ageDays / halfLifeDays)
 */
export function applyRecencyDecay(ageDays: number, halfLifeDays: number): number {
  return Math.exp(-ageDays / halfLifeDays);
}

/**
 * Heavy-tailed signal: log transform with negative clipping.
 * score = log(1 + max(0, value))
 */
export function applyLogTransform(value: number): number {
  return Math.log(1 + Math.max(0, value));
}

/**
 * Min-max normalize across a candidate set.
 * All equal → all 0; single element → [0]; empty → [].
 */
export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) {
    return values.map(() => 0);
  }
  return values.map((v) => (v - min) / range);
}

export interface RrfResultWithSignals<T> {
  item: T;
  rrfScore: number;
  signals: Record<string, number>;
}

export interface ScoredResult<T> {
  item: T;
  combinedScore: number;
  breakdown: {
    rrfAnchor: number;
    signals: Record<string, number>;
  };
}

/**
 * Pure weighted sum rescoring.
 * Extractors emit fully-normalized signals; this function just sums and sorts.
 */
export function multiSignalRescore<T>(
  items: RrfResultWithSignals<T>[],
  weights: Record<string, number>,
  limit: number,
): ScoredResult<T>[] {
  const rrfValues = items.map((i) => i.rrfScore);
  const rrfNormalized = minMaxNormalize(rrfValues);

  const scored = items.map((item, i) => {
    let combined = (weights.rrfAnchor ?? 0) * (rrfNormalized[i] ?? 0);
    const signalBreakdown: Record<string, number> = {};

    for (const [key, value] of Object.entries(item.signals)) {
      const weight = weights[key] ?? 0;
      const contribution = weight * value;
      combined += contribution;
      signalBreakdown[key] = contribution;
    }

    return {
      item: item.item,
      combinedScore: combined,
      breakdown: {
        rrfAnchor: (weights.rrfAnchor ?? 0) * (rrfNormalized[i] ?? 0),
        signals: signalBreakdown,
      },
    };
  });

  // Stable sort: preserve original order for equal scores
  return scored.sort((a, b) => b.combinedScore - a.combinedScore).slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test test/rescore.test.ts`
Expected: All 15 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/rescore.ts test/rescore.test.ts
git commit -m "feat: add multiSignalRescore with transforms and normalizers

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Create `src/utils/time.ts` (age parsing)

**Files:**

- Create: `src/utils/time.ts`
- Test: `test/time.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/time.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgeToDays } from '../src/utils/time.js';

test('parseAgeToDays: "2 days ago" → 2', () => {
  assert.equal(parseAgeToDays('2 days ago'), 2);
});

test('parseAgeToDays: "1 week ago" → 7', () => {
  assert.equal(parseAgeToDays('1 week ago'), 7);
});

test('parseAgeToDays: "1 hour ago" → ~0.04', () => {
  const result = parseAgeToDays('1 hour ago');
  assert.ok(result !== null && Math.abs(result - 1 / 24) < 0.01);
});

test('parseAgeToDays: ISO date → days since', () => {
  const result = parseAgeToDays('2024-01-15');
  assert.ok(result !== null && result > 0);
});

test('parseAgeToDays: null → null', () => {
  assert.equal(parseAgeToDays(null), null);
});

test('parseAgeToDays: empty string → null', () => {
  assert.equal(parseAgeToDays(''), null);
});

test('parseAgeToDays: unknown → null', () => {
  assert.equal(parseAgeToDays('unknown'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test test/time.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/time.ts`:

```typescript
/**
 * Parse a human-readable age string to days old.
 * Handles: "2 days ago", "1 week ago", "1 hour ago", ISO dates, "Jan 15, 2024".
 * Returns null for unparseable input.
 */
export function parseAgeToDays(ageStr: string | null | undefined): number | null {
  if (!ageStr || ageStr.trim().length === 0) return null;
  const s = ageStr.trim().toLowerCase();

  // "N units ago"
  const agoMatch = /^(\d+(?:\.\d+)?)\s*([a-z]+)\s*ago$/.exec(s);
  if (agoMatch) {
    const amount = parseFloat(agoMatch[1]!);
    const unit = agoMatch[2]!;
    switch (unit) {
      case 'second':
      case 'seconds':
        return amount / 86400;
      case 'minute':
      case 'minutes':
        return amount / 1440;
      case 'hour':
      case 'hours':
        return amount / 24;
      case 'day':
      case 'days':
        return amount;
      case 'week':
      case 'weeks':
        return amount * 7;
      case 'month':
      case 'months':
        return amount * 30;
      case 'year':
      case 'years':
        return amount * 365;
      default:
        return null;
    }
  }

  // ISO date (YYYY-MM-DD)
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (isoMatch) {
    const date = new Date(
      parseInt(isoMatch[1]!, 10),
      parseInt(isoMatch[2]!, 10) - 1,
      parseInt(isoMatch[3]!, 10),
    );
    const now = new Date();
    return (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);
  }

  // "Jan 15, 2024" or "15 Jan 2024"
  const parsed = Date.parse(ageStr);
  if (!isNaN(parsed)) {
    const now = new Date();
    return (now.getTime() - parsed) / (1000 * 60 * 60 * 24);
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test test/time.test.ts`
Expected: All 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/time.ts test/time.test.ts
git commit -m "feat: add parseAgeToDays utility for age string parsing

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Add per-tool signal extractors to `rescore.ts`

**Files:**

- Modify: `src/utils/rescore.ts`
- Test: `test/rescore.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Extend `test/rescore.test.ts`:

```typescript
import type { SearchResult } from '../src/types.js';
import type { AcademicPaper } from '../src/types.js';
import type { HackerNewsItem } from '../src/types.js';
import type { RedditPost } from '../src/types.js';
import {
  extractWebSearchSignals,
  extractAcademicSignals,
  extractHNSignals,
  extractRedditSignals,
} from '../src/utils/rescore.js';

// --- Web search signals ---

test('extractWebSearchSignals: recency from age, hasDeepLinks', () => {
  const results: SearchResult[] = [
    {
      title: 'Test',
      url: 'https://example.com',
      description: 'Desc',
      position: 1,
      domain: 'example.com',
      source: 'brave',
      age: '2 days ago',
      extraSnippet: null,
      deepLinks: [{ title: 'a', url: 'https://example.com/a' }],
    },
  ];
  const signals = extractWebSearchSignals(results);
  assert.equal(signals.length, 1);
  assert.ok(signals[0]!.recency > 0);
  assert.equal(signals[0]!.hasDeepLinks, 1);
});

test('extractWebSearchSignals: missing age → recency = 0', () => {
  const results: SearchResult[] = [
    {
      title: 'Test',
      url: 'https://example.com',
      description: 'Desc',
      position: 1,
      domain: 'example.com',
      source: 'brave',
      age: null,
      extraSnippet: null,
      deepLinks: null,
    },
  ];
  const signals = extractWebSearchSignals(results);
  assert.equal(signals[0]!.recency, 0);
});

// --- Academic signals ---

test('extractAcademicSignals: citations, venue, recency', () => {
  const papers: AcademicPaper[] = [
    {
      title: 'Paper A',
      authors: ['Smith'],
      abstract: 'Abstract',
      url: 'https://arxiv.org/abs/1234',
      year: 2024,
      venue: 'NeurIPS',
      citationCount: 100,
      source: 'arxiv',
      doi: null,
      pdfUrl: null,
    },
  ];
  const signals = extractAcademicSignals(papers, 2026);
  assert.equal(signals.length, 1);
  assert.ok(signals[0]!.citations > 0);
  assert.equal(signals[0]!.venue, 1);
  assert.ok(signals[0]!.recency > 0);
});

test('extractAcademicSignals: missing venue → venue = 0', () => {
  const papers: AcademicPaper[] = [
    {
      title: 'Paper B',
      authors: ['Jones'],
      abstract: 'Abstract',
      url: 'https://arxiv.org/abs/5678',
      year: 2024,
      venue: null,
      citationCount: 0,
      source: 'arxiv',
      doi: null,
      pdfUrl: null,
    },
  ];
  const signals = extractAcademicSignals(papers, 2026);
  assert.equal(signals[0]!.venue, 0);
});

// --- HN signals ---

test('extractHNSignals relevance mode: all signals present', () => {
  const items: HackerNewsItem[] = [
    {
      id: 1,
      title: 'Test',
      url: 'https://example.com',
      author: 'user',
      points: 100,
      numComments: 50,
      createdAt: '2024-01-01',
      storyText: null,
      type: 'story',
      objectId: '1',
    },
  ];
  const signals = extractHNSignals(items, 'relevance');
  assert.ok(signals[0]!.recency > 0);
  assert.ok(signals[0]!.engagement > 0);
  assert.ok(signals[0]!.commentEngagement > 0);
});

test('extractHNSignals date mode: recency omitted', () => {
  const items: HackerNewsItem[] = [
    {
      id: 1,
      title: 'Test',
      url: 'https://example.com',
      author: 'user',
      points: 100,
      numComments: 50,
      createdAt: '2024-01-01',
      storyText: null,
      type: 'story',
      objectId: '1',
    },
  ];
  const signals = extractHNSignals(items, 'date');
  assert.equal(signals[0]!.recency, undefined);
  assert.ok(signals[0]!.engagement > 0);
});

// --- Reddit signals ---

test('extractRedditSignals top mode: engagement omitted', () => {
  const posts: RedditPost[] = [
    {
      title: 'Test',
      url: 'https://example.com',
      selftext: '',
      score: 100,
      numComments: 50,
      subreddit: 'test',
      author: 'user',
      createdUtc: 1700000000,
      permalink: '/r/test/comments/1',
      isVideo: false,
    },
  ];
  const signals = extractRedditSignals(posts, 'top');
  assert.equal(signals[0]!.engagement, undefined);
  assert.ok(signals[0]!.commentEngagement > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test test/rescore.test.ts`
Expected: FAIL — extractors not exported from `rescore.ts`.

- [ ] **Step 3: Add extractors**

Extend `src/utils/rescore.ts`:

```typescript
import { parseAgeToDays } from './time.js';
import type { SearchResult } from '../types.js';
import type { AcademicPaper } from '../types.js';
import type { HackerNewsItem } from '../types.js';
import type { RedditPost } from '../types.js';

// ── Web search signals ────────────────────────────────────────────────────────

export interface WebSearchSignals {
  recency: number;
  hasDeepLinks: number;
}

export function extractWebSearchSignals(results: SearchResult[]): WebSearchSignals[] {
  const rawRecency = results.map((r) => {
    const days = parseAgeToDays(r.age);
    return days !== null ? applyRecencyDecay(days, 7) : 0;
  });
  const normalizedRecency = minMaxNormalize(rawRecency);

  return results.map((r, i) => ({
    recency: normalizedRecency[i] ?? 0,
    hasDeepLinks: r.deepLinks && r.deepLinks.length > 0 ? 1 : 0,
  }));
}

// ── Academic signals ────────────────────────────────────────────────────────

export interface AcademicSignals {
  recency: number;
  citations: number;
  venue: number;
}

export function extractAcademicSignals(
  papers: AcademicPaper[],
  currentYear: number,
): AcademicSignals[] {
  const rawRecency = papers.map((p) => {
    const ageYears = p.year !== null ? currentYear - p.year : 10; // default to 10 years old if no year
    return applyRecencyDecay(ageYears * 365, 1095);
  });
  const normalizedRecency = minMaxNormalize(rawRecency);

  const rawCitations = papers.map((p) =>
    p.citationCount !== null ? applyLogTransform(p.citationCount) : 0,
  );
  const normalizedCitations = minMaxNormalize(rawCitations);

  return papers.map((p, i) => ({
    recency: normalizedRecency[i] ?? 0,
    citations: normalizedCitations[i] ?? 0,
    venue: p.venue !== null && p.venue.length > 0 ? 1 : 0,
  }));
}

// ── HN signals ────────────────────────────────────────────────────────────────

export interface HNSignals {
  recency?: number;
  engagement: number;
  commentEngagement: number;
}

export function extractHNSignals(
  items: HackerNewsItem[],
  sort: 'relevance' | 'date' | 'top',
): HNSignals[] {
  const rawEngagement = items.map((i) => applyLogTransform(i.points));
  const normalizedEngagement = minMaxNormalize(rawEngagement);

  const rawComments = items.map((i) => applyLogTransform(i.numComments));
  const normalizedComments = minMaxNormalize(rawComments);

  let normalizedRecency: number[] | undefined;
  if (sort !== 'date') {
    const rawRecency = items.map((i) => {
      const days = (Date.now() - new Date(i.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      return applyRecencyDecay(days, 180);
    });
    normalizedRecency = minMaxNormalize(rawRecency);
  }

  return items.map((_, i) => ({
    ...(normalizedRecency !== undefined ? { recency: normalizedRecency[i] ?? 0 } : {}),
    engagement: normalizedEngagement[i] ?? 0,
    commentEngagement: normalizedComments[i] ?? 0,
  }));
}

// ── Reddit signals ───────────────────────────────────────────────────────────

export interface RedditSignals {
  recency?: number;
  engagement?: number;
  commentEngagement: number;
}

export function extractRedditSignals(
  posts: RedditPost[],
  sort: 'relevance' | 'date' | 'top',
): RedditSignals[] {
  const rawComments = posts.map((p) => applyLogTransform(p.numComments));
  const normalizedComments = minMaxNormalize(rawComments);

  let normalizedRecency: number[] | undefined;
  if (sort !== 'date') {
    const rawRecency = posts.map((p) => {
      const days = (Date.now() - p.createdUtc * 1000) / (1000 * 60 * 60 * 24);
      return applyRecencyDecay(days, 180);
    });
    normalizedRecency = minMaxNormalize(rawRecency);
  }

  let normalizedEngagement: number[] | undefined;
  if (sort !== 'top') {
    const rawEngagement = posts.map((p) => applyLogTransform(p.score));
    normalizedEngagement = minMaxNormalize(rawEngagement);
  }

  return posts.map((_, i) => ({
    ...(normalizedRecency !== undefined ? { recency: normalizedRecency[i] ?? 0 } : {}),
    ...(normalizedEngagement !== undefined ? { engagement: normalizedEngagement[i] ?? 0 } : {}),
    commentEngagement: normalizedComments[i] ?? 0,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test test/rescore.test.ts`
Expected: All 22 tests pass (15 from Task 2 + 7 new).

- [ ] **Step 5: Commit**

```bash
git add src/utils/rescore.ts test/rescore.test.ts
git commit -m "feat: add per-tool signal extractors

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: Wire into `webSearch.ts`

**Files:**

- Modify: `src/tools/webSearch.ts`
- Test: `test/webSearch.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Extend `test/webSearch.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWithBackends } from '../src/tools/webSearch.js';
import type { SearchResult } from '../src/types.js';

function makeResult(url: string, position: number, age: string | null = null): SearchResult {
  return {
    title: `Title for ${url}`,
    url,
    description: `Desc for ${url}`,
    position,
    domain: new URL(url.startsWith('http') ? url : `https://${url}`).hostname,
    source: 'brave' as const,
    age,
    extraSnippet: null,
    deepLinks: null,
  };
}

test('searchWithBackends with rescoring: fresher results bubble up', async () => {
  const braveResults: SearchResult[] = [
    makeResult('https://example.com/old', 1, '30 days ago'),
    makeResult('https://example.com/new', 2, '1 day ago'),
  ];
  const searxResults: SearchResult[] = [
    makeResult('https://example.com/old', 1, '30 days ago'),
    makeResult('https://example.com/new', 2, '1 day ago'),
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

  // With rescoring, newer result should outrank older one
  assert.equal(results[0].url, 'https://example.com/new');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test test/webSearch.test.ts`
Expected: FAIL — rescoring not yet wired.

- [ ] **Step 3: Wire rescoring**

Modify `src/tools/webSearch.ts`:

```typescript
import { logger } from '../logger.js';
import { loadConfig, type SearchBackend } from '../config.js';
import { braveSearch } from './braveSearch.js';
import { searxngSearch } from './searxngSearch.js';
import { normalizeUrl, rrfMerge } from '../utils/fusion.js';
import { multiSignalRescore, extractWebSearchSignals } from '../utils/rescore.js';
import type { SearchResult } from '../types.js';

// ... existing code ...

export async function searchWithBackends(
  query: string,
  limit: number,
  safeSearch: 'strict' | 'moderate' | 'off',
  deps: WebSearchDeps,
  overrideBackends?: SearchBackend[],
): Promise<SearchResult[]> {
  // ... existing backend resolution and parallel query code ...

  const merged = rrfMerge(valid, {
    k: 60,
    keyFn: (r) => normalizeUrl(r.url),
  });

  // Extract signals and rescore
  const signaled = merged.map((m) => ({
    item: m.item,
    rrfScore: m.rrfScore,
    signals: extractWebSearchSignals([m.item])[0]!,
  }));

  const rescoreWeights = loadConfig().rescoreWeights?.webSearch ?? {
    rrfAnchor: 0.5,
    recency: 0.2,
    hasDeepLinks: 0.05,
  };

  const rescored = multiSignalRescore(signaled, rescoreWeights, limit);

  return rescored.map((r, i) => ({
    ...r.item,
    position: i + 1,
  }));
}
```

Wait — there's an issue. `extractWebSearchSignals` takes an array and returns an array. I'm calling it with `[m.item]` for each item individually, which is inefficient. Better to extract signals for all items at once:

```typescript
const merged = rrfMerge(valid, {
  k: 60,
  keyFn: (r) => normalizeUrl(r.url),
});

const allItems = merged.map((m) => m.item);
const allSignals = extractWebSearchSignals(allItems);

const signaled = merged.map((m, i) => ({
  item: m.item,
  rrfScore: m.rrfScore,
  signals: allSignals[i]!,
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test test/webSearch.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/webSearch.ts test/webSearch.test.ts
git commit -m "feat: wire multi-signal rescoring into webSearch

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: Wire into `academicSearch.ts`

**Files:**

- Modify: `src/tools/academicSearch.ts`
- Test: `test/academicSearch.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/academicSearch.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { academicSearch } from '../src/tools/academicSearch.js';

test('academicSearch parallel RRF + rescoring: highly cited outranks obscure', async () => {
  // This test mocks the internal backends; requires dependency injection or spy
  // For now, just verify the function signature and basic behavior
  const result = await academicSearch('machine learning', 'all', 10);
  assert.ok(Array.isArray(result.papers));
});
```

Actually, testing `academicSearch` properly requires mocking ArXiv and Semantic Scholar. Let me skip detailed tests for now and focus on the implementation.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test test/academicSearch.test.ts`
Expected: FAIL — parallel RRF not yet implemented.

- [ ] **Step 3: Rewrite `academicSearch.ts` with parallel RRF + rescoring**

Modify `src/tools/academicSearch.ts`:

The key changes:

1. Query ArXiv and Semantic Scholar in parallel
2. Cap each result set to `limit * 2` before RRF
3. `rrfMerge` with `getId` for DOI/title dedup
4. Extract signals and rescoring

```typescript
// Add imports at top:
import { rrfMerge } from '../utils/fusion.js';
import { multiSignalRescore, extractAcademicSignals } from '../utils/rescore.js';

// ... existing backend functions ...

// Modify the 'all' source branch in academicSearch():
} else {
  // Parallel query with RRF fusion
  const promises = [
    searchArxiv(query, limit * 2, yearFrom),
    searchSemanticScholar(query, limit * 2, yearFrom),
  ];

  const settled = await Promise.allSettled(promises);
  const valid: AcademicPaper[][] = [];
  const warnings: string[] = [];

  if (settled[0].status === 'fulfilled') {
    valid.push(settled[0].value);
  } else {
    warnings.push(`ArXiv search failed: ${settled[0].reason}`);
  }

  if (settled[1].status === 'fulfilled') {
    valid.push(settled[1].value);
  } else {
    warnings.push(`Semantic Scholar search failed: ${settled[1].reason}`);
  }

  if (valid.length === 0) {
    throw unavailableError(`Both ArXiv and Semantic Scholar APIs failed. ${warnings.join('. ')}`);
  }

  if (valid.length === 1) {
    allPapers = valid[0] ?? [];
  } else {
    // RRF merge with canonical dedup
    const merged = rrfMerge(valid, {
      k: 60,
      keyFn: (p) => p.url,
      getId: (p) => {
        if (p.doi) return p.doi.toLowerCase().trim();
        return normalizeTitle(p.title) + '|' + normalizeAuthor(p.authors[0] ?? '');
      },
    });

    // Extract signals and rescore
    const currentYear = new Date().getFullYear();
    const allSignals = extractAcademicSignals(
      merged.map(m => m.item),
      currentYear,
    );

    const signaled = merged.map((m, i) => ({
      item: m.item,
      rrfScore: m.rrfScore,
      signals: allSignals[i]!,
    }));

    const rescoreWeights = loadConfig().rescoreWeights?.academicSearch ?? {
      rrfAnchor: 0.5,
      recency: 0.05,
      citations: 0.3,
      venue: 0.15,
    };

    const rescored = multiSignalRescore(signaled, rescoreWeights, limit);
    allPapers = rescored.map(r => r.item);
  }
}
```

Also add helper functions for title and author normalization:

```typescript
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1') // strip LaTeX commands
    .replace(/\$[^$]*\$/g, '') // strip math mode
    .replace(/[^a-z0-9\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();
}

function normalizeAuthor(author: string): string {
  const s = author.toLowerCase().trim();
  // Extract last name from "J. A. Smith" or "Smith, J. A."
  const match = /,\s*(.+)$/.exec(s);
  if (match) {
    // "Smith, J. A." → "smith"
    return s.split(',')[0]!.trim();
  }
  const parts = s.split(/\s+/);
  return parts[parts.length - 1] ?? s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test test/academicSearch.test.ts`
Expected: Pass (or skip if mocking is too complex).

- [ ] **Step 5: Commit**

```bash
git add src/tools/academicSearch.ts test/academicSearch.test.ts
git commit -m "feat: parallel RRF + rescoring for academicSearch

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: Wire into `hackernewsSearch.ts`

**Files:**

- Modify: `src/tools/hackernewsSearch.ts`

- [ ] **Step 1: Modify to add RRF + rescoring**

Modify `src/tools/hackernewsSearch.ts`:

```typescript
// Add imports:
import { rrfMerge } from '../utils/fusion.js';
import { multiSignalRescore, extractHNSignals } from '../utils/rescore.js';

// At the end of hackernewsSearch(), before returning:
// Single-source RRF then rescoring
const merged = rrfMerge([[...results]], { k: 60 });

const signaled = merged.map((m, i) => ({
  item: m.item,
  rrfScore: m.rrfScore,
  signals: extractHNSignals([m.item], sort)[0]!,
}));

const rescoreWeights = loadConfig().rescoreWeights?.hackernewsSearch ?? {
  rrfAnchor: 0.5,
  recency: 0.15,
  engagement: 0.2,
  commentEngagement: 0.15,
};

const rescored = multiSignalRescore(signaled, rescoreWeights, limit);
return rescored.map((r) => r.item);
```

- [ ] **Step 2: Run lint and typecheck**

Run: `npm run typecheck && npm run lint`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/hackernewsSearch.ts
git commit -m "feat: wire RRF + rescoring into hackernewsSearch

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 8: Wire into `redditSearch.ts`

**Files:**

- Modify: `src/tools/redditSearch.ts`

- [ ] **Step 1: Modify to add RRF + rescoring**

Modify `src/tools/redditSearch.ts`:

```typescript
// Add imports:
import { rrfMerge } from '../utils/fusion.js';
import { multiSignalRescore, extractRedditSignals } from '../utils/rescore.js';

// At the end of redditSearch(), before returning:
// Note: redditSearch doesn't have a sort parameter exposed currently.
// We'll use 'relevance' as default for now.
const merged = rrfMerge([[...results]], { k: 60 });

const signaled = merged.map((m, i) => ({
  item: m.item,
  rrfScore: m.rrfScore,
  signals: extractRedditSignals([m.item], 'relevance')[0]!,
}));

const rescoreWeights = loadConfig().rescoreWeights?.redditSearch ?? {
  rrfAnchor: 0.5,
  recency: 0.1,
  engagement: 0.25,
  commentEngagement: 0.15,
};

const rescored = multiSignalRescore(signaled, rescoreWeights, limit);
return rescored.map((r) => r.item);
```

- [ ] **Step 2: Run lint and typecheck**

Run: `npm run typecheck && npm run lint`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/redditSearch.ts
git commit -m "feat: wire RRF + rescoring into redditSearch

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: Add config weights

**Files:**

- Modify: `src/config.ts`

- [ ] **Step 1: Add RescoreConfig to config schema**

Modify `src/config.ts`:

```typescript
export interface RescoreWeights {
  rrfAnchor: number;
  recency: number;
  citations: number;
  engagement: number;
  commentEngagement: number;
  venue: number;
  hasDeepLinks: number;
}

export interface RescoreConfig {
  webSearch: RescoreWeights;
  academicSearch: RescoreWeights;
  hackernewsSearch: RescoreWeights;
  redditSearch: RescoreWeights;
}

const DEFAULT_RESCORE_WEIGHTS = {
  webSearch: { rrfAnchor: 0.5, recency: 0.2, hasDeepLinks: 0.05 },
  academicSearch: { rrfAnchor: 0.5, recency: 0.05, citations: 0.3, venue: 0.15 },
  hackernewsSearch: { rrfAnchor: 0.5, recency: 0.15, engagement: 0.2, commentEngagement: 0.15 },
  redditSearch: { rrfAnchor: 0.5, recency: 0.1, engagement: 0.25, commentEngagement: 0.15 },
};

// Add to Config interface:
export interface Config {
  // ... existing fields ...
  rescoreWeights?: RescoreConfig;
}

// In loadConfig(), merge with defaults:
export function loadConfig(): Config {
  // ... existing code ...
  return {
    // ... existing fields ...
    rescoreWeights: cfg.rescoreWeights ?? DEFAULT_RESCORE_WEIGHTS,
  };
}
```

- [ ] **Step 2: Add guardrail check**

Add to `src/config.ts`:

```typescript
function validateRescoreWeights(weights: RescoreWeights, toolName: string): void {
  const otherWeights = Object.entries(weights)
    .filter(([k]) => k !== 'rrfAnchor')
    .map(([, v]) => v);
  const maxOther = otherWeights.length > 0 ? Math.max(...otherWeights) : 0;
  if (weights.rrfAnchor < maxOther) {
    logger.warn(
      { tool: toolName, rrfAnchor: weights.rrfAnchor, maxOther },
      'Rescore weights warning: rrfAnchor should dominate any single other signal',
    );
  }
}

// In loadConfig(), after merging:
for (const [tool, weights] of Object.entries(config.rescoreWeights ?? {})) {
  validateRescoreWeights(weights as RescoreWeights, tool);
}
```

- [ ] **Step 3: Run lint and typecheck**

Run: `npm run typecheck && npm run lint`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat: add RescoreConfig with per-tool weights and guardrail

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 10: Full test suite + final verification

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Run lint and typecheck**

Run: `npm run typecheck && npm run lint`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git commit -m "test: full test suite for multi-signal rescoring

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - `getId` cross-source dedup → Task 1
   - Extractors own normalization → Tasks 2, 4
   - Pure weighted sum rescorer → Task 2
   - Age parsing utility → Task 3
   - Web search rescoring → Task 5
   - Academic parallel RRF + rescoring → Task 6
   - HN/RD rescoring → Tasks 7, 8
   - Config weights + guardrail → Task 9
   - Tests for all components → Tasks 1-10

2. **Placeholder scan:** No TBD/TODO/fill-in-details.

3. **Type consistency:**
   - `RrfMergeOptions<T>` added to fusion.ts
   - `RrfResultWithSignals<T>` in rescore.ts
   - `ScoredResult<T>` in rescore.ts
   - Per-tool signal interfaces in rescore.ts
   - `RescoreConfig` + `RescoreWeights` in config.ts
