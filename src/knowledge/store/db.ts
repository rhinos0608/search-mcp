/**
 * Knowledge Graph database manager.
 *
 * Singleton lazy-initialised SQLite connection backed by better-sqlite3.
 * Schema management is delegated to schema.ts.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { logger } from '../../logger.js';
import { initializeKgSchema } from './schema.js';

// ────────────────────────────────────────────────────────────────────
// Singleton state
// ────────────────────────────────────────────────────────────────────

let _db: BetterSqliteDatabase | null = null;
let _dbPath: string | null = null;

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function ensureDir(filePath: string): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return true;
  } catch (err) {
    logger.warn({ err, filePath }, 'kg: failed to create database directory');
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────
// Database open / close
// ────────────────────────────────────────────────────────────────────

/**
 * Open (or reopen) the KG SQLite database at the given path.
 * Returns null if the directory cannot be created or the database
 * cannot be opened.
 */
export function openKgDb(databasePath: string): BetterSqliteDatabase | null {
  try {
    if (!ensureDir(databasePath)) return null;

    _dbPath = databasePath;
    const db = new Database(databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    initializeKgSchema(db);
    _db = db;
    logger.info({ databasePath }, 'kg: database opened');
    return db;
  } catch (err) {
    logger.warn({ err, databasePath }, 'kg: failed to open database');
    return null;
  }
}

/**
 * Get the singleton KG database handle.
 *
 * If not yet initialised, attempts to open at the default path
 * (~/.cache/search-mcp/kg/kg.sqlite).
 */
export function getKgDb(): BetterSqliteDatabase | null {
  if (_db !== null) return _db;
  const defaultPath = path.join(os.homedir(), '.cache', 'search-mcp', 'kg', 'kg.sqlite');
  return openKgDb(defaultPath);
}

/**
 * Set the database path and return a handle.
 *
 * Call this during server startup after config is loaded,
 * before any KG operations execute.
 */
export function initKgDb(databasePath: string): BetterSqliteDatabase | null {
  if (_db !== null) {
    _db.close();
    _db = null;
  }
  return openKgDb(databasePath);
}

/**
 * Close the KG database gracefully.
 * Safe to call multiple times.
 */
export function closeKgDb(): void {
  try {
    if (_db !== null) {
      _db.close();
      _db = null;
      _dbPath = null;
      logger.info('kg: database closed');
    }
  } catch (err) {
    logger.warn({ err }, 'kg: error closing database');
  }
}

/**
 * Current database path, if open.
 */
export function getKgDbPath(): string | null {
  return _dbPath;
}
