# Spec: PreparedQuery Tokenization Cache

## Source Pattern

From `last30days/scripts/lib/relevance.py`: `PreparedQuery` class precomputes query tokenization once, reused across all items in a stream. Avoids re-tokenizing the same query N times.

## Goal

Add a `PreparedQuery` class to `queryExpansion.ts` that caches tokenized query form for reuse in relevance scoring. Currently `expandQuery()` generates variations but doesn't provide a reusable tokenized form.

## Target File

`src/tools/queryExpansion.ts`

## Design

### New Export

```typescript
export class PreparedQuery {
  readonly raw: string;
  readonly tokens: Set<string>;
  readonly informativeTokens: Set<string>;
  readonly normalizedPhrase: string;

  constructor(query: string);

  /** Token overlap score between this query and target text (0-1) */
  relevanceScore(text: string): number;
}
```

### Tokenization

Reuse the existing stopword + synonym expansion logic from the CONCEPT_MAP in queryExpansion.ts, but formalize it:

```typescript
const RELEVANCE_STOPWORDS = new Set([
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
  'my',
  'your',
  'i',
  'me',
  'we',
  'you',
  'what',
  'are',
  'do',
  'can',
  'its',
  'be',
  'or',
  'not',
  'no',
  'so',
  'if',
  'but',
  'about',
  'all',
  'just',
  'get',
  'has',
  'have',
  'was',
  'will',
]);

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
```

### relevanceScore Method

Port from `relevance.py`'s `token_overlap_relevance()`:

```typescript
relevanceScore(text: string): number {
  const textTokens = PreparedQuery.tokenize(text);
  if (this.tokens.size === 0) return 0.5;

  const overlap = new Set([...this.tokens].filter(t => textTokens.has(t)));
  if (overlap.size === 0) return 0;

  const coverage = overlap.size / this.tokens.size;
  const informativeOverlap = this.informativeTokens.size > 0
    ? new Set([...this.informativeTokens].filter(t => textTokens.has(t))).size / this.informativeTokens.size
    : 0;
  const precisionDenom = Math.min(textTokens.size, this.tokens.size + 4) || 1;
  const precision = overlap.size / precisionDenom;

  const base = 0.55 * Math.pow(coverage, 1.35) + 0.25 * informativeOverlap + 0.20 * precision;

  // Cap if only low-signal tokens matched
  if (this.informativeTokens.size > 0 && new Set([...this.informativeTokens].filter(t => textTokens.has(t))).size === 0) {
    return Math.min(0.24, base);
  }

  return Math.min(1.0, base);
}
```

## Verification

1. `new PreparedQuery('kanye west bully review').relevanceScore('Kanye West BULLY album review')` → high score
2. `new PreparedQuery('kanye west bully review').relevanceScore('random unrelated text')` → 0
3. Tokenization is computed once per PreparedQuery, not per relevanceScore call
