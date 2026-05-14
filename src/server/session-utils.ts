/**
 * Parse SESSION_TTL_HOURS env var into milliseconds.
 * Defaults to 12 hours. Values <= 0 are treated as 12.
 */
export function parseSessionTtlMs(): number {
  const rawTtl = process.env.SESSION_TTL_HOURS;
  const ttlHours = rawTtl !== undefined ? Number.parseFloat(rawTtl) : 12;
  return (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 12) * 3600 * 1000;
}
