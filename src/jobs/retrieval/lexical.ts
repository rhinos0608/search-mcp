/**
 * Stable monotonic lexical transform v1.
 *
 * Tokenizes and lowercases text. Monotonic: higher raw term frequency → higher
 * transformed score. Independent of result-set percentiles (no TF-IDF normalization
 * within the scored set; IDF computed from a fixed reference corpus or left to BM25).
 *
 * Versioned: LEXICAL_TRANSFORM_VERSION stamps the algorithm. Any behavioral change
 * increments the version, ensuring reproducibility across runs.
 */

import { LEXICAL_TRANSFORM_VERSION } from './contracts.js';

export { LEXICAL_TRANSFORM_VERSION };

/**
 * Stable tokenization: lowercase, split on non-alphanumeric, drop empty.
 * Order-preserving, deterministic, no stemming (version v1).
 */
export function lexicalTokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Merge two sorted token arrays into a single deduplicated sorted array.
 * Used to combine field tokens while preserving stability.
 */
export function mergeTokenLists(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const list of lists) {
    for (const t of list) {
      if (!seen.has(t)) {
        seen.add(t);
        result.push(t);
      }
    }
  }
  return result.sort();
}
