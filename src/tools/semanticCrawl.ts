import { logger } from '../logger.js';
import { unavailableError, networkError, parseError } from '../errors.js';
import { retryWithBackoff } from '../retry.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { webCrawl, type WebCrawlOptions } from './webCrawl.js';
import { webSearch } from './webSearch.js';
import { chunkMarkdown } from '../chunking.js';
import { parseSitemap, isSitemapIndex } from '../utils/sitemap.js';
import { dedupPages } from '../utils/url.js';
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
    const batchEmbeddings = await embedTexts(
      baseUrl,
      apiToken,
      batchTexts,
      mode,
      dimensions,
      batchTitles,
    );
    embeddings.push(...batchEmbeddings);
  }
  return embeddings;
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

  const dim = chunkEmbeddings[0]!.embedding.length;
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
  const chunkTitles = deduped.map(
    (c) =>
      c.section
        .split(' > ')
        .at(-1)
        ?.replace(/^#+\s+/, '') ?? 'none',
  );
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
  const paired: ChunkWithEmbedding[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const chunk = deduped[i];
    const emb = chunkEmbeddings[i];
    if (!chunk || emb === undefined) continue;
    paired.push({
      chunk: {
        text: chunk.text,
        url: chunk.url,
        section: chunk.section,
        biEncoderScore: cosineSimilarity(queryEmbedding, emb),
        charOffset: chunk.charOffset,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
      },
      embedding: emb,
    });
  }
  paired.sort((a, b) => b.chunk.biEncoderScore - a.chunk.biEncoderScore);

  // 5. Semantic coherence filter (borderline off-topic chunks)
  const coherent = filterBySemanticCoherence(paired);
  if (coherent.length < paired.length) {
    logger.info(
      { before: paired.length, after: coherent.length },
      'Semantic coherence filter removed off-topic chunks',
    );
  }

  // 6. Optional cross-encoder re-ranking
  let topChunks: SemanticCrawlChunk[];

  if (opts.useReranker !== false && coherent.length > 1) {
    const rerankCount = Math.min(RERANK_CANDIDATES, coherent.length);
    const candidates = coherent.slice(0, rerankCount);
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
    topChunks = coherent.slice(0, opts.topK);
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
    return reranked.map((r) => {
      const candidate = candidates[r.index];
      return candidate ? { ...candidate, rerankScore: r.score } : candidates[r.index]!;
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

/** Crawl a list of seed URLs with per-seed budget division and sequential budget tracking. */
async function crawlSeeds(
  seedUrls: string[],
  crawl4aiCfg: Crawl4aiConfig,
  opts: Pick<
    SemanticCrawlOptions,
    'strategy' | 'maxDepth' | 'maxPages' | 'includeExternalLinks' | 'maxBytes'
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
    totalPagesAttempted += result.totalPages;
    totalSuccessfulPages += result.successfulPages;
    allPages.push(...result.pages);

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

function pagesToCorpus(pages: CrawlPageResult[]): CorpusChunk[] {
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

    default: {
      // Exhaustiveness check — TypeScript should prevent this at compile time
      throw new Error(`Unknown source type '${(opts.source as { type: string }).type}'`);
    }
  }

  // Embed and rank via shared helper
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
