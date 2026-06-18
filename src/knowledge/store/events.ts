/**
 * Event store — append-only kg_events operations.
 *
 * Events are the single source of truth. Every graph write is an event.
 * No updates, no deletes (except via full projection rebuild).
 */

import crypto from 'node:crypto';
import { logger } from '../../logger.js';
import { getKgDb } from './db.js';
import type { KgEvent, KgEventType } from '../types.js';

// ────────────────────────────────────────────────────────────────────
// ID generation
// ────────────────────────────────────────────────────────────────────

/**
 * Generate a sortable ULID-like identifier.
 *
 * Format: base36-encoded timestamp (milliseconds, 8+ chars) + '-' +
 *         16 random hex chars + optional monotonic counter.
 *
 * This produces chronologically-sortable strings without clock-skew
 * dependency. Unlike real ULIDs, these are pure JS with no native
 * dependency.
 *
 * A module-level monotonic counter prevents collisions when multiple
 * calls happen within the same millisecond.
 */
let _lastUlidTs = 0;
let _ulidCounter = 0;

export function generateUlid(): string {
  const now = Date.now();
  if (now === _lastUlidTs) {
    _ulidCounter++;
  } else {
    _lastUlidTs = now;
    _ulidCounter = 0;
  }
  const ts = now.toString(36);
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `${ts}-${rand}-${String(_ulidCounter).padStart(3, '0')}`;
}

// ────────────────────────────────────────────────────────────────────
// Payload hash
// ────────────────────────────────────────────────────────────────────

function hashPayload(payload: string): string {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ────────────────────────────────────────────────────────────────────
// Insert helpers
// ────────────────────────────────────────────────────────────────────

const INSERT_EVENT_SQL = `
  INSERT INTO kg_events (id, timestamp, event_type, event_version, run_id, batch_id,
    actor, entity_id, entity_type, payload, payload_hash)
  VALUES (@id, @timestamp, @eventType, @eventVersion, @runId, @batchId,
    @actor, @entityId, @entityType, @payload, @payloadHash)
`;

/**
 * Append multiple events in a single transaction.
 *
 * Computes payload_hash for each event. Returns the fully-populated
 * event array with generated IDs.
 */
export function appendEvents(events: Omit<KgEvent, 'id'>[]): KgEvent[] {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: appendEvents called before database initialised');
    return [];
  }

  try {
    const insert = db.prepare(INSERT_EVENT_SQL);

    const result: KgEvent[] = [];

    const txn = db.transaction(() => {
      for (const ev of events) {
        const id = generateUlid();
        const payload = ev.payload;
        const payloadHash = hashPayload(payload);

        insert.run({
          id,
          timestamp: ev.timestamp,
          eventType: ev.eventType,
          eventVersion: ev.eventVersion,
          runId: ev.runId,
          batchId: ev.batchId,
          actor: ev.actor,
          entityId: ev.entityId,
          entityType: ev.entityType,
          payload,
          payloadHash,
        });

        result.push({
          id,
          timestamp: ev.timestamp,
          eventType: ev.eventType,
          eventVersion: ev.eventVersion,
          runId: ev.runId,
          batchId: ev.batchId,
          actor: ev.actor,
          entityId: ev.entityId,
          entityType: ev.entityType,
          payload,
          payloadHash,
        });
      }
    });

    txn();
    return result;
  } catch (err) {
    logger.warn({ err, count: events.length }, 'kg: appendEvents failed');
    return [];
  }
}

/**
 * Append a single event. Convenience wrapper around appendEvents.
 */
export function appendEvent(event: Omit<KgEvent, 'id'>): KgEvent | null {
  const results = appendEvents([event]);
  return results[0] ?? null;
}

// ────────────────────────────────────────────────────────────────────
// Query helpers
// ────────────────────────────────────────────────────────────────────

interface QueryEventsOpts {
  runId?: string;
  eventType?: KgEventType;
  entityId?: string;
  after?: string;
  before?: string;
  limit?: number;
  cursor?: string;
}

const QUERY_BASE = 'SELECT * FROM kg_events WHERE 1=1';
const QUERY_ORDER = 'ORDER BY timestamp ASC, id ASC';

/**
 * Query events with optional filters.
 *
 * Supports cursor-based pagination. Cursor is the `id` of the
 * last event in the previous page. Returns events with id > cursor
 * (lexicographic, works because ULIDs are sortable).
 */
export function queryEvents(opts: QueryEventsOpts = {}): KgEvent[] {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: queryEvents called before database initialised');
    return [];
  }

  try {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.runId !== undefined) {
      clauses.push('run_id = @runId');
      params.runId = opts.runId;
    }
    if (opts.eventType !== undefined) {
      clauses.push('event_type = @eventType');
      params.eventType = opts.eventType;
    }
    if (opts.entityId !== undefined) {
      clauses.push('entity_id = @entityId');
      params.entityId = opts.entityId;
    }
    if (opts.after !== undefined) {
      clauses.push('timestamp >= @after');
      params.after = opts.after;
    }
    if (opts.before !== undefined) {
      clauses.push('timestamp <= @before');
      params.before = opts.before;
    }
    if (opts.cursor !== undefined) {
      clauses.push('id > @cursor');
      params.cursor = opts.cursor;
    }

    const where = clauses.length > 0 ? ' AND ' + clauses.join(' AND ') : '';
    let limit = '';
    if (opts.limit !== undefined && Number.isInteger(opts.limit) && opts.limit > 0) {
      limit = ` LIMIT ${String(opts.limit)}`;
    }

    const sql = `${QUERY_BASE}${where} ${QUERY_ORDER}${limit}`;
    const rows = db.prepare(sql).all(params) as Record<string, unknown>[];

    return rows.map(rowToEvent);
  } catch (err) {
    logger.warn({ err, opts }, 'kg: queryEvents failed');
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────
// Checkpoints
// ────────────────────────────────────────────────────────────────────

/**
 * Get the latest event cursor (ULID of the most recent event),
 * or null if the event store is empty.
 */
export function getLatestEventCursor(): string | null {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: getLatestEventCursor called before database initialised');
    return null;
  }

  try {
    const row = db
      .prepare('SELECT id FROM kg_events ORDER BY timestamp DESC, id DESC LIMIT 1')
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  } catch (err) {
    logger.warn({ err }, 'kg: getLatestEventCursor failed');
    return null;
  }
}

/**
 * Count total events in the store.
 */
export function countEvents(): number {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: countEvents called before database initialised');
    return 0;
  }

  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM kg_events').get() as
      | {
          cnt: number;
        }
      | undefined;
    return row?.cnt ?? 0;
  } catch (err) {
    logger.warn({ err }, 'kg: countEvents failed');
    return 0;
  }
}

// ────────────────────────────────────────────────────────────────────
// Row mapping
// ────────────────────────────────────────────────────────────────────

function rowToEvent(row: Record<string, unknown>): KgEvent {
  const id = typeof row.id === 'string' ? row.id : '';
  const timestamp = typeof row.timestamp === 'string' ? row.timestamp : new Date().toISOString();
  const eventType = (
    typeof row.event_type === 'string' ? row.event_type : 'NODE_ADDED'
  ) as KgEventType;
  const eventVersion = Number(row.event_version) || 1;
  const runId = typeof row.run_id === 'string' ? row.run_id : '';
  const batchId = typeof row.batch_id === 'string' ? row.batch_id : null;
  const actor = typeof row.actor === 'string' ? row.actor : 'system';
  const entityId = typeof row.entity_id === 'string' ? row.entity_id : null;
  const entityType = typeof row.entity_type === 'string' ? row.entity_type : null;
  const payload = typeof row.payload === 'string' ? row.payload : '{}';
  const payloadHash = typeof row.payload_hash === 'string' ? row.payload_hash : null;

  return {
    id,
    timestamp,
    eventType,
    eventVersion,
    runId,
    batchId,
    actor,
    entityId,
    entityType,
    payload,
    payloadHash,
  };
}
