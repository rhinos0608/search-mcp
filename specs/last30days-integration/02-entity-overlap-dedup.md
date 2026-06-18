# Spec: Entity Overlap Merge for dedup.ts

## Source Pattern

From `last30days/scripts/lib/cluster.py`: Second-pass merge that catches cross-source duplicates with different URLs but shared entities. Uses overlap coefficient (intersection / min set size).

## Goal

Add a 4th dedup layer to `deduplicateCorpus()` that merges items sharing high entity overlap across different URLs. Catches cases like "Reddit thread about Kanye West" + "X post about Kanye West" with different URLs but same underlying story.

## Target File

`src/rag/dedup.ts`

## Design

### New Export

```typescript
export function dedupeByEntityOverlap<T extends { id: string; text: string; url: string }>(
  items: T[],
  threshold?: number, // default 0.45
): DedupeResult<T>;
```

### Entity Extraction

Port `_extract_entities()` from `cluster.py`:

```typescript
const ENTITY_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'for',
  'how',
  'is',
  'in',
  'of',
  'on',
  'and',
  'with',
  'from',
  'by',
  'at',
  'this',
  'that',
  'it',
  'what',
  'are',
  'do',
  'can',
  'his',
  'her',
  'he',
  'she',
  'its',
  'was',
  'has',
  'new',
  'just',
  'says',
  'said',
  'will',
  'about',
  'after',
  'now',
  'all',
  'been',
  'here',
  'not',
  'out',
  'up',
  'more',
  'also',
  'but',
  'who',
  'year',
  'first',
  'make',
  'being',
  'making',
  'over',
  'into',
  'than',
  'they',
  'their',
  'would',
  'could',
  'get',
  'got',
  'some',
  'like',
  'back',
  'going',
]);

function extractEntities(text: string): Set<string> {
  const words = text.replace(/[^\w\s]/g, ' ').split(/\s+/);
  const entities = new Set<string>();
  for (const word of words) {
    const lower = word.toLowerCase();
    if (ENTITY_STOPWORDS.has(lower) || word.length <= 2) continue;
    if (
      word[0]?.toUpperCase() === word[0] ||
      word === word.toUpperCase() ||
      /\d/.test(word) ||
      word.length >= 4
    ) {
      entities.add(lower);
    }
  }
  return entities;
}
```

### Overlap Coefficient (not Jaccard)

From `cluster.py`: Use overlap coefficient instead of Jaccard because a short tweet about the same event has fewer total entities but high overlap with a longer post:

```typescript
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const smaller = Math.min(a.size, b.size);
  return smaller > 0 ? intersection.size / smaller : 0;
}
```

### Merge Logic

1. Extract entities from each item's `text` field
2. For each item pair where URLs differ and overlap >= threshold (0.45):
   - Mark the shorter-text item as duplicate of the longer-text item
3. Only merge items with different URLs (same-URL dedup is handled by Layer 1)
4. Cap merge iterations: O(n²) on entity sets, but entity sets are small

### Integration with deduplicateCorpus

Add as Layer 4 after semantic dedup:

```typescript
// Layer 4: Entity overlap (cross-source)
if (config.layers.entityOverlap) {
  const entityResult = dedupeByEntityOverlap(currentItems);
  allLayers.push(...entityResult.layers);
  // ... same merge pattern as other layers
}
```

### Config Extension

Add to `DedupeConfig` in `src/rag/types.ts`:

```typescript
layers: {
  url: boolean;
  fingerprint: boolean;
  semantic: boolean;
  entityOverlap: boolean; // NEW
}
```

## Verification

1. Two items about "Kanye West Wireless Festival" with different URLs, one from Reddit and one from X, should be merged
2. Two items about different topics mentioning "Kanye West" should NOT be merged (insufficient entity overlap)
3. Items with the same URL should NOT reach this layer (handled by Layer 1)
