/**
 * V7.0.0 — Event version adapters.
 *
 * When the event schema evolves (new fields, type changes, etc.), a new
 * adapter function is created to normalise old events to the current
 * projection schema. This keeps the projection codebase forward-compatible
 * without requiring a full event store migration.
 */

import { logger } from '../../../logger.js';
import type { KgEvent } from '../../types.js';

// ────────────────────────────────────────────────────────────────────
// Current version
// ────────────────────────────────────────────────────────────────────

/**
 * Current projection version. Increment each time an adapter is added.
 *
 * Must match `SCHEMA_VERSION` in `store/schema.ts`.
 */
export const CURRENT_PROJECTION_VERSION = 1;

// ────────────────────────────────────────────────────────────────────
// Adapter registry
// ────────────────────────────────────────────────────────────────────

/**
 * Normalise an event to the latest schema version.
 *
 * Dispatches to the correct adapter based on `eventVersion`. If the
 * event is already at the current version, it is returned unchanged.
 */
export function normalizeToLatest(event: KgEvent): KgEvent {
  if (event.eventVersion >= CURRENT_PROJECTION_VERSION) {
    return event;
  }

  // Future versions will dispatch here:
  // if (event.eventVersion === 0) return v1ToV2(event);
  // if (event.eventVersion === 1) return v2ToV3(event);

  // Unknown version — log a warning and pass through
  logger.warn(
    { eventVersion: event.eventVersion, eventType: event.eventType, eventId: event.id },
    'kg: normalizeToLatest received unknown event version. Passed through unchanged.',
  );
  return event;
}
