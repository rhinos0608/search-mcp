/**
 * Intent-driven output filter for search results.
 *
 * When result byte size exceeds a threshold and an intent is provided,
 * BM25-style term scoring is used to retain only intent-matched items.
 * Designed for MCP tools where large responses waste context window.
 */

// ── Common English stopwords (salient terms filter) ─────────────────────────

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'had',
  'her',
  'was',
  'one',
  'our',
  'out',
  'has',
  'have',
  'been',
  'some',
  'them',
  'than',
  'that',
  'this',
  'with',
  'will',
  'what',
  'when',
  'where',
  'which',
  'who',
  'how',
  'its',
  'may',
  'also',
  'more',
  'very',
  'just',
  'only',
  'over',
  'such',
  'each',
  'about',
  'into',
  'could',
  'other',
  'their',
  'there',
  'these',
  'those',
  'should',
  'would',
  'after',
  'being',
  'does',
  'down',
  'own',
  'too',
  'any',
  'here',
  'from',
  'come',
  'like',
  'than',
  'then',
  'than',
  'make',
  'more',
  'most',
  'much',
  'same',
  'some',
  'such',
  'than',
  'them',
  'then',
  'they',
  'this',
  'very',
  'well',
  'were',
  'your',
  'done',
  'even',
  'many',
  'said',
  'made',
  'know',
  'need',
  'part',
  'used',
  'using',
  'work',
  'year',
  'back',
  'good',
  'new',
  'now',
  'old',
  'way',
  'get',
  'got',
  'see',
  'first',
  'last',
  'long',
  'must',
  'still',
  'take',
  'think',
  'use',
  'want',
  'thing',
  'things',
]);

// ── Types ───────────────────────────────────────────────────────────────────

export interface IntentFilterResult<T> {
  /** Whether filtering was actually applied (true = threshold exceeded). */
  filtered: boolean;
  /** Filtered results (subset when filtered, full set when not). */
  results: T[];
  /** Total items before filtering. */
  totalResults: number;
  /** Number of items removed by filtering (0 when not filtered). */
  filteredCount: number;
  /** Salient terms extracted from filtered results, useful for follow-up searches. */
  searchableTerms: string[];
  /** Total byte size of results before filtering. */
  bytesBefore: number;
  /** Total byte size after filtering. */
  bytesAfter: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Split text into terms (lowercase, non-empty, >2 chars).
 */
function extractTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+(?:[-'][a-z0-9]+)*/g);
  if (!words) return [];
  return words.filter((w) => w.length > 2);
}

/**
 * Serialize items to JSON and return byte length.
 */
function measureBytes(items: unknown[]): number {
  const json = JSON.stringify(items);
  return new TextEncoder().encode(json).length;
}

/**
 * Extract searchable text from an item for intent matching.
 */
function getSearchableText(item: Record<string, unknown>): string {
  const text = item.text ?? item.title ?? item.snippet ?? '';
  if (typeof text === 'string') return text;
  return '';
}

/**
 * Generate salient (non-stopword) terms from item texts.
 * Returns up to 20 terms, sorted by frequency (most common first).
 */
function extractSearchableTerms(items: Record<string, unknown>[], maxTerms = 20): string[] {
  const freq = new Map<string, number>();

  for (const item of items) {
    const searchText = getSearchableText(item);
    const terms = extractTerms(searchText);
    for (const term of terms) {
      if (STOP_WORDS.has(term)) continue;
      // Skip short numeric-only terms
      if (/^\d+$/.test(term)) continue;
      freq.set(term, (freq.get(term) ?? 0) + 1);
    }
  }

  // Sort by frequency descending, then alphabetically
  const sorted = Array.from(freq.entries())
    .sort((a, b) => {
      const freqCmp = b[1] - a[1];
      if (freqCmp !== 0) return freqCmp;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, maxTerms);

  return sorted.map(([term]) => term);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Apply intent-driven filtering to search results.
 *
 * When the serialized result size exceeds `thresholdBytes`, items are scored
 * by how many intent terms appear in their searchable text (case-insensitive).
 * Only items matching at least 1 intent term are retained.
 *
 * When under threshold or intent is empty, returns results unchanged with
 * `filtered: false`.
 *
 * @param items - Result items to filter
 * @param intent - Natural language intent description
 * @param thresholdBytes - Byte threshold to trigger filtering (default 5000)
 * @returns Filtered results with metadata
 */
export function applyIntentFilter<T extends { text?: string; title?: string; snippet?: string }>(
  items: T[],
  intent: string,
  thresholdBytes?: number,
): IntentFilterResult<T>;

export function applyIntentFilter<T>(
  items: T[],
  intent: string,
  thresholdBytes?: number,
  getText?: (item: T) => string,
): IntentFilterResult<T>;

export function applyIntentFilter<T>(
  items: T[],
  intent: string,
  thresholdBytes = 5000,
  getText?: (item: T) => string,
): IntentFilterResult<T> {
  const totalResults = items.length;

  // Empty input guard
  if (items.length === 0) {
    return {
      filtered: false,
      results: [],
      totalResults: 0,
      filteredCount: 0,
      searchableTerms: [],
      bytesBefore: 0,
      bytesAfter: 0,
    };
  }

  // Empty intent guard — no filtering
  if (!intent || intent.trim().length === 0) {
    const bytesBefore = measureBytes(items);
    return {
      filtered: false,
      results: items,
      totalResults,
      filteredCount: 0,
      searchableTerms: [],
      bytesBefore,
      bytesAfter: bytesBefore,
    };
  }

  const bytesBefore = measureBytes(items);

  // Under threshold — no filtering needed
  if (bytesBefore <= thresholdBytes) {
    return {
      filtered: false,
      results: items,
      totalResults,
      filteredCount: 0,
      searchableTerms: [],
      bytesBefore,
      bytesAfter: bytesBefore,
    };
  }

  // ── Threshold exceeded — apply intent filtering ───────────────────────

  // Extract intent terms (words > 2 chars)
  const intentTerms = extractTerms(intent);
  if (intentTerms.length === 0) {
    return {
      filtered: false,
      results: items,
      totalResults,
      filteredCount: 0,
      searchableTerms: [],
      bytesBefore,
      bytesAfter: bytesBefore,
    };
  }

  // Score each item: count how many intent terms appear in its text
  interface Scored {
    item: T;
    score: number;
    matchedTerms: Set<string>;
  }

  const scored: Scored[] = items.map((item) => {
    let searchText: string;
    if (getText) {
      searchText = getText(item);
    } else {
      searchText = getSearchableText(item as unknown as Record<string, unknown>);
    }

    const lowerText = searchText.toLowerCase();
    const matchedTerms = new Set<string>();

    for (const term of intentTerms) {
      if (lowerText.includes(term)) {
        matchedTerms.add(term);
      }
    }

    return { item, score: matchedTerms.size, matchedTerms };
  });

  // Keep items matching at least 1 intent term, sorted by match count descending
  const matching = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item);

  const bytesAfter = measureBytes(matching);

  // Generate searchable terms from filtered items
  const searchableTerms = extractSearchableTerms(matching as unknown as Record<string, unknown>[]);

  return {
    filtered: true,
    results: matching,
    totalResults,
    filteredCount: totalResults - matching.length,
    searchableTerms,
    bytesBefore,
    bytesAfter,
  };
}
