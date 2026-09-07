import { createHash } from 'node:crypto';
import type { ProfileDatabase } from './contracts.js';
import { PROFILE_PERSISTENCE_CONTRACT_VERSION } from './contracts.js';

// ---------------------------------------------------------------------------
// Migration: v1 — create-only, checksummed
// ---------------------------------------------------------------------------

const MIGRATION_VERSION = 1;

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

const V1_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  profile_id TEXT PRIMARY KEY CHECK(profile_id = 'profile:default'),
  contract_version TEXT NOT NULL CHECK(contract_version = '${PROFILE_PERSISTENCE_CONTRACT_VERSION}'),
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_revisions (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  adopted_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, revision_id),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS profile_provenance (
  profile_id TEXT NOT NULL,
  provenance_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind = 'user_adoption'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, provenance_id),
  FOREIGN KEY (profile_id, revision_id) REFERENCES profile_revisions(profile_id, revision_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS profile_fact_values (
  profile_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN (
    'role','capability','qualification','licence','clearance','registration','eligibility'
  )),
  pack_id TEXT NOT NULL,
  pack_version TEXT NOT NULL,
  term_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin = 'user_supplied'),
  data_class TEXT NOT NULL CHECK(data_class = 'job_fact'),
  PRIMARY KEY (profile_id, fact_id),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS profile_preference_values (
  profile_id TEXT NOT NULL,
  preference_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'work_mode','employment_type','term','minimum_compensation'
  )),
  dimension TEXT,
  scalar_value TEXT,
  term_kind TEXT,
  pack_id TEXT,
  pack_version TEXT,
  term_id TEXT,
  amount INTEGER,
  currency TEXT,
  period TEXT,
  desired INTEGER NOT NULL CHECK(desired IN (0, 1)),
  explicit INTEGER NOT NULL CHECK(explicit = 1),
  PRIMARY KEY (profile_id, preference_id),
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
  CHECK (
    (kind = 'work_mode' AND dimension IS NULL AND scalar_value IS NOT NULL AND term_kind IS NULL) OR
    (kind = 'employment_type' AND dimension IS NULL AND scalar_value IS NOT NULL AND term_kind IS NULL) OR
    (kind = 'term' AND dimension IS NOT NULL AND scalar_value IS NULL AND term_kind IS NOT NULL) OR
    (kind = 'minimum_compensation' AND dimension IS NULL AND scalar_value IS NULL AND amount IS NOT NULL AND currency IS NOT NULL AND period IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS revision_facts (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  provenance_id TEXT NOT NULL,
  PRIMARY KEY (profile_id, revision_id, fact_id),
  FOREIGN KEY (profile_id, revision_id) REFERENCES profile_revisions(profile_id, revision_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, fact_id) REFERENCES profile_fact_values(profile_id, fact_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS revision_preferences (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  preference_id TEXT NOT NULL,
  provenance_id TEXT NOT NULL,
  PRIMARY KEY (profile_id, revision_id, preference_id),
  FOREIGN KEY (profile_id, revision_id) REFERENCES profile_revisions(profile_id, revision_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, preference_id) REFERENCES profile_preference_values(profile_id, preference_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS revision_fact_corrections (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  correction_id TEXT NOT NULL,
  prior_fact_id TEXT NOT NULL,
  replacement_fact_id TEXT,
  provenance_id TEXT NOT NULL,
  PRIMARY KEY (profile_id, revision_id, correction_id),
  FOREIGN KEY (profile_id, revision_id) REFERENCES profile_revisions(profile_id, revision_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, prior_fact_id) REFERENCES profile_fact_values(profile_id, fact_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, replacement_fact_id) REFERENCES profile_fact_values(profile_id, fact_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS revision_preference_corrections (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  correction_id TEXT NOT NULL,
  prior_preference_id TEXT NOT NULL,
  replacement_preference_id TEXT,
  provenance_id TEXT NOT NULL,
  PRIMARY KEY (profile_id, revision_id, correction_id),
  FOREIGN KEY (profile_id, revision_id) REFERENCES profile_revisions(profile_id, revision_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, prior_preference_id) REFERENCES profile_preference_values(profile_id, preference_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, replacement_preference_id) REFERENCES profile_preference_values(profile_id, preference_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS saved_profile_packets (
  profile_id TEXT NOT NULL,
  packet_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, packet_id),
  UNIQUE (profile_id, revision_id),
  FOREIGN KEY (profile_id, revision_id) REFERENCES profile_revisions(profile_id, revision_id) ON DELETE CASCADE
);
`;

const V1_CHECKSUM = sha256hex(V1_DDL);

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

export interface MigrationResult {
  applied: boolean;
  version: number;
}

/**
 * Apply migrations to the database. v1 is create-only — no destructive
 * migration, no silent version overwrite.
 */
export function applyMigrations(db: ProfileDatabase): MigrationResult {
  // Ensure migration table exists first (bootstrap)
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
    // Verify checksum
    if (existing.checksum !== V1_CHECKSUM) {
      throw new Error('SCHEMA_INCOMPATIBLE');
    }
    return { applied: false, version: MIGRATION_VERSION };
  }

  // Check no future migration has run
  const maxVersion = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    | { v: number | null }
    | undefined;
  if (maxVersion && maxVersion.v !== null && maxVersion.v > MIGRATION_VERSION) {
    throw new Error('SCHEMA_INCOMPATIBLE');
  }

  // Apply v1
  db.exec(V1_DDL);
  db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  ).run(MIGRATION_VERSION, 'v1-create-profiles', V1_CHECKSUM, new Date().toISOString());

  return { applied: true, version: MIGRATION_VERSION };
}

export { V1_CHECKSUM, MIGRATION_VERSION, V1_DDL };
