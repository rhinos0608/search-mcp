import type { UncertaintyTag } from './types.js';

interface ScoredItem {
  score?: number;
  source?: string;
  sources?: string[];
}

/**
 * Annotate items with uncertainty tags based on source diversity and score.
 *
 * - `'single-source'` — item's sources are a subset of the broader source set
 *   (i.e. evidence from only 1 source when multiple sources exist globally)
 * - `'thin-evidence'` — item score < 55 (on 0-100 scale)
 * - `null` — no notable uncertainty
 *
 * Items that come from the *only* source across all items do NOT get
 * `single-source` — if the whole result set comes from Reddit alone,
 * nothing is single-source; it's the only available view.
 *
 * @param items - Result items to annotate
 * @param getScore - Extractor for numeric score from each item
 * @returns Items with `uncertainty` field appended
 */
const THIN_EVIDENCE_THRESHOLD = 55;

export function annotateUncertainty<T extends ScoredItem>(
  items: T[],
  getScore: (item: T) => number,
): (T & { uncertainty: UncertaintyTag })[] {
  if (items.length === 0) return [];

  // Determine which sources are represented across all items
  const sourcesPresent = new Set(
    items.flatMap((item) => item.sources ?? (item.source ? [item.source] : [])),
  );

  return items.map((item) => {
    const itemSources = item.sources ?? (item.source ? [item.source] : []);
    const isSingleSource = itemSources.length === 1 && sourcesPresent.size > 1;
    const score = getScore(item);
    const isThinEvidence = score < THIN_EVIDENCE_THRESHOLD;

    let uncertainty: UncertaintyTag = null;
    if (isSingleSource) uncertainty = 'single-source';
    else if (isThinEvidence) uncertainty = 'thin-evidence';

    return { ...item, uncertainty };
  });
}
