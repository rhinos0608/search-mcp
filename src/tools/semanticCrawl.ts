import { logger } from '../logger.js';
import { unavailableError } from '../errors.js';
import { assertSafeUrl } from '../httpGuards.js';
import { webCrawl, type WebCrawlOptions } from './webCrawl.js';
import { webSearch } from './webSearch.js';
import { chunkMarkdown } from '../chunking.js';
import { parseSitemap, isSitemapIndex } from '../utils/sitemap.js';
import { collapseSitemapLocaleDuplicates, rankSitemapUrls } from '../utils/sitemapRanking.js';
import { dedupPages } from '../utils/url.js';
import { isCookieBannerPage } from '../utils/cookieBanner.js';
import { rrfMerge } from '../utils/fusion.js';
import { applySoftLexicalConstraint } from '../utils/lexicalConstraint.js';
import { buildBm25Index, type Bm25Index } from '../utils/bm25.js';
import { getOrBuildCorpus, loadCorpusById, logCorpusQuery } from '../utils/corpusCache.js';
import { embedTexts, embedTextsBatched } from '../rag/embedding.js';
import { prepareCorpus, retrieveCorpus } from '../rag/pipeline.js';
import { enrichChunksBatched } from '../rag/contextualEmbedding.js';
import type { RagChunk } from '../rag/types.js';
import { finalizeStructuredContent } from '../utils/elementHelpers.js';
import { evaluateDomainTrust, type DomainTrustOptions } from '../utils/domainTrust.js';
import { scrubContent } from '../utils/contentScrubber.js';
import { recordOutcome } from '../utils/extractionStats.js';
import { documentFallbackUrls, isDocumentUrl } from '../utils/documentUtils.js';
import { extractDocumentUrl } from '../utils/documentExtraction.js';
import { getUserAgent } from '../version.js';
import type { ContentElement, StructuredContent } from '../types.js';
import type {
  SemanticCrawlResult,
  SemanticCrawlChunk,
  CorpusChunk,
  SemanticCrawlSource,
  CrawlPageResult,
  SemanticCrawlWarning,
  SemanticCrawlPageMetadata,
} from '../types.js';
import type { Crawl4aiConfig, DomainTrustConfig, LlmConfig } from '../config.js';
import { loadConfig } from '../config.js';
import type { ExtractionConfig } from '../utils/extractionConfig.js';
import { createHash } from 'node:crypto';
import {
  SAFE_BYTES,
  DEFAULT_AVG_PAGE_BYTES,
  JS_HEAVY_AVG_PAGE_BYTES,
  isLikelyJsHeavySite,
} from '../utils/crawlBudget.js';

// ── Semantic Coherence Filter ────────────────────────────────────────────

interface ChunkWithEmbedding {
  chunk: SemanticCrawlChunk;
  embedding: number[];
}

export function isBorderline(chunk: SemanticCrawlChunk): boolean {
  const text = chunk.text;
  const linkMatches = text.match(/\[([^\]]+)\]\(([^)]+)\)/g);
  const linkChars = linkMatches ? linkMatches.reduce((sum, m) => sum + m.length, 0) : 0;
  const density = text.length > 0 ? linkChars / text.length : 0;

  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const totalWords = lines.reduce((sum, l) => sum + l.trim().split(/\s+/).length, 0);
  const avgWords = lines.length > 0 ? totalWords / lines.length : 0;

  return (density >= 0.2 && density < 0.4) || (avgWords >= 3 && avgWords < 5);
}

function filterBySemanticCoherence(chunkEmbeddings: ChunkWithEmbedding[]): SemanticCrawlChunk[] {
  if (chunkEmbeddings.length === 0) return [];

  const first = chunkEmbeddings[0];
  if (!first) return [];
  const dim = first.embedding.length;
  const centroid: number[] = new Array<number>(dim).fill(0);
  for (const ce of chunkEmbeddings) {
    for (let d = 0; d < dim; d++) {
      centroid[d] = (centroid[d] ?? 0) + (ce.embedding[d] ?? 0);
    }
  }
  for (let d = 0; d < dim; d++) {
    centroid[d] = (centroid[d] ?? 0) / chunkEmbeddings.length;
  }

  let norm = 0;
  for (let d = 0; d < dim; d++) {
    const v = centroid[d] ?? 0;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let d = 0; d < dim; d++) {
      centroid[d] = (centroid[d] ?? 0) / norm;
    }
  }

  const filtered = chunkEmbeddings.filter((ce) => {
    if (!isBorderline(ce.chunk)) return true;
    const sim = cosineSimilarity(centroid, ce.embedding);
    return sim >= BOILERPLATE_CENTROID_THRESHOLD;
  });

  return filtered.map((ce) => ce.chunk);
}

// ── Embed-and-Rank Shared Helper ────────────────────────────────────────────

const MAX_CHUNKS_SOFT = 2_000;
const MAX_CHUNKS_HARD = 5_000;
const RERANK_CANDIDATES = 30;
const BOILERPLATE_CENTROID_THRESHOLD = 0.2;

interface EmbedAndRankOptions {
  query: string;
  topK: number;
  useReranker?: boolean;
  minScore?: number;
  embeddingBaseUrl: string;
  embeddingApiToken: string;
  embeddingDimensions: number;
  /** Pre-computed chunk embeddings from cache (skip embed step when provided). */
  precomputedEmbeddings?: number[][] | undefined;
  /** Pre-built BM25 index from cache (built inline when not provided). */
  bm25Index?: Bm25Index | undefined;
  structuredWarnings?: SemanticCrawlWarning[] | undefined;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

function normalizeScore(raw: number, min: number, max: number): number {
  if (max === min) return 0;
  return (raw - min) / (max - min);
}

interface RetrieveSemanticChunksOptions {
  query: string;
  topK: number;
  useReranker?: boolean;
  minScore?: number;
  embeddingBaseUrl: string;
  embeddingApiToken: string;
  embeddingDimensions: number;
  precomputedEmbeddings: number[][];
  structuredWarnings?: SemanticCrawlWarning[] | undefined;
}

interface RankingFilterStats {
  beforeCoherence: number;
  afterCoherence: number;
  afterLexical: number;
  afterRerank: number;
  requestedTopK: number;
}

function pushRankingFilterWarning(
  structuredWarnings: SemanticCrawlWarning[] | undefined,
  stats: RankingFilterStats,
): void {
  if (structuredWarnings === undefined) return;
  if (stats.afterRerank >= stats.requestedTopK) return;
  if (stats.beforeCoherence === 0) return;
  const removed = stats.beforeCoherence - stats.afterRerank;
  if (removed < stats.beforeCoherence * 0.5 && stats.afterRerank > 0) return;

  const message =
    `Ranking pipeline returned ${String(stats.afterRerank)} chunks for topK=${String(stats.requestedTopK)}. ` +
    `Candidates: ${String(stats.beforeCoherence)} → coherence ${String(stats.afterCoherence)} → lexical ${String(stats.afterLexical)} → final ${String(stats.afterRerank)}.`;
  structuredWarnings.push({
    code: 'SEMANTIC_CRAWL_RANKING_FILTER',
    message,
    pipeline: stats,
  });
}

export async function retrieveSemanticChunks(
  chunks: CorpusChunk[],
  opts: RetrieveSemanticChunksOptions,
): Promise<SemanticCrawlChunk[]> {
  if (chunks.length === 0) return [];

  const queryResponse = await embedTexts({
    baseUrl: opts.embeddingBaseUrl,
    apiToken: opts.embeddingApiToken,
    texts: [opts.query],
    mode: 'query',
    dimensions: opts.embeddingDimensions,
  });
  const queryEmbedding = queryResponse.embeddings[0];
  if (!queryEmbedding) {
    throw new Error('Embedding sidecar returned empty query embedding');
  }

  const ragChunks = chunks as unknown as RagChunk[];
  const prepared = prepareCorpus({
    adapter: 'text',
    chunks: ragChunks,
    embeddings: opts.precomputedEmbeddings,
  });

  // Fetch all fused candidates for post-filtering (trimmed to topK at the end)
  const response = retrieveCorpus(prepared, {
    query: opts.query,
    queryEmbedding,
    topK: chunks.length,
  });

  if (response.results.length === 0) return [];

  // Compute corpus-level score stats from all fused candidates
  const vectorScores = response.results.map((r) => r.score.vector ?? 0);
  const bm25Scores = response.results.map((r) => r.score.lexical ?? 0);
  const rrfScores = response.results.map((r) => r.score.fused);

  const vecMin = Math.min(...vectorScores);
  const vecMax = Math.max(...vectorScores);
  const vecMedian = median(vectorScores);
  const bm25Min = Math.min(...bm25Scores);
  const bm25Max = Math.max(...bm25Scores);
  const bm25Median = median(bm25Scores);
  const rrfMin = Math.min(...rrfScores);
  const rrfMax = Math.max(...rrfScores);
  const rrfMedian = median(rrfScores);

  // Build lookup: chunkIndex → embedding
  const embeddingByIndex = new Map<number, number[]>();
  for (let i = 0; i < chunks.length; i++) {
    const emb = opts.precomputedEmbeddings[i];
    if (emb !== undefined) embeddingByIndex.set(i, emb);
  }

  // Map retrieval results to SemanticCrawlChunk with full score details
  const scoredChunks: SemanticCrawlChunk[] = response.results.map(({ item, score }) => ({
    text: item.text,
    url: item.url,
    section: item.section,
    charOffset: item.charOffset,
    chunkIndex: item.chunkIndex,
    totalChunks: item.totalChunks,
    scores: {
      biEncoder: {
        raw: score.vector ?? 0,
        normalized: normalizeScore(score.vector ?? 0, vecMin, vecMax),
        corpusMin: vecMin,
        corpusMax: vecMax,
        median: vecMedian,
      },
      bm25: {
        raw: score.lexical ?? 0,
        normalized: normalizeScore(score.lexical ?? 0, bm25Min, bm25Max),
        corpusMin: bm25Min,
        corpusMax: bm25Max,
        median: bm25Median,
      },
      rrf: {
        raw: score.fused,
        normalized: normalizeScore(score.fused, rrfMin, rrfMax),
        corpusMin: rrfMin,
        corpusMax: rrfMax,
        median: rrfMedian,
      },
    },
  }));

  let scoreFiltered = scoredChunks;
  const minScore = opts.minScore;
  if (minScore !== undefined) {
    scoreFiltered = scoredChunks.filter((chunk) => chunk.scores.biEncoder.raw >= minScore);
    if (scoreFiltered.length < scoredChunks.length) {
      opts.structuredWarnings?.push({
        code: 'SEMANTIC_CRAWL_MIN_SCORE_FILTER',
        message: `Filtered ${String(scoredChunks.length - scoreFiltered.length)} chunk(s) below minScore=${String(minScore)}.`,
        minScore,
        removedCount: scoredChunks.length - scoreFiltered.length,
      });
    }
  }

  // Semantic coherence filter (removes off-topic borderline chunks)
  const fusedPaired: ChunkWithEmbedding[] = [];
  for (const chunk of scoreFiltered) {
    const emb = embeddingByIndex.get(chunk.chunkIndex);
    if (emb !== undefined) fusedPaired.push({ chunk, embedding: emb });
  }

  const beforeCoherence = scoreFiltered.length;
  const coherent = fusedPaired.length > 0 ? filterBySemanticCoherence(fusedPaired) : scoreFiltered;
  if (coherent.length < scoreFiltered.length) {
    logger.info(
      { before: scoreFiltered.length, after: coherent.length },
      'Semantic coherence filter removed off-topic chunks',
    );
  }

  // Soft lexical constraint (IDF-weighted token coverage)
  const lexicalResult = applySoftLexicalConstraint(coherent, opts.query, chunks);
  if (lexicalResult.warning) {
    logger.warn(lexicalResult.warning);
  }
  if (lexicalResult.filtered.length < coherent.length) {
    logger.info(
      { before: coherent.length, after: lexicalResult.filtered.length },
      'Soft lexical constraint filtered chunks',
    );
  }
  const afterLexical =
    lexicalResult.filtered.length >= opts.topK ? lexicalResult.filtered : coherent;

  // Optional cross-encoder reranking
  let topChunks: SemanticCrawlChunk[];
  if (opts.useReranker === true && afterLexical.length > 1) {
    topChunks = await applyReranking(
      opts.query,
      afterLexical.slice(0, Math.min(RERANK_CANDIDATES, afterLexical.length)),
      opts.topK,
    );
  } else {
    topChunks = afterLexical.slice(0, opts.topK);
  }

  pushRankingFilterWarning(opts.structuredWarnings, {
    beforeCoherence,
    afterCoherence: coherent.length,
    afterLexical: afterLexical.length,
    afterRerank: topChunks.length,
    requestedTopK: opts.topK,
  });
  return topChunks;
}

export async function embedAndRank(
  chunks: CorpusChunk[],
  opts: EmbedAndRankOptions,
): Promise<SemanticCrawlChunk[]> {
  if (chunks.length === 0) return [];

  // 1. Chunk safety check
  if (chunks.length > MAX_CHUNKS_HARD) {
    throw new Error(
      `Produced ${String(chunks.length)} chunks, exceeding hard cap of ${String(MAX_CHUNKS_HARD)}. Reduce maxPages or increase chunk size.`,
    );
  }
  if (chunks.length > MAX_CHUNKS_SOFT) {
    logger.warn(
      { chunkCount: chunks.length, softCap: MAX_CHUNKS_SOFT },
      'Chunk count exceeds soft cap; embedding may be slower',
    );
  }

  // 2. Embed chunks (batched) and query in parallel
  const chunkTexts = chunks.map((c) => c.text);
  const chunkTitles = chunks.map(
    (c) =>
      c.section
        .split(' > ')
        .at(-1)
        ?.replace(/^#+\s+/, '') ?? 'none',
  );

  if (opts.precomputedEmbeddings !== undefined) {
    if (opts.precomputedEmbeddings.length !== chunks.length) {
      throw new Error(
        `precomputedEmbeddings length (${String(opts.precomputedEmbeddings.length)}) does not match chunk count (${String(chunks.length)}). Pass already-deduplicated chunks.`,
      );
    }
  }

  const queryEmbedPromise = embedTexts({
    baseUrl: opts.embeddingBaseUrl,
    apiToken: opts.embeddingApiToken,
    texts: [opts.query],
    mode: 'query',
    dimensions: opts.embeddingDimensions,
  });

  let chunkEmbeddings: number[][];
  if (opts.precomputedEmbeddings !== undefined) {
    chunkEmbeddings = opts.precomputedEmbeddings;
  } else {
    const [{ embeddings }] = await Promise.all([
      embedTextsBatched({
        baseUrl: opts.embeddingBaseUrl,
        apiToken: opts.embeddingApiToken,
        texts: chunkTexts,
        mode: 'document',
        dimensions: opts.embeddingDimensions,
        titles: chunkTitles,
      }),
      queryEmbedPromise,
    ]);
    chunkEmbeddings = embeddings;
  }

  const queryResponse = await queryEmbedPromise;
  const queryEmbedding = queryResponse.embeddings[0];
  if (!queryEmbedding) {
    throw new Error('Embedding sidecar returned empty query embedding');
  }

  // 4. Bi-encoder ranking (cosine similarity)
  const paired: ChunkWithEmbedding[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const emb = chunkEmbeddings[i];
    if (!chunk || emb === undefined) continue;
    paired.push({
      chunk: {
        text: chunk.text,
        url: chunk.url,
        section: chunk.section,
        charOffset: chunk.charOffset,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        scores: {
          biEncoder: {
            raw: 0,
            normalized: 0,
            corpusMin: 0,
            corpusMax: 0,
            median: 0,
          },
          bm25: {
            raw: 0,
            normalized: 0,
            corpusMin: 0,
            corpusMax: 0,
            median: 0,
          },
          rrf: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
        },
      },
      embedding: emb,
    });
  }

  for (const p of paired) {
    p.chunk.scores.biEncoder.raw = cosineSimilarity(queryEmbedding, p.embedding);
  }
  paired.sort((a, b) => b.chunk.scores.biEncoder.raw - a.chunk.scores.biEncoder.raw);

  // Compute bi-encoder score stats
  const biScores = paired.map((p) => p.chunk.scores.biEncoder.raw);
  const biMin = biScores.length > 0 ? Math.min(...biScores) : 0;
  const biMax = biScores.length > 0 ? Math.max(...biScores) : 0;
  const biMedian = median(biScores);

  // 5. BM25+ ranking
  const bm25 =
    opts.bm25Index ??
    buildBm25Index(
      chunks.map((c) => ({
        id: c.url + ':' + String(c.chunkIndex),
        text: c.text,
      })),
    );

  const idToChunk = new Map<string, SemanticCrawlChunk>();
  for (const p of paired) {
    idToChunk.set(p.chunk.url + ':' + String(p.chunk.chunkIndex), p.chunk);
  }

  const bm25Scores = bm25.search(opts.query);
  const bm25ScoresMap = new Map<string, number>();
  for (const { id, score } of bm25Scores) {
    bm25ScoresMap.set(id, score);
  }

  const bm25Min = bm25Scores.length > 0 ? Math.min(...bm25Scores.map((s) => s.score)) : 0;
  const bm25Max = bm25Scores.length > 0 ? Math.max(...bm25Scores.map((s) => s.score)) : 0;
  const bm25Median = median(bm25Scores.map((s) => s.score));

  // 6. RRF candidate pool restriction
  // Bi-encoder pool: max(topK * 3, 30)
  // BM25 pool: topK only — BM25 is more promiscuous on noisy corpora.
  const poolSize = Math.max(opts.topK * 3, 30);
  const biEncoderTopN = paired.slice(0, poolSize).map((p) => p.chunk);

  // Re-use bm25Scores for topK extraction (avoids double search call)
  const bm25TopKResults = bm25Scores.slice(0, opts.topK);
  const bm25TopK: SemanticCrawlChunk[] = [];
  for (const { id } of bm25TopKResults) {
    const c = idToChunk.get(id);
    if (c) bm25TopK.push(c);
  }

  const fused = rrfMerge([biEncoderTopN, bm25TopK], {
    k: 60,
    keyFn: (item) => item.url + '|' + item.text,
  });

  // Compute RRF score stats
  const rrfScores = fused.map((f) => f.rrfScore);
  const rrfMin = rrfScores.length > 0 ? Math.min(...rrfScores) : 0;
  const rrfMax = rrfScores.length > 0 ? Math.max(...rrfScores) : 0;
  const rrfMedian = median(rrfScores);

  logger.info(
    {
      biEncoderCount: biEncoderTopN.length,
      bm25Count: bm25TopK.length,
      fusedCount: fused.length,
      poolSize,
    },
    'RRF fusion completed with restricted candidate pool',
  );

  // 7. Attach scores to fused chunks
  const scoredChunks: SemanticCrawlChunk[] = [];
  for (const { item, rrfScore } of fused) {
    const biRaw = item.scores.biEncoder.raw;
    const bm25Raw = bm25ScoresMap.get(item.url + ':' + String(item.chunkIndex)) ?? 0;

    scoredChunks.push({
      ...item,
      scores: {
        biEncoder: {
          raw: biRaw,
          normalized: normalizeScore(biRaw, biMin, biMax),
          corpusMin: biMin,
          corpusMax: biMax,
          median: biMedian,
        },
        bm25: {
          raw: bm25Raw,
          normalized: normalizeScore(bm25Raw, bm25Min, bm25Max),
          corpusMin: bm25Min,
          corpusMax: bm25Max,
          median: bm25Median,
        },
        rrf: {
          raw: rrfScore,
          normalized: normalizeScore(rrfScore, rrfMin, rrfMax),
          corpusMin: rrfMin,
          corpusMax: rrfMax,
          median: rrfMedian,
        },
      },
    });
  }

  let scoreFiltered = scoredChunks;
  const minScore = opts.minScore;
  if (minScore !== undefined) {
    scoreFiltered = scoredChunks.filter((chunk) => chunk.scores.biEncoder.raw >= minScore);
    if (scoreFiltered.length < scoredChunks.length) {
      opts.structuredWarnings?.push({
        code: 'SEMANTIC_CRAWL_MIN_SCORE_FILTER',
        message: `Filtered ${String(scoredChunks.length - scoreFiltered.length)} chunk(s) below minScore=${String(minScore)}.`,
        minScore,
        removedCount: scoredChunks.length - scoreFiltered.length,
      });
    }
  }

  // 8. Semantic coherence filter (borderline off-topic chunks)
  const chunkToEmbedding = new Map<string, number[]>();
  for (const p of paired) {
    chunkToEmbedding.set(p.chunk.url + '|' + p.chunk.text, p.embedding);
  }

  const fusedPaired: ChunkWithEmbedding[] = [];
  for (const chunk of scoreFiltered) {
    const emb = chunkToEmbedding.get(chunk.url + '|' + chunk.text);
    if (emb) {
      fusedPaired.push({ chunk, embedding: emb });
    }
  }

  const beforeCoherence = scoreFiltered.length;
  const coherent = fusedPaired.length > 0 ? filterBySemanticCoherence(fusedPaired) : scoreFiltered;
  if (coherent.length < fusedPaired.length) {
    logger.info(
      { before: fusedPaired.length, after: coherent.length },
      'Semantic coherence filter removed off-topic chunks',
    );
  }

  // 9. Soft lexical constraint (IDF-weighted token coverage)
  const lexicalResult = applySoftLexicalConstraint(coherent, opts.query, chunks);
  if (lexicalResult.warning) {
    logger.warn(lexicalResult.warning);
  }
  if (lexicalResult.filtered.length < coherent.length) {
    logger.info(
      { before: coherent.length, after: lexicalResult.filtered.length },
      'Soft lexical constraint filtered chunks',
    );
  }
  const afterLexical =
    lexicalResult.filtered.length >= opts.topK ? lexicalResult.filtered : coherent;

  // 9. Optional cross-encoder re-ranking (opt-in, default false)
  let topChunks: SemanticCrawlChunk[];

  if (opts.useReranker === true && afterLexical.length > 1) {
    const rerankCount = Math.min(RERANK_CANDIDATES, afterLexical.length);
    const candidates = afterLexical.slice(0, rerankCount);
    const candidateTexts = candidates.map((c) => c.text);

    try {
      const { rerank } = await import('../utils/rerank.js');
      const reranked = await rerank(opts.query, candidateTexts, {
        topK: opts.topK,
      });

      const rerankScores = reranked.map((r) => r.score);
      const rerankMin = Math.min(...rerankScores);
      const rerankMax = Math.max(...rerankScores);
      const rerankMedian = median(rerankScores);

      topChunks = [];
      for (let rankIdx = 0; rankIdx < reranked.length; rankIdx++) {
        const r = reranked[rankIdx];
        if (!r) continue;
        const candidate = candidates[r.index];
        if (!candidate) continue;
        topChunks.push({
          ...candidate,
          scores: {
            ...candidate.scores,
            rerank: {
              raw: r.score,
              normalized: normalizeScore(r.score, rerankMin, rerankMax),
              corpusMin: rerankMin,
              corpusMax: rerankMax,
              median: rerankMedian,
              medianDelta: r.score - rerankMedian,
              rank: rankIdx + 1,
            },
          },
        });
      }
      logger.info({ topK: opts.topK, candidates: rerankCount }, 'Cross-encoder re-ranking applied');
    } catch (err) {
      logger.warn({ err }, 'Cross-encoder re-ranking failed, falling back to bi-encoder ranking');
      topChunks = candidates.slice(0, opts.topK);
    }
  } else {
    topChunks = afterLexical.slice(0, opts.topK);
  }

  pushRankingFilterWarning(opts.structuredWarnings, {
    beforeCoherence,
    afterCoherence: coherent.length,
    afterLexical: afterLexical.length,
    afterRerank: topChunks.length,
    requestedTopK: opts.topK,
  });

  return topChunks;
}

export async function applyReranking(
  query: string,
  candidates: SemanticCrawlChunk[],
  topK: number,
): Promise<SemanticCrawlChunk[]> {
  if (candidates.length <= topK) {
    return candidates;
  }
  try {
    const { rerank } = await import('../utils/rerank.js');
    const candidateTexts = candidates.map((c) => c.text);
    const reranked = await rerank(query, candidateTexts, { topK });

    const rerankScores = reranked.map((r) => r.score);
    const rerankMin = Math.min(...rerankScores);
    const rerankMax = Math.max(...rerankScores);
    const rerankMedian = median(rerankScores);

    return reranked.map((r, rankIdx) => {
      const candidate = candidates[r.index];
      if (!candidate) {
        throw new Error(`Reranker returned invalid index ${String(r.index)}`);
      }
      return {
        ...candidate,
        scores: {
          ...candidate.scores,
          rerank: {
            raw: r.score,
            normalized: normalizeScore(r.score, rerankMin, rerankMax),
            corpusMin: rerankMin,
            corpusMax: rerankMax,
            median: rerankMedian,
            medianDelta: r.score - rerankMedian,
            rank: rankIdx + 1,
          },
        },
      };
    });
  } catch (err) {
    logger.warn({ err }, 'Cross-encoder re-ranking failed, falling back to bi-encoder ranking');
    return candidates.slice(0, topK);
  }
}

function deduplicateCorpusChunks(chunks: CorpusChunk[]): CorpusChunk[] {
  const seen = new Set<string>();
  return chunks.filter((c) => {
    const normalized = c.text.trim().toLowerCase().replace(/\s+/g, ' ');
    const hash = createHash('sha256').update(normalized).digest('hex');
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Source Helpers ────────────────────────────────────────────────────────

/** SSRF-validate every URL in a list, dropping unsafe ones. */
export function filterSafeUrls(urls: string[], trustConfig?: DomainTrustConfig): string[] {
  const safe: string[] = [];
  const trustOptions: DomainTrustOptions | undefined =
    trustConfig?.enabled === true
      ? {
          trustedDomains: trustConfig.trustedDomains,
          blockedDomains: trustConfig.blockedDomains,
        }
      : undefined;

  for (const u of urls) {
    try {
      assertSafeUrl(u);
      if (!trustConfig?.enabled) {
        safe.push(u);
        continue;
      }

      const trust = evaluateDomainTrust(u, trustOptions);
      if (trust.tier === 'blocked') {
        logger.warn({ url: u, trust }, 'semantic_crawl: dropping blocked adapter URL');
        continue;
      }
      if (trust.tier === 'suspicious') {
        logger.warn({ url: u, trust }, 'semantic_crawl: suspicious adapter URL');
      }
      safe.push(u);
    } catch {
      logger.warn({ url: u }, 'semantic_crawl: dropping unsafe adapter URL');
    }
  }
  return safe;
}

function safeRecordOutcomeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Divide a numeric budget across N seeds, with a floor of 1. */
function divideBudget(total: number, seeds: number): number {
  return Math.max(1, Math.ceil(total / seeds));
}

/**
 * Run async functions with a concurrency limit.
 * Results are returned in input order; rejections are surfaced immediately.
 */
async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const queue = items.map((item, i) => ({ item, i }));

  const worker = async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry === undefined) break;
      results[entry.i] = await fn(entry.item, entry.i);
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Format an unknown error value into a human-readable string. */
function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return '[unserializable error]';
    }
  }
  // Primitive fallback: number, boolean, symbol, null, undefined
  return typeof err === 'string' ? err : String(err);
}

export function isDirectChild(pagePath: string, seedPath: string): boolean {
  const seedParts = seedPath.split('/').filter(Boolean);
  const pageParts = pagePath.split('/').filter(Boolean);
  return (
    pageParts.length === seedParts.length + 1 &&
    pageParts.slice(0, seedParts.length).join('/') === seedParts.join('/')
  );
}

export function filterByPathPrefix(
  pages: CrawlPageResult[],
  seedUrl: string,
  allowPathDrift = false,
): {
  kept: CrawlPageResult[];
  droppedCount: number;
  malformedCount: number;
  droppedUrls: string[];
} {
  if (allowPathDrift) {
    return { kept: pages, droppedCount: 0, malformedCount: 0, droppedUrls: [] };
  }
  let seedPath: string;
  try {
    seedPath = new URL(seedUrl).pathname;
  } catch {
    logger.warn({ url: seedUrl }, 'semantic_crawl: invalid seed URL; skipping path filter');
    return { kept: pages, droppedCount: 0, malformedCount: 0, droppedUrls: [] };
  }
  const prefix = seedPath.endsWith('/') ? seedPath : `${seedPath}/`;
  const kept: CrawlPageResult[] = [];
  const droppedUrls: string[] = [];
  let dropped = 0;
  let malformed = 0;
  for (const page of pages) {
    let pagePath: string;
    try {
      pagePath = new URL(page.url).pathname;
    } catch {
      logger.warn({ url: page.url }, 'semantic_crawl: dropping page with malformed URL');
      malformed++;
      droppedUrls.push(page.url);
      continue;
    }
    if (pagePath === seedPath || pagePath.startsWith(prefix)) {
      kept.push(page);
    } else {
      dropped++;
      droppedUrls.push(page.url);
    }
  }
  if (dropped > 0 || malformed > 0) {
    logger.info(
      { dropped, malformed, seedPath },
      'semantic_crawl: dropped pages outside seed path or with malformed URLs',
    );
  }
  return { kept, droppedCount: dropped, malformedCount: malformed, droppedUrls };
}

export type SemanticCrawlSeedsOptions = Pick<
  SemanticCrawlOptions,
  | 'strategy'
  | 'maxDepth'
  | 'maxPages'
  | 'includeExternalLinks'
  | 'maxBytes'
  | 'allowPathDrift'
  | 'waitFor'
  | 'delayBeforeReturnHtml'
  | 'pageTimeout'
  | 'jsCode'
  | 'extractionConfig'
  | 'llmFallback'
> & { sourceType?: 'url' | 'sitemap' | 'search' | 'github' | 'cached' };

/** Crawl a list of seed URLs with per-seed budget division and sequential budget tracking. */
export async function crawlSeeds(
  seedUrls: string[],
  crawl4aiCfg: Crawl4aiConfig,
  opts: SemanticCrawlSeedsOptions,
): Promise<{
  pages: CrawlPageResult[];
  totalPages: number;
  successfulPages: number;
  warnings: string[];
  structuredWarnings: SemanticCrawlWarning[];
  omittedPages: { url: string; reason: string; estimatedBytes?: number }[];
}> {
  if (seedUrls.length === 0) {
    return {
      pages: [],
      totalPages: 0,
      successfulPages: 0,
      warnings: [],
      structuredWarnings: [],
      omittedPages: [],
    };
  }

  if (!crawl4aiCfg.baseUrl) {
    throw unavailableError(
      'crawl4ai sidecar is not configured. Set CRAWL4AI_BASE_URL to enable semantic_crawl.',
    );
  }

  const allPages: CrawlPageResult[] = [];
  const warnings: string[] = [];
  const structuredWarnings: SemanticCrawlWarning[] = [];
  const omittedPages: {
    url: string;
    reason: string;
    estimatedBytes?: number;
  }[] = [];
  let totalPagesFromCrawler = 0;

  // ── Preflight size guard ──────────────────────────────────────────────────
  const firstSeedUrl = seedUrls[0];
  if (firstSeedUrl === undefined) {
    throw new Error('No seed URLs provided for preflight size guard');
  }
  const heavy = isLikelyJsHeavySite({
    sourceType: opts.sourceType ?? 'url',
    url: firstSeedUrl,
  });
  const avgPageBytes = heavy ? JS_HEAVY_AVG_PAGE_BYTES : DEFAULT_AVG_PAGE_BYTES;
  const estimatedTotalBytes = opts.maxPages * avgPageBytes;

  let resolvedMaxPages = opts.maxPages;
  if (estimatedTotalBytes > SAFE_BYTES) {
    const safeCap = Math.max(1, Math.floor(SAFE_BYTES / avgPageBytes));
    const requestedMaxPages = opts.maxPages;
    resolvedMaxPages = safeCap;
    const msg: string =
      `semantic_crawl: maxPages ${String(requestedMaxPages)} may exceed the response size limit; ` +
      `capped to ${String(safeCap)} pages to avoid truncation.`;
    structuredWarnings.push({
      code: 'SEMANTIC_CRAWL_RESPONSE_SIZE_GUARD',
      message: msg,
      requestedMaxPages,
      cappedMaxPages: safeCap,
      estimatedBytes: estimatedTotalBytes,
      safeBytes: SAFE_BYTES,
      avgPageBytes,
    });
    warnings.push(msg);
    logger.warn(
      { requestedMaxPages, safeCap, estimatedTotalBytes, heavy },
      'semantic_crawl: preflight size guard capped maxPages',
    );
  }

  // ── Concurrent crawl with pre-divided budget ────────────────────────────
  const numSeeds = seedUrls.length;
  const targetPageMode = opts.sourceType === 'search' || opts.sourceType === 'sitemap';
  const perSeedPages = targetPageMode ? 1 : divideBudget(resolvedMaxPages, numSeeds);
  const perSeedBytes =
    opts.maxBytes !== undefined && !targetPageMode
      ? divideBudget(opts.maxBytes, numSeeds)
      : undefined;

  if (numSeeds > 1 && !targetPageMode) {
    const msg =
      `semantic_crawl: maxPages is a total budget divided across ${String(numSeeds)} seed URLs ` +
      `(${String(perSeedPages)} pages per seed).`;
    warnings.push(msg);
    structuredWarnings.push({
      code: 'SEMANTIC_CRAWL_BUDGET_DIVISION',
      message: msg,
      seedCount: numSeeds,
      requestedMaxPages: resolvedMaxPages,
      pagesPerSeed: perSeedPages,
    });
  }

  // Run all seed crawls concurrently (up to 4 in parallel) to avoid sequential
  // timeouts compounding when many seeds are provided.
  const crawlResults = await concurrentMap(
    seedUrls,
    async (seedUrl: string) => {
      // ── Document URL extraction (text docs only) ────────────────────
      if (isDocumentUrl(seedUrl)) {
        const docResult = await extractDocumentUrl(
          seedUrl,
          opts.pageTimeout === undefined ? undefined : { timeoutMs: opts.pageTimeout },
        );
        if (docResult.success && docResult.markdown.trim().length > 0) {
          const page: import('../types.js').CrawlPageResult = {
            url: seedUrl,
            success: true,
            markdown: docResult.markdown,
            title: null,
            description: null,
            links: [],
            statusCode: null,
            errorMessage: null,
          };
          const result: import('../types.js').WebCrawlResult = {
            seedUrl,
            strategy: opts.strategy,
            maxDepth: opts.maxDepth,
            maxPages: 1,
            totalPages: 1,
            successfulPages: 1,
            pages: [page],
          };
          return { seedUrl, result, error: undefined as unknown };
        }
        // binary or failed — fall through to Crawl4AI
        logger.debug(
          { seedUrl, unsupported: docResult.unsupported },
          'semantic_crawl: document URL extraction skipped or failed, falling back to Crawl4AI',
        );
      }

      const crawlOpts: WebCrawlOptions = {
        strategy: opts.strategy,
        maxDepth: opts.maxDepth,
        maxPages: perSeedPages,
        includeExternalLinks: opts.includeExternalLinks,
        ...(perSeedBytes !== undefined ? { maxBytes: perSeedBytes } : {}),
        ...(opts.waitFor !== undefined ? { waitFor: opts.waitFor } : {}),
        ...(opts.delayBeforeReturnHtml !== undefined
          ? { delayBeforeReturnHtml: opts.delayBeforeReturnHtml }
          : {}),
        ...(opts.pageTimeout !== undefined ? { pageTimeout: opts.pageTimeout } : {}),
        ...(opts.jsCode !== undefined ? { jsCode: opts.jsCode } : {}),
        ...(opts.extractionConfig !== undefined ? { extractionConfig: opts.extractionConfig } : {}),
        ...(opts.llmFallback !== undefined ? { llmFallback: opts.llmFallback } : {}),
      };
      try {
        const result = await webCrawl(
          seedUrl,
          crawl4aiCfg.baseUrl,
          crawl4aiCfg.apiToken ?? '',
          crawlOpts,
        );
        return { seedUrl, result, error: undefined as unknown };
      } catch (err: unknown) {
        if (isDocumentUrl(seedUrl)) {
          for (const fallbackUrl of documentFallbackUrls(seedUrl)) {
            try {
              assertSafeUrl(fallbackUrl);
              const fallbackResult = await webCrawl(
                fallbackUrl,
                crawl4aiCfg.baseUrl,
                crawl4aiCfg.apiToken ?? '',
                crawlOpts,
              );
              if (fallbackResult.successfulPages > 0) {
                const msg = `semantic_crawl: document URL failed to crawl; fell back from ${seedUrl} to ${fallbackUrl}`;
                warnings.push(msg);
                structuredWarnings.push({
                  code: 'SEMANTIC_CRAWL_DOCUMENT_FALLBACK',
                  message: msg,
                  originalUrl: seedUrl,
                  fallbackUrl,
                });
                return {
                  seedUrl: fallbackUrl,
                  result: fallbackResult,
                  error: undefined as unknown,
                };
              }
            } catch (fallbackErr: unknown) {
              logger.warn(
                { err: fallbackErr, seedUrl, fallbackUrl },
                'semantic_crawl: document fallback crawl failed',
              );
            }
          }
        }
        logger.warn({ err, seedUrl }, 'semantic_crawl: seed crawl failed');
        return { seedUrl, result: undefined, error: err };
      }
    },
    Math.min(numSeeds, 4),
  );

  // Post-process results (seed order preserved)
  let accumulatedBytes = 0;
  let sizeLimitReached = false;

  for (const entry of crawlResults) {
    if (entry.error !== undefined) {
      const errMsg = formatUnknownError(entry.error);
      warnings.push(`semantic_crawl: seed crawl failed for ${entry.seedUrl}: ${errMsg}`);
      continue;
    }

    const result = entry.result;
    if (result === undefined) continue;
    warnings.push(...(result.warnings ?? []));

    // Path focus filter
    const pathFilter = filterByPathPrefix(
      result.pages,
      entry.seedUrl,
      opts.allowPathDrift ?? false,
    );
    let pages = pathFilter.kept;
    if (pathFilter.droppedCount > 0) {
      structuredWarnings.push({
        code: 'SEMANTIC_CRAWL_PATH_DRIFT_FILTERED',
        message: `Dropped ${String(pathFilter.droppedCount)} page(s) outside the seed path for ${entry.seedUrl}.`,
        seedUrl: entry.seedUrl,
        droppedCount: pathFilter.droppedCount,
        droppedUrls: pathFilter.droppedUrls.slice(0, 10),
      });
      omittedPages.push(
        ...pathFilter.droppedUrls.map((url) => ({
          url,
          reason: 'path_prefix_filtered',
        })),
      );
    }

    // maxPages client-side enforcement (guarantee seed-first, then truncate)
    const seedIdx = pages.findIndex((p) => p.url === entry.seedUrl);
    if (seedIdx > 0) {
      const [seedPage] = pages.splice(seedIdx, 1);
      if (seedPage) pages.unshift(seedPage);
    }
    if (pages.length > perSeedPages) {
      logger.warn(
        { requested: perSeedPages, received: pages.length, seedUrl: entry.seedUrl },
        'semantic_crawl: crawl4ai returned more pages than requested; truncating client-side',
      );
      pages = pages.slice(0, perSeedPages);
    }

    // In-flight byte accumulator (applied post-hoc since crawls ran concurrently)
    for (const page of pages) {
      if (sizeLimitReached) {
        omittedPages.push({
          url: page.url,
          reason: 'response_size_budget_exceeded',
          estimatedBytes: Buffer.byteLength(page.markdown, 'utf8'),
        });
        continue;
      }

      const pageBytes = Buffer.byteLength(page.markdown, 'utf8');
      if (accumulatedBytes + pageBytes > SAFE_BYTES) {
        omittedPages.push({
          url: page.url,
          reason: 'response_size_budget_exceeded',
          estimatedBytes: pageBytes,
        });
        sizeLimitReached = true;
        const limitMsg: string =
          `semantic_crawl stopped after ${String(allPages.length)} pages because ` +
          `the response was approaching the size limit.`;
        structuredWarnings.push({
          code: 'SEMANTIC_CRAWL_RESPONSE_SIZE_LIMIT_APPROACHED',
          message: limitMsg,
          requestedMaxPages: opts.maxPages,
          pagesReturned: allPages.length,
          safeBytes: SAFE_BYTES,
          accumulatedBytes,
        });
        warnings.push(limitMsg);
        logger.warn(
          {
            pagesReturned: allPages.length,
            accumulatedBytes,
            safeBytes: SAFE_BYTES,
          },
          'semantic_crawl: in-flight size limit reached; stopping accumulation',
        );
        continue;
      }

      allPages.push(page);
      accumulatedBytes += pageBytes;
    }

    totalPagesFromCrawler += result.totalPages;
  }

  // Deduplicate by URL across all seeds
  const beforeDedup = allPages.length;
  const deduped = dedupPages(allPages);
  if (deduped.length < beforeDedup) {
    logger.info(
      { before: beforeDedup, after: deduped.length },
      'Multi-URL crawl deduplicated pages by URL',
    );
  }

  return {
    pages: deduped,
    totalPages: totalPagesFromCrawler,
    successfulPages: deduped.filter((p) => p.success).length,
    warnings,
    structuredWarnings,
    omittedPages,
  };
}

/** Known consent/tracking domains that 404 pages commonly redirect to. */
const CONSENT_WALL_DOMAINS = [
  'consent.google.com',
  'consent.youtube.com',
  'consent.google.co.uk',
  'consent.google.de',
  'consent.google.fr',
  'consent.google.ca',
  'consent.google.com.au',
  'privacy.google.com',
  'policies.google.com',
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'www.facebook.com/cookie',
];

/**
 * Detect pages that redirected to a consent wall (e.g. 404 → cookie consent).
 * This catches the pattern where a dead URL redirects to a consent/tracking page
 * whose content would otherwise produce boilerplate chunks that lexically match queries.
 */
function isConsentWallRedirect(pageUrl: string, markdown: string): boolean {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    const isConsentDomain = CONSENT_WALL_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith('.' + d),
    );
    if (isConsentDomain) return true;
  } catch {
    // malformed URL — skip check
  }

  // Check for consent-wall page titles (common after 404→consent redirects)
  const titleMatch = /^#\s+(.+)$/m.exec(markdown);
  if (titleMatch?.[1]) {
    const title = titleMatch[1].toLowerCase();
    if (
      /before you continue/i.test(title) ||
      /cookie.*choice/i.test(title) ||
      /privacy.*check/i.test(title) ||
      /your.*privacy/i.test(title) ||
      /verify.*human/i.test(title)
    ) {
      return true;
    }
  }

  return false;
}

export function pagesToCorpus(
  pages: CrawlPageResult[],
  scrub?: boolean,
  maxTokens?: number,
): CorpusChunk[] {
  const cfg = scrub ?? loadConfig().scrubContent;
  const chunks: CorpusChunk[] = [];
  let pagesWithContent = 0;
  let droppedBannerPages = 0;
  let droppedErrorPages = 0;
  let scrubbedCount = 0;
  let threatDetections = 0;

  for (const page of pages) {
    if (!page.success || !page.markdown) continue;

    // Drop pages with 4xx status codes — these are error pages, not content.
    // The crawler follows redirects, so a 404 that redirects to a consent wall
    // will have the consent wall's content but still report the 4xx status.
    if (page.statusCode !== null && page.statusCode >= 400 && page.statusCode < 500) {
      droppedErrorPages++;
      logger.debug(
        { url: page.url, statusCode: page.statusCode },
        'Dropping page with 4xx status code',
      );
      continue;
    }

    // Detect consent-wall redirects: a page whose URL was redirected to a
    // known consent/analytics/tracking domain. These produce boilerplate
    // chunks that lexically match many queries.
    if (isConsentWallRedirect(page.url, page.markdown)) {
      droppedBannerPages++;
      logger.debug({ url: page.url }, 'Dropping page that redirected to consent wall');
      continue;
    }

    if (isCookieBannerPage(page.markdown)) {
      droppedBannerPages++;
      continue;
    }

    let markdown = page.markdown;
    if (cfg) {
      const result = scrubContent(page.markdown);
      if (!result.clean) {
        scrubbedCount++;
        threatDetections += result.threats.length;
      }
      markdown = result.content;
    }

    const mdChunks = chunkMarkdown(
      markdown,
      page.url,
      maxTokens !== undefined ? { maxTokens } : undefined,
    );
    if (mdChunks.length === 0) continue;
    pagesWithContent++;
    chunks.push(
      ...mdChunks.map((c) => ({
        text: c.content,
        url: c.url,
        section: c.section,
        charOffset: c.charOffset,
        chunkIndex: c.chunkIndex,
        totalChunks: c.totalChunks,
      })),
    );
  }
  if (droppedBannerPages > 0 || droppedErrorPages > 0) {
    logger.warn(
      { droppedBannerPages, droppedErrorPages, totalPages: pages.length },
      'Dropped cookie-banner and error pages before chunking',
    );
  }
  if (scrubbedCount > 0) {
    logger.warn(
      { scrubbedCount, threatDetections, totalPages: pages.length },
      'Content scrubbing redacted threats in pages before chunking',
    );
  }
  if (
    pagesWithContent <
    pages.filter((p) => p.success).length - droppedBannerPages - droppedErrorPages
  ) {
    logger.info(
      {
        pagesWithContent,
        successfulPages:
          pages.filter((p) => p.success).length - droppedBannerPages - droppedErrorPages,
      },
      'Some successfully crawled pages produced no meaningful chunks (likely boilerplate or empty)',
    );
  }
  return chunks;
}

/** Collects and merges structured elements from all successful pages. */
export function collectPageElements(
  pages: CrawlPageResult[],
  elementsLimit?: number,
): StructuredContent {
  const allElements: ContentElement[] = [];
  let omittedCount = 0;
  for (const page of pages) {
    if (!page.success || !page.elements) continue;
    for (const el of page.elements) {
      if (el.type === 'text' && 'truncated' in el) {
        omittedCount++;
        continue;
      }
      allElements.push(el);
    }
  }

  const limitedElements =
    elementsLimit !== undefined && allElements.length > elementsLimit
      ? allElements.slice(0, elementsLimit)
      : allElements;
  const limitOmitted = allElements.length - limitedElements.length;
  const merged = finalizeStructuredContent(limitedElements);
  const totalOmitted = omittedCount + limitOmitted + (merged.omittedElementCount ?? 0);
  if (totalOmitted > 0) {
    const keptCount = merged.elements?.length ?? 0;
    return {
      ...merged,
      originalElementCount: keptCount + totalOmitted,
      omittedElementCount: totalOmitted,
    };
  }
  return merged;
}

// ── Extracted Data Aggregation ───────────────────────────────────────────

function aggregateExtractedData(
  pages: CrawlPageResult[],
): Record<string, Record<string, unknown>[]> | undefined {
  const byUrl: Record<string, Record<string, unknown>[]> = {};
  for (const page of pages) {
    if (page.extractedData !== undefined && page.extractedData.length > 0) {
      byUrl[page.url] = page.extractedData;
    }
  }
  return Object.keys(byUrl).length > 0 ? byUrl : undefined;
}

function detectPageQuality(page: CrawlPageResult): {
  paywallSuspected: boolean;
  loginWallSuspected: boolean;
  truncatedSuspected: boolean;
  consentWallSuspected: boolean;
} {
  const normalized = page.markdown.toLowerCase();
  const paywallSuspected =
    /subscribe to read|become a subscriber|members only|premium content|paywall/i.test(
      normalized,
    ) ||
    (Buffer.byteLength(page.markdown, 'utf8') < 800 &&
      /subscribe|sign up|membership/i.test(normalized));
  const loginWallSuspected =
    /sign in to continue|log in to continue|create an account|please sign in|please log in/i.test(
      normalized,
    );
  const truncatedSuspected =
    Buffer.byteLength(page.markdown, 'utf8') < 800 &&
    /continue reading|read more|subscribe|sign in/i.test(normalized);
  const consentWallSuspected = isConsentWallRedirect(page.url, page.markdown);
  return {
    paywallSuspected,
    loginWallSuspected,
    truncatedSuspected,
    consentWallSuspected,
  };
}

function buildPageMetadata(
  pages: CrawlPageResult[],
  corpusChunks: CorpusChunk[],
  topChunks: SemanticCrawlChunk[],
): SemanticCrawlPageMetadata[] {
  const chunkCounts = new Map<string, number>();
  for (const chunk of corpusChunks) {
    chunkCounts.set(chunk.url, (chunkCounts.get(chunk.url) ?? 0) + 1);
  }
  const topChunkCounts = new Map<string, number>();
  const bestRanks = new Map<string, number>();
  topChunks.forEach((chunk, index) => {
    const rank = index + 1;
    topChunkCounts.set(chunk.url, (topChunkCounts.get(chunk.url) ?? 0) + 1);
    const current = bestRanks.get(chunk.url);
    if (current === undefined || rank < current) {
      bestRanks.set(chunk.url, rank);
    }
  });

  return pages.map((page) => {
    const quality = detectPageQuality(page);
    return {
      url: page.url,
      statusCode: page.statusCode,
      contentBytes: Buffer.byteLength(page.markdown, 'utf8'),
      chunksProduced: chunkCounts.get(page.url) ?? 0,
      topChunkCount: topChunkCounts.get(page.url) ?? 0,
      topChunkBestRank: bestRanks.get(page.url) ?? null,
      paywallSuspected: quality.paywallSuspected,
      loginWallSuspected: quality.loginWallSuspected,
      truncatedSuspected: quality.truncatedSuspected,
      consentWallSuspected: quality.consentWallSuspected,
      errorMessage: page.errorMessage,
      ...(page.recoverySource !== undefined ? { recoverySource: page.recoverySource } : {}),
    } satisfies SemanticCrawlPageMetadata;
  });
}

function pushPageQualityWarnings(
  structuredWarnings: SemanticCrawlWarning[],
  pageMetadata: SemanticCrawlPageMetadata[],
): void {
  const affected = pageMetadata.filter(
    (page) => page.paywallSuspected || page.loginWallSuspected || page.truncatedSuspected,
  );
  if (affected.length === 0) return;
  structuredWarnings.push({
    code: 'SEMANTIC_CRAWL_PAGE_QUALITY',
    message: `Detected potential paywall, login-wall, or truncation issues on ${String(affected.length)} page(s).`,
    affectedUrls: affected.map((page) => page.url).slice(0, 10),
    paywalledCount: affected.filter((page) => page.paywallSuspected).length,
    loginWallCount: affected.filter((page) => page.loginWallSuspected).length,
    truncatedCount: affected.filter((page) => page.truncatedSuspected).length,
  });
}

// ── Semantic Crawl Orchestrator ─────────────────────────────────────────

export interface SemanticCrawlOptions {
  /** Discriminated source for the corpus. */
  source: SemanticCrawlSource;
  query: string;
  topK: number;
  minScore?: number | undefined;
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  includeExternalLinks: boolean;
  maxBytes?: number | undefined;
  useReranker?: boolean | undefined;
  allowPathDrift?: boolean | undefined;
  /** CSS selector (css:.selector) or JS expression (js:() => boolean) to wait for before extracting. */
  waitFor?: string | undefined;
  /** Extra seconds to wait after page load for dynamic content to settle. */
  delayBeforeReturnHtml?: number | undefined;
  /** Page operation timeout in milliseconds. */
  pageTimeout?: number | undefined;
  /** Custom JavaScript to execute on the page (e.g. scroll, click buttons). */
  jsCode?: string | undefined;
  /** Structured data extraction configuration. */
  extractionConfig?: ExtractionConfig | undefined;
  /** LLM provider credentials for LLM extraction strategy fallback. */
  llmFallback?: { provider: string; apiToken: string; baseUrl?: string } | undefined;
  /** Optional LLM config for contextual embedding enrichment. */
  contextualEmbedding?: LlmConfig | undefined;
  /** Use LLM-generated context when embedding chunks. */
  useContextualEmbeddings?: boolean | undefined;
  /** Override max tokens per chunk (default: 400). Larger values produce fewer
   * chunks, reducing LLM calls when useContextualEmbeddings is enabled. */
  maxChunkTokens?: number | undefined;
  /** Include page-level structured elements in the response. */
  includeElements?: boolean | undefined;
  /** Maximum page-level structured elements to return when included. */
  elementsLimit?: number | undefined;
  /** Full response or low-context passages response. */
  outputMode?: 'full' | 'passages' | undefined;
  /** Optional security policy for domain trust evaluation. Disabled by default. */
  domainTrust?: DomainTrustConfig | undefined;
}

export async function semanticCrawl(
  opts: SemanticCrawlOptions,
  crawl4aiCfg: Crawl4aiConfig,
  embeddingBaseUrl: string,
  embeddingApiToken: string,
  embeddingDimensions: number,
): Promise<SemanticCrawlResult> {
  let corpusChunks: CorpusChunk[];
  let pagesCrawled: number;
  let successfulPages: number;
  let seedUrl: string;
  // Pre-computed data from cache (populated for 'cached' source only)
  let precomputedEmbeddings: number[][] | undefined;
  let cachedCorpusId: string | undefined;
  let contextualDocuments: Map<string, string> | undefined;
  // Aggregated extracted data from non-cached crawl sources
  let extractedData: Record<string, Record<string, unknown>[]> | undefined;
  // Recovery and crawl warnings collected across seed URLs.
  const crawlWarnings: string[] = [];
  const crawlStructuredWarnings: SemanticCrawlWarning[] = [];
  const crawlOmittedPages: {
    url: string;
    reason: string;
    estimatedBytes?: number;
  }[] = [];
  // Track latest pages for structured elements
  let lastPages: CrawlPageResult[] = [];

  // Auto-scale chunk size when contextual embeddings are on — larger chunks
  // mean fewer LLM calls per page, speeding up enrichment substantially.
  const effectiveMaxChunkTokens =
    opts.maxChunkTokens ?? (opts.useContextualEmbeddings ? 1200 : undefined);

  switch (opts.source.type) {
    case 'url': {
      seedUrl = opts.source.url;
      const seedUrls =
        opts.source.urls && opts.source.urls.length > 0
          ? [opts.source.url, ...opts.source.urls]
          : [opts.source.url];
      const safeUrls = filterSafeUrls(seedUrls, opts.domainTrust);
      const result = await crawlSeeds(safeUrls, crawl4aiCfg, {
        ...opts,
        sourceType: opts.source.type,
      });
      crawlWarnings.push(...result.warnings);
      for (const sw of result.structuredWarnings) {
        crawlStructuredWarnings.push(sw);
      }
      crawlOmittedPages.push(...result.omittedPages);
      // Record outcomes for self-improvement tracking
      for (const page of result.pages) {
        recordOutcome({
          url: page.url,
          domain: safeRecordOutcomeDomain(page.url),
          success: page.success,
          strategy: 'semantic-crawl',
          timestamp: Date.now(),
          chars: page.markdown.length,
        });
      }
      corpusChunks = pagesToCorpus(result.pages, undefined, effectiveMaxChunkTokens);
      lastPages = result.pages;
      contextualDocuments = new Map(
        result.pages
          .filter((page) => page.success && page.markdown.length > 0)
          .map((page) => [page.url, page.markdown] as const),
      );
      pagesCrawled = result.totalPages;
      successfulPages = result.successfulPages;
      extractedData = aggregateExtractedData(result.pages);
      break;
    }

    case 'sitemap': {
      seedUrl = opts.source.url;
      assertSafeUrl(seedUrl);
      const response = await fetch(seedUrl, {
        headers: { 'User-Agent': getUserAgent() },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`Sitemap fetch failed: HTTP ${String(response.status)} for ${seedUrl}`);
      }
      const xml = await response.text();
      let sitemapUrls = parseSitemap(xml);

      // If it's a sitemap index, fetch sub-sitemaps for page URLs
      if (isSitemapIndex(xml) && sitemapUrls.length > 0) {
        logger.info(
          { sitemapUrl: seedUrl, subSitemaps: sitemapUrls.length },
          'Sitemap is an index; fetching sub-sitemaps',
        );
        const pageUrls: string[] = [];
        for (const subUrl of sitemapUrls.slice(0, 10)) {
          try {
            assertSafeUrl(subUrl);
            const subResponse = await fetch(subUrl, {
              headers: { 'User-Agent': getUserAgent() },
              signal: AbortSignal.timeout(30_000),
            });
            if (subResponse.ok) {
              const subXml = await subResponse.text();
              const subUrls = parseSitemap(subXml);
              pageUrls.push(...subUrls);
            }
          } catch (err) {
            logger.warn({ err, subUrl }, 'Failed to fetch sub-sitemap');
          }
        }
        sitemapUrls = pageUrls;
        logger.info(
          { firstSub: sitemapUrls.length, urlsFound: sitemapUrls.length },
          'Fetched sub-sitemaps',
        );
      }

      const safeUrls = filterSafeUrls(sitemapUrls, opts.domainTrust);
      const localeCollapsed = collapseSitemapLocaleDuplicates(safeUrls, opts.source.preferLocale);
      if (localeCollapsed.collapsedCount > 0) {
        crawlStructuredWarnings.push({
          code: 'SEMANTIC_CRAWL_SITEMAP_LOCALE_COLLAPSED',
          message: `Collapsed ${String(localeCollapsed.collapsedCount)} locale-duplicate sitemap URL(s) before ranking.`,
          urlsBefore: safeUrls.length,
          urlsAfter: localeCollapsed.urls.length,
          collapsedCount: localeCollapsed.collapsedCount,
          selectedUrls: localeCollapsed.urls.slice(0, 10),
        });
      }
      const rankedUrls = rankSitemapUrls(localeCollapsed.urls, opts.query);
      const selectedUrls = rankedUrls.slice(0, opts.maxPages);
      if (selectedUrls.length > 0 && selectedUrls[0] !== safeUrls[0]) {
        const msg =
          `semantic_crawl: sitemap URLs were preselected by relevance to query; ` +
          `${String(safeUrls.length)} safe URLs found, ${String(selectedUrls.length)} selected.`;
        crawlWarnings.push(msg);
        crawlStructuredWarnings.push({
          code: 'SEMANTIC_CRAWL_SITEMAP_REORDERED',
          message: msg,
          urlsFound: safeUrls.length,
          urlsSelected: selectedUrls.length,
          selectedUrls: selectedUrls.slice(0, 10),
        });
      }
      logger.info(
        {
          sitemapUrl: seedUrl,
          urlsFound: sitemapUrls.length,
          urlsUsed: selectedUrls.length,
        },
        'Parsed sitemap',
      );

      // Sitemap URLs are the authoritative list — do not follow links
      if (opts.maxDepth > 0) {
        logger.warn(
          { requestedDepth: opts.maxDepth },
          'semantic_crawl: sitemap mode ignores maxDepth > 0, forcing depth 0',
        );
      }
      const sitemapOpts = {
        ...opts,
        maxDepth: 0,
        sourceType: opts.source.type,
      };
      const result = await crawlSeeds(selectedUrls, crawl4aiCfg, sitemapOpts);
      crawlWarnings.push(...result.warnings);
      for (const sw of result.structuredWarnings) {
        crawlStructuredWarnings.push(sw);
      }
      crawlOmittedPages.push(...result.omittedPages);
      // Record outcomes for self-improvement tracking
      for (const page of result.pages) {
        recordOutcome({
          url: page.url,
          domain: safeRecordOutcomeDomain(page.url),
          success: page.success,
          strategy: 'semantic-crawl',
          timestamp: Date.now(),
          chars: page.markdown.length,
        });
      }
      corpusChunks = pagesToCorpus(result.pages, undefined, effectiveMaxChunkTokens);
      lastPages = result.pages;
      contextualDocuments = new Map(
        result.pages
          .filter((page) => page.success && page.markdown.length > 0)
          .map((page) => [page.url, page.markdown] as const),
      );
      pagesCrawled = result.totalPages;
      successfulPages = result.successfulPages;
      extractedData = aggregateExtractedData(result.pages);
      break;
    }

    case 'search': {
      seedUrl = opts.source.query;
      const searchResults = await webSearch(
        opts.source.query,
        opts.source.maxSeedUrls ?? 10,
        'moderate',
      );
      const searchUrls = searchResults.map((r) => r.url).filter((url) => url.length > 0);
      const safeUrls = filterSafeUrls(searchUrls, opts.domainTrust).slice(0, opts.maxPages);
      logger.info(
        {
          searchQuery: opts.source.query,
          urlsFound: searchUrls.length,
          urlsUsed: safeUrls.length,
        },
        'Search-then-crawl: discovered URLs',
      );

      // Search-derived URLs are the target pages — do not follow links
      if (opts.maxDepth > 0) {
        logger.warn(
          { requestedDepth: opts.maxDepth },
          'semantic_crawl: search mode ignores maxDepth > 0, forcing depth 0',
        );
      }
      const searchOpts = {
        ...opts,
        maxDepth: 0,
        sourceType: opts.source.type,
        allowPathDrift: true,
      };
      const result = await crawlSeeds(safeUrls, crawl4aiCfg, searchOpts);
      crawlWarnings.push(...result.warnings);
      for (const sw of result.structuredWarnings) {
        crawlStructuredWarnings.push(sw);
      }
      crawlOmittedPages.push(...result.omittedPages);
      // Record outcomes for self-improvement tracking
      for (const page of result.pages) {
        recordOutcome({
          url: page.url,
          domain: safeRecordOutcomeDomain(page.url),
          success: page.success,
          strategy: 'semantic-crawl',
          timestamp: Date.now(),
          chars: page.markdown.length,
        });
      }
      corpusChunks = pagesToCorpus(result.pages, undefined, effectiveMaxChunkTokens);
      lastPages = result.pages;
      contextualDocuments = new Map(
        result.pages
          .filter((page) => page.success && page.markdown.length > 0)
          .map((page) => [page.url, page.markdown] as const),
      );
      pagesCrawled = result.totalPages;
      successfulPages = result.successfulPages;
      extractedData = aggregateExtractedData(result.pages);
      break;
    }

    case 'github': {
      seedUrl = `https://github.com/${opts.source.owner}/${opts.source.repo}`;
      const { fetchGitHubCorpus } = await import('../utils/githubCorpus.js');
      const ghOpts: import('../utils/githubCorpus.js').GitHubCorpusOptions = {
        owner: opts.source.owner,
        repo: opts.source.repo,
        maxFiles: opts.maxPages,
      };
      if (opts.source.branch !== undefined) ghOpts.branch = opts.source.branch;
      if (opts.source.extensions !== undefined) ghOpts.extensions = opts.source.extensions;
      if (opts.source.query !== undefined) ghOpts.query = opts.source.query;
      if (opts.source.includePaths !== undefined) ghOpts.includePaths = opts.source.includePaths;
      if (opts.source.excludePaths !== undefined) ghOpts.excludePaths = opts.source.excludePaths;
      if (opts.source.preFilterByContent !== undefined) {
        ghOpts.preFilterByContent = opts.source.preFilterByContent;
      }
      const docs = await fetchGitHubCorpus(ghOpts);
      const selectedPaths = docs.map((doc) => doc.path);
      if (selectedPaths.length > 0) {
        const msg =
          `semantic_crawl: selected ${String(selectedPaths.length)} GitHub files for ` +
          `${opts.source.owner}/${opts.source.repo}. Top paths: ${selectedPaths.slice(0, 5).join(', ')}`;
        crawlWarnings.push(msg);
        crawlStructuredWarnings.push({
          code: 'SEMANTIC_CRAWL_GITHUB_FILE_SELECTION',
          message: msg,
          selectedPaths: selectedPaths.slice(0, 20),
        });
      }
      corpusChunks = [];
      contextualDocuments = new Map<string, string>();
      for (const doc of docs) {
        contextualDocuments.set(doc.url, doc.content);
        const chunks = chunkMarkdown(
          doc.content,
          doc.url,
          effectiveMaxChunkTokens !== undefined
            ? { maxTokens: effectiveMaxChunkTokens }
            : undefined,
        );
        corpusChunks.push(
          ...chunks.map((c) => ({
            text: c.content,
            url: c.url,
            section: `${doc.path} > ${c.section}`,
            charOffset: c.charOffset,
            chunkIndex: c.chunkIndex,
            totalChunks: c.totalChunks,
          })),
        );
      }
      pagesCrawled = docs.length;
      successfulPages = docs.length;
      break;
    }

    case 'cached': {
      // NOTE: extractedData is not persisted in the corpus cache.
      // If extractionConfig was used on the original crawl, the extractedData
      // was returned in that first response but is not available here.
      // The server handler emits a warning when extractionConfig is combined with cached source.
      const cached = loadCorpusById(opts.source.corpusId, {
        ttlMs: 24 * 60 * 60 * 1000,
      });
      if (!cached) {
        throw new Error(
          `Corpus '${opts.source.corpusId}' not found or expired. Re-issue with the original source to rebuild, or use semantic_crawl_list_corpora to browse available cached corpora.`,
        );
      }
      corpusChunks = cached.chunks;
      precomputedEmbeddings = cached.embeddings;
      cachedCorpusId = cached.corpusId;
      pagesCrawled = 0;
      successfulPages = 0;
      seedUrl = `corpus:${opts.source.corpusId}`;
      break;
    }

    default: {
      // Exhaustiveness check — TypeScript should prevent this at compile time
      throw new Error(
        `Unknown source type '${(opts.source as { type: string }).type}'. Valid values: "url", "sitemap", "search", "github", "cached".`,
      );
    }
  }

  // For non-cached sources: wrap embed+build in corpus cache so results are
  // persisted for future calls with source: { type: 'cached', corpusId }.
  // For 'cached' source: skip the cache build — use what we already loaded.
  let resolvedCorpusId: string;

  if (opts.source.type === 'cached') {
    // Already loaded from cache — just use the pre-computed data directly.
    resolvedCorpusId = cachedCorpusId ?? opts.source.corpusId;
    // Cached sources have no page-level elements (not persisted in corpus cache)
    const cachedMsg =
      'Cached corpus: page-level structured elements and extracted data are not available from cache. Re-crawl with the original source type if these are needed.';
    crawlStructuredWarnings.push({
      code: 'SEMANTIC_CRAWL_CACHED_SOURCE_LIMITATION',
      message: cachedMsg,
    });
    crawlWarnings.push(cachedMsg);

    if (opts.useContextualEmbeddings) {
      const ctxMsg =
        'useContextualEmbeddings was requested but is not supported for cached corpora. The corpus was built with the embeddings from the original crawl. Re-crawl with the original source type to apply contextual embeddings.';
      crawlWarnings.push(ctxMsg);
      logger.warn({ corpusId: opts.source.corpusId }, ctxMsg);
    }

    const topChunks = await retrieveSemanticChunks(corpusChunks, {
      query: opts.query,
      topK: opts.topK,
      ...(opts.useReranker !== undefined ? { useReranker: opts.useReranker } : {}),
      ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
      embeddingBaseUrl,
      embeddingApiToken,
      embeddingDimensions,
      precomputedEmbeddings: precomputedEmbeddings ?? [],
      structuredWarnings: crawlStructuredWarnings,
    });
    if (topChunks.length < opts.topK) {
      crawlStructuredWarnings.push({
        code: 'SEMANTIC_CRAWL_TOPK_UNMET',
        message: `Requested topK=${String(opts.topK)} but only ${String(topChunks.length)} chunk(s) were returned.`,
        requestedTopK: opts.topK,
        deliveredTopK: topChunks.length,
      });
    }
    logCorpusQuery(resolvedCorpusId, opts.query, opts.topK, topChunks.length);

    return {
      seedUrl,
      query: opts.query,
      pagesCrawled,
      totalChunks: corpusChunks.length,
      successfulPages,
      corpusId: resolvedCorpusId,
      topKRequested: opts.topK,
      topKDelivered: topChunks.length,
      chunks: topChunks,
      ...(crawlWarnings.length > 0 ? { warnings: crawlWarnings } : {}),
      ...(crawlStructuredWarnings.length > 0
        ? { structuredWarnings: crawlStructuredWarnings }
        : {}),
      ...(crawlOmittedPages.length > 0 ? { omittedPages: crawlOmittedPages } : {}),
    };
  }

  // Non-cached sources: build corpus (embed + cache)
  let deduped = deduplicateCorpusChunks(corpusChunks);
  if (opts.useContextualEmbeddings) {
    if (!opts.contextualEmbedding) {
      const msg =
        'useContextualEmbeddings requested but no LLM config was provided; using original chunk text';
      crawlWarnings.push(msg);
      logger.warn({ sourceType: opts.source.type }, msg);
    } else if (!contextualDocuments || contextualDocuments.size === 0) {
      const msg =
        'useContextualEmbeddings requested but source documents were unavailable; using original chunk text';
      crawlWarnings.push(msg);
      logger.warn({ sourceType: opts.source.type }, msg);
    } else if (deduped.length > 0) {
      const enrichments = await enrichChunksBatched(
        deduped,
        contextualDocuments,
        opts.contextualEmbedding,
      );
      deduped = deduped.map((chunk, index) => {
        const enrichment = enrichments[index];
        if (enrichment?.enriched !== true) return chunk;
        return { ...chunk, embedText: enrichment.embedText };
      });
    } else {
      const msg =
        'useContextualEmbeddings requested but all chunks were deduplicated away; using original chunk text';
      crawlWarnings.push(msg);
      logger.warn({ sourceType: opts.source.type }, msg);
    }
  }
  const chunkTexts = deduped.map((c) => c.embedText ?? c.text);
  const chunkTitles = deduped.map(
    (c) =>
      c.section
        .split(' > ')
        .at(-1)
        ?.replace(/^#+\s+/, '') ?? 'none',
  );

  // Build a cache variant string that differentiates contextual-embedding corpora
  // from plain ones. This prevents a corpus built with enrichment from being
  // served to a request that asked for no enrichment (and vice versa).
  const corpusVariant =
    opts.useContextualEmbeddings && opts.contextualEmbedding?.provider
      ? `ctx:${opts.contextualEmbedding.provider}`
      : 'ctx:off';

  const corpus = await getOrBuildCorpus(
    opts.source,
    async () => {
      const { embeddings, model } = await embedTextsBatched({
        baseUrl: embeddingBaseUrl,
        apiToken: embeddingApiToken,
        texts: chunkTexts,
        mode: 'document',
        dimensions: embeddingDimensions,
        titles: chunkTitles,
      });
      const contentHash = createHash('sha256').update(chunkTexts.join('\n')).digest('hex');
      return { chunks: deduped, embeddings, model, contentHash };
    },
    { ttlMs: 24 * 60 * 60 * 1000, maxCorpora: 50 },
    corpusVariant,
  );

  resolvedCorpusId = corpus.corpusId;

  // Use cached embeddings + BM25 index from the corpus
  const topChunks = await retrieveSemanticChunks(corpus.chunks, {
    query: opts.query,
    topK: opts.topK,
    ...(opts.useReranker !== undefined ? { useReranker: opts.useReranker } : {}),
    ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
    embeddingBaseUrl,
    embeddingApiToken,
    embeddingDimensions,
    precomputedEmbeddings: corpus.embeddings,
    structuredWarnings: crawlStructuredWarnings,
  });
  if (topChunks.length < opts.topK) {
    crawlStructuredWarnings.push({
      code: 'SEMANTIC_CRAWL_TOPK_UNMET',
      message: `Requested topK=${String(opts.topK)} but only ${String(topChunks.length)} chunk(s) were returned.`,
      requestedTopK: opts.topK,
      deliveredTopK: topChunks.length,
    });
  }
  const pageMetadata = buildPageMetadata(lastPages, deduped, topChunks);
  pushPageQualityWarnings(crawlStructuredWarnings, pageMetadata);
  logCorpusQuery(resolvedCorpusId, opts.query, opts.topK, topChunks.length);

  return {
    seedUrl,
    query: opts.query,
    pagesCrawled,
    totalChunks: corpus.chunks.length,
    successfulPages,
    corpusId: resolvedCorpusId,
    topKRequested: opts.topK,
    topKDelivered: topChunks.length,
    chunks: topChunks,
    ...(crawlWarnings.length > 0 ? { warnings: crawlWarnings } : {}),
    ...(crawlStructuredWarnings.length > 0 ? { structuredWarnings: crawlStructuredWarnings } : {}),
    ...(opts.outputMode !== 'passages' && pageMetadata.length > 0 ? { pageMetadata } : {}),
    ...(opts.outputMode !== 'passages' && crawlOmittedPages.length > 0
      ? { omittedPages: crawlOmittedPages }
      : {}),
    ...(opts.outputMode !== 'passages' && extractedData ? { extractedData } : {}),
    ...(opts.outputMode !== 'passages' && opts.includeElements !== false
      ? collectPageElements(lastPages, opts.elementsLimit)
      : {}),
  };
}
