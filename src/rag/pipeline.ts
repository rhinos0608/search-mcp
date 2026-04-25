import { createHash } from 'node:crypto';
import { buildBm25Index } from './bm25.js';
import { rrfMerge } from './fusion.js';
import { getProfileSettings } from './profiles.js';
import { validationError } from '../errors.js';
import type {
  PreparedCorpus,
  PrepareCorpusOptions,
  ProfileSettings,
  RagChunk,
  RetrievalResponse,
  RetrievalResult,
  RetrievalScore,
  RetrieveCorpusOptions,
  RawDocument,
} from './types.js';

interface Candidate {
  index: number;
}

function corpusIdFor(options: PrepareCorpusOptions, chunks: RagChunk[]): string {
  const payload = JSON.stringify({
    adapter: options.adapter,
    model: options.model,
    dimensions: options.dimensions,
    chunks: chunks.map((chunk) => ({
      text: chunk.text,
      url: chunk.url,
      chunkIndex: chunk.chunkIndex,
    })),
  });
  return createHash('sha256').update(payload).digest('hex');
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function candidateId(candidate: Candidate): string {
  return String(candidate.index);
}

function chunksFromDocuments(documents: RawDocument[]): RagChunk[] {
  return documents.map((document, index) => ({
    text: document.text,
    url: document.url,
    section: document.title ?? document.id,
    charOffset: 0,
    chunkIndex: index,
    totalChunks: documents.length,
    metadata: {
      ...document.metadata,
      adapter: document.adapter,
      documentId: document.id,
      title: document.title,
    },
  }));
}

function validateEmbeddingsForChunks(embeddings: number[][], chunkCount: number): void {
  if (embeddings.length !== chunkCount) {
    throw validationError(
      `Embedding count (${String(embeddings.length)}) must match chunk count (${String(chunkCount)})`,
    );
  }

  for (let index = 0; index < embeddings.length; index++) {
    const embedding = embeddings[index];
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw validationError(`Embedding at index ${String(index)} must be a numeric vector`);
    }
  }
}

export function prepareCorpus(options: PrepareCorpusOptions): PreparedCorpus {
  const documents = options.documents ?? [];
  const chunks = options.chunks ?? chunksFromDocuments(documents);
  return {
    id: corpusIdFor(options, chunks),
    status: chunks.length === 0 ? 'empty' : 'ready',
    adapter: options.adapter,
    documents,
    chunks,
    embeddings: options.embeddings,
    model: options.model,
    modelRevision: options.modelRevision,
    dimensions: options.dimensions,
    metadata: options.metadata,
  };
}

export function retrieveCorpus(
  corpus: PreparedCorpus,
  options: RetrieveCorpusOptions,
): RetrievalResponse {
  const overrides: Partial<Omit<ProfileSettings, 'profile'>> = {};
  if (options.topK !== undefined) overrides.topK = options.topK;
  if (options.useReranker !== undefined) overrides.useReranker = options.useReranker;
  const profile = getProfileSettings(options.profile ?? 'balanced', overrides);
  const topK = profile.topK;

  if (corpus.chunks.length === 0) {
    return {
      corpus: { ...corpus, status: 'empty' },
      results: [],
      trace: {
        query: options.query,
        profile: profile.profile,
        totalChunks: 0,
        vectorCandidates: 0,
        lexicalCandidates: 0,
        fusedCandidates: 0,
        returnedResults: 0,
      },
      warnings: [],
    };
  }

  const vectorScores = new Map<number, number>();
  const vectorRanking: Candidate[] = [];
  if (options.queryEmbedding !== undefined && corpus.embeddings !== undefined) {
    validateEmbeddingsForChunks(corpus.embeddings, corpus.chunks.length);
    const scored = corpus.embeddings
      .map((embedding, index) => ({
        index,
        score: cosineSimilarity(options.queryEmbedding ?? [], embedding),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const candidate of scored) {
      vectorScores.set(candidate.index, candidate.score);
      vectorRanking.push({ index: candidate.index });
    }
  }

  const bm25 = buildBm25Index(
    corpus.chunks.map((chunk, index) => ({
      id: String(index),
      text: chunk.text,
    })),
  );
  const lexicalScores = new Map<number, number>();
  const lexicalRanking = bm25.search(options.query).map((result) => {
    const index = Number(result.id);
    lexicalScores.set(index, result.score);
    return { index };
  });

  const fused = rrfMerge([vectorRanking, lexicalRanking], {
    k: profile.rrfK,
    getId: candidateId,
  });

  const results: RetrievalResult[] = fused.slice(0, topK).map((candidate, index) => {
    const chunkIndex = candidate.item.index;
    const item = corpus.chunks[chunkIndex];
    if (item === undefined) {
      throw new Error(`RAG pipeline produced invalid chunk index ${String(chunkIndex)}`);
    }
    const score: RetrievalScore = {
      fused: candidate.rrfScore,
    };
    const vector = vectorScores.get(chunkIndex);
    if (vector !== undefined) score.vector = vector;
    const lexical = lexicalScores.get(chunkIndex);
    if (lexical !== undefined) score.lexical = lexical;
    return {
      item,
      score,
      rank: index + 1,
    };
  });

  return {
    corpus,
    results,
    trace: {
      query: options.query,
      profile: profile.profile,
      totalChunks: corpus.chunks.length,
      vectorCandidates: vectorRanking.length,
      lexicalCandidates: lexicalRanking.length,
      fusedCandidates: fused.length,
      returnedResults: results.length,
    },
    warnings: [],
  };
}

export function prepareAndRetrieve(
  prepareOptions: PrepareCorpusOptions,
  retrieveOptions: RetrieveCorpusOptions,
): RetrievalResponse {
  const corpus = prepareCorpus(prepareOptions);
  return retrieveCorpus(corpus, retrieveOptions);
}
