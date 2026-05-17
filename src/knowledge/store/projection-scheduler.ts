/**
 * V7.0.0 — Projection rebuild scheduler.
 *
 * Triggers projection rebuilds after run completion and on periodic
 * thresholds (500 events or 24 hours) for runs that fail or run long.
 *
 * Uses a simple flag to prevent concurrent rebuilds.
 */

import { logger } from '../../logger.js';
import { rebuildProjection } from './projection-builder.js';
import { countEvents, getLatestEventCursor } from './events.js';
import { getLatestCompatibleCheckpoint } from './checkpoints.js';
import { CURRENT_PROJECTION_VERSION } from '../extractor/versions/v1.js';

// ────────────────────────────────────────────────────────────────────
// Internal state
// ────────────────────────────────────────────────────────────────────

let _rebuildInProgress = false;
let _rebuildQueued = false; // true when a trigger arrived while a rebuild was in progress
let _lastRebuildTime = 0;

/** Default thresholds — 500 events or 24 hours since last rebuild. */
const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Trigger an async projection rebuild after a run completes.
 *
 * This does NOT await the rebuild — it fires and forgets to avoid
 * blocking the run completion flow. Concurrent rebuilds are prevented
 * by the _rebuildInProgress flag.
 */
export function triggerProjectionRebuildOnRunComplete(runId: string): void {
  if (_rebuildInProgress) {
    logger.info(
      { runId },
      'kg: projection rebuild already in progress; queueing follow-up trigger for run',
    );
    _rebuildQueued = true;
    return;
  }

  _rebuildInProgress = true;

  // Fire and forget — do not block the caller
  scheduleRebuild(runId).catch((err: unknown) => {
    logger.warn({ err, runId }, 'kg: scheduled projection rebuild failed');
  });
}

/**
 * Check whether a periodic rebuild is needed, and trigger one if so.
 *
 * Rebuild thresholds:
 * - 500 events since the last checkpoint's event cursor
 * - 24 hours since the last rebuild
 *
 * Safe to call on a timer or after tool calls.
 */
export function maybeTriggerPeriodicRebuild(): void {
  if (_rebuildInProgress) {
    logger.info('kg: periodic rebuild trigger queued — rebuild already in progress');
    _rebuildQueued = true;
    return;
  }

  const now = Date.now();

  // Check time threshold
  if (now - _lastRebuildTime < DEFAULT_MAX_AGE_MS) {
    // Time threshold not met — check event count threshold
    const checkpoint = getLatestCompatibleCheckpoint(CURRENT_PROJECTION_VERSION);
    if (checkpoint === null) {
      // No checkpoint exists — trigger genesis rebuild
      logger.info('kg: no compatible checkpoint; triggering genesis rebuild');
      void triggerRebuildInternal();
      return;
    }

    const latestCursor = getLatestEventCursor();
    if (latestCursor === null) {
      // No events — nothing to rebuild
      return;
    }

    const totalEvents = countEvents();
    if (totalEvents - checkpoint.eventCount < DEFAULT_MAX_EVENTS) {
      // Below both thresholds
      return;
    }
  }

  logger.info('kg: periodic rebuild threshold exceeded; triggering rebuild');
  void triggerRebuildInternal();
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

async function scheduleRebuild(runId: string): Promise<void> {
  logger.info({ runId }, 'kg: starting post-run projection rebuild');

  // Use setImmediate to yield the event loop, then rebuild
  await new Promise<void>((resolve) => setImmediate(() => { resolve(); }));

  // Always replay from genesis: projection rebuild swaps complete tables, so
  // applying only post-checkpoint events would drop previously projected rows.

  try {
    const result = rebuildProjection({ full: true });

    _lastRebuildTime = Date.now();

    logger.info(
      {
        runId,
        durationMs: result.durationMs,
        eventsProcessed: result.eventsProcessed,
        fromGenesis: result.fromGenesis,
      },
      'kg: post-run projection rebuild complete',
    );
  } finally {
    _rebuildInProgress = false;

    // If another trigger arrived while we were rebuilding, run one more rebuild
    if (_rebuildQueued) {
      _rebuildQueued = false;
      logger.info('kg: running queued follow-up projection rebuild');
      void triggerRebuildInternal();
    }
  }
}

async function triggerRebuildInternal(): Promise<void> {
  _rebuildInProgress = true;

  try {
    // Yield event loop before potentially expensive rebuild
    await new Promise<void>((resolve) => setImmediate(() => { resolve(); }));

    const result = rebuildProjection({ full: true });

    _lastRebuildTime = Date.now();

    logger.info(
      {
        durationMs: result.durationMs,
        eventsProcessed: result.eventsProcessed,
        fromGenesis: result.fromGenesis,
      },
      'kg: periodic projection rebuild complete',
    );
  } catch (err) {
    logger.warn({ err }, 'kg: periodic projection rebuild failed');
  } finally {
    _rebuildInProgress = false;

    // If another trigger arrived while we were rebuilding, run one more rebuild
    if (_rebuildQueued) {
      _rebuildQueued = false;
      logger.info('kg: running queued follow-up projection rebuild (from periodic)');
      void triggerRebuildInternal();
    }
  }
}
