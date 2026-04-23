import { logger } from '../logger.js';
import { unavailableError, networkError, parseError } from '../errors.js';
import { retryWithBackoff } from '../retry.js';
import { safeResponseJson } from '../httpGuards.js';
import { webCrawl, type WebCrawlOptions } from './webCrawl.js';
import { chunkMarkdown } from '../chunking.js';
import type {
  SemanticCrawlResult,
  SemanticCrawlChunk,
  CorpusChunk,
  SemanticCrawlSource,
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
): Promise<number[][]> {
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
    let response = await retryWithBackoff(
      () =>
        fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        }),
      { label: 'embedding-sidecar', maxAttempts: 2, initialDelayMs: 500 },
    );

    if (response.status === 503) {
      const retryAfter = response.headers.get('retry-after');
      const delayMs = Math.min(parseInt(retryAfter ?? '5', 10) * 1000, 30_000);
      logger.warn({ delayMs }, 'Embedding sidecar returned 503, retrying after delay');
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    }

    if (!response.ok) {
      throw networkError(
        `Embedding sidecar returned HTTP ${String(response.status)}`,
        { statusCode: response.status },
      );
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

  return data.embeddings;
}

async function embedTextsBatched(
  baseUrl: string,
  apiToken: string,
  texts: string[],
  mode: 'document' | 'query',
  dimensions: number,
  titles?: string[],
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_EMBEDDING_BATCH) {
    const batchTexts = texts.slice(i, i + MAX_EMBEDDING_BATCH);
    const batchTitles = titles ? titles.slice(i, i + MAX_EMBEDDING_BATCH) : undefined;
    const batchEmbeddings = await embedTexts(baseUrl, apiToken, batchTexts, mode, dimensions, batchTitles);
    embeddings.push(...batchEmbeddings);
  }
  return embeddings;
}

// ── Embed-and-Rank Shared Helper ────────────────────────────────────────────

const MAX_CHUNKS_SOFT = 2_000;
const MAX_CHUNKS_HARD = 5_000;
const RERANK_CANDIDATES = 30;

interface EmbedAndRankOptions {
  query: string;
  topK: number;
  useReranker?: boolean;
  embeddingBaseUrl: string;
  embeddingApiToken: string;
  embeddingDimensions: number;
}

export async function embedAndRank(
  chunks: CorpusChunk[],
  opts: EmbedAndRankOptions,
): Promise<SemanticCrawlChunk[]> {
  if (chunks.length === 0) return [];

  // 1. Deduplicate
  const preDedupCount = chunks.length;
  const deduped = deduplicateCorpusChunks(chunks);
  if (preDedupCount !== deduped.length) {
    logger.info(
      { preDedup: preDedupCount, postDedup: deduped.length },
      'Deduplicated corpus chunks before embedding',
    );
  }

  // 2. Chunk safety check
  if (deduped.length > MAX_CHUNKS_HARD) {
    throw new Error(
      `Produced ${String(deduped.length)} chunks, exceeding hard cap of ${String(MAX_CHUNKS_HARD)}. Reduce maxPages or increase chunk size.`,
    );
  }
  if (deduped.length > MAX_CHUNKS_SOFT) {
    logger.warn(
      { chunkCount: deduped.length, softCap: MAX_CHUNKS_SOFT },
      'Chunk count exceeds soft cap; embedding may be slower',
    );
  }

  // 3. Embed chunks (batched) and query in parallel
  const chunkTexts = deduped.map((c) => c.text);
  const chunkTitles = deduped.map((c) => c.section.split(' > ').at(-1)?.replace(/^#+\s+/, '') ?? 'none');
  const [chunkEmbeddings, queryEmbeddings] = await Promise.all([
    embedTextsBatched(
      opts.embeddingBaseUrl,
      opts.embeddingApiToken,
      chunkTexts,
      'document',
      opts.embeddingDimensions,
      chunkTitles,
    ),
    embedTexts(
      opts.embeddingBaseUrl,
      opts.embeddingApiToken,
      [opts.query],
      'query',
      opts.embeddingDimensions,
    ),
  ]);
  const queryEmbedding = queryEmbeddings[0];
  if (!queryEmbedding) {
    throw new Error('Embedding sidecar returned empty query embedding');
  }

  // 4. Bi-encoder ranking (cosine similarity)
  const ranked: SemanticCrawlChunk[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const chunk = deduped[i];
    const emb = chunkEmbeddings[i];
    if (!chunk || emb === undefined) continue;
    ranked.push({
      text: chunk.text,
      url: chunk.url,
      section: chunk.section,
      biEncoderScore: cosineSimilarity(queryEmbedding, emb),
      charOffset: chunk.charOffset,
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
    });
  }
  ranked.sort((a, b) => b.biEncoderScore - a.biEncoderScore);

  // 5. Optional cross-encoder re-ranking
  let topChunks: SemanticCrawlChunk[];

  if (opts.useReranker !== false && ranked.length > 1) {
    const rerankCount = Math.min(RERANK_CANDIDATES, ranked.length);
    const candidates = ranked.slice(0, rerankCount);
    const candidateTexts = candidates.map((c) => c.text);

    try {
      // Lazy import reranker — other agent owns this module
      const { rerank } = await import('../utils/rerank.js');
      const reranked = await rerank(opts.query, candidateTexts, { topK: opts.topK });

      topChunks = [];
      for (const r of reranked) {
        const candidate = candidates[r.index];
        if (candidate) {
          topChunks.push({
            ...candidate,
            rerankScore: r.score,
          });
        }
      }
      logger.info({ topK: opts.topK, candidates: rerankCount }, 'Cross-encoder re-ranking applied');
    } catch (err) {
      logger.warn({ err }, 'Cross-encoder re-ranking failed, falling back to bi-encoder ranking');
      topChunks = candidates.slice(0, opts.topK);
    }
  } else {
    topChunks = ranked.slice(0, opts.topK);
  }

  return topChunks;
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
  maxBytes?: number;
  useReranker?: boolean;
}

export async function semanticCrawl(
  opts: SemanticCrawlOptions,
  crawl4aiCfg: Crawl4aiConfig,
  embeddingBaseUrl: string,
  embeddingApiToken: string,
  embeddingDimensions: number,
): Promise<SemanticCrawlResult> {
  // 1. Resolve source → corpus chunks
  let corpusChunks: CorpusChunk[];
  let pagesCrawled: number;
  let successfulPages: number;
  let seedUrl: string;

  switch (opts.source.type) {
    case 'url': {
      seedUrl = opts.source.url;
      const crawlOpts: WebCrawlOptions = {
        strategy: opts.strategy,
        maxDepth: opts.maxDepth,
        maxPages: opts.maxPages,
        includeExternalLinks: opts.includeExternalLinks,
        ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      };
      const crawlResult = await webCrawl(seedUrl, crawl4aiCfg.baseUrl, crawl4aiCfg.apiToken, crawlOpts);
      corpusChunks = pagesToCorpus(crawlResult.pages);
      pagesCrawled = crawlResult.totalPages;
      successfulPages = crawlResult.successfulPages;
      break;
    }

    default: {
      // Fallback for sources not yet implemented (sitemap, search, github)
      // This will be replaced in the next task with full adapter dispatch
      throw new Error(`Source type '${opts.source.type}' is not yet implemented`);
    }
  }

  // 2. Embed and rank via shared helper
  const topChunks = await embedAndRank(corpusChunks, {
    query: opts.query,
    topK: opts.topK,
    ...(opts.useReranker !== undefined ? { useReranker: opts.useReranker } : {}),
    embeddingBaseUrl,
    embeddingApiToken,
    embeddingDimensions,
  });

  return {
    seedUrl,
    query: opts.query,
    pagesCrawled,
    totalChunks: corpusChunks.length,
    successfulPages,
    chunks: topChunks,
  };
}

function pagesToCorpus(pages: import('../types.js').CrawlPageResult[]): CorpusChunk[] {
  const chunks: CorpusChunk[] = [];
  let pagesWithContent = 0;
  for (const page of pages) {
    if (!page.success || !page.markdown) continue;
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
  if (pagesWithContent < pages.filter((p) => p.success).length) {
    logger.warn(
      { pagesWithContent, successfulPages: pages.filter((p) => p.success).length },
      'Some successfully crawled pages produced no meaningful chunks (likely boilerplate or empty)',
    );
  }
  return chunks;
}
