/**
 * Optional semantic scoring channel.
 *
 * Accepts pre-computed similarity scores (e.g., from embeddings). When scores
 * are not provided, returns neutral 0.5 for all candidates (missing evidence).
 * No network calls, no LLM invocations — purely a data passthrough channel.
 */

import type { ChannelResult, ChannelScoreEntry } from '../contracts.js';

export function scoreSemantic(input: {
  /** Pre-computed candidate similarity scores. Absent = channel unavailable. */
  readonly candidateScores?: ReadonlyMap<string, number>;
  readonly candidateIds: readonly string[];
}): ChannelResult {
  const entries: ChannelScoreEntry[] = [];

  for (const id of input.candidateIds) {
    const raw = input.candidateScores?.get(id);
    // Omit candidates without scores from channel entries (no RRF rank for missing evidence)
    if (raw === undefined) continue;
    const score = Math.max(0, Math.min(1, raw));
    entries.push({ candidateId: id, score });
  }

  entries.sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));

  return {
    channelId: 'semantic',
    entries,
    fullyScored: input.candidateScores !== undefined,
  };
}
