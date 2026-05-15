/**
 * V7.0.0 — Embedding cache store for the KG database.
 *
 * Manages the `kg_embeddings` table which caches computed embeddings
 * for nodes, families, and aliases. Embeddings are stored as float32
 * BLOBs (matching the corpusCache pattern) with an associated
 * content_hash for staleness detection.
 *
 * Cosine similarity is computed in JavaScript, not SQLite.
 */

import { logger } from '../../logger.js';
import { getKgDb } from './db.js';

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/** Default limit for similarity search results. */
const DEFAULT_SIMILARITY_LIMIT = 20;

/** Minimum similarity threshold to return in search results. */
const MIN_SIMILARITY = 0.5;

// ────────────────────────────────────────────────────────────────────
// Float32 BLOB serialisation
// ────────────────────────────────────────────────────────────────────

/**
 * Serialise a number array as a float32 BLOB.
 *
 * Uses a 4-byte little-endian Buffer per float, matching the pattern
 * used in src/rag/corpusCache.ts.
 */
function float32ArrayToBlob(vector: number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) {
    const val = vector[i];
    if (val !== undefined) {
      buffer.writeFloatLE(val, i * 4);
    }
  }
  return buffer;
}

/**
 * Deserialise a float32 BLOB back to a number array.
 */
function blobToFloat32Array(blob: Buffer): number[] {
  const result: number[] = [];
  const count = blob.byteLength / 4;
  for (let i = 0; i < count; i++) {
    const byteOffset = i * 4;
    if (byteOffset + 4 <= blob.byteLength) {
      result.push(blob.readFloatLE(byteOffset));
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Cosine similarity
// ────────────────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 *
 * Returns a value in [-1, 1]. For embedding vectors (non-negative),
 * this is typically [0, 1].
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (av !== undefined && bv !== undefined) {
      dot += av * bv;
      normA += av * av;
      normB += bv * bv;
    }
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ────────────────────────────────────────────────────────────────────
// SQL statements
// ────────────────────────────────────────────────────────────────────

const UPSERT_EMBEDDING_SQL = `
  INSERT OR REPLACE INTO kg_embeddings
    (object_id, object_type, embedding_model, embedding, content_hash, created_at)
  VALUES
    (@objectId, @objectType, @embeddingModel, @embedding, @contentHash, @createdAt)
`;

const QUERY_ALL_EMBEDDINGS_SQL = `
  SELECT object_id, object_type, embedding, content_hash
  FROM kg_embeddings
  WHERE object_type = @objectType
`;

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Store an embedding vector for a given object.
 *
 * If an embedding already exists for (objectId, embeddingModel), it is
 * replaced. The content_hash allows downstream code to detect staleness.
 */
export function storeEmbedding(
  objectId: string,
  objectType: 'node' | 'family' | 'alias',
  model: string,
  embedding: number[],
  contentHash: string,
): void {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: storeEmbedding called before database initialised');
    return;
  }

  try {
    const blob = float32ArrayToBlob(embedding);
    db.prepare(UPSERT_EMBEDDING_SQL).run({
      objectId,
      objectType,
      embeddingModel: model,
      embedding: blob,
      contentHash,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err, objectId, objectType }, 'kg: storeEmbedding failed');
  }
}

/**
 * Find embeddings similar to the given query embedding within the
 * specified object type.
 *
 * Computes cosine similarity in JavaScript against all stored embeddings
 * of the target type. Returns results sorted by descending similarity,
 * filtered by the `threshold`.
 */
export function findSimilarEmbeddings(
  embedding: number[],
  objectType: string,
  threshold: number,
  limit: number = DEFAULT_SIMILARITY_LIMIT,
): { objectId: string; objectType: string; similarity: number }[] {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: findSimilarEmbeddings called before database initialised');
    return [];
  }

  try {
    const rows = db.prepare(QUERY_ALL_EMBEDDINGS_SQL).all({
      objectType,
    }) as {
      object_id: string;
      object_type: string;
      embedding: Buffer;
      content_hash: string;
    }[];

    if (rows.length === 0) return [];

    const candidates: {
      objectId: string;
      objectType: string;
      similarity: number;
    }[] = [];

    for (const row of rows) {
      const blob = row.embedding;
      const stored = blobToFloat32Array(blob);
      const sim = cosineSimilarity(embedding, stored);

      if (sim >= Math.max(threshold, MIN_SIMILARITY)) {
        candidates.push({
          objectId: row.object_id,
          objectType: row.object_type,
          similarity: sim,
        });
      }
    }

    candidates.sort((a, b) => b.similarity - a.similarity);

    return candidates.slice(0, limit);
  } catch (err) {
    logger.warn({ err, objectType }, 'kg: findSimilarEmbeddings failed');
    return [];
  }
}

/**
 * Delete stale embeddings for an object when its content changes.
 *
 * Only removes embeddings whose content_hash no longer matches the
 * current hash. If contentHash is null/undefined, all embeddings for the
 * object are removed unconditionally.
 */
export function deleteStaleEmbeddings(
  objectId: string,
  contentHash: string | null,
): void {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: deleteStaleEmbeddings called before database initialised');
    return;
  }

  try {
    if (contentHash === null) {
      // Remove all embeddings for this object
      db.prepare('DELETE FROM kg_embeddings WHERE object_id = ?').run(objectId);
    } else {
      // Remove only embeddings whose content hash doesn't match
      db.prepare(
        'DELETE FROM kg_embeddings WHERE object_id = ? AND content_hash != ?',
      ).run(objectId, contentHash);
    }
  } catch (err) {
    logger.warn({ err, objectId }, 'kg: deleteStaleEmbeddings failed');
  }
}
