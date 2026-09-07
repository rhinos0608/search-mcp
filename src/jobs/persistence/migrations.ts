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
const V1_CHECKSUM = sha256hex(JOBS_V1_DDL);

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Apply migrations to the database. v1 is create-only — no destructive
 * migration, no silent version overwrite.
 */
export function applyJobsMigrations(db: JobsDatabase): MigrationResult {
  // Bootstrap migration table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const existing = db
    .prepare('SELECT version, checksum FROM schema_migrations WHERE version = ?')
    .get(MIGRATION_VERSION) as { version: number; checksum: string } | undefined;

  if (existing) {
    if (existing.checksum !== V1_CHECKSUM) {
      throw new JobsStoreError(JobsStoreErrorCode.SCHEMA_INCOMPATIBLE, 'schema checksum mismatch');
    }
    return { applied: false, version: MIGRATION_VERSION };
  }

  // Check no future migration has run
  const maxVersion = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    | { v: number | null }
    | undefined;
  if (maxVersion && maxVersion.v !== null && maxVersion.v > MIGRATION_VERSION) {
    throw new JobsStoreError(
      JobsStoreErrorCode.SCHEMA_INCOMPATIBLE,
      'future schema version present',
    );
  }

  // Apply v1 DDL
  db.exec(JOBS_V1_DDL);
  db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  ).run(MIGRATION_VERSION, 'v1-create-jobs', V1_CHECKSUM, new Date().toISOString());

  return { applied: true, version: MIGRATION_VERSION };
}

export { V1_CHECKSUM, MIGRATION_VERSION };
