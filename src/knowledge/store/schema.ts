/**
 * KG SQLite schema — all DDL statements.
 *
 * Extracted to keep db.ts under 300 lines.
 */

import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { logger } from '../../logger.js';
import { invalidateAllCheckpoints } from './checkpoints.js';

export const SCHEMA_VERSION = 1;

/**
 * Schema DDL string for the KG database.
 */
export const KG_SCHEMA_DDL = `
  -- Append-only event store — the single source of truth
  CREATE TABLE IF NOT EXISTS kg_events (
    id            TEXT PRIMARY KEY,
    timestamp     TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    run_id        TEXT NOT NULL,
    batch_id      TEXT,
    actor         TEXT NOT NULL DEFAULT 'system',
    entity_id     TEXT,
    entity_type   TEXT,
    payload       TEXT NOT NULL,
    payload_hash  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_kg_events_run_id
    ON kg_events(run_id);
  CREATE INDEX IF NOT EXISTS idx_kg_events_type
    ON kg_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_kg_events_entity_id
    ON kg_events(entity_id);
  CREATE INDEX IF NOT EXISTS idx_kg_events_timestamp
    ON kg_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_kg_events_batch_id
    ON kg_events(batch_id);

  -- Run lifecycle
  CREATE TABLE IF NOT EXISTS kg_runs (
    run_id          TEXT PRIMARY KEY,
    status          TEXT NOT NULL,
    topic           TEXT,
    query           TEXT,
    session_mode    INTEGER NOT NULL DEFAULT 0,
    started_at      TEXT NOT NULL,
    completed_at    TEXT,
    failed_at       TEXT,
    last_error      TEXT,
    entity_count    INTEGER,
    edge_count      INTEGER,
    source_count    INTEGER,
    artifact_paths  TEXT,
    idempotency_key TEXT,
    active          INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_kg_runs_status
    ON kg_runs(status);
  CREATE INDEX IF NOT EXISTS idx_kg_runs_active
    ON kg_runs(active);
  CREATE INDEX IF NOT EXISTS idx_kg_runs_idempotency
    ON kg_runs(idempotency_key);

  -- Projection: nodes
  CREATE TABLE IF NOT EXISTS kg_nodes (
    id                     TEXT PRIMARY KEY,
    label                  TEXT NOT NULL,
    canonical_label        TEXT,
    type                   TEXT NOT NULL,
    extraction_confidence  REAL,
    primary_family_id      TEXT,
    aliases                TEXT,
    first_seen_run_id      TEXT,
    last_updated           TEXT,
    metadata               TEXT
  );

  -- Projection: edges
  CREATE TABLE IF NOT EXISTS kg_edges (
    id                TEXT PRIMARY KEY,
    from_id           TEXT NOT NULL,
    to_id             TEXT NOT NULL,
    type              TEXT NOT NULL,
    evidence_strength REAL,
    evidence          TEXT,
    evidence_verbatim INTEGER,
    source_id         TEXT,
    run_id            TEXT,
    created_at        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_kg_edges_from
    ON kg_edges(from_id);
  CREATE INDEX IF NOT EXISTS idx_kg_edges_to
    ON kg_edges(to_id);

  -- Projection: families
  CREATE TABLE IF NOT EXISTS kg_families (
    id               TEXT PRIMARY KEY,
    label            TEXT NOT NULL,
    description      TEXT,
    created_at       TEXT,
    last_activity    TEXT,
    run_count        INTEGER,
    related_families TEXT
  );

  -- Projection: sources
  CREATE TABLE IF NOT EXISTS kg_sources (
    id              TEXT PRIMARY KEY,
    url             TEXT NOT NULL,
    canonical_url   TEXT,
    title           TEXT,
    domain          TEXT,
    source_kind     TEXT,
    authority_score REAL,
    run_id          TEXT NOT NULL,
    retrieved_at    TEXT NOT NULL,
    published_at    TEXT,
    content_hash    TEXT NOT NULL,
    raw_hash        TEXT,
    tool_name       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_kg_sources_url
    ON kg_sources(url);

  -- Projection: multi-membership node-family assignments
  CREATE TABLE IF NOT EXISTS kg_node_families (
    node_id            TEXT NOT NULL,
    family_id          TEXT NOT NULL,
    confidence         REAL,
    is_primary         INTEGER NOT NULL DEFAULT 0,
    run_id             TEXT,
    classifier_version TEXT,
    PRIMARY KEY (node_id, family_id)
  );

  CREATE INDEX IF NOT EXISTS idx_kg_node_families_family
    ON kg_node_families(family_id);

  -- Event-to-entity reference index
  CREATE TABLE IF NOT EXISTS kg_event_refs (
    event_id TEXT NOT NULL,
    ref_type TEXT NOT NULL,
    ref_id   TEXT NOT NULL,
    PRIMARY KEY (event_id, ref_type, ref_id)
  );

  CREATE INDEX IF NOT EXISTS idx_kg_event_refs_ref_id
    ON kg_event_refs(ref_id);

  -- Projection checkpoints
  CREATE TABLE IF NOT EXISTS kg_projection_checkpoints (
    id                 TEXT PRIMARY KEY,
    created_at         TEXT NOT NULL,
    event_cursor       TEXT NOT NULL,
    projection_version INTEGER NOT NULL,
    schema_version     INTEGER NOT NULL,
    event_count        INTEGER NOT NULL,
    checksum           TEXT NOT NULL,
    compatible         INTEGER NOT NULL DEFAULT 1
  );

  -- Working state: pending families (not yet solidified)
  CREATE TABLE IF NOT EXISTS kg_pending_families (
    id          TEXT PRIMARY KEY,
    label       TEXT,
    description TEXT,
    entity_ids  TEXT,
    run_ids     TEXT,
    created_at  TEXT
  );

  -- Working state: pending family assignments
  CREATE TABLE IF NOT EXISTS kg_pending_assignments (
    entity_id TEXT,
    family_id TEXT,
    run_id    TEXT,
    queued_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_pending_assignments_unique
    ON kg_pending_assignments(entity_id, family_id, run_id);
  CREATE INDEX IF NOT EXISTS idx_kg_pending_assignments_family
    ON kg_pending_assignments(family_id);
  CREATE INDEX IF NOT EXISTS idx_kg_pending_assignments_entity
    ON kg_pending_assignments(entity_id);

  -- Working state: pending extractions (session accumulator)
  CREATE TABLE IF NOT EXISTS kg_pending_extractions (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    run_id       TEXT,
    tool_name    TEXT NOT NULL,
    content      TEXT NOT NULL,
    source_url   TEXT,
    content_hash TEXT,
    queued_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_kg_pending_extractions_session
    ON kg_pending_extractions(session_id);
  CREATE INDEX IF NOT EXISTS idx_kg_pending_extractions_run
    ON kg_pending_extractions(run_id);

  -- Working state: proposed family merges
  CREATE TABLE IF NOT EXISTS kg_family_merge_candidates (
    family_a              TEXT NOT NULL,
    family_b              TEXT NOT NULL,
    confidence            REAL,
    reason                TEXT,
    generated_at          TEXT NOT NULL,
    consolidation_version TEXT,
    PRIMARY KEY (family_a, family_b)
  );

  -- Embedding cache
  CREATE TABLE IF NOT EXISTS kg_embeddings (
    object_id       TEXT NOT NULL,
    object_type     TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding       BLOB NOT NULL,
    content_hash    TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (object_id, embedding_model)
  );
`;

/**
 * Execute the schema DDL and track schema version.
 */
export function initializeKgSchema(db: BetterSqliteDatabase): void {
  db.exec(KG_SCHEMA_DDL);

  const current = db
    .prepare('SELECT schema_version FROM kg_projection_checkpoints WHERE id = ?')
    .get('__schema_version') as { schema_version: number } | undefined;

  if (current === undefined) {
    db.prepare(
      'INSERT INTO kg_projection_checkpoints (id, created_at, event_cursor, projection_version, schema_version, event_count, checksum, compatible) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('__schema_version', new Date().toISOString(), '', 0, SCHEMA_VERSION, 0, '', 0);
  } else if (current.schema_version !== SCHEMA_VERSION) {
    logger.warn(
      { found: current.schema_version, expected: SCHEMA_VERSION },
      'kg: SQLite schema version changed',
    );
    // Invalidate all checkpoints before updating to prevent rebuilds
    // from using checkpoints created under the old schema
    invalidateAllCheckpoints();
    db.prepare('UPDATE kg_projection_checkpoints SET schema_version = ? WHERE id = ?').run(
      SCHEMA_VERSION,
      '__schema_version',
    );
  }
}
