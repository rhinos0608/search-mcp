/**
 * Family pending storage — queued family assignments and consolidation
 * candidates awaiting solidification.
 *
 * These functions manage the pipeline from Pass 1 classifier output
 * to event-committed families. Candidates sit in working-state tables
 * until the solidification threshold is met.
 */

import { logger } from '../../logger.js';
import { getKgDb } from './db.js';

// ────────────────────────────────────────────────────────────────────
// Family assignment queue
// ────────────────────────────────────────────────────────────────────

const INSERT_ASSIGNMENT_SQL = `
  INSERT INTO kg_pending_assignments (entity_id, family_id, run_id, queued_at)
  VALUES (@entityId, @familyId, @runId, @queuedAt)
`;

/**
 * Queue a family assignment for solidification.
 *
 * These are Pass 1 classifier outputs that have not yet been
 * committed as events.
 */
export function queueFamilyAssignment(
  entityId: string,
  familyId: string,
  runId: string,
): void {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: queueFamilyAssignment called before database initialised');
    return;
  }

  try {
    db.prepare(INSERT_ASSIGNMENT_SQL).run({
      entityId,
      familyId,
      runId,
      queuedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn(
      { err, entityId, familyId },
      'kg: queueFamilyAssignment failed',
    );
  }
}

// ────────────────────────────────────────────────────────────────────
// Family candidate queue
// ────────────────────────────────────────────────────────────────────

const INSERT_CANDIDATE_SQL = `
  INSERT INTO kg_pending_families (id, label, description, entity_ids, run_ids, created_at)
  VALUES (@id, @label, @description, @entityIds, @runIds, @createdAt)
`;

interface FamilyCandidate {
  id: string;
  label: string;
  description?: string;
  entityIds: string[];
  runIds: string[];
}

/**
 * Queue a family candidate for solidification.
 */
export function queueFamilyCandidate(candidate: FamilyCandidate): void {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: queueFamilyCandidate called before database initialised');
    return;
  }

  try {
    db.prepare(INSERT_CANDIDATE_SQL).run({
      id: candidate.id,
      label: candidate.label,
      description: candidate.description ?? null,
      entityIds: JSON.stringify(candidate.entityIds),
      runIds: JSON.stringify(candidate.runIds),
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err, candidateId: candidate.id }, 'kg: queueFamilyCandidate failed');
  }
}

// ────────────────────────────────────────────────────────────────────
// Solidification — get pending candidates + solidify
// ────────────────────────────────────────────────────────────────────

const SELECT_PENDING_FAMILIES_SQL = `
  SELECT * FROM kg_pending_families ORDER BY created_at ASC
`;

const DELETE_FAMILY_SQL = 'DELETE FROM kg_pending_families WHERE id = ?';
const DELETE_ASSIGNMENT_SQL =
  'DELETE FROM kg_pending_assignments WHERE entity_id = ? AND family_id = ?';

interface PendingFamilyRow {
  id: string;
  label: string | null;
  description: string | null;
  entity_ids: string;
  run_ids: string;
  created_at: string;
}

interface PendingAssignmentRow {
  entity_id: string;
  family_id: string;
  run_id: string;
}

export interface PendingFamilyForSolidification {
  id: string;
  label: string | null;
  description: string | null;
  entityIds: string[];
  runIds: string[];
  assignments: { entityId: string; familyId: string; runId: string }[];
}

/**
 * Get all pending families with their assignments, ready for
 * solidification checks.
 */
export function getPendingFamiliesForSolidification(): PendingFamilyForSolidification[] {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: getPendingFamiliesForSolidification called before database initialised');
    return [];
  }

  try {
    const familyRows = db.prepare(SELECT_PENDING_FAMILIES_SQL).all() as PendingFamilyRow[];

    // Batch-fetch all assignments for all families at once
    const familyIds = familyRows.map((r) => r.id);
    let allAssignments: PendingAssignmentRow[] = [];
    if (familyIds.length > 0) {
      const placeholders = familyIds.map(() => '?').join(',');
      allAssignments = db
        .prepare(`SELECT * FROM kg_pending_assignments WHERE family_id IN (${placeholders})`)
        .all(...familyIds) as PendingAssignmentRow[];
    }
    const assignmentsByFamily = new Map<string, PendingAssignmentRow[]>();
    for (const a of allAssignments) {
      const list = assignmentsByFamily.get(a.family_id) ?? [];
      list.push(a);
      assignmentsByFamily.set(a.family_id, list);
    }

    return familyRows.map((row) => {
      const assignmentRows = assignmentsByFamily.get(row.id) ?? [];

      return {
        id: row.id,
        label: row.label,
        description: row.description,
        entityIds: parseJsonArray(row.entity_ids),
        runIds: parseJsonArray(row.run_ids),
        assignments: assignmentRows.map((a) => ({
          entityId: a.entity_id,
          familyId: a.family_id,
          runId: a.run_id,
        })),
      };
    });
  } catch (err) {
    logger.warn({ err }, 'kg: getPendingFamiliesForSolidification failed');
    return [];
  }
}

/**
 * Solidify a family — commit FAMILY_CREATED and FAMILY_CLASSIFIED
 * events, then remove the pending rows.
 *
 * This is a transaction boundary: either the family is fully
 * solidified or nothing changes.
 */
export function solidifyFamily(
  familyId: string,
  assignments: { entityId: string; familyId: string; runId: string }[],
): void {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: solidifyFamily called before database initialised');
    return;
  }

  try {
    const deleteFamily = db.prepare(DELETE_FAMILY_SQL);
    const deleteAssignment = db.prepare(DELETE_ASSIGNMENT_SQL);

    const txn = db.transaction(() => {
      deleteFamily.run(familyId);

      for (const a of assignments) {
        deleteAssignment.run(a.entityId, a.familyId);
      }
    });

    txn();

    logger.info({ familyId, assignmentCount: assignments.length }, 'kg: solidified family');
  } catch (err) {
    logger.warn({ err, familyId }, 'kg: solidifyFamily failed');
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function parseJsonArray(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as string[];
    return [];
  } catch {
    return [];
  }
}
