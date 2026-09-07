import { createRequire } from 'node:module';
import type { ProfileDatabase, ProfileDatabaseOpener } from './contracts.js';

const _require = createRequire(import.meta.url);

/**
 * Creates a ProfileDatabaseOpener that uses better-sqlite3-multiple-ciphers
 * with SQLCipher v4 compatibility.
 *
 * The binding is dynamically imported so the package is only required when
 * this opener is actually used (production SQLCipher path).
 *
 * Caller must install `better-sqlite3-multiple-ciphers` for production use.
 */
export async function createSqlCipherOpener(): Promise<ProfileDatabaseOpener> {
  // Dynamic require — package may not be installed in test environments
  const Database: new (filename: string, opts?: Record<string, unknown>) => ProfileDatabase =
    _require('better-sqlite3-multiple-ciphers') as never;

  return {
    open(databasePath: string, key: Uint8Array): ProfileDatabase {
      const hexKey = Buffer.from(key).toString('hex');
      const db = new Database(databasePath, {
        readonly: false,
        fileMustNotExist: false,
      });

      // Pin SQLCipher v4 before key
      db.pragma("cipher = 'sqlcipher'");
      db.pragma('legacy = 4');

      // Apply key
      db.pragma(`key = "x'${hexKey}'"`);

      // Verify keyed access
      const check = db.prepare('SELECT count(*) AS c FROM sqlite_master').get();
      if (!check) {
        db.close();
        throw new Error('SQLCipher key verification failed');
      }

      // Post-key pragmas
      db.pragma('foreign_keys = ON');
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('busy_timeout = 5000');
      db.pragma('secure_delete = ON');

      return db;
    },
  };
}
