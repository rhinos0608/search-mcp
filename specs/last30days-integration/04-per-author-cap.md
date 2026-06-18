# Spec: Per-Author Cap for Search Results

## Source Pattern

From `last30days/scripts/lib/fusion.py`: `_apply_per_author_cap()` keeps at most 3 items per author to prevent single-voice domination.

## Goal

Add a per-author cap utility that can be applied to search results before ranking. Prevents any single source/author/handle from dominating the result set.

## Target File

`src/rag/dedup.ts` (add as utility alongside existing dedup functions)

## Design

### New Export

```typescript
export function capPerAuthor<T extends { author?: string }>(
  items: T[],
  maxPerAuthor?: number, // default 3
): T[];
```

### Logic

Port directly from `fusion.py`:

```typescript
const DEFAULT_MAX_PER_AUTHOR = 3;

export function capPerAuthor<T extends { author?: string }>(
  items: T[],
  maxPerAuthor: number = DEFAULT_MAX_PER_AUTHOR,
): T[] {
  const authorCounts = new Map<string, number>();
  const result: T[] = [];

  for (const item of items) {
    const author = item.author?.trim().toLowerCase();
    if (author === undefined) {
      result.push(item);
      continue;
    }
    const count = authorCounts.get(author) ?? 0;
    if (count < maxPerAuthor) {
      result.push(item);
      authorCounts.set(author, count + 1);
    }
  }

  return result;
}
```

### Integration with deduplicateCorpus

Add as optional post-processing step:

```typescript
// After semantic dedup, before rebuilding decisions:
if (config.maxPerAuthor !== undefined) {
  currentItems = capPerAuthor(currentItems, config.maxPerAuthor);
}
```

### Config Extension

Add to `DedupeConfig` in `src/rag/types.ts`:

```typescript
maxPerAuthor?: number;  // default undefined (disabled); set to 3 to enable
```

## Verification

1. 5 items from author "elonmusk" → only first 3 kept
2. 2 items from author "elonmusk" + 3 from author "sama" → all 5 kept
3. Items with no author → always kept
4. Empty array → empty array
