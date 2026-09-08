import { createHash } from 'node:crypto';
import type { JobsDatabase, MigrationResult } from './contracts.js';
import { JOBS_SQLITE_SCHEMA_VERSION, JobsStoreError, JobsStoreErrorCode } from './contracts.js';
import { JOBS_V1_DDL } from './schema.sql.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

const MIGRATION_VERSION = JOBS_SQLITE_SCHEMA_VERSION;
const V1_VERSION = 1;
const V2_DDL = 'ALTER TABLE postings ADD COLUMN contact_metadata TEXT NULL;';
const V1_CHECKSUM = sha256hex(JOBS_V1_DDL);
const V2_CHECKSUM = sha256hex(V2_DDL);

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Apply migrations to the database. v1 is create-only — no destructive
 * migration, no silent version overwrite.
 */
export function applyJobsMigrations(db: JobsDatabase): MigrationResult {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);`,
  );
  let applied = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db
      .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
      .all() as { version: number; checksum: string }[];
    const versions = new Set(rows.map((row) => row.version));
    if (rows.some((row) => row.version > MIGRATION_VERSION || row.version < 1))
      throw new JobsStoreError(JobsStoreErrorCode.SCHEMA_INCOMPATIBLE, 'invalid schema version');
    const v1 = rows.find((row) => row.version === V1_VERSION);
    const v2 = rows.find((row) => row.version === MIGRATION_VERSION);
    if (v1 && v1.checksum !== V1_CHECKSUM)
      throw new JobsStoreError(JobsStoreErrorCode.SCHEMA_INCOMPATIBLE, 'schema checksum mismatch');
    if (v2 && v2.checksum !== V2_CHECKSUM)
      throw new JobsStoreError(JobsStoreErrorCode.SCHEMA_INCOMPATIBLE, 'schema checksum mismatch');
    if (!v1 && versions.has(MIGRATION_VERSION))
      throw new JobsStoreError(JobsStoreErrorCode.SCHEMA_INCOMPATIBLE, 'schema version gap');
    if (!v1) {
      db.exec(JOBS_V1_DDL);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(V1_VERSION, 'v1-create-jobs', V1_CHECKSUM, new Date().toISOString());
      applied = true;
    }
    if (!v2) {
      db.exec(V2_DDL);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(MIGRATION_VERSION, 'v2-contact-metadata', V2_CHECKSUM, new Date().toISOString());
      applied = true;
    }
    db.exec('COMMIT');
    return { applied, version: MIGRATION_VERSION };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* preserve migration error */
    }
    throw error;
  }
}

export { V1_CHECKSUM, MIGRATION_VERSION };
