/**
 * Fielded BM25+ text scoring channel.
 *
 * Builds a separate BM25+ index per weighted text field from candidate postings,
 * scores each with the intent query, and combines per-field scores by field weights.
 * Reuses the generic BM25+ implementation from src/utils/bm25.ts.
 */

import { buildBm25Index } from '../../../utils/bm25.js';
import type { ChannelResult, ChannelScoreEntry, TextFieldWeight } from '../contracts.js';
import { DEFAULT_TEXT_FIELD_WEIGHTS } from '../contracts.js';
import { lexicalTokenize } from '../lexical.js';

// ---------------------------------------------------------------------------
// Field extraction from posting-like objects
// ---------------------------------------------------------------------------

export interface TextBm25PostingLike {
  /** Candidate ID for RRF fusion. Falls back to postingId when absent. */
  readonly candidateId?: string;
  readonly postingId: string;
  readonly title?: string;
  readonly normalizedTitle?: string;
  readonly organisation?: string;
  readonly description?: string;
  readonly responsibilities?: readonly string[];
  readonly requirements?: readonly { rawText?: string }[];
}

function extractField(posting: TextBm25PostingLike, field: TextFieldWeight['field']): string {
  switch (field) {
    case 'title':
      return posting.title ?? '';
    case 'normalisedTitle':
      return posting.normalizedTitle ?? '';
    case 'organisation':
      return posting.organisation ?? '';
    case 'description':
      return posting.description ?? '';
    case 'responsibilities':
      return (posting.responsibilities ?? []).join(' ');
    case 'requirements':
      return (posting.requirements ?? []).map((r) => r.rawText ?? '').join(' ');
  }
}

// ---------------------------------------------------------------------------
// Build fielded BM25+ scores
// ---------------------------------------------------------------------------

export function scoreTextBm25(input: {
  readonly query: string;
  readonly postings: readonly TextBm25PostingLike[];
  readonly fieldWeights?: readonly TextFieldWeight[];
}): ChannelResult {
  const fieldWeights = input.fieldWeights ?? DEFAULT_TEXT_FIELD_WEIGHTS;
  const postings = input.postings;
  const candidateIds = postings.map((p) => p.candidateId ?? p.postingId);

  const scoreAccum = new Map<string, number>();
  const hasText = new Set<string>();

  for (const fw of fieldWeights) {
    if (fw.weight <= 0) continue;

    const docs = postings
      .map((p) => {
        const text = extractField(p, fw.field);
        return { id: p.candidateId ?? p.postingId, text };
      })
      .filter((d) => d.text.length > 0);

    if (docs.length === 0) continue;
    for (const d of docs) hasText.add(d.id);

    const idx = buildBm25Index(docs, lexicalTokenize);
    const hits = idx.search(input.query, docs.length);

    for (const hit of hits) {
      const prev = scoreAccum.get(hit.id) ?? 0;
      scoreAccum.set(hit.id, prev + hit.score * fw.weight);
    }
  }

  const uniqueIds = [...new Set(candidateIds)];
  const entries: ChannelScoreEntry[] = uniqueIds
    .filter((id) => hasText.has(id))
    .map((id) => ({
      candidateId: id,
      score: scoreAccum.get(id) ?? 0,
    }));

  entries.sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));

  const scoredIds = new Set(entries.map((e) => e.candidateId));
  const fullyScored = uniqueIds.every((id) => scoredIds.has(id));

  return {
    channelId: 'text_bm25',
    entries,
    fullyScored,
  };
}
