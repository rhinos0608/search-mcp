/**
 * Weighted Reciprocal Rank Fusion (RRF).
 *
 * Combines multiple ranked channel results into a single fused ranking.
 * Each channel is assigned a weight. Channels omitted from the candidate's
 * scoring (weight = 0) do not redistribute their weight to other channels.
 *
 * Frozen invariant: weighted RRF union only, never W9 utility.
 * RRF rank/score is retrieval metadata only.
 */

import type { ChannelResult, RetrievalChannelId, RetrievalChannelWeights } from './contracts.js';

// ---------------------------------------------------------------------------
// RRF config
// ---------------------------------------------------------------------------

const DEFAULT_K = 60;

// ---------------------------------------------------------------------------
// Weighted RRF fusion
// ---------------------------------------------------------------------------

export interface RrfFusedEntry {
  readonly candidateId: string;
  readonly rrfScore: number;
  /** Per-channel rank (1-based) for candidates that appeared in that channel's ranking. Null if not ranked. */
  readonly channelRanks: Readonly<Record<RetrievalChannelId, number | null>>;
  /** Per-channel raw score. Null if not scored. */
  readonly channelScores: Readonly<Record<RetrievalChannelId, number | null>>;
  /** Count of channels that contributed a non-neutral real score. */
  readonly scoredChannelCount: number;
  /** Count of channels with non-zero weight. */
  readonly activeChannelCount: number;
}

export function weightedRrfFuse(input: {
  readonly channelResults: readonly ChannelResult[];
  readonly weights: RetrievalChannelWeights;
  readonly candidateIds: readonly string[];
  readonly k?: number;
}): readonly RrfFusedEntry[] {
  const k = input.k ?? DEFAULT_K;
  const { weights, candidateIds } = input;

  // Count active channels (non-zero weight)
  const activeChannelCount = Object.values(weights).filter((w) => w > 0).length;

  // Build per-channel rank maps: candidateId → rank (1-based)
  const channelRankMaps = new Map<RetrievalChannelId, Map<string, number>>();
  const channelScoreMaps = new Map<RetrievalChannelId, Map<string, number>>();

  for (const result of input.channelResults) {
    const rankMap = new Map<string, number>();
    const scoreMap = new Map<string, number>();
    for (let i = 0; i < result.entries.length; i++) {
      const entry = result.entries[i];
      if (!entry) continue;
      rankMap.set(entry.candidateId, i + 1);
      scoreMap.set(entry.candidateId, entry.score);
    }
    channelRankMaps.set(result.channelId, rankMap);
    channelScoreMaps.set(result.channelId, scoreMap);
  }

  // Compute weighted RRF score per candidate
  const fused: {
    candidateId: string;
    rrfScore: number;
    channelRanks: Record<RetrievalChannelId, number | null>;
    channelScores: Record<RetrievalChannelId, number | null>;
    scoredChannelCount: number;
    activeChannelCount: number;
  }[] = [];

  const ALL_CHANNELS: RetrievalChannelId[] = [
    'text_bm25',
    'role_family',
    'capability_overlap',
    'geography',
    'semantic',
  ];

  for (const cid of candidateIds) {
    let rrfScore = 0;
    const channelRanks: Record<RetrievalChannelId, number | null> = {} as Record<
      RetrievalChannelId,
      number | null
    >;
    const channelScores: Record<RetrievalChannelId, number | null> = {} as Record<
      RetrievalChannelId,
      number | null
    >;
    let scoredChannelCount = 0;

    for (const ch of ALL_CHANNELS) {
      const w = (weights as Record<string, number>)[ch] ?? 0;
      const rankMap = channelRankMaps.get(ch);
      const scoreMap = channelScoreMaps.get(ch);

      if (w <= 0 || !rankMap || !scoreMap) {
        channelRanks[ch] = null;
        channelScores[ch] = null;
        continue;
      }

      const rank = rankMap.get(cid);
      const score = scoreMap.get(cid);

      if (rank !== undefined) {
        // Candidate genuinely ranked by this channel — real evidence
        channelRanks[ch] = rank;
        channelScores[ch] = score ?? null;
        rrfScore += w * (1 / (k + rank));
        scoredChannelCount++;
      } else {
        // Candidate not ranked by this channel — neutral 0.5 evidence
        // Do NOT add RRF term or count toward scoredChannelCount.
        channelRanks[ch] = null;
        channelScores[ch] = 0.5;
      }
    }

    fused.push({
      candidateId: cid,
      rrfScore,
      channelRanks,
      channelScores,
      scoredChannelCount,
      activeChannelCount,
    });
  }

  // Stable sort: by rrfScore descending, ties broken by candidateId ascending (deterministic)
  fused.sort((a, b) => b.rrfScore - a.rrfScore || a.candidateId.localeCompare(b.candidateId));

  return fused;
}
