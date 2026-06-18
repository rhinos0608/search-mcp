import type { CorpusChunk, ScoreDetail, RerankScoreDetail, SemanticCrawlChunk } from '../types.js';

// ── Coverage tracking for retrieval operations ───────────────────────────────

export interface Coverage {
  sourcesAttempted: string[];
  sourcesSucceeded: string[];
  sourcesPartial: string[];
  sourcesFailed: string[];
  documentsFound: number;
  documentsAfterDedup: number;
  chunksGenerated: number;
  embeddingsGenerated: number;
  retrievalTimeMs: number;
}

// ── Query constraints for structured retrieval ─────────────────────────────

export interface QueryConstraints {
  hard: {
    location?: string[];
    salary?: { min?: number; max?: number; currency?: string };
    experience?: { min?: number; max?: number };
    workMode?: ('remote' | 'hybrid' | 'onsite')[];
    language?: string[];
    availability?: ('now' | 'week' | 'month')[];
    dateRange?: { from?: Date; to?: Date };
  };
  soft: {
    companySize?: { preferred: string[]; weight: number };
    techStack?: { keywords: string[]; weight: number };
    remoteFirst?: { weight: number };
    sourceReliability?: { weight: number };
    recency?: { weight: number; decay: 'linear' | 'exponential' };
  };
}

// ── Deduplication configuration ────────────────────────────────────────────

export interface DedupeConfig {
  layers: {
    url: boolean;
    fingerprint: boolean;
    semantic: boolean;
    entityOverlap: boolean;
  };
  fingerprintThreshold: number; // default 0.95
  semanticThreshold: number; // default 0.90
  preferKeep: 'newest' | 'mostComplete' | 'highestScore';
  /** Optional per-author cap: limits items from any single author. Default undefined (disabled). */
  maxPerAuthor?: number;
}

// ── Constraint evaluation result ───────────────────────────────────────────

export interface ConstraintEvaluation {
  passedHard: boolean;
  softScore: number; // 0-1
  matchedConstraints: string[];
  failedConstraints: string[];
  explanations: {
    constraint: string;
    expected: unknown;
    actual: unknown;
    matched: boolean;
  }[];
}

// ── Adapter types ──────────────────────────────────────────────────────────

export type AdapterType =
  | 'text'
  | 'code'
  | 'job'
  | 'transcript'
  | 'conversation'
  | 'github'
  | 'url'
  | 'sitemap'
  | 'search'
  | 'cached'
  | 'academic'
  | 'qa';

export type RetrievalProfileName =
  | 'balanced'
  | 'lexical-heavy'
  | 'semantic-heavy'
  | 'high-precision'
  | 'fast'
  | 'precision'
  | 'recall';

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
  // New fields for V3.2.0
  constraintScore?: number; // 0-1 from constraint evaluation
  qualityScore?: number; // 0-1 from quality heuristics
  duplicateScore?: number; // 0-1 (higher = more likely duplicate)
  overallScore?: number; // Combined score after all factors
  explanation?: {
    matched: string[]; // What constraints/features matched
    caveats: string[]; // Warnings or limitations
  };
}

export interface RetrievalResponse<T = RagChunk> {
  corpus: PreparedCorpus;
  results: RetrievalResult<T>[];
  trace: RetrievalTrace;
  coverage?: Coverage; // New for V3.2.0
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

// ── Uncertainty annotations for search results ─────────────────────────────

export type UncertaintyTag = 'single-source' | 'thin-evidence' | null;

export interface UncertaintyAnnotated {
  uncertainty: UncertaintyTag;
}
