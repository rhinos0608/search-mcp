/**
 * Single source of truth for the package version.
 *
 * Reads from package.json at runtime so there is exactly one place to bump
 * when cutting a release.  All code that needs the version string (MCP server
 * info, User-Agent headers, health check probes) imports from here.
 */

import { readFileSync } from 'node:fs';

let cached: string | null = null;

export function getVersion(): string {
  if (cached !== null) return cached;

  try {
    // import.meta.url is the file URL of *this* compiled module.
    // In dev (tsx):  file://.../src/version.ts   → ../package.json
    // In prod:       file://.../dist/version.js  → ../package.json
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { version?: string };
    cached = typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }

  return cached;
}

/** Convenience: "search-mcp/<version>" User-Agent prefix. */
export function getUserAgent(extra?: string): string {
  const base = `search-mcp/${getVersion()}`;
  return extra ? `${base} ${extra}` : base;
}
