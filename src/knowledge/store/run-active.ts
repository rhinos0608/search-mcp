/**
 * Run active flag and stuck recovery operations.
 *
 * Active flag: marks a run so passive tool calls attach to it.
 * Stuck recovery: detects runs in non-terminal states on startup.
 */

import { logger } from '../../logger.js';
import { getKgDb } from './db.js';

// ────────────────────────────────────────────────────────────────────
// Active run helpers
// ────────────────────────────────────────────────────────────────────

const SET_ACTIVE_SQL = 'UPDATE kg_runs SET active = 1 WHERE run_id = ?';
const CLEAR_ACTIVE_SQL = 'UPDATE kg_runs SET active = 0 WHERE run_id = ?';
const GET_ACTIVE_SQL = 'SELECT run_id FROM kg_runs WHERE active = 1 LIMIT 1';

/**
 * Set a run's active flag for passive capture attachment.
 */
export function setRunActiveFlag(runId: string): void {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: setRunActiveFlag called before database initialised');
    return;
  }

  try {
    db.prepare(SET_ACTIVE_SQL).run(runId);
  } catch (err) {
    logger.warn({ err, runId }, 'kg: setRunActiveFlag failed');
  }
}

/**
 * Clear a run's active flag.
 */
export function clearRunActiveFlag(runId: string): void {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: clearRunActiveFlag called before database initialised');
    return;
  }

  try {
    db.prepare(CLEAR_ACTIVE_SQL).run(runId);
  } catch (err) {
    logger.warn({ err, runId }, 'kg: clearRunActiveFlag failed');
  }
}

/**
 * Get the currently active run ID, or null if none.
 */
export function getActiveRunId(): string | null {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: getActiveRunId called before database initialised');
    return null;
  }

  try {
    const row = db.prepare(GET_ACTIVE_SQL).get() as
      | { run_id: string }
      | undefined;
    return row?.run_id ?? null;
  } catch (err) {
    logger.warn({ err }, 'kg: getActiveRunId failed');
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// Stuck run recovery
// ────────────────────────────────────────────────────────────────────

const MARK_STUCK_SQL = `
  UPDATE kg_runs SET
    status = 'failed',
    failed_at = @now,
    last_error = 'process_restart'
  WHERE status IN ('queued', 'extracting', 'canonicalizing', 'classifying', 'projecting')
`;

/**
 * Mark all runs stuck in non-terminal states as failed.
 *
 * Called during startup recovery. Returns the number of runs
 * that were marked as failed.
 */
export function markStuckRunsFailed(): number {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: markStuckRunsFailed called before database initialised');
    return 0;
  }

  try {
    const now = new Date().toISOString();
    const result = db.prepare(MARK_STUCK_SQL).run({ now });
    const count = result.changes;
    if (count > 0) {
      logger.info({ count }, 'kg: marked stuck runs as failed');
    }
    return count;
  } catch (err) {
    logger.warn({ err }, 'kg: markStuckRunsFailed failed');
    return 0;
  }
}
