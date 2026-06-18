# Spec: Uncertainty Tags for Search Results

## Source Pattern

From `last30days/scripts/lib/cluster.py`: `Cluster.uncertainty` field with typed literal values `"single-source"` | `"thin-evidence"` | `null`.

## Goal

Add uncertainty annotations to search/crawl results so callers can surface confidence information. Matches the typed union pattern already used by `SemanticCrawlWarning`.

## Target Files

- `src/rag/types.ts` — add `UncertaintyTag` type
- `src/tools/response.ts` — add uncertainty to `ToolResult` metadata

## Design

### New Type

```typescript
// In src/rag/types.ts
export type UncertaintyTag = 'single-source' | 'thin-evidence' | null;

export interface UncertaintyAnnotated {
  uncertainty: UncertaintyTag;
}
```

### Annotation Function

```typescript
// New file: src/rag/uncertainty.ts
import type { UncertaintyTag } from './types.js';

interface ScoredItem {
  score?: number;
  source?: string;
  sources?: string[];
}

export function annotateUncertainty<T extends ScoredItem>(
  items: T[],
  getScore: (item: T) => number,
): Array<T & { uncertainty: UncertaintyTag }> {
  // Determine which sources are represented
  const sourcesPresent = new Set(
    items.flatMap((item) => item.sources ?? (item.source ? [item.source] : [])),
  );

  return items.map((item) => {
    const itemSources = item.sources ?? (item.source ? [item.source] : []);
    const isSingleSource = itemSources.length === 1 && sourcesPresent.size > 1;
    const score = getScore(item);
    const isThinEvidence = score < 55;

    let uncertainty: UncertaintyTag = null;
    if (isSingleSource) uncertainty = 'single-source';
    else if (isThinEvidence) uncertainty = 'thin-evidence';

    return { ...item, uncertainty };
  });
}
```

### Integration Points

- Export from `src/rag/index.ts`
- Document in AGENTS.md under RAG Modules
- No forced integration into existing pipelines — opt-in by callers who want confidence metadata

## Verification

1. Single item from Reddit only, when X and YouTube also returned items → `single-source`
2. All items from Reddit only → `null` (not single-source when sole provider)
3. Item with score 40 → `thin-evidence`
4. Item with score 70 from 3 sources → `null`
