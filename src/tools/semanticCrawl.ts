import { logger } from '../logger.js';
import { unavailableError, networkError, parseError } from '../errors.js';
import { retryWithBackoff } from '../retry.js';
import { safeResponseJson } from '../httpGuards.js';
import { webCrawl, type WebCrawlOptions } from './webCrawl.js';
import { chunkMarkdown } from '../chunking.js';
import type { SemanticCrawlResult, SemanticCrawlChunk } from '../types.js';
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

function deduplicateChunks(chunks: SemanticCrawlChunk[]): SemanticCrawlChunk[] {
  const seen = new Set<string>();
  return chunks.filter((c) => {
    const normalized = c.text.trim().toLowerCase().replace(/\s+/g, ' ');
    const hash = createHash('sha256').update(normalized).digest('hex');
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

const MAX_CHUNKS_SOFT = 2_000;
const MAX_CHUNKS_HARD = 5_000;

export interface SemanticCrawlOptions {
  url: string;
  query: string;
  topK: number;
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  includeExternalLinks: boolean;
}

export async function semanticCrawl(
  opts: SemanticCrawlOptions,
  crawl4aiCfg: Crawl4aiConfig,
  embeddingBaseUrl: string,
  embeddingApiToken: string,
  embeddingDimensions: number,
): Promise<SemanticCrawlResult> {
  // 1. Crawl
  const crawlOpts: WebCrawlOptions = {
    strategy: opts.strategy,
    maxDepth: opts.maxDepth,
    maxPages: opts.maxPages,
    includeExternalLinks: opts.includeExternalLinks,
  };
  const crawlResult = await webCrawl(opts.url, crawl4aiCfg.baseUrl, crawl4aiCfg.apiToken, crawlOpts);

  // 2. Chunk
  let allChunks: SemanticCrawlChunk[] = [];
  let pagesWithContent = 0;
  for (const page of crawlResult.pages) {
    if (!page.success || !page.markdown) continue;
    const chunks = chunkMarkdown(page.markdown, page.url);
    if (chunks.length === 0) {
      logger.debug({ url: page.url }, 'semantic_crawl: page produced no chunks');
      continue;
    }
    pagesWithContent++;
    allChunks.push(
      ...chunks.map((c) => ({
        text: c.content,
        url: c.url,
        section: c.section,
        biEncoderScore: 0,
        charOffset: c.charOffset,
        chunkIndex: c.chunkIndex,
        totalChunks: c.totalChunks,
      })),
    );
  }

  if (pagesWithContent < crawlResult.successfulPages) {
    logger.warn(
      { pagesWithContent, successfulPages: crawlResult.successfulPages },
      'Some successfully crawled pages produced no meaningful chunks (likely boilerplate or empty)',
    );
  }

  // 3. Deduplicate before embedding
  const preDedupCount = allChunks.length;
  allChunks = deduplicateChunks(allChunks);
  if (preDedupCount !== allChunks.length) {
    logger.info(
      { preDedup: preDedupCount, postDedup: allChunks.length },
      'Deduplicated chunks before embedding',
    );
  }

  // 4. Chunk safety check
  if (allChunks.length > MAX_CHUNKS_HARD) {
    throw new Error(
      `Produced ${String(allChunks.length)} chunks, exceeding hard cap of ${String(MAX_CHUNKS_HARD)}. Reduce maxPages or increase chunk size.`,
    );
  }
  if (allChunks.length > MAX_CHUNKS_SOFT) {
    logger.warn(
      { chunkCount: allChunks.length, softCap: MAX_CHUNKS_SOFT },
      'Chunk count exceeds soft cap; embedding may be slower',
    );
  }

  if (allChunks.length === 0) {
    return {
      seedUrl: opts.url,
      query: opts.query,
      pagesCrawled: crawlResult.totalPages,
      totalChunks: 0,
      successfulPages: crawlResult.successfulPages,
      chunks: [],
    };
  }

  // 5. Embed chunks (batched) and query in parallel
  const chunkTexts = allChunks.map((c) => c.text);
  const chunkTitles = allChunks.map((c) => c.section.split(' > ').at(-1)?.replace(/^#+\s+/, '') ?? 'none');
  const [chunkEmbeddings, queryEmbeddings] = await Promise.all([
    embedTextsBatched(embeddingBaseUrl, embeddingApiToken, chunkTexts, 'document', embeddingDimensions, chunkTitles),
    embedTexts(embeddingBaseUrl, embeddingApiToken, [opts.query], 'query', embeddingDimensions),
  ]);
  const queryEmbedding = queryEmbeddings[0];
  if (!queryEmbedding) {
    throw new Error('Embedding sidecar returned empty query embedding');
  }

  // 6. Rank
  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    const emb = chunkEmbeddings[i];
    if (!chunk || emb === undefined) continue;
    chunk.biEncoderScore = cosineSimilarity(queryEmbedding, emb);
  }
  allChunks.sort((a, b) => b.biEncoderScore - a.biEncoderScore);

  // 7. Return topK
  const topChunks = allChunks.slice(0, opts.topK);

  return {
    seedUrl: opts.url,
    query: opts.query,
    pagesCrawled: crawlResult.totalPages,
    totalChunks: allChunks.length,
    successfulPages: crawlResult.successfulPages,
    chunks: topChunks,
  };
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
