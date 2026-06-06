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
}

export interface SemanticMatchResult<T> {
  item: T;
  score: number;
  rank: number;
}

const MAX_EMBEDDING_BATCH = 512;

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

export async function semanticMatch<T>(options: SemanticMatchOptions<T>): Promise<SemanticMatchResult<T>[]> {
  const { query, candidates, getText, embeddingBaseUrl, embeddingApiToken, embeddingDimensions, topK } = options;

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
        logger.warn({ err }, 'semanticMatch query embedding timed out, returning unsorted candidates');
      } else {
        logger.warn({ err }, 'semanticMatch query embedding failed, returning unsorted candidates');
      }
    } else {
      logger.warn({ err: String(err) }, 'semanticMatch query embedding failed (non-Error throw), returning unsorted candidates');
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
        logger.warn({ err }, 'semanticMatch candidate embedding timed out, returning unsorted candidates');
      } else {
        logger.warn({ err }, 'semanticMatch candidate embedding failed, returning unsorted candidates');
      }
    } else {
      logger.warn({ err: String(err) }, 'semanticMatch candidate embedding failed (non-Error throw), returning unsorted candidates');
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

  const scored = candidates.map((item, index) => ({
    item,
    score: cosineSimilarity(queryEmbedding, candidateEmbeddings[index] ?? []),
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((result, index) => ({ item: result.item, score: result.score, rank: index + 1 }));
}