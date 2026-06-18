# Spec: Low-Signal Token Detection

## Source Pattern

From `last30days/scripts/lib/relevance.py`: `LOW_SIGNAL_QUERY_TOKENS` frozenset that caps generic query words below the normal relevance filter threshold.

## Goal

Add low-signal token detection to `queryExpansion.ts` so that generic words like "best", "review", "tutorial" don't inflate relevance scores. Pairs with the PreparedQuery spec (#5).

## Target File

`src/tools/queryExpansion.ts`

## Design

### New Export

```typescript
/** Returns true if the query consists entirely of low-signal tokens */
export function isLowSignalQuery(query: string): boolean;
```

### Implementation

```typescript
const LOW_SIGNAL_TOKENS = new Set([
  'advice',
  'animation',
  'animations',
  'best',
  'chance',
  'chances',
  'code',
  'compare',
  'comparison',
  'differences',
  'explain',
  'guide',
  'guides',
  'how',
  'latest',
  'news',
  'odds',
  'opinion',
  'opinions',
  'prediction',
  'predictions',
  'probability',
  'probabilities',
  'prompt',
  'prompting',
  'prompts',
  'rate',
  'review',
  'reviews',
  'thoughts',
  'tip',
  'tips',
  'tricks',
  'tutorial',
  'tutorials',
  'update',
  'updates',
  'use',
  'using',
  'versus',
  'vs',
  'worth',
]);

export function isLowSignalQuery(query: string): boolean {
  const words = query
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (words.length === 0) return false;
  return words.every((w) => LOW_SIGNAL_TOKENS.has(w));
}
```

### Integration

Export from `queryExpansion.ts`. Use in `web_search` tool handler to warn callers:

```typescript
if (isLowSignalQuery(query)) {
  // Add warning to tool result metadata
  warnings.push('Query contains only generic terms. Add specific nouns for better results.');
}
```

## Verification

1. `isLowSignalQuery('best')` → true
2. `isLowSignalQuery('best headphones 2026')` → false ("headphones" and "2026" are not low-signal)
3. `isLowSignalQuery('how to use Docker')` → false ("docker" is not low-signal)
4. `isLowSignalQuery('tips tricks advice')` → true
5. `isLowSignalQuery('')` → false
