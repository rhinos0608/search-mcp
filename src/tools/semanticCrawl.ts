import { logger } from '../logger.js';
import { unavailableError, networkError, parseError } from '../errors.js';
import { retryWithBackoff } from '../retry.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { webCrawl, type WebCrawlOptions } from './webCrawl.js';
import { chunkMarkdown } from '../chunking.js';
import type { SemanticCrawlResult, SemanticCrawlChunk } from '../types.js';
import type { Crawl4aiConfig } from '../config.js';

interface EmbedRequest {
  texts: string[];
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

export async function embedTexts(
  baseUrl: string,
  apiToken: string,
  texts: string[],
  mode: 'document' | 'query',
  dimensions: number,
): Promise<number[][]> {
  if (!baseUrl) {
    throw unavailableError('Embedding sidecar is not configured. Set EMBEDDING_SIDECAR_BASE_URL.');
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/embed`;
  assertSafeUrl(endpoint);

  const body: EmbedRequest = { texts, mode, dimensions };

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
      () =>
        fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        }),
      { label: 'embedding-sidecar', maxAttempts: 2, initialDelayMs: 500 },
    );

    if (!response.ok) {
      if (response.status === 503) {
        const retryAfter = response.headers.get('retry-after');
        throw unavailableError(
          `Embedding sidecar returned 503 (model loading). Retry after ${retryAfter ?? 'unknown'} seconds.`,
          { statusCode: 503 },
        );
      }
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
  const allChunks: SemanticCrawlChunk[] = [];
  for (const page of crawlResult.pages) {
    if (!page.success || !page.markdown) continue;
    const chunks = chunkMarkdown(page.markdown, page.url);
    allChunks.push(
      ...chunks.map((c) => ({
        text: c.content,
        url: c.url,
        section: c.section,
        score: 0,
        charOffset: c.charOffset,
        chunkIndex: c.chunkIndex,
        totalChunks: c.totalChunks,
      })),
    );
  }

  // 3. Chunk safety check
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

  // 4. Embed chunks and query in parallel
  const chunkTexts = allChunks.map((c) => c.text);
  const [chunkEmbeddings, queryEmbeddings] = await Promise.all([
    embedTexts(embeddingBaseUrl, embeddingApiToken, chunkTexts, 'document', embeddingDimensions),
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
    chunk.score = cosineSimilarity(queryEmbedding, emb);
  }
  allChunks.sort((a, b) => b.score - a.score);

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
