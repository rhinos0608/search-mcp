/**
 * SQLite persistence for the Job Intelligence Graph.
 *
 * Storage: {JOB_GRAPH_DATABASE_PATH or ~/.cache/search-mcp/semantic-crawl/job-graph.sqlite}
 *
 * Uses better-sqlite3 with WAL mode, sharing the same database-directory
 * resolution as the corpus cache so both files land in the same directory.
 *
 * All public functions are non-throwing: errors are logged via the project
 * logger and a safe fallback (null / false / empty array) is returned.
 * An optional `db` parameter allows callers to manage their own transaction
 * scope when performing batch inserts.
 *
 * ESM-only. All internal imports use `.js` extension.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import type {
  GraphJobPosting,
  GraphCompany,
  GraphLocation,
  GraphDuplicateCluster,
} from '../rag/types/jobGraph.js';
import { logger } from '../logger.js';

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_CACHE_DIR =
  process.env.SEMANTIC_CRAWL_CACHE_DIR ??
  path.join(os.homedir(), '.cache', 'search-mcp', 'semantic-crawl');

function resolveDatabasePath(): string {
  const cacheDir = process.env.SEMANTIC_CRAWL_CACHE_DIR ?? DEFAULT_CACHE_DIR;
  const graphDir = process.env.JOB_GRAPH_DATABASE_DIR ?? cacheDir;
  return process.env.JOB_GRAPH_DATABASE_PATH ?? path.join(graphDir, 'job-graph.sqlite');
}

// ── Schema ────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 2; // Incremented for new graph tables

const MIGRATIONS: Record<
  number,
  { up: (db: BetterSqliteDatabase) => void; down: (db: BetterSqliteDatabase) => void }
> = {
  1: {
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS graph_job_postings (
          job_id               TEXT PRIMARY KEY,
          title                TEXT NOT NULL,
          company_id           TEXT,
          location_id          TEXT,
          source_site          TEXT NOT NULL,
          source_url           TEXT NOT NULL,
          verification_status  TEXT NOT NULL DEFAULT 'pending',
          confidence           REAL NOT NULL DEFAULT 0,
          caveats              TEXT NOT NULL DEFAULT '[]'
        );
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS graph_job_postings');
    },
  },
  2: {
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS graph_companies (
          company_id       TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          domain          TEXT,
          industry        TEXT,
          careers_page_url TEXT,
          logo_url        TEXT,
          first_seen_at   INTEGER NOT NULL,
          last_seen_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS graph_locations (
          location_id  TEXT PRIMARY KEY,
          city         TEXT,
          state        TEXT,
          country      TEXT,
          display_name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS graph_duplicate_clusters (
          cluster_id       TEXT PRIMARY KEY,
          canonical_job_id TEXT NOT NULL,
          member_job_ids   TEXT NOT NULL DEFAULT '[]',
          member_sites     TEXT NOT NULL DEFAULT '[]',
          cluster_size    INTEGER NOT NULL DEFAULT 1,
          first_seen_at   INTEGER NOT NULL,
          last_seen_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS graph_job_skills (
          job_id    TEXT NOT NULL,
          skill_id  TEXT NOT NULL,
          PRIMARY KEY (job_id, skill_id)
        );

        CREATE TABLE IF NOT EXISTS graph_skills (
          skill_id  TEXT PRIMARY KEY,
          name      TEXT NOT NULL,
          category  TEXT
        );
      `);

      // Add new columns to graph_job_postings if they don't exist
      try {
        db.exec(`
          ALTER TABLE graph_job_postings ADD COLUMN salary_min REAL;
          ALTER TABLE graph_job_postings ADD COLUMN salary_max REAL;
          ALTER TABLE graph_job_postings ADD COLUMN salary_currency TEXT;
          ALTER TABLE graph_job_postings ADD COLUMN salary_interval TEXT;
          ALTER TABLE graph_job_postings ADD COLUMN work_mode TEXT;
          ALTER TABLE graph_job_postings ADD COLUMN job_type TEXT;
          ALTER TABLE graph_job_postings ADD COLUMN seniority TEXT;
          ALTER TABLE graph_job_postings ADD COLUMN posted_at TEXT;
          ALTER TABLE graph_job_postings ADD COLUMN description TEXT;
          ALTER TABLE graph_job_postings ADD COLUMN extracted_text TEXT;
        `);
      } catch (err) {
        // columns might already exist from half-failed initSchema in older version
        logger.debug({ err }, 'jobGraphDb: migration v2 ALTER TABLE failed (likely columns exist)');
      }
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS graph_companies;
        DROP TABLE IF EXISTS graph_locations;
        DROP TABLE IF EXISTS graph_duplicate_clusters;
        DROP TABLE IF EXISTS graph_job_skills;
        DROP TABLE IF EXISTS graph_skills;
      `);
      // Note: SQLite doesn't support DROP COLUMN easily before 3.35.0
    },
  },
};

/**
 * Migration Runner: Applies all pending migrations in a transaction.
 */
function runMigrations(db: BetterSqliteDatabase, currentVersion: number): void {
  for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (!migration) continue;

    logger.info({ version: v }, 'jobGraphDb: applying migration');
    try {
      db.transaction(() => {
        migration.up(db);
        db.prepare('UPDATE schema_version SET value = ? WHERE key = ?').run(
          String(v),
          'schemaVersion',
        );
      })();
    } catch (err) {
      logger.error({ err, version: v }, 'jobGraphDb: migration failed; aborting');
      throw err; // Fail-fast on migration failure
    }
  }
}

/**
 * Rollback Handler: Executes down migrations for specified versions.
 */
export function rollbackMigrations(db: BetterSqliteDatabase, toVersion: number): void {
  const row = db.prepare('SELECT value FROM schema_version WHERE key = ?').get('schemaVersion') as
    | { value: string }
    | undefined;
  const currentVersion = row ? Number(row.value) : 0;

  for (let v = currentVersion; v > toVersion; v--) {
    const migration = MIGRATIONS[v];
    if (!migration) continue;

    logger.info({ version: v }, 'jobGraphDb: rolling back migration');
    db.transaction(() => {
      migration.down(db);
      db.prepare('UPDATE schema_version SET value = ? WHERE key = ?').run(
        String(v - 1),
        'schemaVersion',
      );
    })();
  }
}

/**
 * Backfill Job Data: Maps existing JobPosting rows to new graph entities.
 */
export function backfillJobData(db: BetterSqliteDatabase): void {
  logger.info('jobGraphDb: starting data backfill');
  const postings = db.prepare('SELECT * FROM graph_job_postings').all() as JobPostingRow[];

  db.transaction(() => {
    for (const p of postings) {
      if (p.company_id) {
        // Heuristic: create company if missing
        db.prepare(
          `
          INSERT OR IGNORE INTO graph_companies (company_id, name, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?)
        `,
        ).run(p.company_id, p.company_id, Date.now(), Date.now());
      }
    }
  })();
  logger.info({ count: postings.length }, 'jobGraphDb: backfill complete');
}

/**
 * Unified schema initialization with migration support.
 */
function initSchema(db: BetterSqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const row = db.prepare('SELECT value FROM schema_version WHERE key = ?').get('schemaVersion') as
    | { value: string }
    | undefined;

  if (row === undefined) {
    db.prepare('INSERT INTO schema_version (key, value) VALUES (?, ?)').run('schemaVersion', '0');
  }

  const currentVersion = row ? Number(row.value) : 0;
  if (currentVersion < SCHEMA_VERSION) {
    runMigrations(db, currentVersion);
    if (currentVersion === 0) {
      backfillJobData(db);
    }
  }
}

// ── Database lifecycle ───────────────────────────────────────────────────

let _db: BetterSqliteDatabase | null = null;

function ensureDatabaseDir(databasePath: string): void {
  try {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  } catch {
    // best-effort — callers will surface errors on open
  }
}

function openDatabase(databasePath: string): BetterSqliteDatabase {
  ensureDatabaseDir(databasePath);
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

/**
 * Open (or reuse) the job-graph SQLite database.
 *
 * Subsequent calls return the same open handle until the process exits.
 * Errors are logged and null is returned — callers must guard for null.
 */
export function getJobGraphDb(): BetterSqliteDatabase | null {
  if (_db !== null) return _db;

  const databasePath = resolveDatabasePath();
  try {
    _db = openDatabase(databasePath);
    return _db;
  } catch (err) {
    logger.error({ err, databasePath }, 'jobGraphDb: failed to open database');
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Deserialize a JSON text array to a string[]. */
function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

// ── Insert helpers ────────────────────────────────────────────────────────

/**
 * Upsert a GraphJobPosting record.
 *
 * On error, logs and returns without throwing.
 */
export function insertJobPosting(p: GraphJobPosting, db?: BetterSqliteDatabase): boolean {
  const handle = db ?? getJobGraphDb();
  if (handle === null) return false;

  try {
    handle
      .prepare(
        `
      INSERT INTO graph_job_postings (
        job_id, title, company_id, location_id, source_site, source_url,
        salary_min, salary_max, salary_currency, salary_interval,
        work_mode, job_type, seniority, posted_at, description, extracted_text,
        verification_status, confidence, caveats
      ) VALUES (
        @job_id, @title, @company_id, @location_id, @source_site, @source_url,
        @salary_min, @salary_max, @salary_currency, @salary_interval,
        @work_mode, @job_type, @seniority, @posted_at, @description, @extracted_text,
        @verification_status, @confidence, @caveats
      )
      ON CONFLICT(job_id) DO UPDATE SET
        title               = excluded.title,
        company_id          = excluded.company_id,
        location_id         = excluded.location_id,
        source_site         = excluded.source_site,
        source_url          = excluded.source_url,
        salary_min          = excluded.salary_min,
        salary_max          = excluded.salary_max,
        salary_currency     = excluded.salary_currency,
        salary_interval     = excluded.salary_interval,
        work_mode           = excluded.work_mode,
        job_type            = excluded.job_type,
        seniority           = excluded.seniority,
        posted_at           = excluded.posted_at,
        description         = excluded.description,
        extracted_text      = excluded.extracted_text,
        verification_status = excluded.verification_status,
        confidence         = excluded.confidence,
        caveats            = excluded.caveats
    `,
      )
      .run({
        job_id: p.jobId,
        title: p.title,
        company_id: p.companyId ?? null,
        location_id: p.locationId ?? null,
        source_site: p.sourceSite,
        source_url: p.sourceUrl,
        salary_min: p.salaryMin ?? null,
        salary_max: p.salaryMax ?? null,
        salary_currency: p.salaryCurrency ?? null,
        salary_interval: p.salaryInterval ?? null,
        work_mode: p.workMode ?? null,
        job_type: p.jobType ?? null,
        seniority: p.seniority ?? null,
        posted_at: p.postedAt ?? null,
        description: p.description ?? null,
        extracted_text: p.extractedText ?? null,
        verification_status: p.verificationStatus,
        confidence: p.confidence,
        caveats: JSON.stringify(p.caveats),
      });
    return true;
  } catch (err) {
    logger.error({ err, jobId: p.jobId }, 'jobGraphDb: insertJobPosting failed');
    return false;
  }
}

/**
 * Upsert a GraphCompany record.
 *
 * Returns true on success, false on error.
 */
export function insertCompany(c: GraphCompany, db?: BetterSqliteDatabase): boolean {
  const handle = db ?? getJobGraphDb();
  if (handle === null) return false;

  try {
    handle
      .prepare(
        `
      INSERT INTO graph_companies (
        company_id, name, domain, industry, careers_page_url, logo_url,
        first_seen_at, last_seen_at
      ) VALUES (
        @company_id, @name, @domain, @industry, @careers_page_url, @logo_url,
        @first_seen_at, @last_seen_at
      )
      ON CONFLICT(company_id) DO UPDATE SET
        name              = excluded.name,
        domain            = excluded.domain,
        industry          = excluded.industry,
        careers_page_url  = excluded.careers_page_url,
        logo_url          = excluded.logo_url,
        last_seen_at      = excluded.last_seen_at
    `,
      )
      .run({
        company_id: c.companyId,
        name: c.name,
        domain: c.domain ?? null,
        industry: c.industry ?? null,
        careers_page_url: c.careersPageUrl ?? null,
        logo_url: c.logoUrl ?? null,
        first_seen_at: c.firstSeenAt,
        last_seen_at: c.lastSeenAt,
      });
    return true;
  } catch (err) {
    logger.error({ err, companyId: c.companyId }, 'jobGraphDb: insertCompany failed');
    return false;
  }
}

/**
 * Upsert a GraphLocation record.
 *
 * On error, logs and returns without throwing.
 */
export function insertLocation(l: GraphLocation, db?: BetterSqliteDatabase): void {
  const handle = db ?? getJobGraphDb();
  if (handle === null) return;

  try {
    handle
      .prepare(
        `
      INSERT INTO graph_locations (location_id, city, state, country, display_name)
      VALUES (@location_id, @city, @state, @country, @display_name)
      ON CONFLICT(location_id) DO UPDATE SET
        city         = excluded.city,
        state        = excluded.state,
        country      = excluded.country,
        display_name = excluded.display_name
    `,
      )
      .run({
        location_id: l.locationId,
        city: l.city ?? null,
        state: l.state ?? null,
        country: l.country ?? null,
        display_name: l.displayName,
      });
  } catch (err) {
    logger.error({ err, locationId: l.locationId }, 'jobGraphDb: insertLocation failed');
  }
}

/**
 * Upsert a GraphDuplicateCluster record.
 *
 * On error, logs and returns without throwing.
 */
export function insertDuplicateCluster(c: GraphDuplicateCluster, db?: BetterSqliteDatabase): void {
  const handle = db ?? getJobGraphDb();
  if (handle === null) return;

  try {
    handle
      .prepare(
        `
      INSERT INTO graph_duplicate_clusters (
        cluster_id, canonical_job_id, member_job_ids, member_sites,
        cluster_size, first_seen_at, last_seen_at
      ) VALUES (
        @cluster_id, @canonical_job_id, @member_job_ids, @member_sites,
        @cluster_size, @first_seen_at, @last_seen_at
      )
      ON CONFLICT(cluster_id) DO UPDATE SET
        canonical_job_id = excluded.canonical_job_id,
        member_job_ids   = excluded.member_job_ids,
        member_sites     = excluded.member_sites,
        cluster_size    = excluded.cluster_size,
        last_seen_at    = excluded.last_seen_at
    `,
      )
      .run({
        cluster_id: c.clusterId,
        canonical_job_id: c.canonicalJobId,
        member_job_ids: JSON.stringify(c.memberJobIds),
        member_sites: JSON.stringify(c.memberSites),
        cluster_size: c.clusterSize,
        first_seen_at: c.firstSeenAt,
        last_seen_at: c.lastSeenAt,
      });
  } catch (err) {
    logger.error({ err, clusterId: c.clusterId }, 'jobGraphDb: insertDuplicateCluster failed');
  }
}

// ── Row types ──────────────────────────────────────────────────────────────

type NullOr<T> = T | null;

interface JobPostingRow {
  job_id: string;
  title: string;
  company_id: NullOr<string>;
  location_id: NullOr<string>;
  source_site: string;
  source_url: string;
  salary_min: NullOr<number>;
  salary_max: NullOr<number>;
  salary_currency: NullOr<string>;
  salary_interval: NullOr<string>;
  work_mode: NullOr<string>;
  job_type: NullOr<string>;
  seniority: NullOr<string>;
  posted_at: NullOr<string>;
  description: NullOr<string>;
  extracted_text: NullOr<string>;
  verification_status: string;
  confidence: number;
  caveats: string;
}

interface DuplicateClusterRow {
  cluster_id: string;
  canonical_job_id: string;
  member_job_ids: string;
  member_sites: string;
  cluster_size: number;
  first_seen_at: number;
  last_seen_at: number;
}

// ── Row → entity converters ───────────────────────────────────────────────

function rowToJobPosting(r: JobPostingRow): GraphJobPosting {
  // Build the required fields first, then conditionally assign optional ones.
  // This avoids exactOptionalPropertyTypes narrowing in the return type by
  // building the object via a typed variable (not an object literal cast).
  const result: GraphJobPosting = {
    jobId: r.job_id,
    title: r.title,
    sourceSite: r.source_site,
    sourceUrl: r.source_url,
    verificationStatus: r.verification_status as GraphJobPosting['verificationStatus'],
    confidence: r.confidence,
    caveats: parseJsonArray(r.caveats),
  };

  if (r.company_id != null) result.companyId = r.company_id;
  if (r.location_id != null) result.locationId = r.location_id;
  if (r.salary_min != null) result.salaryMin = r.salary_min;
  if (r.salary_max != null) result.salaryMax = r.salary_max;
  if (r.salary_currency != null) result.salaryCurrency = r.salary_currency;
  if (r.salary_interval != null) result.salaryInterval = r.salary_interval;
  if (r.work_mode != null) result.workMode = r.work_mode as 'remote' | 'hybrid' | 'onsite';
  if (r.job_type != null) result.jobType = r.job_type;
  if (r.seniority != null) result.seniority = r.seniority;
  if (r.posted_at != null) result.postedAt = r.posted_at;
  if (r.description != null) result.description = r.description;
  if (r.extracted_text != null) result.extractedText = r.extracted_text;

  return result;
}

function rowToDuplicateCluster(r: DuplicateClusterRow): GraphDuplicateCluster {
  return {
    clusterId: r.cluster_id,
    canonicalJobId: r.canonical_job_id,
    memberJobIds: parseJsonArray(r.member_job_ids),
    memberSites: parseJsonArray(r.member_sites),
    clusterSize: r.cluster_size,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  };
}

// ── Query helpers ────────────────────────────────────────────────────────

/**
 * Find all job postings associated with a company ID.
 *
 * Returns an empty array on error or if the DB is unavailable.
 */
export function findJobsByCompany(companyId: string): GraphJobPosting[] {
  const handle = getJobGraphDb();
  if (handle === null) return [];

  try {
    const rows = handle
      .prepare('SELECT * FROM graph_job_postings WHERE company_id = ?')
      .all(companyId) as JobPostingRow[];
    return rows.map(rowToJobPosting);
  } catch (err) {
    logger.error({ err, companyId }, 'jobGraphDb: findJobsByCompany failed');
    return [];
  }
}

/**
 * Find duplicate clusters matching a company name + job title.
 *
 * Both arguments are matched case-insensitively after normalization.
 * Returns an empty array on error or if the DB is unavailable.
 */
export function findDuplicatesByTitleCompany(
  company: string,
  title: string,
): GraphDuplicateCluster[] {
  const handle = getJobGraphDb();
  if (handle === null) return [];

  const normalizedCompany = company.trim().toLowerCase();
  const normalizedTitle = title.trim().toLowerCase();

  try {
    const matchingStmt = handle.prepare(
      'SELECT job_id FROM graph_job_postings ' +
        'WHERE LOWER(title) = ? AND company_id IN (' +
        '  SELECT company_id FROM graph_companies WHERE LOWER(name) = ?' +
        ')',
    );

    const matchingJobs = matchingStmt.all(normalizedTitle, normalizedCompany) as {
      job_id: string;
    }[];
    const matchingJobIds = new Set(matchingJobs.map((mj) => mj.job_id));

    const rows = handle
      .prepare('SELECT * FROM graph_duplicate_clusters')
      .all() as DuplicateClusterRow[];

    return rows.map(rowToDuplicateCluster).filter((cluster) => {
      return cluster.memberJobIds.some((id) => matchingJobIds.has(id));
    });
  } catch (err) {
    logger.error({ err, company, title }, 'jobGraphDb: findDuplicatesByTitleCompany failed');
    return [];
  }
}

// ── Health check ─────────────────────────────────────────────────────────

/**
 * Connectivity health check for the job-graph database.
 *
 * Opens the DB, runs a trivial SELECT 1, and closes the handle.
 * Returns true on success, false on any failure.
 */
export function graphHealth(): boolean {
  const databasePath = resolveDatabasePath();

  let db: BetterSqliteDatabase | undefined;
  try {
    db = openDatabase(databasePath);
    db.prepare('SELECT 1').get();
    return true;
  } catch (err) {
    logger.warn({ err, databasePath }, 'jobGraphDb: health check failed');
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort
    }
  }
}

// ── Batch helpers ─────────────────────────────────────────────────────────

/**
 * Batch upsert job postings inside a transaction.
 *
 * Commits on success; rolls back on any error.
 */
export function insertJobPostingsBatch(postings: GraphJobPosting[]): {
  inserted: number;
  errors: number;
} {
  const handle = getJobGraphDb();
  if (handle === null) return { inserted: 0, errors: postings.length };

  let inserted = 0;
  try {
    handle.transaction(() => {
      for (const p of postings) {
        if (insertJobPosting(p, handle)) {
          inserted++;
        }
      }
    })();
    return { inserted, errors: postings.length - inserted };
  } catch (err) {
    logger.error({ err }, 'jobGraphDb: insertJobPostingsBatch transaction failed');
    return { inserted: 0, errors: postings.length };
  }
}

/**
 * Batch upsert companies inside a transaction.
 */
export function insertCompaniesBatch(companies: GraphCompany[]): {
  inserted: number;
  errors: number;
} {
  const handle = getJobGraphDb();
  if (handle === null) return { inserted: 0, errors: companies.length };

  let inserted = 0;
  try {
    handle.transaction(() => {
      for (const c of companies) {
        if (insertCompany(c, handle)) {
          inserted++;
        }
      }
    })();
    return { inserted, errors: companies.length - inserted };
  } catch (err) {
    logger.error({ err }, 'jobGraphDb: insertCompaniesBatch transaction failed');
    return { inserted: 0, errors: companies.length };
  }
}
