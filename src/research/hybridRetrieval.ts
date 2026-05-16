/**
 * HybridRetrieval — BM25 + dense embedding retrieval fused with RRF.
 *
 * Pipeline:
 *   1. Build BM25 index from source chunks.
 *   2. Embed query + chunks via the configured embedding provider.
 *   3. Score chunks with BM25 (lexical) and cosine similarity (dense).
 *   4. Fuse both ranked lists via Reciprocal Rank Fusion (RRF).
 *   5. Return top-K chunks sorted by RRF score.
 *
 * This replaces the purely-lexical relevance scoring that used a fixed 0.72
 * threshold. RRF is robust to score-scale mismatches between BM25 and dense
 * signals — neither signal dominates by magnitude alone.
 */

import { logger } from '../logger.js';
import { buildBm25Index, type Bm25Index, type Bm25Document } from '../utils/bm25.js';
import { rrfMerge } from '../utils/fusion.js';
import { embedTextsBatched } from '../rag/embedding.js';
import { loadConfig } from '../config.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChunkEntry {
  /** Unique ID for this chunk (e.g. `sourceId-chunkIndex`). */
  id: string;
  /** Chunk text content. */
  text: string;
  /** Source ID this chunk belongs to. */
  sourceId: string;
  /** Source URL. */
  sourceUrl?: string;
  /** Optional section heading. */
  heading?: string;
}

export interface RankedChunk {
  chunk: ChunkEntry;
  /** RRF fused score — higher is more relevant. */
  rrfScore: number;
  /** BM25 lexical score (pre-fusion). */
  bm25Score?: number;
  /** Cosine similarity score (pre-fusion). */
  denseScore?: number;
  /** 0-based rank in BM25 list. */
  bm25Rank?: number;
  /** 0-based rank in dense list. */
  denseRank?: number;
}

export interface HybridRetrievalOptions {
  /** Number of top chunks to return after RRF fusion. Default: 60. */
  topK?: number;
  /** RRF constant k. Default: 60. */
  rrfK?: number;
  /** Embedding dimensions. Default: from config (768). */
  dimensions?: number;
  /** Max chunks to embed per batch. Default: 512. */
  embedBatchSize?: number;
  /** Whether to expand the query into multiple paraphrase variations. Default: false. */
  expandQuery?: boolean;
  /** LLM client for query expansion (required if expandQuery is true). */
  llmClient?: import('./llm/chat.js').DeepResearchLlmClient | undefined;
}

// ── Cosine similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) {
    throw new RangeError(`cosineSimilarity length mismatch: a=${String(a.length)}, b=${String(b.length)}`);
  }
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

// ── BM25 retrieval ───────────────────────────────────────────────────────────

interface Bm25Result {
  id: string;
  score: number;
}

function bm25Retrieve(index: Bm25Index, query: string, topK: number): Bm25Result[] {
  try {
    const results = index.search(query, topK);
    return results.map((r) => ({ id: r.id, score: r.score }));
  } catch (err) {
    logger.warn({ err }, 'BM25 retrieval failed, returning empty list');
    return [];
  }
}

// ── Dense retrieval ──────────────────────────────────────────────────────────

interface DenseResult {
  id: string;
  score: number;
}

interface EmbeddingConfig {
  baseUrl: string;
  apiToken: string | undefined;
}

interface ChunkEmbedding {
  id: string;
  embedding: number[];
}

async function embedChunkEmbeddings(
  chunks: ChunkEntry[],
  dimensions: number,
  embeddingConfig: EmbeddingConfig,
): Promise<ChunkEmbedding[]> {
  if (chunks.length === 0) return [];

  try {
    const chunkResp = await embedTextsBatched({
      texts: chunks.map((c) => c.text),
      mode: 'document',
      dimensions,
      baseUrl: embeddingConfig.baseUrl,
      apiToken: embeddingConfig.apiToken,
    });

    const results: ChunkEmbedding[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = chunkResp.embeddings[i];
      if (!chunk?.id || !embedding || embedding.length === 0) continue;
      results.push({ id: chunk.id, embedding });
    }

    return results;
  } catch (err) {
    logger.warn({ err }, 'Dense retrieval failed while embedding chunks');
    return [];
  }
}

async function denseRetrieve(
  query: string,
  chunkEmbeddings: ChunkEmbedding[],
  dimensions: number,
  embeddingConfig: EmbeddingConfig,
): Promise<DenseResult[]> {
  if (chunkEmbeddings.length === 0) return [];

  try {
    const queryEmbedResp = await embedTextsBatched({
      texts: [query],
      mode: 'query',
      dimensions,
      baseUrl: embeddingConfig.baseUrl,
      apiToken: embeddingConfig.apiToken,
    });
    const queryEmbedding = queryEmbedResp.embeddings[0];
    if (!queryEmbedding || queryEmbedding.length === 0) {
      logger.warn('Dense retrieval: query embedding is empty');
      return [];
    }

    const results: DenseResult[] = [];
    for (const chunk of chunkEmbeddings) {
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (score > 0) {
        results.push({ id: chunk.id, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  } catch (err) {
    logger.warn({ err }, 'Dense retrieval failed, returning empty list');
    return [];
  }
}

// ── RRF fusion ───────────────────────────────────────────────────────────────

function buildBestScoreMap(
  rankings: { id: string; score: number }[][],
): Map<string, { score: number; rank: number }> {
  const map = new Map<string, { score: number; rank: number }>();
  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank++) {
      const item = ranking[rank];
      if (!item) continue;
      const current = map.get(item.id);
      if (!current || item.score > current.score || (item.score === current.score && rank < current.rank)) {
        map.set(item.id, { score: item.score, rank });
      }
    }
  }
  return map;
}

function fuseResults(
  bm25Rankings: Bm25Result[][],
  denseRankings: DenseResult[][],
  chunks: ChunkEntry[],
  rrfK: number,
): RankedChunk[] {
  // Build lookup maps
  const chunkMap = new Map<string, ChunkEntry>();
  for (const c of chunks) {
    chunkMap.set(c.id, c);
  }

  // Convert to RRF-compatible format (ordered lists of items with a URL/id)
  // RRF uses a keyFn to identify items across rankings.
  // We use chunk.id as the canonical key and pass getId for cross-ranking merge.

  const fused = rrfMerge([...bm25Rankings, ...denseRankings], {
    k: rrfK,
    keyFn: (item) => (item as { id: string }).id,
    getId: (item) => (item as { id: string }).id,
  });

  // Build result with scores from each ranking
  const bm25Map = buildBestScoreMap(bm25Rankings);
  const denseMap = buildBestScoreMap(denseRankings);

  const ranked: RankedChunk[] = [];
  for (const fusedItem of fused) {
    const chunkId = (fusedItem.item as { id: string }).id;
    const chunk = chunkMap.get(chunkId);
    if (!chunk) continue;

    const bm25Info = bm25Map.get(chunkId);
    const denseInfo = denseMap.get(chunkId);

    const entry: RankedChunk = {
      chunk,
      rrfScore: fusedItem.rrfScore,
    };
    if (bm25Info !== undefined) {
      entry.bm25Score = bm25Info.score;
      entry.bm25Rank = bm25Info.rank;
    }
    if (denseInfo !== undefined) {
      entry.denseScore = denseInfo.score;
      entry.denseRank = denseInfo.rank;
    }
    ranked.push(entry);
  }

  return ranked;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Expand a query into 3-5 paraphrase variations using the LLM.
 * Uses the worker model for cost efficiency.
 */
async function expandQueryWithLlm(
  query: string,
  llmClient: import('./llm/chat.js').DeepResearchLlmClient,
): Promise<string[]> {
  const { WORKER_EXPAND_QUERY } = await import('./llm/prompts.js');
  const { QueryExpansionResultSchema } = await import('./llm/schemas.js');

  const result = await llmClient.callJSON<{ variations: string[] }>({
    messages: [
      { role: 'system', content: WORKER_EXPAND_QUERY },
      { role: 'user', content: query },
    ],
    temperature: 0.5,
    maxTokens: 512,
    responseFormat: 'json_object',
    model: 'worker',
  });

  if (!result.success) {
    logger.warn('Query expansion LLM call failed');
    return [];
  }

  const validated = QueryExpansionResultSchema.safeParse(result.data);
  if (!validated.success) {
    logger.warn({ errors: validated.error.issues }, 'Query expansion validation failed');
    return [];
  }

  return validated.data.variations.filter((v) => v.length > 0).slice(0, 5);
}

/**
 * Run hybrid retrieval on a set of chunks.
 *
 * 1. Builds BM25 index from all chunks.
 * 2. Dense-embeds query + chunks.
 * 3. Retrieves top-K via BM25 and cosine similarity.
 * 4. Fuses both ranked lists with RRF.
 * 5. Returns top-ranked chunks.
 *
 * @param query  The research sub-question or query text.
 * @param chunks The chunks to retrieve from.
 * @param options  Tuning parameters.
 * @returns Top-ranked chunks sorted by fused relevance.
 */
export async function hybridRetrieve(
  query: string,
  chunks: ChunkEntry[],
  options: HybridRetrievalOptions = {},
): Promise<RankedChunk[]> {
  const topK = options.topK ?? 60;
  const rrfK = options.rrfK ?? 60;
  const embedBatchSize = options.embedBatchSize ?? 512;
  const config = loadConfig();
  const dimensions = options.dimensions ?? config.embeddingSidecar.dimensions;
  const embeddingConfig: EmbeddingConfig = {
    baseUrl: config.embeddingSidecar.baseUrl,
    apiToken: config.embeddingSidecar.apiToken,
  };

  if (chunks.length === 0) return [];

  logger.info(
    { chunkCount: chunks.length, query: query.slice(0, 80) },
    'Hybrid retrieval starting',
  );

  // Step 0: Expand query if enabled and LLM is available
  let queries = [query];
  if (options.expandQuery && options.llmClient) {
    try {
      const expansions = await expandQueryWithLlm(query, options.llmClient);
      queries = [query, ...expansions];
      logger.info(
        { originalQuery: query.slice(0, 80), variations: expansions.length },
        'Query expanded for retrieval',
      );
    } catch (err) {
      logger.warn({ err }, 'Query expansion failed, using original query only');
    }
  }

  // Step 0.5: Limit chunks to what we can reasonably embed
  if (chunks.length > embedBatchSize) {
    logger.warn(
      { originalChunks: chunks.length, embedBatchSize },
      'Hybrid retrieval truncating chunks before embedding',
    );
  }
  const effectiveChunks = chunks.slice(0, embedBatchSize);
  const chunkEmbeddings = await embedChunkEmbeddings(effectiveChunks, dimensions, embeddingConfig);

  // Step 1: Build BM25 index (shared across all query variations)
  const bm25Docs: Bm25Document[] = effectiveChunks.map((c) => ({
    id: c.id,
    text: c.text,
  }));
  const bm25Index = buildBm25Index(bm25Docs);

  // Step 2: BM25 retrieval for all query variations (lexical)
  const bm25Rankings: Bm25Result[][] = [];
  for (const q of queries) {
    bm25Rankings.push(bm25Retrieve(bm25Index, q, topK * 3));
  }

  // Step 3: Dense retrieval for all query variations (semantic)
  const denseRankings: DenseResult[][] = [];
  for (const q of queries) {
    denseRankings.push(await denseRetrieve(q, chunkEmbeddings, dimensions, embeddingConfig));
  }

  // Step 4: RRF fusion
  const fused = fuseResults(bm25Rankings, denseRankings, effectiveChunks, rrfK);

  // Step 5: Return top-K
  const final = fused.slice(0, topK);

  logger.info(
    {
      query: query.slice(0, 80),
      totalChunks: chunks.length,
      bm25Candidates: bm25Rankings.reduce((sum, ranking) => sum + ranking.length, 0),
      denseCandidates: denseRankings.reduce((sum, ranking) => sum + ranking.length, 0),
      fusedCount: fused.length,
      returned: final.length,
    },
    'Hybrid retrieval complete',
  );

  return final;
}

/**
 * Run hybrid retrieval per source across all sources.
 *
 * For each source's chunks, retrieves top-K relevant to the query.
 * Returns a flat list of ranked chunks with source attribution.
 *
 * This is used by the ExtractionEngine to narrow chunks from 30 pages
 * (~600 passages) down to 60 relevant passages before reranking.
 */
export async function hybridRetrieveAcrossSources(
  query: string,
  sourceChunks: Map<string, ChunkEntry[]>,
  options: HybridRetrievalOptions = {},
): Promise<RankedChunk[]> {
  const topK = options.topK ?? 60;
  const allChunks: ChunkEntry[] = [];

  // Flatten all source chunks into a single list, prefixing IDs with source
  for (const [sourceId, chunks] of sourceChunks) {
    for (const chunk of chunks) {
      allChunks.push({
        ...chunk,
        id: `${sourceId}-${chunk.id}`,
        sourceId,
      });
    }
  }

  return hybridRetrieve(query, allChunks, { ...options, topK });
}
