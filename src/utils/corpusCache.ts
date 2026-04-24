/**
 * Disk-backed corpus cache.
 *
 * Storage:
 *   {cacheDir}/source-index.json  — source key → corpusId mapping (fast lookup)
 *   {cacheDir}/{corpusId}.json     — metadata + chunks + bm25Docs
 *   {cacheDir}/{corpusId}.bin      — raw Float32Array embeddings
 *
 * Binary layout (.bin):
 *   [4 bytes: uint32 numEmbeddings]
 *   [4 bytes: uint32 dimensionsPerEmbedding]
 *   [N × D × 4 bytes: float32 values row-major]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { CorpusChunk, SemanticCrawlSource } from '../types.js';
import { buildBm25Index, type Bm25Index } from './bm25.js';
import { logger } from '../logger.js';
import { MAX_TOKENS, MIN_TOKENS, TOKEN_RATIO, OVERLAP_RATIO } from '../chunking.js';

// ────────────────────────────────────────────────────────────────────
// Schema version — increment when the on-disk format changes
// ────────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

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
  /**
   * Aggregated extractedData from the original crawl, keyed by URL.
   * Only present when the original crawl used an extractionConfig.
   * Absent for older cached corpora or those built without extraction.
   *
   * **Known limitation**: extractedData is not currently persisted to disk cache.
   * Re-querying with `source: { type: 'cached', corpusId }` will return no
   * extractedData even if the original crawl produced some. To get extractedData
   * again, re-issue the request with the original source type (e.g. 'url').
   */
  extractedData?: Record<string, Record<string, unknown>[]>;
}

// ────────────────────────────────────────────────────────────────────
// Internal metadata shape (what we write to .json)
// ────────────────────────────────────────────────────────────────────

interface CorpusMetadata {
  schemaVersion: number;
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
// Source index entry (stored in source-index.json)
// ────────────────────────────────────────────────────────────────────

interface SourceIndexEntry {
  corpusId: string;
  model: string;
  dimensions: number;
  createdAt: number;
}

// ────────────────────────────────────────────────────────────────────
// Options
// ────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CORPORA = 50;

const DEFAULT_CACHE_DIR =
  process.env.SEMANTIC_CRAWL_CACHE_DIR ??
  path.join(os.homedir(), '.cache', 'search-mcp', 'semantic-crawl');

const DEFAULT_TTL_MS =
  process.env.SEMANTIC_CRAWL_CACHE_TTL_MS !== undefined
    ? parseInt(process.env.SEMANTIC_CRAWL_CACHE_TTL_MS, 10)
    : 7 * 24 * 60 * 60 * 1000;

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
 * Normalize a source for stable comparison: sort urls arrays so that
 * different orderings produce the same canonical form.
 */
function normalizeSource(source: SemanticCrawlSource): SemanticCrawlSource {
  if (source.type === 'url') {
    if (source.urls !== undefined) {
      return { type: 'url', url: source.url, urls: [...source.urls].sort() };
    }
    return source;
  }
  if (source.type === 'search') {
    return { type: 'search', query: source.query, maxSeedUrls: source.maxSeedUrls };
  }
  if (source.type === 'sitemap') {
    return { type: 'sitemap', url: source.url };
  }
  if (source.type === 'github') {
    return { type: 'github', owner: source.owner, repo: source.repo, branch: source.branch, extensions: source.extensions, query: source.query };
  }
  return { type: 'cached', corpusId: source.corpusId };
}

/**
 * Deterministic corpusId including chunking parameters.
 * sha256(normalized_source | model | dimensions | MAX_TOKENS | MIN_TOKENS | OVERLAP_RATIO | TOKEN_RATIO)
 */
export function computeCorpusId(
  source: SemanticCrawlSource,
  model: string,
  dimensions: number,
): string {
  const payload =
    stableStringify(normalizeSource(source)) +
    '|' + model + '|' + String(dimensions) +
    '|' + String(MAX_TOKENS) + '|' + String(MIN_TOKENS) +
    '|' + String(OVERLAP_RATIO) + '|' + String(TOKEN_RATIO);
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

function indexPath(cacheDir: string): string {
  return path.join(cacheDir, 'source-index.json');
}

// ────────────────────────────────────────────────────────────────────
// Source index helpers
// ────────────────────────────────────────────────────────────────────

/** Read the full source-index.json, or return empty object if absent. */
function readSourceIndex(cacheDir: string): Record<string, SourceIndexEntry[]> {
  const ip = indexPath(cacheDir);
  if (!fs.existsSync(ip)) return {};
  try {
    const raw = fs.readFileSync(ip, 'utf-8');
    return JSON.parse(raw) as Record<string, SourceIndexEntry[]>;
  } catch {
    return {};
  }
}

/** Write the source index (entries sorted by createdAt descending). */
function writeSourceIndex(cacheDir: string, index: Record<string, SourceIndexEntry[]>): void {
  fs.writeFileSync(indexPath(cacheDir), JSON.stringify(index), 'utf-8');
}

/**
 * Add or update an entry in the source index for a given source key.
 * Entries are kept sorted by createdAt descending (most recent first).
 */
function addToSourceIndex(
  cacheDir: string,
  sourceKey: string,
  entry: SourceIndexEntry,
): void {
  const index = readSourceIndex(cacheDir);
  const existing = index[sourceKey] ?? [];
  // Remove any entry with the same corpusId (replace case)
  const filtered = existing.filter(e => e.corpusId !== entry.corpusId);
  // Insert in descending createdAt order
  const insertAt = filtered.findIndex(e => e.createdAt < entry.createdAt);
  if (insertAt === -1) {
    filtered.push(entry);
  } else {
    filtered.splice(insertAt, 0, entry);
  }
  index[sourceKey] = filtered;
  writeSourceIndex(cacheDir, index);
}

/**
 * Look up corpusIds for a source key from the source index.
 * Returns entries sorted by createdAt descending.
 */
function findInSourceIndex(
  cacheDir: string,
  sourceKey: string,
): SourceIndexEntry[] {
  return readSourceIndex(cacheDir)[sourceKey] ?? [];
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
  const jsonTmp = metaPath(cacheDir, meta.corpusId) + '.tmp';
  const binTmp = binPath(cacheDir, meta.corpusId) + '.tmp';
  const jsonFinal = metaPath(cacheDir, meta.corpusId);
  const binFinal = binPath(cacheDir, meta.corpusId);

  try {
    fs.writeFileSync(jsonTmp, JSON.stringify(meta), 'utf-8');
    fs.writeFileSync(binTmp, serializeEmbeddings(embeddings));
    fs.renameSync(jsonTmp, jsonFinal);
    fs.renameSync(binTmp, binFinal);
  } catch (err) {
    // Clean up temp files on any error
    try {
      fs.rmSync(jsonTmp, { force: true });
    } catch {
      // best effort
    }
    try {
      fs.rmSync(binTmp, { force: true });
    } catch {
      // best effort
    }
    throw err;
  }
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

  // Schema version check
  if (meta.schemaVersion !== SCHEMA_VERSION) {
    logger.warn({ corpusId, found: meta.schemaVersion, expected: SCHEMA_VERSION }, 'corpusCache: schema version mismatch');
    return null;
  }

  // Content hash validation
  const recomputedHash = crypto.createHash('sha256').update(meta.chunks.map(c => c.text).join('\n')).digest('hex');
  if (recomputedHash !== meta.contentHash) {
    logger.warn({ corpusId, expected: meta.contentHash, actual: recomputedHash }, 'corpusCache: content hash mismatch');
    return null;
  }

  // TTL check
  if (Date.now() - meta.createdAt > ttlMs) {
    return null;
  }

  if (meta.chunks.length === 0) {
    logger.warn({ corpusId }, 'corpusCache: ignoring empty corpus');
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
    // Skip the source-index.json
    if (f === 'source-index.json') continue;
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
 * - Looks up source in source-index.json → reads from disk when available and within TTL.
 * - Writes to disk after materializing (updating source-index.json).
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

  // Stable key for pendingBuilds map — uses normalized source for consistency
  const sourceKey = stableStringify(normalizeSource(source));

  const existing = pendingBuilds.get(sourceKey);
  if (existing !== undefined) {
    return existing;
  }

  const promise = (async (): Promise<CachedCorpus> => {
    // Ensure cache dir exists
    const dirOk = ensureCacheDir(cacheDir);

    // Look up corpusIds for this source via the source index
    if (dirOk) {
      const candidates = findInSourceIndex(cacheDir, sourceKey);
      for (const candidate of candidates) {
        const loaded = readCorpusFromDisk(cacheDir, candidate.corpusId, ttlMs, true);
        if (loaded !== null) {
          // Return the disk-loaded corpus; update lastAccessedAt was done in readCorpusFromDisk
          return loaded;
        }
        // If readCorpusFromDisk returned null (hash mismatch, schema mismatch, TTL expired),
        // fall through to materialize
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

    if (dirOk && chunks.length > 0) {
      try {
        evictIfNeeded(cacheDir, ttlMs, maxCorpora, corpusId);

        const meta: CorpusMetadata = {
          schemaVersion: SCHEMA_VERSION,
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

        // Update the source index
        addToSourceIndex(cacheDir, sourceKey, {
          corpusId,
          model,
          dimensions,
          createdAt: now,
        });
      } catch (err) {
        logger.warn({ err, corpusId }, 'corpusCache: failed to write corpus to disk');
      }
    } else if (chunks.length === 0) {
      logger.warn({ source }, 'corpusCache: not persisting empty corpus');
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
): CachedCorpus | null {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const cacheDir = opts?.cacheDir ?? DEFAULT_CACHE_DIR;
  return readCorpusFromDisk(cacheDir, corpusId, ttlMs);
}

/**
 * Remove a corpus from disk and from the in-memory lock map.
 * Subsequent calls to getOrBuildCorpus will re-materialize.
 *
 * Pass `source` to also cancel any in-flight build for that source
 * (the pendingBuilds key is stableStringify(normalizeSource(source)), not corpusId).
 */
export function invalidateCorpus(
  corpusId: string,
  opts?: { cacheDir?: string; source?: SemanticCrawlSource },
): void {
  const cacheDir = opts?.cacheDir ?? DEFAULT_CACHE_DIR;
  deleteCorpusFiles(cacheDir, corpusId);
  if (opts?.source !== undefined) {
    pendingBuilds.delete(stableStringify(normalizeSource(opts.source)));
  }
}
