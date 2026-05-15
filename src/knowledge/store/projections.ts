/**
 * V7.0.0 — Projection query functions.
 *
 * Provides read access to the six projection tables (kg_nodes, kg_edges,
 * kg_families, kg_sources, kg_node_families, kg_event_refs).
 *
 * Re-exports rebuildProjection from the builder module for convenience.
 */

import { logger } from '../../logger.js';
import { getKgDb } from './db.js';
import type { KgNode, KgEdge, KgFamily } from '../types.js';

export { rebuildProjection } from './projection-builder.js';
export type { ProjectionRebuildResult } from './projection-builder.js';

// ────────────────────────────────────────────────────────────────────
// Query result types
// ────────────────────────────────────────────────────────────────────

export interface QueryNodesResult {
  nodes: KgNode[];
  total: number;
  nextCursor: string | null;
}

export interface QueryEdgesResult {
  edges: KgEdge[];
  total: number;
  nextCursor: string | null;
}

export interface QueryFamiliesResult {
  families: KgFamily[];
  total: number;
  nextCursor: string | null;
}

// ────────────────────────────────────────────────────────────────────
// queryNodes
// ────────────────────────────────────────────────────────────────────

/**
 * Query projected nodes with optional filters.
 *
 * Supports filtering by entityId (exact), label (alias-aware — checks
 * both label column and aliases JSON), type, familyId (via
 * kg_node_families join), minConfidence, runId, and temporal range.
 *
 * Pagination is cursor-based. Cursor is the last seen node ID (ULID).
 */
export function queryNodes(opts: {
  entityId?: string;
  label?: string;
  type?: string;
  familyId?: string;
  minConfidence?: number;
  runId?: string;
  after?: string;
  before?: string;
  limit?: number;
  cursor?: string;
}): QueryNodesResult {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: queryNodes called before database initialised');
    return { nodes: [], total: 0, nextCursor: null };
  }

  try {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.entityId !== undefined) {
      clauses.push('n.id = @entityId');
      params.entityId = opts.entityId;
    }

    if (opts.label !== undefined) {
      // Alias-aware: match label OR aliases JSON
      clauses.push(
        '(n.label LIKE @label OR n.aliases LIKE @aliasPattern)',
      );
      params.label = `%${opts.label}%`;
      params.aliasPattern = `%${opts.label}%`;
    }

    if (opts.type !== undefined) {
      clauses.push('n.type = @type');
      params.type = opts.type;
    }

    if (opts.familyId !== undefined) {
      clauses.push(
        'n.id IN (SELECT node_id FROM kg_node_families WHERE family_id = @familyId)',
      );
      params.familyId = opts.familyId;
    }

    if (opts.minConfidence !== undefined) {
      clauses.push(
        'n.extraction_confidence >= @minConfidence',
      );
      params.minConfidence = opts.minConfidence;
    }

    if (opts.runId !== undefined) {
      clauses.push('n.first_seen_run_id = @runId');
      params.runId = opts.runId;
    }

    if (opts.after !== undefined) {
      clauses.push('n.last_updated >= @after');
      params.after = opts.after;
    }

    if (opts.before !== undefined) {
      clauses.push('n.last_updated <= @before');
      params.before = opts.before;
    }

    if (opts.cursor !== undefined) {
      clauses.push('n.id > @cursor');
      params.cursor = opts.cursor;
    }

    const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';
    const pageLimit = opts.limit ?? 20;
    const limit = opts.limit !== undefined ? ` LIMIT ${String(opts.limit + 1)}` : ` LIMIT ${String(pageLimit + 1)}`;

    // Count
    const countRow = db
      .prepare(`SELECT COUNT(*) as cnt FROM kg_nodes n${where}`)
      .get(params) as { cnt: number } | undefined;
    const total = countRow?.cnt ?? 0;

    // Fetch with pagination
    const sql = `SELECT n.* FROM kg_nodes n${where} ORDER BY n.last_updated ASC, n.id ASC${limit}`;
    const rows = db.prepare(sql).all(params) as Record<string, unknown>[];

    const hasMore = rows.length > pageLimit;
    const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;
    const lastRow =
      pageRows.length > 0 ? pageRows[pageRows.length - 1] : undefined;
    const nextCursor =
      hasMore && lastRow !== undefined ? (lastRow.id as string) : null;

    return {
      nodes: pageRows.map(rowToNode),
      total,
      nextCursor,
    };
  } catch (err) {
    logger.warn({ err, opts }, 'kg: queryNodes failed');
    return { nodes: [], total: 0, nextCursor: null };
  }
}

// ────────────────────────────────────────────────────────────────────
// getNode
// ────────────────────────────────────────────────────────────────────

/**
 * Retrieve a single node by ID.
 * Returns null if not found.
 */
export function getNode(id: string): KgNode | null {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: getNode called before database initialised');
    return null;
  }

  try {
    const row = db.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row !== undefined ? rowToNode(row) : null;
  } catch (err) {
    logger.warn({ err, id }, 'kg: getNode failed');
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// getEdgesForNode
// ────────────────────────────────────────────────────────────────────

/**
 * Get edges connected to a node.
 *
 * Returns edges where from_id OR to_id matches the given nodeId.
 * Depth parameter controls whether to include edges at distance > 1
 * (not implemented in V7.0 — depth is always 1).
 */
export function getEdgesForNode(
  nodeId: string,
  _depth = 1,
): KgEdge[] {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: getEdgesForNode called before database initialised');
    return [];
  }

  try {
    const rows = db
      .prepare(
        'SELECT * FROM kg_edges WHERE from_id = ? OR to_id = ? ORDER BY created_at ASC',
      )
      .all(nodeId, nodeId) as Record<string, unknown>[];
    return rows.map(rowToEdge);
  } catch (err) {
    logger.warn({ err, nodeId }, 'kg: getEdgesForNode failed');
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────
// queryEdges
// ────────────────────────────────────────────────────────────────────

/**
 * Query edges with optional filters.
 */
export function queryEdges(opts: {
  fromId?: string;
  toId?: string;
  type?: string;
  minStrength?: number;
  sourceId?: string;
  runId?: string;
  limit?: number;
  cursor?: string;
}): QueryEdgesResult {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: queryEdges called before database initialised');
    return { edges: [], total: 0, nextCursor: null };
  }

  try {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.fromId !== undefined) {
      clauses.push('from_id = @fromId');
      params.fromId = opts.fromId;
    }
    if (opts.toId !== undefined) {
      clauses.push('to_id = @toId');
      params.toId = opts.toId;
    }
    if (opts.type !== undefined) {
      clauses.push('type = @type');
      params.type = opts.type;
    }
    if (opts.minStrength !== undefined) {
      clauses.push('evidence_strength >= @minStrength');
      params.minStrength = opts.minStrength;
    }
    if (opts.sourceId !== undefined) {
      clauses.push('source_id = @sourceId');
      params.sourceId = opts.sourceId;
    }
    if (opts.runId !== undefined) {
      clauses.push('run_id = @runId');
      params.runId = opts.runId;
    }
    if (opts.cursor !== undefined) {
      clauses.push('id > @cursor');
      params.cursor = opts.cursor;
    }

    const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';
    const pageLimit = opts.limit ?? 20;
    const limit = opts.limit !== undefined ? ` LIMIT ${String(opts.limit + 1)}` : ` LIMIT ${String(pageLimit + 1)}`;

    const countRow = db
      .prepare(`SELECT COUNT(*) as cnt FROM kg_edges${where}`)
      .get(params) as { cnt: number } | undefined;
    const total = countRow?.cnt ?? 0;

    const sql = `SELECT * FROM kg_edges${where} ORDER BY created_at ASC, id ASC${limit}`;
    const rows = db.prepare(sql).all(params) as Record<string, unknown>[];

    const hasMore = rows.length > pageLimit;
    const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;
    const lastRow =
      pageRows.length > 0 ? pageRows[pageRows.length - 1] : undefined;
    const nextCursor =
      hasMore && lastRow !== undefined ? (lastRow.id as string) : null;

    return {
      edges: pageRows.map(rowToEdge),
      total,
      nextCursor,
    };
  } catch (err) {
    logger.warn({ err, opts }, 'kg: queryEdges failed');
    return { edges: [], total: 0, nextCursor: null };
  }
}

// ────────────────────────────────────────────────────────────────────
// queryFamilies
// ────────────────────────────────────────────────────────────────────

/**
 * List all families with pagination.
 */
export function queryFamilies(opts: {
  limit?: number;
  cursor?: string;
}): QueryFamiliesResult {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: queryFamilies called before database initialised');
    return { families: [], total: 0, nextCursor: null };
  }

  try {
    const params: Record<string, unknown> = {};
    const cursorClause =
      opts.cursor !== undefined ? ' AND id > @cursor' : '';

    if (opts.cursor !== undefined) {
      params.cursor = opts.cursor;
    }

    const pageLimit = opts.limit ?? 20;
    const limit = opts.limit !== undefined ? ` LIMIT ${String(opts.limit + 1)}` : ` LIMIT ${String(pageLimit + 1)}`;

    const countRow = db
      .prepare('SELECT COUNT(*) as cnt FROM kg_families')
      .get() as { cnt: number } | undefined;
    const totalCount = countRow?.cnt ?? 0;

    const sql = `SELECT * FROM kg_families WHERE 1=1${cursorClause} ORDER BY last_activity DESC, id ASC${limit}`;
    const rows = db.prepare(sql).all(params) as Record<string, unknown>[];

    const hasMore = rows.length > pageLimit;
    const pageRows = hasMore ? rows.slice(0, pageLimit) : rows;
    const lastRow =
      pageRows.length > 0 ? pageRows[pageRows.length - 1] : undefined;
    const nextCursor =
      hasMore && lastRow !== undefined ? (lastRow.id as string) : null;

    return {
      families: pageRows.map(rowToFamily),
      total: totalCount,
      nextCursor,
    };
  } catch (err) {
    logger.warn({ err, opts }, 'kg: queryFamilies failed');
    return { families: [], total: 0, nextCursor: null };
  }
}

// ────────────────────────────────────────────────────────────────────
// getFamily
// ────────────────────────────────────────────────────────────────────

/**
 * Retrieve a single family by ID.
 * Returns null if not found.
 */
export function getFamily(id: string): KgFamily | null {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: getFamily called before database initialised');
    return null;
  }

  try {
    const row = db.prepare('SELECT * FROM kg_families WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row !== undefined ? rowToFamily(row) : null;
  } catch (err) {
    logger.warn({ err, id }, 'kg: getFamily failed');
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// getNodeFamilyIds
// ────────────────────────────────────────────────────────────────────

/**
 * Get all family IDs that a node belongs to, via kg_node_families.
 */
export function getNodeFamilyIds(nodeId: string): string[] {
  const db = getKgDb();
  if (db === null) {
    logger.warn('kg: getNodeFamilyIds called before database initialised');
    return [];
  }

  try {
    const rows = db
      .prepare('SELECT family_id FROM kg_node_families WHERE node_id = ?')
      .all(nodeId) as { family_id: string }[];
    return rows.map((r) => r.family_id);
  } catch (err) {
    logger.warn({ err, nodeId }, 'kg: getNodeFamilyIds failed');
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────
// Row mapping
// ────────────────────────────────────────────────────────────────────

function rowToNode(row: Record<string, unknown>): KgNode {
  return {
    id: row.id as string,
    label: row.label as string,
    canonicalLabel: (row.canonical_label as string | null) ?? null,
    type: row.type as string,
    extractionConfidence:
      row.extraction_confidence != null
        ? Number(row.extraction_confidence)
        : null,
    primaryFamilyId: (row.primary_family_id as string | null) ?? null,
    aliases: (row.aliases as string | null) ?? null,
    firstSeenRunId: (row.first_seen_run_id as string | null) ?? null,
    lastUpdated: (row.last_updated as string | null) ?? null,
    metadata: (row.metadata as string | null) ?? null,
  };
}

function rowToEdge(row: Record<string, unknown>): KgEdge {
  return {
    id: row.id as string,
    fromId: row.from_id as string,
    toId: row.to_id as string,
    type: row.type as string,
    evidenceStrength:
      row.evidence_strength != null ? Number(row.evidence_strength) : null,
    evidence: (row.evidence as string | null) ?? null,
    evidenceVerbatim: row.evidence_verbatim != null ? Number(row.evidence_verbatim) : 0,
    sourceId: (row.source_id as string | null) ?? null,
    runId: (row.run_id as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
  };
}

function rowToFamily(row: Record<string, unknown>): KgFamily {
  return {
    id: row.id as string,
    label: row.label as string,
    description: (row.description as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
    lastActivity: (row.last_activity as string | null) ?? null,
    runCount: row.run_count != null ? Number(row.run_count) : null,
    relatedFamilies: (row.related_families as string | null) ?? null,
  };
}
