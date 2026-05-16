/**
 * Run management — kg_runs lifecycle operations.
 *
 * Manages run creation, status transitions, listing, and
 * cleanup of stuck runs.
 */

import { logger } from '../../logger.js';
import { getKgDb } from './db.js';
import { generateUlid } from './events.js';
import type { KgRun, RunStatus } from '../types.js';

// ────────────────────────────────────────────────────────────────────
// Create run
// ────────────────────────────────────────────────────────────────────

const INSERT_RUN_SQL = `
  INSERT INTO kg_runs (
    run_id, status, topic, query, session_mode, started_at,
    completed_at, failed_at, last_error, entity_count, edge_count,
    source_count, artifact_paths, idempotency_key, active
  ) VALUES (
    @runId, @status, @topic, @query, @sessionMode, @startedAt,
    @completedAt, @failedAt, @lastError, @entityCount, @edgeCount,
    @sourceCount, @artifactPaths, @idempotencyKey, @active
  )
`;

interface CreateRunParams {
  runId?: string;
  topic?: string | null;
  query?: string | null;
  sessionMode?: number;
}

/**
 * Create a new run in the kg_runs table.
 *
 * Generates a ULID runId if not provided. Starts with
 * status 'queued'.
 */
export function createRun(params: CreateRunParams = {}): KgRun | null {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: createRun called before database initialised');
    return null;
  }

  const runId = params.runId ?? generateUlid();
  const now = new Date().toISOString();

  try {
    db.prepare(INSERT_RUN_SQL).run({
      runId,
      status: 'queued',
      topic: params.topic ?? null,
      query: params.query ?? null,
      sessionMode: params.sessionMode ?? 0,
      startedAt: now,
      completedAt: null,
      failedAt: null,
      lastError: null,
      entityCount: null,
      edgeCount: null,
      sourceCount: null,
      artifactPaths: null,
      idempotencyKey: null,
      active: 0,
    });

    return getRun(runId);
  } catch (err) {
    logger.warn({ err, runId }, 'kg: createRun failed');
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// Update run status
// ────────────────────────────────────────────────────────────────────

const UPDATE_STATUS_SQL = `
  UPDATE kg_runs SET
    status = @status,
    completed_at = @completedAt,
    failed_at = @failedAt,
    last_error = @lastError,
    entity_count = @entityCount,
    edge_count = @edgeCount,
    source_count = @sourceCount,
    artifact_paths = @artifactPaths
  WHERE run_id = @runId
`;

/**
 * Update a run's status and associated metadata.
 *
 * Automatically sets completed_at when status is 'completed'
 * and failed_at when status is 'failed'.
 */
export function updateRunStatus(runId: string, status: RunStatus, metadata?: Partial<KgRun>): void {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: updateRunStatus called before database initialised');
    return;
  }

  const now = new Date().toISOString();

  try {
    db.prepare(UPDATE_STATUS_SQL).run({
      runId,
      status,
      completedAt: status === 'completed' ? now : (metadata?.completedAt ?? null),
      failedAt: status === 'failed' ? now : (metadata?.failedAt ?? null),
      lastError: metadata?.lastError ?? null,
      entityCount: metadata?.entityCount ?? null,
      edgeCount: metadata?.edgeCount ?? null,
      sourceCount: metadata?.sourceCount ?? null,
      artifactPaths: metadata?.artifactPaths ?? null,
    });
  } catch (err) {
    logger.warn({ err, runId, status }, 'kg: updateRunStatus failed');
  }
}

// ────────────────────────────────────────────────────────────────────
// Get run
// ────────────────────────────────────────────────────────────────────

const SELECT_RUN_SQL = 'SELECT * FROM kg_runs WHERE run_id = ?';

/**
 * Retrieve a single run by ID.
 * Returns null if not found.
 */
export function getRun(runId: string): KgRun | null {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: getRun called before database initialised');
    return null;
  }

  try {
    const row = db.prepare(SELECT_RUN_SQL).get(runId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return rowToRun(row);
  } catch (err) {
    logger.warn({ err, runId }, 'kg: getRun failed');
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// List runs
// ────────────────────────────────────────────────────────────────────

interface ListRunsOpts {
  familyId?: string;
  topic?: string;
  status?: string;
  excludeStatuses?: string[];
  after?: string;
  before?: string;
  limit?: number;
  cursor?: string;
}

interface ListRunsResult {
  runs: KgRun[];
  total: number;
  nextCursor: string | null;
}

const LIST_RUNS_BASE = 'SELECT * FROM kg_runs WHERE 1=1';
const LIST_RUNS_ORDER = 'ORDER BY started_at DESC, run_id DESC';
const LIST_RUNS_COUNT_BASE = 'SELECT COUNT(*) as cnt FROM kg_runs WHERE 1=1';

/**
 * List runs with optional filters and cursor-based pagination.
 *
 * familyId support: uses a subquery into kg_node_families to find
 * runs that contributed entities assigned to the given family.
 */
export function listRuns(opts: ListRunsOpts = {}): ListRunsResult {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: listRuns called before database initialised');
    return { runs: [], total: 0, nextCursor: null };
  }

  try {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.familyId !== undefined) {
      clauses.push('run_id IN (SELECT run_id FROM kg_node_families WHERE family_id = @familyId)');
      params.familyId = opts.familyId;
    }
    if (opts.topic !== undefined) {
      clauses.push('topic LIKE @topic');
      params.topic = `%${opts.topic}%`;
    }
    if (opts.status !== undefined) {
      clauses.push('status = @status');
      params.status = opts.status;
    }
    if (opts.excludeStatuses !== undefined && opts.excludeStatuses.length > 0) {
      const placeholders = opts.excludeStatuses.map((_, i) => `@excludeStatus${String(i)}`);
      clauses.push(`status NOT IN (${placeholders.join(', ')})`);
      opts.excludeStatuses.forEach((s, i) => {
        params[`excludeStatus${String(i)}`] = s;
      });
    }
    if (opts.after !== undefined) {
      clauses.push('started_at >= @after');
      params.after = opts.after;
    }
    if (opts.before !== undefined) {
      clauses.push('started_at <= @before');
      params.before = opts.before;
    }
    if (opts.cursor !== undefined) {
      const [cursorDate, cursorId] = opts.cursor.split('|');
      if (cursorDate && cursorId) {
        clauses.push(
          '(started_at < @cursorDate OR (started_at = @cursorDate AND run_id < @cursorId))',
        );
        params.cursorDate = cursorDate;
        params.cursorId = cursorId;
      }
    }

    const where = clauses.length > 0 ? ' AND ' + clauses.join(' AND ') : '';
    const pageLimit = opts.limit ?? 20;
    const limit = ` LIMIT ${String(pageLimit + 1)}`;

    // Get total
    const countRow = db.prepare(`${LIST_RUNS_COUNT_BASE}${where}`).get(params) as
      | { cnt: number }
      | undefined;
    const total = countRow?.cnt ?? 0;

    // Get rows
    const sql = `${LIST_RUNS_BASE}${where} ${LIST_RUNS_ORDER}${limit}`;
    const rows = db.prepare(sql).all(params) as Record<string, unknown>[];

    // Pagination: if we fetched limit+1, we have a next page
    const hasMore = rows.length > pageLimit;
    const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;

    const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : undefined;
    const nextCursor =
      hasMore && lastRow !== undefined
        ? `${lastRow.started_at as string}|${lastRow.run_id as string}`
        : null;

    return {
      runs: pageRows.map(rowToRun),
      total,
      nextCursor,
    };
  } catch (err) {
    logger.warn({ err, opts }, 'kg: listRuns failed');
    return { runs: [], total: 0, nextCursor: null };
  }
}

// ────────────────────────────────────────────────────────────────────
// Row mapping
// ────────────────────────────────────────────────────────────────────

function rowToRun(row: Record<string, unknown>): KgRun {
  return {
    runId: row.run_id as string,
    status: row.status as RunStatus,
    topic: (row.topic as string | null) ?? null,
    query: (row.query as string | null) ?? null,
    sessionMode: Number(row.session_mode),
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
    failedAt: (row.failed_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    entityCount: row.entity_count != null ? Number(row.entity_count) : null,
    edgeCount: row.edge_count != null ? Number(row.edge_count) : null,
    sourceCount: row.source_count != null ? Number(row.source_count) : null,
    artifactPaths: (row.artifact_paths as string | null) ?? null,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    active: Number(row.active),
  };
}
