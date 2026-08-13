import { embedTexts } from '../rag/embedding.js';
import { cosineSimilarity } from '../rag/pipeline.js';
import { logger } from '../logger.js';

export interface SemanticMatchOptions<T> {
  query: string;
  candidates: T[];
  getText: (item: T) => string;
  embeddingBaseUrl: string;
  embeddingApiToken?: string;
  embeddingDimensions: number;
  topK: number;
  /**
   * Optional web-search-specific credibility floor. When provided, each
   * authority is used only as a tiebreaker when cosine scores are within a
   * small relevance band. Absent for all non-web-search callers (no generic
   * semantic-match behavior change).
   */
  authorityFloor?: ((item: T) => number) | undefined;
}

export interface SemanticMatchResult<T> {
  item: T;
  score: number;
  rank: number;
}

export const MAX_EMBEDDING_BATCH = 512;

/**
 * Credibility-aware score used only as a conservative semantic tiebreaker when
 * an `authorityFloor` is passed (web-search specific).
 */
export function authorityWeightedScore(cosine: number, authority: number): number {
  const clamped = Math.max(0, Math.min(1, authority));
  return cosine * (0.5 + 0.5 * clamped);
}

async function embedBatches(
  texts: string[],
  baseUrl: string,
  apiToken: string | undefined,
  dimensions: number,
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_EMBEDDING_BATCH) {
    const batch = texts.slice(i, i + MAX_EMBEDDING_BATCH);
    const response = await embedTexts({
      baseUrl,
      texts: batch,
      mode: 'document',
      dimensions,
      apiToken,
    });
    embeddings.push(...response.embeddings);
  }
  return embeddings;
}

export async function semanticMatch<T>(
  options: SemanticMatchOptions<T>,
): Promise<SemanticMatchResult<T>[]> {
  const {
    query,
    candidates,
    getText,
    embeddingBaseUrl,
    embeddingApiToken,
    embeddingDimensions,
    topK,
  } = options;

  if (candidates.length === 0) {
    return [];
  }

  let queryEmbedding: number[];
  let candidateEmbeddings: number[][];

  try {
    const queryResponse = await embedTexts({
      baseUrl: embeddingBaseUrl,
      texts: [query],
      mode: 'query',
      dimensions: embeddingDimensions,
      apiToken: embeddingApiToken,
    });
    queryEmbedding = queryResponse.embeddings[0] ?? [];
  } catch (err) {
    if (err instanceof Error) {
      if (
        err.message.includes('timeout') ||
        err.name === 'TimeoutError' ||
        err.name === 'AbortError'
      ) {
        logger.warn('semanticMatch query embedding timed out, returning unsorted candidates');
      } else {
        logger.warn('semanticMatch query embedding failed, returning unsorted candidates');
      }
    } else {
      logger.warn('semanticMatch query embedding failed, returning unsorted candidates');
    }
    return candidates.map((item) => ({ item, score: 0, rank: 0 }));
  }

  try {
    candidateEmbeddings = await embedBatches(
      candidates.map(getText),
      embeddingBaseUrl,
      embeddingApiToken,
      embeddingDimensions,
    );
  } catch (err) {
    if (err instanceof Error) {
      if (
        err.message.includes('timeout') ||
        err.name === 'TimeoutError' ||
        err.name === 'AbortError'
      ) {
        logger.warn('semanticMatch candidate embedding timed out, returning unsorted candidates');
      } else {
        logger.warn('semanticMatch candidate embedding failed, returning unsorted candidates');
      }
    } else {
      logger.warn('semanticMatch candidate embedding failed, returning unsorted candidates');
    }
    return candidates.map((item) => ({ item, score: 0, rank: 0 }));
  }

  if (
    queryEmbedding.length === 0 ||
    candidateEmbeddings.length !== candidates.length ||
    candidateEmbeddings.some((e) => e.length === 0)
  ) {
    logger.warn('semanticMatch embedding returned empty, returning unsorted candidates');
    return candidates.map((item) => ({ item, score: 0, rank: 0 }));
  }

  const scored = candidates.map((item, index) => {
    const cosine = cosineSimilarity(queryEmbedding, candidateEmbeddings[index] ?? []);
    const authority = options.authorityFloor?.(item);
    return {
      item,
      cosine,
      authority,
      // Authority is only a conservative tiebreaker for close relevance.
      authorityScore: authority === undefined ? cosine : authorityWeightedScore(cosine, authority),
    };
  });

  // A fixed 0.05 cosine bucket is a monotonic ordering key (transitive total
  // order), unlike the previous band-based pairwise comparator. Within a bucket
  // authority is a separate non-negative sort key so higher authority
  // consistently ranks first even for negative and zero cosine values.
  // Raw cosine and original input index are subsequent deterministic tie-breakers.
  const relevanceTieBand = 0.05;
  const keyed = scored.map((s, idx) => ({
    ...s,
    bucket: Math.floor(s.cosine / relevanceTieBand),
    authorityKey:
      options.authorityFloor !== undefined && s.authority !== undefined
        ? Math.max(0, Math.min(1, s.authority))
        : 0,
    idx,
  }));
  return keyed
    .sort((a, b) => {
      if (a.bucket !== b.bucket) return b.bucket - a.bucket;
      if (options.authorityFloor !== undefined) {
        if (a.authorityKey !== b.authorityKey) return b.authorityKey - a.authorityKey;
      }
      if (a.cosine !== b.cosine) return b.cosine - a.cosine;
      return a.idx - b.idx;
    })
    .slice(0, topK)
    .map((result, index) => ({ item: result.item, score: result.cosine, rank: index + 1 }));
}
