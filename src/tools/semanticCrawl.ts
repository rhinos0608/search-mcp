import { logger } from '../logger.js';
import { unavailableError, networkError, parseError } from '../errors.js';
import { retryWithBackoff } from '../retry.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { webCrawl, type WebCrawlOptions } from './webCrawl.js';
import { webSearch } from './webSearch.js';
import { chunkMarkdown } from '../chunking.js';
import { parseSitemap, isSitemapIndex } from '../utils/sitemap.js';
import { dedupPages } from '../utils/url.js';
import { isCookieBannerPage } from '../utils/cookieBanner.js';
import { rrfMerge } from '../utils/fusion.js';
import { applySoftLexicalConstraint } from '../utils/lexicalConstraint.js';
import { buildBm25Index, type Bm25Index } from '../utils/bm25.js';
import { getOrBuildCorpus, loadCorpusById } from '../utils/corpusCache.js';
import type {
  SemanticCrawlResult,
  SemanticCrawlChunk,
  CorpusChunk,
  SemanticCrawlSource,
  CrawlPageResult,
} from '../types.js';
import type { Crawl4aiConfig } from '../config.js';
import { createHash } from 'node:crypto';

interface EmbedRequest {
  texts: string[];
  titles?: string[];
  mode: 'document' | 'query';
  dimensions: number;
}

interface EmbedResponse {
  embeddings: number[][];
  model: string;
  modelRevision: string;
  dimensions: number;
  mode: string;
  truncatedIndices: number[];
}

const MAX_EMBEDDING_BATCH = 512;

export async function embedTexts(
  baseUrl: string,
  apiToken: string,
  texts: string[],
  mode: 'document' | 'query',
  dimensions: number,
  titles?: string[],
): Promise<EmbedResponse> {
  if (!baseUrl) {
    throw unavailableError('Embedding sidecar is not configured. Set EMBEDDING_SIDECAR_BASE_URL.');
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/embed`;
  // Sidecar URLs come from operator configuration (EMBEDDING_SIDECAR_BASE_URL);
  // they are inherently trusted and should not be subject to SSRF guards.

  const body: EmbedRequest = { texts, mode, dimensions };
  if (titles !== undefined && titles.length > 0) {
    body.titles = titles;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'search-mcp/1.0',
  };
  if (apiToken) {
    headers.Authorization = `Bearer ${apiToken}`;
  }

  let raw: unknown;
  try {
    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.status === 503) {
          throw networkError('Embedding sidecar returned HTTP 503', { statusCode: 503 });
        }
        return res;
      },
      { label: 'embedding-sidecar', maxAttempts: 2, initialDelayMs: 500 },
    );

    if (!response.ok) {
      throw networkError(`Embedding sidecar returned HTTP ${String(response.status)}`, {
        statusCode: response.status,
      });
    }

    raw = await safeResponseJson(response, endpoint);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw networkError('Embedding sidecar request timed out after 60 seconds');
    }
    throw err;
  }

  if (raw === null || typeof raw !== 'object' || !('embeddings' in raw)) {
    throw parseError('Embedding sidecar returned unexpected response shape');
  }

  const data = raw as EmbedResponse;
  if (!Array.isArray(data.embeddings)) {
    throw parseError('Embedding sidecar response missing embeddings array');
  }

  if (Array.isArray(data.truncatedIndices) && data.truncatedIndices.length > 0) {
    logger.warn(
      { truncatedIndices: data.truncatedIndices },
      'Some chunks were truncated by the embedding model',
    );
  }

  return data;
}

/** Embed texts in batches, returning all embeddings and the model name from the last batch. */
async function embedTextsBatched(
  baseUrl: string,
  apiToken: string,
  texts: string[],
  mode: 'document' | 'query',
  dimensions: number,
  titles?: string[],
): Promise<{ embeddings: number[][]; model: string }> {
  const embeddings: number[][] = [];
  let model = '';
  for (let i = 0; i < texts.length; i += MAX_EMBEDDING_BATCH) {
    const batchTexts = texts.slice(i, i + MAX_EMBEDDING_BATCH);
    const batchTitles = titles ? titles.slice(i, i + MAX_EMBEDDING_BATCH) : undefined;
    const response = await embedTexts(
      baseUrl,
      apiToken,
      batchTexts,
      mode,
      dimensions,
      batchTitles,
    );
    embeddings.push(...response.embeddings);
    model = response.model;
  }
  return { embeddings, model };
}

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
  embeddingBaseUrl: string;
  embeddingApiToken: string;
  embeddingDimensions: number;
  /** Pre-computed chunk embeddings from cache (skip embed step when provided). */
  precomputedEmbeddings?: number[][] | undefined;
  /** Pre-built BM25 index from cache (built inline when not provided). */
  bm25Index?: Bm25Index | undefined;
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

  const queryEmbedPromise = embedTexts(
    opts.embeddingBaseUrl,
    opts.embeddingApiToken,
    [opts.query],
    'query',
    opts.embeddingDimensions,
  );

  let chunkEmbeddings: number[][];
  if (opts.precomputedEmbeddings !== undefined) {
    chunkEmbeddings = opts.precomputedEmbeddings;
  } else {
    const [{ embeddings }] = await Promise.all([
      embedTextsBatched(
        opts.embeddingBaseUrl,
        opts.embeddingApiToken,
        chunkTexts,
        'document',
        opts.embeddingDimensions,
        chunkTitles,
      ),
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
          biEncoder: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
          bm25: { raw: 0, normalized: 0, corpusMin: 0, corpusMax: 0, median: 0 },
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
    buildBm25Index(chunks.map((c) => ({ id: c.url + ':' + String(c.chunkIndex), text: c.text })));

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
    { biEncoderCount: biEncoderTopN.length, bm25Count: bm25TopK.length, fusedCount: fused.length, poolSize },
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

  // 8. Semantic coherence filter (borderline off-topic chunks)
  const chunkToEmbedding = new Map<string, number[]>();
  for (const p of paired) {
    chunkToEmbedding.set(p.chunk.url + '|' + p.chunk.text, p.embedding);
  }

  const fusedPaired: ChunkWithEmbedding[] = [];
  for (const chunk of scoredChunks) {
    const emb = chunkToEmbedding.get(chunk.url + '|' + chunk.text);
    if (emb) {
      fusedPaired.push({ chunk, embedding: emb });
    }
  }

  const coherent = filterBySemanticCoherence(fusedPaired);
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
  const afterLexical = lexicalResult.filtered;

  // 9. Optional cross-encoder re-ranking (opt-in, default false)
  let topChunks: SemanticCrawlChunk[];

  if (opts.useReranker === true && afterLexical.length > 1) {
    const rerankCount = Math.min(RERANK_CANDIDATES, afterLexical.length);
    const candidates = afterLexical.slice(0, rerankCount);
    const candidateTexts = candidates.map((c) => c.text);

    try {
      const { rerank } = await import('../utils/rerank.js');
      const reranked = await rerank(opts.query, candidateTexts, { topK: opts.topK });

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
function filterSafeUrls(urls: string[]): string[] {
  const safe: string[] = [];
  for (const u of urls) {
    try {
      assertSafeUrl(u);
      safe.push(u);
    } catch {
      logger.warn({ url: u }, 'semantic_crawl: dropping unsafe adapter URL');
    }
  }
  return safe;
}

/** Divide a numeric budget across N seeds, with a floor of 1. */
function divideBudget(total: number, seeds: number): number {
  return Math.max(1, Math.ceil(total / seeds));
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
): CrawlPageResult[] {
  if (allowPathDrift) return pages;
  const seedPath = new URL(seedUrl).pathname;
  const kept: CrawlPageResult[] = [];
  let dropped = 0;
  for (const page of pages) {
    const pagePath = new URL(page.url).pathname;
    if (pagePath === seedPath || isDirectChild(pagePath, seedPath)) {
      kept.push(page);
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    logger.info({ dropped, seedPath }, 'semantic_crawl: dropped pages outside seed path');
  }
  return kept;
}

/** Crawl a list of seed URLs with per-seed budget division and sequential budget tracking. */
async function crawlSeeds(
  seedUrls: string[],
  crawl4aiCfg: Crawl4aiConfig,
  opts: Pick<
    SemanticCrawlOptions,
    'strategy' | 'maxDepth' | 'maxPages' | 'includeExternalLinks' | 'maxBytes' | 'allowPathDrift'
  >,
): Promise<{ pages: CrawlPageResult[]; totalPages: number; successfulPages: number }> {
  if (seedUrls.length === 0) {
    return { pages: [], totalPages: 0, successfulPages: 0 };
  }

  const allPages: CrawlPageResult[] = [];
  let totalPagesAttempted = 0;
  let totalSuccessfulPages = 0;

  // Sequential crawl with global budget tracking
  let remainingPages = opts.maxPages;
  let remainingBytes = opts.maxBytes ?? Infinity;

  for (let i = 0; i < seedUrls.length; i++) {
    const seedUrl = seedUrls[i];
    if (seedUrl === undefined) continue;
    if (remainingPages <= 0) break;

    const remainingSeeds = seedUrls.length - i;
    const perSeedPages = divideBudget(remainingPages, remainingSeeds);
    const perSeedBytes =
      remainingBytes !== Infinity ? divideBudget(remainingBytes, remainingSeeds) : undefined;

    const crawlOpts: WebCrawlOptions = {
      strategy: opts.strategy,
      maxDepth: opts.maxDepth,
      maxPages: perSeedPages,
      includeExternalLinks: opts.includeExternalLinks,
      ...(perSeedBytes !== undefined ? { maxBytes: perSeedBytes } : {}),
    };

    const result = await webCrawl(seedUrl, crawl4aiCfg.baseUrl, crawl4aiCfg.apiToken, crawlOpts);

    // Path focus filter
    let pages = filterByPathPrefix(result.pages, seedUrl, opts.allowPathDrift ?? false);

    // maxPages client-side enforcement (guarantee seed-first, then truncate)
    const seedIndex = pages.findIndex((p) => p.url === seedUrl);
    if (seedIndex > 0) {
      const [seedPage] = pages.splice(seedIndex, 1);
      if (seedPage) pages.unshift(seedPage);
    }
    if (pages.length > perSeedPages) {
      logger.warn(
        { requested: perSeedPages, received: pages.length, seedUrl },
        'semantic_crawl: crawl4ai returned more pages than requested; truncating client-side',
      );
      pages = pages.slice(0, perSeedPages);
    }

    totalPagesAttempted += result.totalPages;
    totalSuccessfulPages += result.successfulPages;
    allPages.push(...pages);

    remainingPages -= result.totalPages;
    if (perSeedBytes !== undefined) {
      const bytesUsed = result.pages.reduce((sum, p) => sum + p.markdown.length, 0);
      remainingBytes -= bytesUsed;
    }
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

  return { pages: deduped, totalPages: totalPagesAttempted, successfulPages: totalSuccessfulPages };
}

export function pagesToCorpus(pages: CrawlPageResult[]): CorpusChunk[] {
  const chunks: CorpusChunk[] = [];
  let pagesWithContent = 0;
  let droppedBannerPages = 0;
  for (const page of pages) {
    if (!page.success || !page.markdown) continue;
    if (isCookieBannerPage(page.markdown)) {
      droppedBannerPages++;
      continue;
    }
    const mdChunks = chunkMarkdown(page.markdown, page.url);
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
  if (droppedBannerPages > 0) {
    logger.warn(
      { droppedBannerPages, totalPages: pages.length },
      'Dropped cookie-banner pages before chunking',
    );
  }
  if (pagesWithContent < pages.filter((p) => p.success).length - droppedBannerPages) {
    logger.info(
      { pagesWithContent, successfulPages: pages.filter((p) => p.success).length - droppedBannerPages },
      'Some successfully crawled pages produced no meaningful chunks (likely boilerplate or empty)',
    );
  }
  return chunks;
}

// ── Semantic Crawl Orchestrator ─────────────────────────────────────────

export interface SemanticCrawlOptions {
  /** Discriminated source for the corpus. */
  source: SemanticCrawlSource;
  query: string;
  topK: number;
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  includeExternalLinks: boolean;
  maxBytes?: number | undefined;
  useReranker?: boolean | undefined;
  allowPathDrift?: boolean | undefined;
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
  let bm25IndexFromCache: Bm25Index | undefined;
  let cachedCorpusId: string | undefined;

  switch (opts.source.type) {
    case 'url': {
      seedUrl = opts.source.url;
      const seedUrls =
        opts.source.urls && opts.source.urls.length > 0
          ? [opts.source.url, ...opts.source.urls]
          : [opts.source.url];
      const safeUrls = filterSafeUrls(seedUrls);
      const result = await crawlSeeds(safeUrls, crawl4aiCfg, opts);
      corpusChunks = pagesToCorpus(result.pages);
      pagesCrawled = result.totalPages;
      successfulPages = result.successfulPages;
      break;
    }

    case 'sitemap': {
      seedUrl = opts.source.url;
      assertSafeUrl(seedUrl);
      const response = await fetch(seedUrl, {
        headers: { 'User-Agent': 'search-mcp/1.0' },
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
              headers: { 'User-Agent': 'search-mcp/1.0' },
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

      const safeUrls = filterSafeUrls(sitemapUrls).slice(0, opts.maxPages);
      logger.info(
        { sitemapUrl: seedUrl, urlsFound: sitemapUrls.length, urlsUsed: safeUrls.length },
        'Parsed sitemap',
      );

      // Sitemap URLs are the authoritative list — do not follow links
      if (opts.maxDepth > 0) {
        logger.warn(
          { requestedDepth: opts.maxDepth },
          'semantic_crawl: sitemap mode ignores maxDepth > 0, forcing depth 0',
        );
      }
      const sitemapOpts = { ...opts, maxDepth: 0 };
      const result = await crawlSeeds(safeUrls, crawl4aiCfg, sitemapOpts);
      corpusChunks = pagesToCorpus(result.pages);
      pagesCrawled = result.totalPages;
      successfulPages = result.successfulPages;
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
      const safeUrls = filterSafeUrls(searchUrls).slice(0, opts.maxPages);
      logger.info(
        { searchQuery: opts.source.query, urlsFound: searchUrls.length, urlsUsed: safeUrls.length },
        'Search-then-crawl: discovered URLs',
      );

      // Search-derived URLs are the target pages — do not follow links
      if (opts.maxDepth > 0) {
        logger.warn(
          { requestedDepth: opts.maxDepth },
          'semantic_crawl: search mode ignores maxDepth > 0, forcing depth 0',
        );
      }
      const searchOpts = { ...opts, maxDepth: 0 };
      const result = await crawlSeeds(safeUrls, crawl4aiCfg, searchOpts);
      corpusChunks = pagesToCorpus(result.pages);
      pagesCrawled = result.totalPages;
      successfulPages = result.successfulPages;
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
      const docs = await fetchGitHubCorpus(ghOpts);
      corpusChunks = [];
      for (const doc of docs) {
        const chunks = chunkMarkdown(doc.content, doc.url);
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
      const cached = loadCorpusById(opts.source.corpusId);
      if (!cached) {
        throw new Error(
          `Corpus '${opts.source.corpusId}' not found or expired. Re-issue with the original source to rebuild.`,
        );
      }
      corpusChunks = cached.chunks;
      precomputedEmbeddings = cached.embeddings;
      bm25IndexFromCache = cached.bm25Index;
      cachedCorpusId = cached.corpusId;
      pagesCrawled = 0;
      successfulPages = 0;
      seedUrl = `corpus:${opts.source.corpusId}`;
      break;
    }

    default: {
      // Exhaustiveness check — TypeScript should prevent this at compile time
      throw new Error(`Unknown source type '${(opts.source as { type: string }).type}'`);
    }
  }

  // For non-cached sources: wrap embed+build in corpus cache so results are
  // persisted for future calls with source: { type: 'cached', corpusId }.
  // For 'cached' source: skip the cache build — use what we already loaded.
  let resolvedCorpusId: string;

  if (opts.source.type === 'cached') {
    // Already loaded from cache — just use the pre-computed data directly.
    resolvedCorpusId = cachedCorpusId ?? opts.source.corpusId;

    const topChunks = await embedAndRank(corpusChunks, {
      query: opts.query,
      topK: opts.topK,
      ...(opts.useReranker !== undefined ? { useReranker: opts.useReranker } : {}),
      embeddingBaseUrl,
      embeddingApiToken,
      embeddingDimensions,
      precomputedEmbeddings,
      bm25Index: bm25IndexFromCache,
    });

    return {
      seedUrl,
      query: opts.query,
      pagesCrawled,
      totalChunks: corpusChunks.length,
      successfulPages,
      corpusId: resolvedCorpusId,
      chunks: topChunks,
    };
  }

  // Non-cached sources: build corpus (embed + cache)
  const deduped = deduplicateCorpusChunks(corpusChunks);
  const chunkTexts = deduped.map((c) => c.text);
  const chunkTitles = deduped.map(
    (c) =>
      c.section
        .split(' > ')
        .at(-1)
        ?.replace(/^#+\s+/, '') ?? 'none',
  );

  const corpus = await getOrBuildCorpus(
    opts.source,
    async () => {
      const { embeddings, model } = await embedTextsBatched(
        embeddingBaseUrl,
        embeddingApiToken,
        chunkTexts,
        'document',
        embeddingDimensions,
        chunkTitles,
      );
      const contentHash = createHash('sha256').update(chunkTexts.join('\n')).digest('hex');
      return { chunks: deduped, embeddings, model, contentHash };
    },
    { ttlMs: 24 * 60 * 60 * 1000, maxCorpora: 50 },
  );

  resolvedCorpusId = corpus.corpusId;

  // Use cached embeddings + BM25 index from the corpus
  const topChunks = await embedAndRank(corpus.chunks, {
    query: opts.query,
    topK: opts.topK,
    ...(opts.useReranker !== undefined ? { useReranker: opts.useReranker } : {}),
    embeddingBaseUrl,
    embeddingApiToken,
    embeddingDimensions,
    precomputedEmbeddings: corpus.embeddings,
    bm25Index: corpus.bm25Index,
  });

  return {
    seedUrl,
    query: opts.query,
    pagesCrawled,
    totalChunks: corpus.chunks.length,
    successfulPages,
    corpusId: resolvedCorpusId,
    chunks: topChunks,
  };
}
