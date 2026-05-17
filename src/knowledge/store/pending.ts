/**
 * Pending storage — session extraction accumulator.
 *
 * Manages `kg_pending_extractions` rows written by passive tool calls.
 * Extractions accumulate in a session buffer and are flushed to a run
 * in batch on session close, idle timeout, or buffer limit.
 *
 * Family-related pending operations live in family-pending.ts.
 */

import { logger } from '../../logger.js';
import { getKgDb } from './db.js';
import { generateUlid } from './events.js';
import { createRun } from './runs.js';

// ────────────────────────────────────────────────────────────────────
// Session extraction accumulator
// ────────────────────────────────────────────────────────────────────

const INSERT_EXTRACTION_SQL = `
  INSERT INTO kg_pending_extractions (id, session_id, run_id, tool_name, content, source_url, content_hash, queued_at)
  VALUES (@id, @sessionId, @runId, @toolName, @content, @sourceUrl, @contentHash, @queuedAt)
`;

interface PendingExtractionEntry {
  sessionId: string;
  toolName: string;
  content: string;
  sourceUrl?: string;
  contentHash?: string;
}

/**
 * Append a pending extraction from a passive tool call.
 *
 * Does NOT flush — extractions accumulate until flushSessionExtractions
 * is called.
 */
export function appendPendingExtraction(entry: PendingExtractionEntry): void {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: appendPendingExtraction called before database initialised');
    return;
  }

  try {
    db.prepare(INSERT_EXTRACTION_SQL).run({
      id: generateUlid(),
      sessionId: entry.sessionId,
      runId: null,
      toolName: entry.toolName,
      content: entry.content,
      sourceUrl: entry.sourceUrl ?? null,
      contentHash: entry.contentHash ?? null,
      queuedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err, sessionId: entry.sessionId }, 'kg: appendPendingExtraction failed');
  }
}

const SELECT_EXTRACTIONS_SQL =
  'SELECT * FROM kg_pending_extractions WHERE session_id = ? AND run_id IS NULL ORDER BY queued_at ASC';
const UPDATE_EXTRACTION_RUN_SQL =
  'UPDATE kg_pending_extractions SET run_id = @runId WHERE id = @id';
const DELETE_EXTRACTIONS_SQL =
  'DELETE FROM kg_pending_extractions WHERE session_id = ?';

export interface FlushedPendingExtraction {
  id: string;
  toolName: string;
  content: string;
  sourceUrl: string | undefined;
  contentHash: string | undefined;
}

interface FlushResult {
  runId: string;
  extractionCount: number;
  extractions: FlushedPendingExtraction[];
}

/**
 * Flush all pending extractions for a session into a single run.
 *
 * Creates a new run, assigns all pending extractions to it, then
 * returns the run ID, count, and extracted content rows. The caller
 * is responsible for running the extraction pipeline.
 *
 * Returns null if there are no pending extractions for the session.
 */
export function flushSessionExtractions(sessionId: string): FlushResult | null {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: flushSessionExtractions called before database initialised');
    return null;
  }

  try {
    // Quick check before creating run (optimization, not atomic)
    const hasRows = db.prepare('SELECT 1 FROM kg_pending_extractions WHERE session_id = ? AND run_id IS NULL LIMIT 1').get(sessionId) !== undefined;
    if (!hasRows) return null;

    const run = createRun({ sessionMode: 1 });
    if (run === null) {
      logger.warn({ sessionId }, 'kg: flushSessionExtractions failed to create run');
      return null;
    }

    const runId = run.runId;
    const selectStmt = db.prepare(SELECT_EXTRACTIONS_SQL);
    const updateStmt = db.prepare(UPDATE_EXTRACTION_RUN_SQL);
    const deleteStmt = db.prepare(DELETE_EXTRACTIONS_SQL);

    let extractionCount = 0;
    let extractions: FlushedPendingExtraction[] = [];

    const txn = db.transaction(() => {
      const rows = selectStmt.all(sessionId) as Record<string, unknown>[];
      if (rows.length === 0) return;

      for (const row of rows) {
        updateStmt.run({ runId, id: row.id });
      }
      deleteStmt.run(sessionId);
      extractionCount = rows.length;
      extractions = rows.flatMap((row) => {
        if (typeof row.id !== 'string' || typeof row.tool_name !== 'string' || typeof row.content !== 'string') {
          return [];
        }
        return [{
          id: row.id,
          toolName: row.tool_name,
          content: row.content,
          sourceUrl: typeof row.source_url === 'string' ? row.source_url : undefined,
          contentHash: typeof row.content_hash === 'string' ? row.content_hash : undefined,
        }];
      });
    });

    txn();

    if (extractionCount === 0) return null;

    logger.info(
      { sessionId, runId, count: extractionCount },
      'kg: flushed session extractions',
    );

    return { runId, extractionCount, extractions };
  } catch (err) {
    logger.warn({ err, sessionId }, 'kg: flushSessionExtractions failed');
    return null;
  }
}

const STALE_EXTRACTIONS_SQL = `
  SELECT session_id, COUNT(*) as count
  FROM kg_pending_extractions
  WHERE run_id IS NULL AND queued_at < @cutoff
  GROUP BY session_id
`;

export interface StaleExtractionGroup {
  sessionId: string;
  count: number;
}

/**
 * Find sessions with stale pending extractions older than maxAgeMs.
 *
 * Called during startup recovery to identify sessions that need
 * flushing.
 */
export function getStaleExtractions(maxAgeMs: number): StaleExtractionGroup[] {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: getStaleExtractions called before database initialised');
    return [];
  }

  try {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = db.prepare(STALE_EXTRACTIONS_SQL).all({ cutoff }) as {
      session_id: string;
      count: number;
    }[];

    return rows.map((r) => ({
      sessionId: r.session_id,
      count: r.count,
    }));
  } catch (err) {
    logger.warn({ err }, 'kg: getStaleExtractions failed');
    return [];
  }
}
