import type { PreparedCorpus } from '../rag/types.js';

export interface CompactSemanticCorpusSummary {
  id: string;
  status: PreparedCorpus['status'];
  adapter: PreparedCorpus['adapter'];
  documentCount: number;
  chunkCount: number;
  embeddingCount: number;
  model: string | undefined;
  modelRevision: string | undefined;
  dimensions: number | undefined;
}

function countOrZero(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function summarizeCorpus(corpus: PreparedCorpus): CompactSemanticCorpusSummary {
  return {
    id: corpus.id,
    status: corpus.status,
    adapter: corpus.adapter,
    documentCount: countOrZero(corpus.documents),
    chunkCount: countOrZero(corpus.chunks),
    embeddingCount: countOrZero(corpus.embeddings),
    model: corpus.model,
    modelRevision: corpus.modelRevision,
    dimensions: corpus.dimensions,
  };
}

export function compactSemanticResponse<T extends { corpus: PreparedCorpus }>(
  response: T,
): Omit<T, 'corpus'> & { corpus: CompactSemanticCorpusSummary } {
  const { corpus, ...rest } = response;
  return {
    ...rest,
    corpus: summarizeCorpus(corpus),
  };
}
