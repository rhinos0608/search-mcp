/**
 * Disk-backed corpus cache.
 *
 * Storage:
 *   {cacheDir}/{corpusId}.json  — metadata + chunks + bm25Docs
 *   {cacheDir}/{corpusId}.bin   — raw Float32Array embeddings
 *
 * Binary layout:
 *   [4 bytes: uint32 numEmbeddings]
 *   [4 bytes: uint32 dimensionsPerEmbedding]
 *   [N × D × 4 bytes: float32 values row-major]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CorpusChunk, SemanticCrawlSource } from '../types.js';
import { buildBm25Index, type Bm25Index } from './bm25.js';
import { logger } from '../logger.js';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface CachedCorpus {
  corpusId: string;
  source: SemanticCrawlSource;
  contentHash: string;
  model: string;
  dimensions: number;
  chunks: CorpusChunk[];
  embeddings: number[][];
  bm25Index: Bm25Index;
  createdAt: number;    // Unix ms
  lastAccessedAt: number; // Unix ms
}

// ────────────────────────────────────────────────────────────────────
// Internal metadata shape (what we write to .json)
// ────────────────────────────────────────────────────────────────────

interface CorpusMetadata {
  corpusId: string;
  source: SemanticCrawlSource;
  contentHash: string;
  model: string;
  dimensions: number;
  createdAt: number;
  lastAccessedAt: number;
  chunks: CorpusChunk[];
  bm25Docs: { id: string; text: string }[];
}

// ────────────────────────────────────────────────────────────────────
// Options
// ────────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_CORPORA = 50;
const DEFAULT_CACHE_DIR = path.join(process.cwd(), '.cache', 'semantic-crawl');

interface CacheOpts {
  ttlMs?: number;
  maxCorpora?: number;
  cacheDir?: string;
}

// ────────────────────────────────────────────────────────────────────
// In-memory dedup map (stableStringify(source) → pending Promise)
// ────────────────────────────────────────────────────────────────────

const pendingBuilds = new Map<string, Promise<CachedCorpus>>();

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Sort object keys recursively to produce a stable JSON string. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/**
 * Deterministic corpusId.
 * sha256(stableStringify(source) + "|" + model + "|" + String(dimensions))
 * NOTE: model and dimensions come from the materialize result, so we compute
 * the id AFTER we have that info.
 */
export function computeCorpusId(
  source: SemanticCrawlSource,
  model: string,
  dimensions: number,
): string {
  const payload = stableStringify(source) + '|' + model + '|' + String(dimensions);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** BM25 document id for a chunk. */
function chunkToBm25Id(chunk: CorpusChunk): string {
  return chunk.url + ':' + String(chunk.chunkIndex);
}

// ────────────────────────────────────────────────────────────────────
// Cache directory helpers
// ────────────────────────────────────────────────────────────────────

function ensureCacheDir(cacheDir: string): boolean {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    return true;
  } catch (err) {
    logger.warn({ err, cacheDir }, 'corpusCache: failed to create cache directory');
    return false;
  }
}

function metaPath(cacheDir: string, corpusId: string): string {
  return path.join(cacheDir, `${corpusId}.json`);
}

function binPath(cacheDir: string, corpusId: string): string {
  return path.join(cacheDir, `${corpusId}.bin`);
}

// ────────────────────────────────────────────────────────────────────
// Binary serialization
// ────────────────────────────────────────────────────────────────────

function serializeEmbeddings(embeddings: number[][]): Buffer {
  const N = embeddings.length;
  const D = N > 0 ? (embeddings[0]?.length ?? 0) : 0;
  const header = 8; // 2 × uint32
  const buf = Buffer.allocUnsafe(header + N * D * 4);
  buf.writeUInt32LE(N, 0);
  buf.writeUInt32LE(D, 4);
  let offset = header;
  for (const row of embeddings) {
    for (const val of row) {
      buf.writeFloatLE(val, offset);
      offset += 4;
    }
  }
  return buf;
}

function deserializeEmbeddings(buf: Buffer): number[][] {
  const N = buf.readUInt32LE(0);
  const D = buf.readUInt32LE(4);
  const result: number[][] = [];
  let offset = 8;
  for (let i = 0; i < N; i++) {
    const row: number[] = [];
    for (let d = 0; d < D; d++) {
      row.push(buf.readFloatLE(offset));
      offset += 4;
    }
    result.push(row);
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Write / read corpus files
// ────────────────────────────────────────────────────────────────────

function writeCorpus(
  cacheDir: string,
  meta: CorpusMetadata,
  embeddings: number[][],
): void {
  fs.writeFileSync(metaPath(cacheDir, meta.corpusId), JSON.stringify(meta), 'utf-8');
  fs.writeFileSync(binPath(cacheDir, meta.corpusId), serializeEmbeddings(embeddings));
}

function readCorpusFromDisk(
  cacheDir: string,
  corpusId: string,
  ttlMs: number,
  updateAccess = true,
): CachedCorpus | null {
  const mp = metaPath(cacheDir, corpusId);
  const bp = binPath(cacheDir, corpusId);

  if (!fs.existsSync(mp) || !fs.existsSync(bp)) {
    return null;
  }

  let meta: CorpusMetadata;
  try {
    meta = JSON.parse(fs.readFileSync(mp, 'utf-8')) as CorpusMetadata;
  } catch (err) {
    logger.error({ err, corpusId }, 'corpusCache: failed to parse metadata JSON');
    return null;
  }

  // TTL check
  if (Date.now() - meta.createdAt > ttlMs) {
    return null;
  }

  let embeddings: number[][];
  try {
    const buf = fs.readFileSync(bp);
    embeddings = deserializeEmbeddings(buf);
  } catch (err) {
    logger.error({ err, corpusId }, 'corpusCache: failed to read binary embeddings');
    return null;
  }

  // Rebuild BM25 index
  let bm25Index: Bm25Index;
  try {
    bm25Index = buildBm25Index(meta.bm25Docs);
  } catch (err) {
    logger.warn({ err, corpusId }, 'corpusCache: failed to rebuild BM25 index; using no-op');
    bm25Index = { search: () => [] };
  }

  // Update lastAccessedAt on disk only when this is an actual cache hit (not a scan)
  if (updateAccess) {
    try {
      meta.lastAccessedAt = Date.now();
      fs.writeFileSync(mp, JSON.stringify(meta), 'utf-8');
    } catch {
      // non-fatal
    }
  }

  return {
    corpusId: meta.corpusId,
    source: meta.source,
    contentHash: meta.contentHash,
    model: meta.model,
    dimensions: meta.dimensions,
    chunks: meta.chunks,
    embeddings,
    bm25Index,
    createdAt: meta.createdAt,
    lastAccessedAt: meta.lastAccessedAt,
  };
}

// ────────────────────────────────────────────────────────────────────
// Eviction
// ────────────────────────────────────────────────────────────────────

interface IndexEntry {
  corpusId: string;
  lastAccessedAt: number;
  createdAt: number;
  source: SemanticCrawlSource | undefined;
}

function listCachedCorpora(cacheDir: string): IndexEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(cacheDir);
  } catch {
    return [];
  }

  const entries: IndexEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const corpusId = f.slice(0, -5);
    // Prune orphan .json entries where the corresponding .bin is missing
    if (!fs.existsSync(binPath(cacheDir, corpusId))) {
      try {
        fs.rmSync(path.join(cacheDir, f), { force: true });
      } catch {
        // best effort
      }
      continue;
    }
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(cacheDir, f), 'utf-8'),
      ) as Partial<CorpusMetadata>;
      entries.push({
        corpusId,
        lastAccessedAt: meta.lastAccessedAt ?? 0,
        createdAt: meta.createdAt ?? 0,
        source: meta.source,
      });
    } catch {
      // skip corrupted file
    }
  }
  return entries;
}

function evictIfNeeded(
  cacheDir: string,
  ttlMs: number,
  maxCorpora: number,
  excludeId: string,
): void {
  const entries = listCachedCorpora(cacheDir);

  const now = Date.now();

  // Remove TTL-expired entries
  for (const e of entries) {
    if (e.corpusId !== excludeId && now - e.createdAt > ttlMs) {
      deleteCorpusFiles(cacheDir, e.corpusId);
    }
  }

  // Re-read after TTL cleanup
  const remaining = listCachedCorpora(cacheDir);

  // If over cap (accounting for the one we are about to write), evict LRU
  // The incoming corpusId is being written, so count would be remaining + 1
  // We need to keep maxCorpora - 1 to make room
  if (remaining.length >= maxCorpora) {
    // Sort by lastAccessedAt ascending (oldest = LRU)
    remaining.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    const toEvict = remaining.length - maxCorpora + 1;
    for (let i = 0; i < toEvict; i++) {
      const e = remaining[i];
      if (e && e.corpusId !== excludeId) {
        deleteCorpusFiles(cacheDir, e.corpusId);
      }
    }
  }
}

function deleteCorpusFiles(cacheDir: string, corpusId: string): void {
  try {
    fs.rmSync(metaPath(cacheDir, corpusId), { force: true });
    fs.rmSync(binPath(cacheDir, corpusId), { force: true });
  } catch (err) {
    logger.warn({ err, corpusId }, 'corpusCache: failed to delete corpus files');
  }
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Get a cached corpus or build it via `materializeFn`.
 *
 * - Deduplicates concurrent calls for the same source (thundering herd guard).
 * - Reads from disk when available and within TTL.
 * - Writes to disk after materializing.
 * - Evicts LRU + TTL-expired entries before writing.
 */
export async function getOrBuildCorpus(
  source: SemanticCrawlSource,
  materializeFn: () => Promise<{
    chunks: CorpusChunk[];
    embeddings: number[][];
    model: string;
    contentHash: string;
  }>,
  opts?: CacheOpts,
): Promise<CachedCorpus> {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const maxCorpora = opts?.maxCorpora ?? DEFAULT_MAX_CORPORA;
  const cacheDir = opts?.cacheDir ?? DEFAULT_CACHE_DIR;

  // We need a stable key before we know the model/dimensions.
  // Use a source-only key for the in-memory dedup map.
  const sourceKey = stableStringify(source);

  const existing = pendingBuilds.get(sourceKey);
  if (existing !== undefined) {
    return existing;
  }

  const promise = (async (): Promise<CachedCorpus> => {
    // Ensure cache dir exists
    const dirOk = ensureCacheDir(cacheDir);

    // Try to find an existing corpus for this source on disk.
    // First scan metadata only (no .bin reads) to find a matching entry by source,
    // then load the full corpus (including .bin) only for the single match.
    if (dirOk) {
      const entries = listCachedCorpora(cacheDir);
      const match = entries.find(e => stableStringify(e.source) === sourceKey);
      if (match !== undefined) {
        const loaded = readCorpusFromDisk(cacheDir, match.corpusId, ttlMs, false);
        if (loaded !== null) {
          // Actual cache hit — update lastAccessedAt now
          try {
            const mp = metaPath(cacheDir, match.corpusId);
            const meta = JSON.parse(fs.readFileSync(mp, 'utf-8')) as CorpusMetadata;
            meta.lastAccessedAt = Date.now();
            fs.writeFileSync(mp, JSON.stringify(meta), 'utf-8');
            loaded.lastAccessedAt = meta.lastAccessedAt;
          } catch {
            // non-fatal
          }
          return loaded;
        }
      }
    }

    // Not found — materialize
    const { chunks, embeddings, model, contentHash } = await materializeFn();
    const dimensions = embeddings.length > 0 ? (embeddings[0]?.length ?? 0) : 0;
    const corpusId = computeCorpusId(source, model, dimensions);
    const now = Date.now();

    const bm25Docs = chunks.map(c => ({ id: chunkToBm25Id(c), text: c.text }));
    let bm25Index: Bm25Index;
    try {
      bm25Index = buildBm25Index(bm25Docs);
    } catch (err) {
      logger.warn({ err }, 'corpusCache: failed to build BM25 index; using no-op');
      bm25Index = { search: () => [] };
    }

    const corpus: CachedCorpus = {
      corpusId,
      source,
      contentHash,
      model,
      dimensions,
      chunks,
      embeddings,
      bm25Index,
      createdAt: now,
      lastAccessedAt: now,
    };

    if (dirOk) {
      try {
        evictIfNeeded(cacheDir, ttlMs, maxCorpora, corpusId);

        const meta: CorpusMetadata = {
          corpusId,
          source,
          contentHash,
          model,
          dimensions,
          createdAt: now,
          lastAccessedAt: now,
          chunks,
          bm25Docs,
        };
        writeCorpus(cacheDir, meta, embeddings);
      } catch (err) {
        logger.warn({ err, corpusId }, 'corpusCache: failed to write corpus to disk');
      }
    }

    return corpus;
  })().finally(() => {
    pendingBuilds.delete(sourceKey);
  });

  pendingBuilds.set(sourceKey, promise);
  return promise;
}

/**
 * Load a previously cached corpus by its deterministic ID.
 * Returns null if not found, corrupted, or TTL-expired.
 */
export function loadCorpusById(
  corpusId: string,
  opts?: CacheOpts,
): Promise<CachedCorpus | null> {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const cacheDir = opts?.cacheDir ?? DEFAULT_CACHE_DIR;
  return Promise.resolve(readCorpusFromDisk(cacheDir, corpusId, ttlMs));
}

/**
 * Remove a corpus from disk and from the in-memory lock map.
 * Subsequent calls to getOrBuildCorpus will re-materialize.
 *
 * Pass `source` to also cancel any in-flight build for that source
 * (the pendingBuilds key is stableStringify(source), not corpusId).
 */
export function invalidateCorpus(
  corpusId: string,
  opts?: { cacheDir?: string; source?: SemanticCrawlSource },
): void {
  const cacheDir = opts?.cacheDir ?? DEFAULT_CACHE_DIR;
  deleteCorpusFiles(cacheDir, corpusId);
  if (opts?.source !== undefined) {
    pendingBuilds.delete(stableStringify(opts.source));
  }
}
