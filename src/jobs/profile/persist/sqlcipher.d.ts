declare module 'better-sqlite3-multiple-ciphers' {
  interface Statement {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  interface BetterSqliteDatabase {
    memory: boolean;
    readonly: boolean;
    name: string;
    open: boolean;
    prepare(source: string): Statement;
    exec(source: string): BetterSqliteDatabase;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    close(): BetterSqliteDatabase;
  }
  interface DatabaseConstructor {
    new (filename?: string, options?: Record<string, unknown>): BetterSqliteDatabase;
  }
  const Database: DatabaseConstructor;
  export = Database;
}
