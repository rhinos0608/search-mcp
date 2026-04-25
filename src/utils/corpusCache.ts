/**
 * SQLite-backed corpus cache.
 *
 * Storage:
 *   {cacheDir}/corpus-cache.sqlite by default, or DATABASE_PATH when set.
 *
 * The cache stores corpus metadata, chunks, embedding vectors, and source-key
 * lookup rows in one durable database. BM25 is rebuilt on load from cached
 * chunk text, keeping the database schema small while preserving fast reads.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { CorpusChunk, SemanticCrawlSource } from '../types.js';
import { buildBm25Index, type Bm25Index } from './bm25.js';
import { logger } from '../logger.js';
import { MAX_TOKENS, MIN_TOKENS, TOKEN_RATIO, OVERLAP_RATIO } from '../chunking.js';

// ────────────────────────────────────────────────────────────────────
// Schema version — increment when the SQLite schema changes
// ────────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 2;

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
  createdAt: number; // Unix ms
  lastAccessedAt: number; // Unix ms
  /** Aggregated extractedData from the original crawl, keyed by URL. */
  extractedData?: Record<string, Record<string, unknown>[]>;
}

// ────────────────────────────────────────────────────────────────────
// SQLite row shapes
// ────────────────────────────────────────────────────────────────────

interface CorpusRow {
  corpus_id: string;
  source_key: string;
  source_json: string;
  content_hash: string;
  model: string;
  dimensions: number;
  created_at: number;
  last_accessed_at: number;
  total_bytes: number;
}

interface ChunkRow {
  position: number;
  chunk_json: string;
  bm25_id: string;
  bm25_text: string;
}

interface EmbeddingRow {
  position: number;
  vector: Buffer;
}

interface SourceIndexEntry {
  corpusId: string;
  model: string;
  dimensions: number;
  createdAt: number;
}

interface SourceIndexRow {
  corpus_id: string;
  model: string;
  dimensions: number;
  created_at: number;
}

interface EvictionRow {
  corpus_id: string;
  last_accessed_at: number;
  created_at: number;
  total_bytes: number;
}

interface CacheOpts {
  ttlMs?: number;
  maxCorpora?: number;
  maxTotalBytes?: number;
  cacheDir?: string;
  databasePath?: string;
}

// ────────────────────────────────────────────────────────────────────
// Options
// ────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CORPORA = 50;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

const DEFAULT_CACHE_DIR =
  process.env.SEMANTIC_CRAWL_CACHE_DIR ??
  path.join(os.homedir(), '.cache', 'search-mcp', 'semantic-crawl');

const DEFAULT_TTL_MS =
  process.env.SEMANTIC_CRAWL_CACHE_TTL_MS !== undefined
    ? parseInt(process.env.SEMANTIC_CRAWL_CACHE_TTL_MS, 10)
    : 7 * 24 * 60 * 60 * 1000;

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
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
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
    return {
      type: 'github',
      owner: source.owner,
      repo: source.repo,
      branch: source.branch,
      extensions: source.extensions,
      query: source.query,
    };
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
    '|' +
    model +
    '|' +
    String(dimensions) +
    '|' +
    String(MAX_TOKENS) +
    '|' +
    String(MIN_TOKENS) +
    '|' +
    String(OVERLAP_RATIO) +
    '|' +
    String(TOKEN_RATIO);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** BM25 document id for a chunk. */
function chunkToBm25Id(chunk: CorpusChunk): string {
  return chunk.url + ':' + String(chunk.chunkIndex);
}

function contentHashForChunks(chunks: CorpusChunk[]): string {
  return crypto
    .createHash('sha256')
    .update(chunks.map((c) => c.text).join('\n'))
    .digest('hex');
}

function resolveDatabasePath(opts?: CacheOpts): string {
  if (opts?.databasePath !== undefined) return opts.databasePath;
  if (opts?.cacheDir !== undefined) return path.join(opts.cacheDir, 'corpus-cache.sqlite');
  return process.env.DATABASE_PATH ?? path.join(DEFAULT_CACHE_DIR, 'corpus-cache.sqlite');
}

function ensureDatabaseDir(databasePath: string): boolean {
  try {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    return true;
  } catch (err) {
    logger.warn({ err, databasePath }, 'corpusCache: failed to create database directory');
    return false;
  }
}

function openDatabase(databasePath: string): BetterSqliteDatabase {
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

function initSchema(db: BetterSqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS corpora (
      corpus_id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      source_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      corpus_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      chunk_json TEXT NOT NULL,
      bm25_id TEXT NOT NULL,
      bm25_text TEXT NOT NULL,
      PRIMARY KEY (corpus_id, position),
      FOREIGN KEY (corpus_id) REFERENCES corpora(corpus_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      corpus_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      vector BLOB NOT NULL,
      PRIMARY KEY (corpus_id, position),
      FOREIGN KEY (corpus_id) REFERENCES corpora(corpus_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS source_index (
      source_key TEXT NOT NULL,
      corpus_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source_key, corpus_id),
      FOREIGN KEY (corpus_id) REFERENCES corpora(corpus_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_source_index_lookup
      ON source_index(source_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_corpora_lru
      ON corpora(last_accessed_at ASC, created_at ASC);
  `);

  const current = db.prepare('SELECT value FROM cache_meta WHERE key = ?').get('schemaVersion') as
    | { value: string }
    | undefined;
  if (current === undefined) {
    db.prepare('INSERT INTO cache_meta (key, value) VALUES (?, ?)').run(
      'schemaVersion',
      String(SCHEMA_VERSION),
    );
  } else if (Number(current.value) !== SCHEMA_VERSION) {
    logger.warn(
      { found: current.value, expected: SCHEMA_VERSION },
      'corpusCache: SQLite schema version changed; existing compatible tables will be reused',
    );
    db.prepare('UPDATE cache_meta SET value = ? WHERE key = ?').run(
      String(SCHEMA_VERSION),
      'schemaVersion',
    );
  }
}

function withDatabase<T>(databasePath: string, fn: (db: BetterSqliteDatabase) => T): T | null {
  if (!ensureDatabaseDir(databasePath)) return null;
  let db: BetterSqliteDatabase | undefined;
  try {
    db = openDatabase(databasePath);
    return fn(db);
  } catch (err) {
    logger.warn({ err, databasePath }, 'corpusCache: SQLite operation failed');
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // best effort
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Embedding serialization
// ────────────────────────────────────────────────────────────────────

function serializeEmbedding(row: number[]): Buffer {
  const buf = Buffer.allocUnsafe(row.length * 4);
  let offset = 0;
  for (const val of row) {
    buf.writeFloatLE(val, offset);
    offset += 4;
  }
  return buf;
}

function deserializeEmbedding(buf: Buffer, dimensions: number): number[] | null {
  if (buf.length !== dimensions * 4) return null;
  const row: number[] = [];
  for (let offset = 0; offset < buf.length; offset += 4) {
    row.push(buf.readFloatLE(offset));
  }
  return row;
}

function estimateCorpusBytes(args: {
  sourceKey: string;
  source: SemanticCrawlSource;
  chunks: CorpusChunk[];
  embeddings: number[][];
  contentHash: string;
  model: string;
}): number {
  const jsonBytes =
    Buffer.byteLength(JSON.stringify(args.source), 'utf8') +
    Buffer.byteLength(args.sourceKey, 'utf8') +
    Buffer.byteLength(args.contentHash, 'utf8') +
    Buffer.byteLength(args.model, 'utf8');
  const chunkBytes = args.chunks.reduce(
    (total, chunk) =>
      total +
      Buffer.byteLength(JSON.stringify(chunk), 'utf8') +
      Buffer.byteLength(chunk.text, 'utf8'),
    0,
  );
  const embeddingBytes = args.embeddings.reduce((total, row) => total + row.length * 4, 0);
  return jsonBytes + chunkBytes + embeddingBytes;
}

// ────────────────────────────────────────────────────────────────────
// Read / write corpus rows
// ────────────────────────────────────────────────────────────────────

function writeCorpus(
  db: BetterSqliteDatabase,
  corpus: Omit<CachedCorpus, 'bm25Index'>,
  sourceKey: string,
  totalBytes: number,
): void {
  const insert = db.transaction(() => {
    db.prepare('DELETE FROM corpora WHERE corpus_id = ?').run(corpus.corpusId);
    db.prepare(
      `
      INSERT INTO corpora (
        corpus_id, source_key, source_json, content_hash, model,
        dimensions, created_at, last_accessed_at, total_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      corpus.corpusId,
      sourceKey,
      JSON.stringify(corpus.source),
      corpus.contentHash,
      corpus.model,
      corpus.dimensions,
      corpus.createdAt,
      corpus.lastAccessedAt,
      totalBytes,
    );

    const insertChunk = db.prepare(`
      INSERT INTO chunks (corpus_id, position, chunk_json, bm25_id, bm25_text)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertEmbedding = db.prepare(`
      INSERT INTO embeddings (corpus_id, position, vector)
      VALUES (?, ?, ?)
    `);

    corpus.chunks.forEach((chunk, position) => {
      insertChunk.run(
        corpus.corpusId,
        position,
        JSON.stringify(chunk),
        chunkToBm25Id(chunk),
        chunk.text,
      );
      insertEmbedding.run(
        corpus.corpusId,
        position,
        serializeEmbedding(corpus.embeddings[position] ?? []),
      );
    });

    db.prepare(
      `
      INSERT OR REPLACE INTO source_index (source_key, corpus_id, model, dimensions, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(sourceKey, corpus.corpusId, corpus.model, corpus.dimensions, corpus.createdAt);
  });

  insert();
}

function readCorpusFromDatabase(
  db: BetterSqliteDatabase,
  corpusId: string,
  ttlMs: number,
  updateAccess = true,
): CachedCorpus | null {
  const row = db.prepare('SELECT * FROM corpora WHERE corpus_id = ?').get(corpusId) as
    | CorpusRow
    | undefined;
  if (row === undefined) return null;

  if (Date.now() - row.created_at > ttlMs) {
    return null;
  }

  const chunkRows = db
    .prepare(
      'SELECT position, chunk_json, bm25_id, bm25_text FROM chunks WHERE corpus_id = ? ORDER BY position ASC',
    )
    .all(corpusId) as ChunkRow[];
  if (chunkRows.length === 0) {
    logger.warn({ corpusId }, 'corpusCache: ignoring empty corpus');
    return null;
  }

  let chunks: CorpusChunk[];
  try {
    chunks = chunkRows.map((chunkRow) => JSON.parse(chunkRow.chunk_json) as CorpusChunk);
  } catch (err) {
    logger.warn({ err, corpusId }, 'corpusCache: failed to parse chunk JSON');
    return null;
  }

  const recomputedHash = contentHashForChunks(chunks);
  if (recomputedHash !== row.content_hash) {
    logger.warn(
      { corpusId, expected: row.content_hash, actual: recomputedHash },
      'corpusCache: content hash mismatch',
    );
    return null;
  }

  const embeddingRows = db
    .prepare('SELECT position, vector FROM embeddings WHERE corpus_id = ? ORDER BY position ASC')
    .all(corpusId) as EmbeddingRow[];
  if (embeddingRows.length !== chunks.length) {
    logger.warn(
      { corpusId, chunks: chunks.length, embeddings: embeddingRows.length },
      'corpusCache: embedding count mismatch',
    );
    return null;
  }

  const embeddings: number[][] = [];
  for (const embeddingRow of embeddingRows) {
    const embedding = deserializeEmbedding(embeddingRow.vector, row.dimensions);
    if (embedding === null) {
      logger.warn(
        { corpusId, position: embeddingRow.position },
        'corpusCache: invalid embedding blob',
      );
      return null;
    }
    embeddings.push(embedding);
  }

  let source: SemanticCrawlSource;
  try {
    source = JSON.parse(row.source_json) as SemanticCrawlSource;
  } catch (err) {
    logger.warn({ err, corpusId }, 'corpusCache: failed to parse source JSON');
    return null;
  }

  let bm25Index: Bm25Index;
  try {
    bm25Index = buildBm25Index(
      chunkRows.map((chunkRow) => ({ id: chunkRow.bm25_id, text: chunkRow.bm25_text })),
    );
  } catch (err) {
    logger.warn({ err, corpusId }, 'corpusCache: failed to rebuild BM25 index; using no-op');
    bm25Index = { search: () => [] };
  }

  const lastAccessedAt = updateAccess ? Date.now() : row.last_accessed_at;
  if (updateAccess) {
    db.prepare('UPDATE corpora SET last_accessed_at = ? WHERE corpus_id = ?').run(
      lastAccessedAt,
      corpusId,
    );
  }

  return {
    corpusId: row.corpus_id,
    source,
    contentHash: row.content_hash,
    model: row.model,
    dimensions: row.dimensions,
    chunks,
    embeddings,
    bm25Index,
    createdAt: row.created_at,
    lastAccessedAt,
  };
}

function findInSourceIndex(db: BetterSqliteDatabase, sourceKey: string): SourceIndexEntry[] {
  const rows = db
    .prepare(
      'SELECT corpus_id, model, dimensions, created_at FROM source_index WHERE source_key = ? ORDER BY created_at DESC',
    )
    .all(sourceKey) as SourceIndexRow[];
  return rows.map((row) => ({
    corpusId: row.corpus_id,
    model: row.model,
    dimensions: row.dimensions,
    createdAt: row.created_at,
  }));
}

// ────────────────────────────────────────────────────────────────────
// Eviction
// ────────────────────────────────────────────────────────────────────

function deleteCorpus(db: BetterSqliteDatabase, corpusId: string): void {
  db.prepare('DELETE FROM corpora WHERE corpus_id = ?').run(corpusId);
}

function evictIfNeeded(
  db: BetterSqliteDatabase,
  ttlMs: number,
  maxCorpora: number,
  maxTotalBytes: number,
  excludeId: string,
): void {
  const now = Date.now();

  db.prepare('DELETE FROM corpora WHERE corpus_id <> ? AND ? - created_at > ?').run(
    excludeId,
    now,
    ttlMs,
  );

  let rows = db
    .prepare(
      'SELECT corpus_id, last_accessed_at, created_at, total_bytes FROM corpora ORDER BY last_accessed_at ASC, created_at ASC',
    )
    .all() as EvictionRow[];

  while (rows.length > maxCorpora) {
    const victim = rows.find((row) => row.corpus_id !== excludeId);
    if (victim === undefined) break;
    deleteCorpus(db, victim.corpus_id);
    rows = rows.filter((row) => row.corpus_id !== victim.corpus_id);
  }

  let totalBytes = rows.reduce((total, row) => total + row.total_bytes, 0);
  while (totalBytes > maxTotalBytes && rows.length > 1) {
    const victim = rows.find((row) => row.corpus_id !== excludeId);
    if (victim === undefined) break;
    deleteCorpus(db, victim.corpus_id);
    rows = rows.filter((row) => row.corpus_id !== victim.corpus_id);
    totalBytes -= victim.total_bytes;
  }
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Get a cached corpus or build it via `materializeFn`.
 *
 * - Deduplicates concurrent calls for the same source (thundering herd guard).
 * - Looks up source in SQLite source_index → reads from SQLite when available and within TTL.
 * - Writes to SQLite after materializing.
 * - Evicts TTL-expired, count-over-cap, and byte-over-cap rows after writing.
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
  const maxTotalBytes = opts?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const databasePath = resolveDatabasePath(opts);

  // Stable key for pendingBuilds map — uses normalized source for consistency
  const sourceKey = stableStringify(normalizeSource(source));

  const existing = pendingBuilds.get(sourceKey);
  if (existing !== undefined) {
    return existing;
  }

  const promise = (async (): Promise<CachedCorpus> => {
    const cached = withDatabase(databasePath, (db) => {
      const candidates = findInSourceIndex(db, sourceKey);
      for (const candidate of candidates) {
        const loaded = readCorpusFromDatabase(db, candidate.corpusId, ttlMs, true);
        if (loaded !== null) return loaded;
      }
      return null;
    });
    if (cached !== null) return cached;

    // Not found — materialize
    const { chunks, embeddings, model, contentHash } = await materializeFn();
    const dimensions = embeddings.length > 0 ? (embeddings[0]?.length ?? 0) : 0;
    const corpusId = computeCorpusId(source, model, dimensions);
    const now = Date.now();

    const bm25Docs = chunks.map((c) => ({ id: chunkToBm25Id(c), text: c.text }));
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

    if (chunks.length > 0) {
      const totalBytes = estimateCorpusBytes({
        sourceKey,
        source,
        chunks,
        embeddings,
        contentHash,
        model,
      });
      const writeResult = withDatabase(databasePath, (db) => {
        writeCorpus(db, corpus, sourceKey, totalBytes);
        evictIfNeeded(db, ttlMs, maxCorpora, maxTotalBytes, corpusId);
        return true;
      });
      if (writeResult === null) {
        logger.warn({ corpusId }, 'corpusCache: failed to write corpus to SQLite');
      }
    } else {
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
export function loadCorpusById(corpusId: string, opts?: CacheOpts): CachedCorpus | null {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const databasePath = resolveDatabasePath(opts);
  return withDatabase(databasePath, (db) => readCorpusFromDatabase(db, corpusId, ttlMs)) ?? null;
}

/**
 * Remove a corpus from SQLite and from the in-memory lock map.
 * Subsequent calls to getOrBuildCorpus will re-materialize.
 *
 * Pass `source` to also cancel any in-flight build for that source
 * (the pendingBuilds key is stableStringify(normalizeSource(source)), not corpusId).
 */
export function invalidateCorpus(
  corpusId: string,
  opts?: { cacheDir?: string; databasePath?: string; source?: SemanticCrawlSource },
): void {
  const databasePath = resolveDatabasePath(opts);
  withDatabase(databasePath, (db) => {
    deleteCorpus(db, corpusId);
    return true;
  });
  if (opts?.source !== undefined) {
    pendingBuilds.delete(stableStringify(normalizeSource(opts.source)));
  }
}
