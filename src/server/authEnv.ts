/**
 * Leaf module for auth-related environment flags.
 *
 * Must stay dependency-free so both `http.ts` and `dashboard-router.ts` can
 * import it without creating an import cycle between them.
 */

/** Query-param API key auth is OFF by default; requires explicit MCP_ALLOW_QUERY_KEY=true. */
export function queryKeyAuthEnabled(env = process.env): boolean {
  return env.MCP_ALLOW_QUERY_KEY === 'true';
}
