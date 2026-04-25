import type { CorpusChunk, ScoreDetail, RerankScoreDetail, SemanticCrawlChunk } from '../types.js';

export type AdapterType =
  | 'text'
  | 'transcript'
  | 'conversation'
  | 'github'
  | 'url'
  | 'sitemap'
  | 'search'
  | 'cached';

export type RetrievalProfileName = 'balanced' | 'fast' | 'precision' | 'recall';

export interface RawDocument {
  id: string;
  adapter: AdapterType;
  text: string;
  url: string;
  title?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RagChunk extends Omit<CorpusChunk, never> {
  metadata?: Record<string, unknown> | undefined;
  scores?: SemanticCrawlChunk['scores'] | undefined;
}

export interface PreparedCorpus {
  id: string;
  status: CorpusStatus;
  adapter: AdapterType;
  documents: RawDocument[];
  chunks: RagChunk[];
  embeddings?: number[][] | undefined;
  model?: string | undefined;
  modelRevision?: string | undefined;
  dimensions?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type CorpusStatus = 'ready' | 'empty' | 'partial' | 'error';

export interface RetrievalTrace {
  query: string;
  profile: RetrievalProfileName;
  totalChunks: number;
  vectorCandidates: number;
  lexicalCandidates: number;
  fusedCandidates: number;
  returnedResults: number;
  rerankedCandidates?: number | undefined;
}

export interface RetrievalScore {
  vector?: number | undefined;
  lexical?: number | undefined;
  fused: number;
  rerank?: number | undefined;
  details?:
    | {
        biEncoder: ScoreDetail;
        bm25: ScoreDetail;
        rrf: ScoreDetail;
        rerank?: RerankScoreDetail | undefined;
      }
    | undefined;
}

export interface RetrievalResult<T = RagChunk> {
  item: T;
  score: RetrievalScore;
  rank: number;
}

export interface RetrievalResponse<T = RagChunk> {
  corpus: PreparedCorpus;
  results: RetrievalResult<T>[];
  trace: RetrievalTrace;
  warnings?: string[] | undefined;
}

export interface PrepareCorpusOptions {
  adapter: AdapterType;
  profile?: RetrievalProfileName | undefined;
  documents?: RawDocument[] | undefined;
  chunks?: RagChunk[] | undefined;
  embeddings?: number[][] | undefined;
  model?: string | undefined;
  modelRevision?: string | undefined;
  dimensions?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RetrieveCorpusOptions {
  query: string;
  topK?: number | undefined;
  profile?: RetrievalProfileName | undefined;
  useReranker?: boolean | undefined;
  queryEmbedding?: number[] | undefined;
}

export interface ProfileSettings {
  profile: RetrievalProfileName;
  topK: number;
  vectorWeight: number;
  lexicalWeight: number;
  rrfK: number;
  useReranker: boolean;
}
