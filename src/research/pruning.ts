/**
 * In-Flight Pruning Engine — V5.3.0 Phase A.
 *
 * Operates on ResearchStateEngine during the research loop to prevent
 * unbounded state growth. Provides:
 *   - Finding tiering by source-count confidence
 *   - Stale pending-source eviction
 *   - State-size guard with staged eviction
 */

import { logger } from '../logger.js';
import type { ResearchStateEngine, BudgetTracker } from './state.js';
import type { Finding, SourceEntry, GapRecord, ResearchState } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Jaccard similarity over word sets — local copy (unexported in state.ts). */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
  const setB = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Heuristic confidence score for a finding based on evidence directness,
 * source count, and the presence of caveats.
 */
function findingConfidence(f: Finding): number {
  let score = 0;

  // evidenceDirectness: 'direct' > 'near-direct'
  if (f.evidenceDirectness === 'direct') score += 3;
  else if (f.evidenceDirectness === 'near-direct') score += 1;

  // source count (logarithmic cap)
  score += Math.min(f.sourceIds.length, 5);

  // caveats reduce confidence
  if (f.caveats && f.caveats.length > 0) score -= 1;

  return score;
}

/**
 * Compute a composite rank score for a source.
 * Uses qualityScore, relevanceScore, freshnessScore when available,
 * falling back to 0 for each missing dimension.
 */
function sourceRank(s: SourceEntry): number {
  return (s.qualityScore ?? 0) + (s.relevanceScore ?? 0) + (s.freshnessScore ?? 0);
}

// ── PruningEngine ────────────────────────────────────────────────────────────

export class PruningEngine {
  // ── Finding tiering (A2) ──────────────────────────────────────────────────

  /**
   * Split findings into three confidence tiers by number of supporting sources.
   *
   * - `confirmed`: ≥3 sources
   * - `corroborated`: exactly 2 sources
   * - `unverified`: 0–1 sources
   */
  tierFindings(findings: Finding[]): {
    confirmed: Finding[];
    corroborated: Finding[];
    unverified: Finding[];
  } {
    const confirmed: Finding[] = [];
    const corroborated: Finding[] = [];
    const unverified: Finding[] = [];

    for (const f of findings) {
      const count = f.sourceIds.length;
      if (count >= 3) {
        confirmed.push(f);
      } else if (count === 2) {
        corroborated.push(f);
      } else {
        unverified.push(f);
      }
    }

    return { confirmed, corroborated, unverified };
  }

  // ── Source eviction (A1) ──────────────────────────────────────────────────

  /**
   * Evict stale pending sources and cap total sources at 2× the budget's
   * `maxSources`.
   *
   * Stale sources are those that:
   *   - Are still in `pending` extraction status
   *   - Have no findings referencing them
   *   - Have survived >3 gap loops without being extracted
   *
   * When total sources exceed 2× maxSources, the lowest-ranked sources
   * are evicted (by composite rank score, then by age).
   *
   * @returns The number of sources evicted.
   */
  evictSources(state: ResearchStateEngine, tracker: BudgetTracker): number {
    const snapshot = state.getState();
    const sources = snapshot.sources;
    if (sources.length === 0) return 0;

    // Build set of source IDs referenced by any finding
    const findingSourceIds = new Set<string>();
    for (const f of snapshot.findings) {
      for (const sid of f.sourceIds) {
        findingSourceIds.add(sid);
      }
    }

    const toRemove = new Set<string>();

    // Step 1: Remove stale pending sources with no findings that are still pending.
    // We use elapsed time as a proxy for staleness — sources older than 2 minutes
    // with no findings and still pending are evicted.
    const STALE_SOURCE_AGE_MS = 120_000; // 2 minutes
    const now = Date.now();
    for (const s of sources) {
      if (
        s.extractionStatus === 'pending' &&
        !findingSourceIds.has(s.id) &&
        new Date(s.accessDate).getTime() < now - STALE_SOURCE_AGE_MS
      ) {
        toRemove.add(s.id);
      }
    }
    if (toRemove.size > 0) {
      logger.info(
        { evicted: toRemove.size, reason: 'stale_pending' },
        'Pruning: evicted stale pending sources',
      );
    }

    // Step 2: Cap at 2× maxSources by rank
    const maxSources = tracker.profile.maxSources * 2;
    const remaining = sources.filter((s) => !toRemove.has(s.id));
    if (remaining.length > maxSources) {
      // Sort ascending by rank score, then by age (oldest first)
      remaining.sort((a, b) => {
        const scoreA = sourceRank(a);
        const scoreB = sourceRank(b);
        if (scoreA !== scoreB) return scoreA - scoreB;
        // Tie-break by accessDate (oldest first = lower accessDate)
        return new Date(a.accessDate).getTime() - new Date(b.accessDate).getTime();
      });

      const toEvict = remaining.slice(0, remaining.length - maxSources);
      for (const s of toEvict) {
        toRemove.add(s.id);
      }

      logger.info(
        { evicted: toEvict.length, reason: 'cap', cap: maxSources, totalBefore: sources.length },
        'Pruning: capped sources to 2× maxSources',
      );
    }

    // Apply removal
    if (toRemove.size > 0) {
      const prunedSources = sources.filter((s) => !toRemove.has(s.id));
      const newState: ResearchState = { ...snapshot, sources: prunedSources };
      state.fromJSON(newState);
    }

    return toRemove.size;
  }

  // ── State size guard (A3) ─────────────────────────────────────────────────

  /**
   * Enforce a maximum total entry count (sources + findings + gaps) based on
   * `tracker.profile.maxStateEntries`.
   *
   * Staged eviction (in order):
   *   1. Remove sources that have zero findings referencing them
   *   2. Deduplicate near-identical findings (Jaccard > 0.85), then drop
   *      lowest-confidence unverified findings
   *   3. Evict oldest gap records
   *
   * @returns The total number of entries evicted.
   */
  enforceStateGuard(state: ResearchStateEngine, tracker: BudgetTracker): number {
    const snapshot = state.getState();
    let sources = snapshot.sources;
    let findings = snapshot.findings;
    let gaps = snapshot.gaps;

    const maxEntries = tracker.profile.maxStateEntries;
    let totalEntries = sources.length + findings.length + gaps.length;

    if (totalEntries <= maxEntries) return 0;

    let totalEvicted = 0;
    let entriesToRemove = totalEntries - maxEntries;

    // ── Stage A: Sources with zero findings ──
    const findingSourceIds = new Set<string>();
    for (const f of findings) {
      for (const sid of f.sourceIds) {
        findingSourceIds.add(sid);
      }
    }

    const sourcesWithFindings: SourceEntry[] = [];
    const sourcesWithoutFindings: SourceEntry[] = [];
    for (const s of sources) {
      if (findingSourceIds.has(s.id)) {
        sourcesWithFindings.push(s);
      } else {
        sourcesWithoutFindings.push(s);
      }
    }

    if (sourcesWithoutFindings.length > 0) {
      // Sort zero-finding sources by rank (ascending) so lowest-ranked are removed first
      sourcesWithoutFindings.sort((a, b) => sourceRank(a) - sourceRank(b));
      const toRemove = Math.min(sourcesWithoutFindings.length, entriesToRemove);
      sources = [...sourcesWithFindings, ...sourcesWithoutFindings.slice(toRemove)];

      totalEvicted += toRemove;
      entriesToRemove -= toRemove;

      logger.info(
        { removed: toRemove, reason: 'source_no_findings' },
        'Pruning: removed sources with zero findings',
      );

      if (entriesToRemove <= 0) {
        this.applyState(state, snapshot, sources, findings, gaps);
        return totalEvicted;
      }
    }

    // ── Stage B: Deduplicate + drop lowest-confidence unverified findings ──
    // First, deduplicate near-identical findings
    const deduped = this.deduplicateFindings(findings);
    const dedupedCount = findings.length - deduped.length;
    findings = deduped;

    if (dedupedCount > 0) {
      logger.info(
        { merged: dedupedCount, reason: 'dedup_before_trim' },
        'Pruning: merged near-identical findings before trimming',
      );
      // Recompute after dedup
      totalEntries = sources.length + findings.length + gaps.length;
      entriesToRemove = totalEntries - maxEntries;
      if (entriesToRemove <= 0) {
        this.applyState(state, snapshot, sources, findings, gaps);
        return totalEvicted + dedupedCount;
      }
    }

    // Now drop lowest-confidence unverified findings
    const { unverified } = this.tierFindings(findings);
    if (unverified.length > 0) {
      // Sort unverified by confidence ascending (worst first)
      unverified.sort((a, b) => findingConfidence(a) - findingConfidence(b));

      const unverifiedIds = new Set(unverified.map((f) => f.id));
      const nonUnverified = findings.filter((f) => !unverifiedIds.has(f.id));
      const toRemove = Math.min(unverified.length, entriesToRemove);

      // Take the lowest confidence ones
      const keepCount = unverified.length - toRemove;
      const keptUnverified = unverified.slice(keepCount); // keep higher-confidence ones

      findings = [...nonUnverified, ...keptUnverified];
      totalEvicted += toRemove;
      entriesToRemove -= toRemove;

      logger.info(
        { removed: toRemove, tier: 'unverified' },
        'Pruning: dropped lowest-confidence unverified findings',
      );

      if (entriesToRemove <= 0) {
        this.applyState(state, snapshot, sources, findings, gaps);
        return totalEvicted;
      }
    }

    // ── Stage C: Evict oldest gap records ──
    if (gaps.length > 0 && entriesToRemove > 0) {
      // Sort gaps by priority (lowest first), then by no particular order — oldest gaps first
      gaps.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return 0; // stable sort preserves insertion order
      });

      const toRemove = Math.min(gaps.length, entriesToRemove);
      gaps = gaps.slice(toRemove);

      totalEvicted += toRemove;
      entriesToRemove -= toRemove;

      logger.info(
        { removed: toRemove, reason: 'oldest_gaps' },
        'Pruning: evicted oldest gap records',
      );
    }

    this.applyState(state, snapshot, sources, findings, gaps);
    return totalEvicted;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Deduplicate findings by normalized-claim Jaccard similarity at 0.85.
   * Merges similar findings into the first one (combining sourceIds and
   * subQuestionIds), then removes the absorbed finding.
   *
   * @returns The dedupled findings array.
   */
  private deduplicateFindings(findings: Finding[]): Finding[] {
    const toRemove = new Set<string>();
    // Track merged source/sub-question ids keyed by surviving finding id
    const mergeQueue = new Map<string, { sourceIds: string[]; subQuestionIds: string[] }>();

    for (let i = 0; i < findings.length; i++) {
      const fi = findings[i];
      if (!fi || toRemove.has(fi.id)) continue;

      for (let j = i + 1; j < findings.length; j++) {
        const fj = findings[j];
        if (!fj || toRemove.has(fj.id)) continue;

        const sim = jaccardSimilarity(fi.normalizedClaim, fj.normalizedClaim);
        if (sim > 0.85) {
          // Queue merge of fj into fi (deferred to avoid in-place mutation of state engine references)
          const existing = mergeQueue.get(fi.id);
          if (existing) {
            existing.sourceIds = [...new Set([...existing.sourceIds, ...fj.sourceIds])];
            existing.subQuestionIds = [
              ...new Set([...existing.subQuestionIds, ...fj.subQuestionIds]),
            ];
          } else {
            mergeQueue.set(fi.id, {
              sourceIds: [...new Set([...fi.sourceIds, ...fj.sourceIds])],
              subQuestionIds: [...new Set([...fi.subQuestionIds, ...fj.subQuestionIds])],
            });
          }
          toRemove.add(fj.id);
        }
      }
    }

    // Apply merges by creating new Finding objects instead of mutating originals
    const result: Finding[] = [];
    for (const f of findings) {
      if (toRemove.has(f.id)) continue;
      const merge = mergeQueue.get(f.id);
      if (merge) {
        result.push({
          ...f,
          sourceIds: merge.sourceIds,
          subQuestionIds: merge.subQuestionIds,
          lastUpdated: new Date().toISOString(),
        });
      } else {
        result.push(f);
      }
    }
    return result;
  }

  /**
   * Replace the state engine's internal state, preserving all fields
   * other than those being pruned.
   */
  private applyState(
    state: ResearchStateEngine,
    snapshot: ResearchState,
    sources: SourceEntry[],
    findings: Finding[],
    gaps: GapRecord[],
  ): void {
    const newState: ResearchState = {
      ...snapshot,
      sources,
      findings,
      gaps,
    };
    state.fromJSON(newState);
  }
}
