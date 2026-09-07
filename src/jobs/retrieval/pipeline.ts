/**
 * W8 Retrieval pipeline.
 *
 * Takes identity-bound candidates and produces retrieval metadata:
 * RRF rank, RRF score, per-channel scores, version stamps, truncation.
 *
 * Frozen invariants:
 * - Weighted RRF union only, never W9 utility
 * - Omitted channels not reweighted
 * - Neutral 0.5 for missing ranking evidence
 * - Deterministic ordering/ties/version metadata
 * - No LLM, no network, no locale defaults
 */

import type { DomainPack, LocalePack } from '../packs/types.js';
import type {
  CandidateRetrievalMetadata,
  RetrievalChannelWeights,
  RetrievalResult,
} from './contracts.js';
import {
  RETRIEVAL_CONTRACT_VERSION,
  LEXICAL_TRANSFORM_VERSION,
  DEFAULT_RETRIEVAL_WEIGHTS,
} from './contracts.js';
import { scoreTextBm25, type TextBm25PostingLike } from './channels/textBm25.js';
import { scoreRoleFamily } from './channels/roleFamily.js';
import { scoreCapabilityOverlap } from './channels/capabilityOverlap.js';
import { scoreGeography } from './channels/geography.js';
import { scoreSemantic } from './channels/semantic.js';
import { weightedRrfFuse } from './rrf.js';

// ---------------------------------------------------------------------------
// Location shape (shared between candidates and intent)
// ---------------------------------------------------------------------------

interface LocationLike {
  readonly city?: string;
  readonly region?: string;
  readonly country?: string;
  readonly remoteEligible?: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline input
// ---------------------------------------------------------------------------

export interface RetrievalPipelineInput {
  readonly runId: string;
  readonly emittedAt: string;

  /** Candidates to score (must be in identity_bound state). */
  readonly candidates: readonly {
    readonly candidateId: string;
    readonly postingId?: string;
    readonly roleFamilies: readonly string[];
    readonly locations: readonly LocationLike[];
    readonly capabilities?: readonly string[];
  }[];

  /** Postings for text BM25 scoring. Indexed by postingId. */
  readonly postings: ReadonlyMap<string, TextBm25PostingLike>;

  readonly intent: {
    readonly query: string;
    readonly requestedRoleFamilies: readonly string[];
    readonly requestedCapabilities?: readonly string[];
    readonly locations: readonly LocationLike[];
  };

  readonly domainPack?: DomainPack;
  readonly localePack?: LocalePack;

  /** Optional pre-computed semantic scores. */
  readonly semanticScores?: ReadonlyMap<string, number>;

  /** Channel weights override. Default uses DEFAULT_RETRIEVAL_WEIGHTS. */
  readonly weights?: RetrievalChannelWeights;

  /** Maximum candidates to emit (truncation). Undefined = no truncation. */
  readonly topK?: number;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export function runRetrieval(input: RetrievalPipelineInput): RetrievalResult {
  const weights = input.weights ?? DEFAULT_RETRIEVAL_WEIGHTS;
  const candidateIds = input.candidates.map((c) => c.candidateId);

  if (candidateIds.length === 0) {
    return {
      schemaVersion: RETRIEVAL_CONTRACT_VERSION,
      runId: input.runId,
      candidates: [],
      weightsUsed: weights,
      lexicalTransformVersion: LEXICAL_TRANSFORM_VERSION,
      retrievalVersion: RETRIEVAL_CONTRACT_VERSION,
      candidateCount: 0,
      emittedAt: input.emittedAt,
    };
  }

  // Build candidate data maps
  const candidateRoleFamilies = new Map<string, readonly string[]>();
  const candidateLocations = new Map<string, readonly LocationLike[]>();
  const candidateCapabilities = new Map<string, readonly string[]>();

  for (const c of input.candidates) {
    candidateRoleFamilies.set(c.candidateId, c.roleFamilies);
    candidateLocations.set(c.candidateId, c.locations);
    if (c.capabilities) candidateCapabilities.set(c.candidateId, c.capabilities);
  }

  // Collect postings for BM25 scoring, mapping postingId → candidateId
  const postings: TextBm25PostingLike[] = [];
  for (const c of input.candidates) {
    if (c.postingId) {
      const posting = input.postings.get(c.postingId);
      if (posting) postings.push({ ...posting, candidateId: c.candidateId });
    }
  }

  // -----------------------------------------------------------------------
  // Score each channel
  // -----------------------------------------------------------------------

  const channelResults = [];

  // 1. Text BM25
  if (weights.text_bm25 > 0 && postings.length > 0) {
    channelResults.push(scoreTextBm25({ query: input.intent.query, postings }));
  }

  // 2. Role family graph
  if (weights.role_family > 0 && input.domainPack) {
    channelResults.push(
      scoreRoleFamily({
        intentRoleFamilies: input.intent.requestedRoleFamilies,
        candidateRoleFamilies,
        domainPack: input.domainPack,
      }),
    );
  }

  // 3. Capability overlap
  if (weights.capability_overlap > 0 && input.domainPack) {
    channelResults.push(
      scoreCapabilityOverlap({
        intentCapabilities: input.intent.requestedCapabilities ?? [],
        intentRoleFamilies: input.intent.requestedRoleFamilies,
        candidateRoleFamilies,
        candidateCapabilities,
        domainPack: input.domainPack,
      }),
    );
  }

  // 4. Geography
  if (weights.geography > 0 && input.localePack) {
    channelResults.push(
      scoreGeography({
        intentLocations: input.intent.locations,
        candidateLocations,
        localePack: input.localePack,
      }),
    );
  }

  // 5. Semantic (optional) — only when pre-computed scores provided
  if (weights.semantic > 0 && input.semanticScores !== undefined) {
    channelResults.push(
      scoreSemantic({
        candidateScores: input.semanticScores,
        candidateIds,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Weighted RRF fusion
  // -----------------------------------------------------------------------

  const fused = weightedRrfFuse({
    channelResults,
    weights,
    candidateIds,
  });

  // -----------------------------------------------------------------------
  // Assign ranks and truncate
  // -----------------------------------------------------------------------

  const isTruncation = input.topK !== undefined && input.topK > 0;
  const limit = input.topK ?? fused.length;
  const wasTruncated = isTruncation && fused.length > limit;

  const metadataCandidates: CandidateRetrievalMetadata[] = fused
    .slice(0, limit)
    .map((entry, index) => ({
      candidateId: entry.candidateId,
      rrfRank: index + 1,
      rrfScore: entry.rrfScore,
      channelScores: entry.channelScores,
      channelRanks: entry.channelRanks,
      scoredChannelCount: entry.scoredChannelCount,
      activeChannelCount: entry.activeChannelCount,
      truncated: wasTruncated,
      retrievalVersion: RETRIEVAL_CONTRACT_VERSION,
      lexicalTransformVersion: LEXICAL_TRANSFORM_VERSION,
      emittedAt: input.emittedAt,
    }));

  return {
    schemaVersion: RETRIEVAL_CONTRACT_VERSION,
    runId: input.runId,
    candidates: metadataCandidates,
    weightsUsed: weights,
    lexicalTransformVersion: LEXICAL_TRANSFORM_VERSION,
    retrievalVersion: RETRIEVAL_CONTRACT_VERSION,
    candidateCount: metadataCandidates.length,
    emittedAt: input.emittedAt,
  };
}
