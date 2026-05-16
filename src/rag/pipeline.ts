import { createHash } from 'node:crypto';
import { buildBm25Index } from './bm25.js';
import { rrfMerge } from './fusion.js';
import { getProfileSettings } from './profiles.js';
import { validationError } from '../errors.js';
import { MAX_TOKENS, MIN_TOKENS, TOKEN_RATIO, OVERLAP_RATIO } from '../chunking.js';
import { dedupeByUrl, dedupeByFingerprint, deduplicateCorpus } from './dedup.js';
import { applyConstraints } from './constraints.js';
import { recordRetrievalMetrics, recordDedupMetrics, recordConstraintMetrics } from './metrics.js';
import { extractSmartSnippet } from '../utils/smartSnippet.js';
import type { ConstraintConfig, ConstraintExtractors } from './constraints.js';
import type { DedupeConfig, Coverage } from './types.js';
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

interface PrepareCorpusOptionsV3 extends PrepareCorpusOptions {
  dedupeConfig?: DedupeConfig;
}

interface RetrieveCorpusOptionsV3 extends RetrieveCorpusOptions {
  constraintConfig?: ConstraintConfig;
  constraintExtractors?: ConstraintExtractors<unknown>;
}

interface Candidate {
  index: number;
}

function corpusIdFor(options: PrepareCorpusOptions, chunks: RagChunk[]): string {
  const payload = JSON.stringify({
    adapter: options.adapter,
    model: options.model,
    dimensions: options.dimensions,
    chunking: {
      maxTokens: MAX_TOKENS,
      minTokens: MIN_TOKENS,
      overlapRatio: OVERLAP_RATIO,
      tokenRatio: TOKEN_RATIO,
    },
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

function applySyncDedup(
  documents: RawDocument[],
  config: DedupeConfig,
): {
  items: RawDocument[];
  urlRemoved: number;
  fpRemoved: number;
} {
  // Apply only URL + fingerprint layers synchronously.
  // Semantic dedup needs embeddings and must be done async via prepareCorpusAsync.
  let current = [...documents];
  let urlRemoved = 0;
  let fpRemoved = 0;
  if (config.layers.url) {
    const urlResult = dedupeByUrl(current, { normalize: true, removeTracking: true });
    urlRemoved = urlResult.decisions.filter((d) => !d.kept).length;
    current = urlResult.items;
  }
  if (config.layers.fingerprint) {
    const fpResult = dedupeByFingerprint(current, config.fingerprintThreshold);
    fpRemoved = fpResult.decisions.filter((d) => !d.kept).length;
    current = fpResult.items;
  }
  return { items: current, urlRemoved, fpRemoved };
}

export function prepareCorpus(options: PrepareCorpusOptionsV3): PreparedCorpus {
  let documents = options.documents ?? [];

  // Step 1: Sync dedup (URL + fingerprint only)
  if (options.dedupeConfig && documents.length > 0) {
    const docsBefore = documents.length;
    const dedupResult = applySyncDedup(documents, options.dedupeConfig);
    documents = dedupResult.items;
    const docsAfter = documents.length;
    recordDedupMetrics({
      adapter: options.adapter,
      documentsBefore: docsBefore,
      documentsAfter: docsAfter,
      urlRemoved: dedupResult.urlRemoved,
      fingerprintRemoved: dedupResult.fpRemoved,
      semanticRemoved: 0,
    });
  }

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

export async function prepareCorpusAsync(
  options: PrepareCorpusOptionsV3,
  embedFn?: (texts: string[]) => Promise<number[][]>,
): Promise<PreparedCorpus> {
  let documents = options.documents ?? [];

  // Full async dedup including semantic layer
  if (options.dedupeConfig && documents.length > 0) {
    const docsBefore = documents.length;
    const dedupeResult = await deduplicateCorpus(documents, options.dedupeConfig, embedFn);
    documents = dedupeResult.items;
    const docsAfter = documents.length;
    let urlRemoved = 0;
    let fpRemoved = 0;
    let semanticRemoved = 0;
    for (const layer of dedupeResult.layers) {
      if (layer.name === 'url') urlRemoved = layer.removed;
      else if (layer.name === 'fingerprint') fpRemoved = layer.removed;
      else semanticRemoved = layer.removed;
    }
    recordDedupMetrics({
      adapter: options.adapter,
      documentsBefore: docsBefore,
      documentsAfter: docsAfter,
      urlRemoved,
      fingerprintRemoved: fpRemoved,
      semanticRemoved,
    });
  }

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

function retrieveCorpusImpl(
  corpus: PreparedCorpus,
  options: RetrieveCorpusOptionsV3,
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

  let results: RetrievalResult[] = fused.slice(0, topK).map((candidate, index) => {
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

  // Apply constraints if configured
  const constraintWarnings: string[] = [];
  if (options.constraintConfig && options.constraintExtractors && results.length > 0) {
    const constrained = applyConstraints(
      results,
      options.constraintConfig,
      options.constraintExtractors,
    );
    if (constrained.length < results.length) {
      constraintWarnings.push(
        `Constraints filtered ${String(results.length - constrained.length)} result(s)`,
      );
    }
    // Remap constrained results back to RetrievalResult[] with updated scores
    results = constrained.map((c, index) => {
      const original = results[c.originalRank - 1];
      const baseScore = original?.score ?? { fused: 0 };
      return {
        item: c.item,
        score: {
          ...baseScore,
          fused: c.finalScore,
        },
        rank: index + 1,
        constraintScore: c.constraintEvaluation.softScore,
        overallScore: c.finalScore,
        explanation: {
          matched: c.constraintEvaluation.matchedConstraints,
          caveats: c.constraintEvaluation.failedConstraints,
        },
      };
    });
  }

  // Apply smart snippet extraction to result text
  if (options.query && results.length > 0) {
    results = results.map((result) => {
      const snippet = extractSmartSnippet(result.item.text, options.query);
      if (snippet === result.item.text) return result;
      return {
        ...result,
        item: { ...result.item, text: snippet },
      };
    });
  }

  const coverage: Coverage = {
    sourcesAttempted: [corpus.adapter],
    sourcesSucceeded: corpus.status === 'ready' ? [corpus.adapter] : [],
    sourcesPartial: corpus.status === 'partial' ? [corpus.adapter] : [],
    sourcesFailed: corpus.status === 'error' ? [corpus.adapter] : [],
    documentsFound: corpus.documents.length,
    documentsAfterDedup: corpus.documents.length,
    chunksGenerated: corpus.chunks.length,
    embeddingsGenerated: corpus.embeddings?.length ?? 0,
    retrievalTimeMs: 0,
  };

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
    coverage,
    warnings: [...constraintWarnings],
  };
}

export function retrieveCorpus(
  corpus: PreparedCorpus,
  options: RetrieveCorpusOptionsV3,
): RetrievalResponse {
  const startMs = performance.now();
  const result = retrieveCorpusImpl(corpus, options);
  const durationMs = performance.now() - startMs;

  let hardConstraints = 0;
  let softConstraints = 0;
  let passed = 0;
  let filtered = 0;
  if (options.constraintConfig) {
    hardConstraints = options.constraintConfig.hardConstraints.length;
    softConstraints = options.constraintConfig.softConstraints.length;
    // We can't easily know passed/filtered from the result without re-running constraints,
    // but we can infer from warnings
    const constraintWarning = result.warnings?.find((w) => w.startsWith('Constraints filtered'));
    if (constraintWarning) {
      const match = /Constraints filtered (\d+)/.exec(constraintWarning);
      if (match) {
        filtered = Number.parseInt(match[1] ?? '0', 10);
      }
    }
    passed = result.results.length;
  }
  if (options.constraintConfig) {
    recordConstraintMetrics({
      adapter: corpus.adapter,
      hardConstraints,
      softConstraints,
      passed,
      filtered,
    });
  }

  recordRetrievalMetrics({
    adapter: corpus.adapter,
    totalChunks: corpus.chunks.length,
    returnedResults: result.results.length,
    durationMs,
    vectorCandidates: result.trace.vectorCandidates,
    lexicalCandidates: result.trace.lexicalCandidates,
  });

  return result;
}

export function prepareAndRetrieve(
  prepareOptions: PrepareCorpusOptions,
  retrieveOptions: RetrieveCorpusOptions,
): RetrievalResponse {
  const corpus = prepareCorpus(prepareOptions);
  return retrieveCorpus(corpus, retrieveOptions);
}
