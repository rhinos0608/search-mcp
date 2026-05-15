/**
 * V7.0.0 — Projection checkpoint management.
 *
 * Checkpoints allow incremental projection rebuilds: instead of replaying
 * every event from genesis, the builder starts from the latest compatible
 * checkpoint and processes only events after its cursor.
 *
 * Genesis rebuild is always available as an escape hatch.
 */

import crypto from 'node:crypto';
import { logger } from '../../logger.js';
import { getKgDb } from './db.js';
import { CURRENT_PROJECTION_VERSION } from '../extractor/versions/v1.js';
import { SCHEMA_VERSION } from './schema.js';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface ProjectionCheckpoint {
  id: string;
  createdAt: string;
  eventCursor: string;
  projectionVersion: number;
  schemaVersion: number;
  eventCount: number;
  checksum: string;
  compatible: boolean;
}

// ────────────────────────────────────────────────────────────────────
// SQL statements
// ────────────────────────────────────────────────────────────────────

const INSERT_CHECKPOINT_SQL = `
  INSERT INTO kg_projection_checkpoints
    (id, created_at, event_cursor, projection_version, schema_version,
     event_count, checksum, compatible)
  VALUES
    (@id, @createdAt, @eventCursor, @projectionVersion, @schemaVersion,
     @eventCount, @checksum, @compatible)
`;

const LATEST_COMPATIBLE_SQL = `
  SELECT * FROM kg_projection_checkpoints
  WHERE compatible = 1 AND projection_version = @projectionVersion
  ORDER BY created_at DESC
  LIMIT 1
`;

const INVALIDATE_ALL_SQL = `
  UPDATE kg_projection_checkpoints SET compatible = 0
  WHERE id != '__schema_version'
`;

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Create a new projection checkpoint.
 *
 * Inserts a checkpoint row with the given event cursor, event count,
 * and computed checksum. Marks the checkpoint as compatible so future
 * rebuilds can start from it.
 */
export function createCheckpoint(
  eventCursor: string,
  eventCount: number,
  checksum: string,
): ProjectionCheckpoint | null {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: createCheckpoint called before database initialised');
    return null;
  }

  try {
    const now = new Date().toISOString();
    const row = {
      id: `${now}-${crypto.randomUUID().slice(0, 8)}`,
      createdAt: now,
      eventCursor,
      projectionVersion: CURRENT_PROJECTION_VERSION,
      schemaVersion: SCHEMA_VERSION,
      eventCount,
      checksum,
      compatible: 1,
    };

    db.prepare(INSERT_CHECKPOINT_SQL).run(row);

    return {
      id: row.id,
      createdAt: row.createdAt,
      eventCursor: row.eventCursor,
      projectionVersion: row.projectionVersion,
      schemaVersion: row.schemaVersion,
      eventCount: row.eventCount,
      checksum: row.checksum,
      compatible: true,
    };
  } catch (err) {
    logger.warn({ err, eventCursor }, 'kg: createCheckpoint failed');
    return null;
  }
}

/**
 * Get the latest compatible checkpoint for a given projection version.
 *
 * Returns null if no compatible checkpoint exists, which triggers a
 * genesis rebuild.
 */
export function getLatestCompatibleCheckpoint(
  projectionVersion: number,
): ProjectionCheckpoint | null {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: getLatestCompatibleCheckpoint called before database initialised');
    return null;
  }

  try {
    const row = db.prepare(LATEST_COMPATIBLE_SQL).get({
      projectionVersion,
    }) as Record<string, unknown> | undefined;

    if (row === undefined) return null;

    return rowToCheckpoint(row);
  } catch (err) {
    logger.warn({ err, projectionVersion }, 'kg: getLatestCompatibleCheckpoint failed');
    return null;
  }
}

/**
 * Mark all projection checkpoints as incompatible.
 *
 * Called when the projection schema changes (SCHEMA_VERSION bump) or
 * when a full rebuild is forced. This ensures the next rebuild starts
 * from genesis.
 */
export function invalidateAllCheckpoints(): void {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: invalidateAllCheckpoints called before database initialised');
    return;
  }

  try {
    db.prepare(INVALIDATE_ALL_SQL).run();
    logger.info('kg: all projection checkpoints invalidated');
  } catch (err) {
    logger.warn({ err }, 'kg: invalidateAllCheckpoints failed');
  }
}

/**
 * Compute a deterministic checksum of the current projection tables.
 *
 * Returns `sha256(sorted_node_ids + '|' + sorted_edge_ids)` of the
 * currently-projected data. This is used to verify projection integrity
 * and to tag checkpoints.
 */
export function computeProjectionChecksum(): string {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: computeProjectionChecksum called before database initialised');
    return '';
  }

  try {
    const nodeRows = db
      .prepare('SELECT id FROM kg_nodes ORDER BY id ASC')
      .all() as { id: string }[];

    const edgeRows = db
      .prepare('SELECT id FROM kg_edges ORDER BY id ASC')
      .all() as { id: string }[];

    const nodeIds = JSON.stringify(nodeRows.map((r) => r.id));
    const edgeIds = JSON.stringify(edgeRows.map((r) => r.id));

    const hash = crypto.createHash('sha256');
    hash.update(nodeIds);
    hash.update('|');
    hash.update(edgeIds);
    return hash.digest('hex');
  } catch (err) {
    logger.warn({ err }, 'kg: computeProjectionChecksum failed');
    return '';
  }
}

// ────────────────────────────────────────────────────────────────────
// Row mapping
// ────────────────────────────────────────────────────────────────────

function rowToCheckpoint(row: Record<string, unknown>): ProjectionCheckpoint {
  return {
    id: row.id as string,
    createdAt: row.created_at as string,
    eventCursor: row.event_cursor as string,
    projectionVersion: Number(row.projection_version),
    schemaVersion: Number(row.schema_version),
    eventCount: Number(row.event_count),
    checksum: row.checksum as string,
    compatible: Boolean(row.compatible),
  };
}
