/**
 * Safe coercion helpers for untrusted search-provider JSON fields.
 *
 * Provider payloads are typed as `unknown` at the boundary because upstream
 * APIs sometimes emit non-string values (numbers, booleans, objects) for fields
 * that are documented as strings. These helpers coerce ONLY string values to
 * strings; every other value maps to an empty string (or null for nullable
 * fields), so a malformed field can never throw downstream (e.g. a numeric
 * `title` would otherwise reach `.trim()` and crash).
 */

/** Return `value` when it is a string, otherwise an empty string. */
export function strField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Return `value` when it is a string, otherwise `null` (for nullable fields). */
export function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Return the string entries of `value` when it is an array of strings,
 * otherwise an empty array. Non-string entries are dropped so a malformed
 * highlight never throws or corrupts output.
 */
export function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}
