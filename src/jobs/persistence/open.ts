import path from 'node:path';
import type { JobsDatabase, OpenJobsDbOptions } from './contracts.js';
import { JobsStoreError, JobsStoreErrorCode } from './contracts.js';

// ---------------------------------------------------------------------------
// Database opener DI seam
// ---------------------------------------------------------------------------

let _databaseOpener: ((dbPath: string) => JobsDatabase) | undefined;

/**
 * Register a database opener implementation. Must be called before
 * openJobsDatabase. Default uses better-sqlite3.
 */
export function registerJobsDatabaseOpener(opener: (dbPath: string) => JobsDatabase): void {
  _databaseOpener = opener;
}

// ---------------------------------------------------------------------------
// Lazy import of better-sqlite3 (dynamic for fast startup)
// ---------------------------------------------------------------------------

async function getDefaultOpener(): Promise<(dbPath: string) => JobsDatabase> {
  const Database = (await import('better-sqlite3')).default;
  return (dbPath: string) => new Database(dbPath);
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

function validatePath(databasePath: string): void {
  if (!databasePath || databasePath.trim().length === 0) {
    throw new JobsStoreError(JobsStoreErrorCode.PATH_UNCONFIGURED, 'database path is required');
  }
  // Must be absolute
  if (!path.isAbsolute(databasePath)) {
    throw new JobsStoreError(
      JobsStoreErrorCode.PATH_UNCONFIGURED,
      'database path must be absolute',
    );
  }
  // Reject $HOME default — no fallback to homedir
}

// ---------------------------------------------------------------------------
// Pragmas
// ---------------------------------------------------------------------------

function applyPragmas(db: JobsDatabase, busyTimeoutMs: number): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${String(busyTimeoutMs)}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a jobs.sqlite database at the given absolute path.
 * Applies WAL, foreign_keys ON, synchronous=FULL, busy_timeout pragmas.
 * No $HOME default — caller supplies path from trusted config.
 */
export async function openJobsDatabase(opts: OpenJobsDbOptions): Promise<JobsDatabase> {
  validatePath(opts.databasePath);

  const opener = _databaseOpener ?? (await getDefaultOpener());
  const db = opener(opts.databasePath);
  applyPragmas(db, opts.busyTimeoutMs ?? 5000);
  return db;
}
