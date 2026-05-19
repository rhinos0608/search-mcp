/**
 * Shared input normalization helpers for tool family schemas.
 *
 * These helpers make common tool inputs more tolerant without changing
 * existing public field definitions.  All functions here are additive
 * and compatibility-preserving.
 */

import { z } from 'zod/v4';

// ── Scalar helpers ──────────────────────────────────────────────────────────

/**
 * Convert empty string (`""`) to `undefined`.
 * Useful as a Zod preprocessor so that optional fields default correctly
 * when an LLM serialises an omitted field as `""`.
 */
export function emptyStringToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}

/** Like `emptyStringToUndefined` but also converts `null`. */
export function nullishOrEmptyToUndefined(value: unknown): unknown {
  return value === null || value === '' ? undefined : value;
}

/**
 * Zod preprocessed schema that treats both `null` and empty string as
 * omitted, producing `undefined` for optional string fields.
 *
 * @example
 * ```ts
 * const sortSchema = optionalTrimmedString(z.enum(['a','b'])).optional().default('a');
 * ```
 */
export function optionalTrimmedString(schema?: z.ZodType): z.ZodType {
  const inner: z.ZodType = schema ?? z.string();
  return z.preprocess(nullishOrEmptyToUndefined, inner.optional());
}

// ── Number coercion ────────────────────────────────────────────────────────

/**
 * Coerce a numeric string to a number, pass through all other values.
 * Handles the case where MCP clients serialize numbers as strings.
 */
export function coerceNumericString(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const num = Number(trimmed);
    if (!Number.isNaN(num)) return num;
  }
  return value;
}

/**
 * Wrap any Zod schema to coerce numeric strings to numbers before validation.
 * Safe for all types — values that aren't valid numbers pass through unchanged.
 *
 * @example
 * ```ts
 * limit: tolerant(z.number().int().min(1).max(50)).optional().default(10)
 * ```
 */
export function tolerant<T extends z.ZodType>(schema: T) {
  return z.preprocess(coerceNumericString, schema);
}

/**
 * Recursively walk an args object and coerce all numeric string values
 * to actual numbers.  Arrays and nested objects are traversed; primitives
 * are passed through.  Returns a shallow copy with transformed values.
 */
export function coerceArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    const val = raw[key];
    if (typeof val === 'string') {
      result[key] = coerceNumericString(val);
    } else if (Array.isArray(val)) {
      result[key] = val.map((v: unknown): unknown =>
        typeof v === 'string' ? coerceNumericString(v) : v,
      );
    } else if (typeof val === 'object' && val !== null) {
      result[key] = coerceArgs(val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ── Limit resolver ─────────────────────────────────────────────────────────

/**
 * Resolve a numerical limit from an input object by trying multiple
 * field aliases in order.  Returns the first finite number found, or
 * `defaultVal` if none match.
 *
 * @example
 * ```ts
 * const limit = resolveLimit(rawArgs, ['limit', 'commentLimit', 'maxResults'], 25);
 * ```
 */
export function resolveLimit(
  input: Record<string, unknown>,
  aliases: string[],
  defaultVal: number,
): number {
  for (const alias of aliases) {
    const val = input[alias];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
  }
  return defaultVal;
}

// ── GitHub repo locator ────────────────────────────────────────────────────

export interface GitHubRepoLocator {
  owner: string;
  repo: string;
}

/**
 * Parse a GitHub repository identifier into `{ owner, repo }`.
 * Accepts these forms:
 *
 *   - `"owner/repo"`
 *   - `"https://github.com/owner/repo"` (with or without trailing path)
 *   - `"http://github.com/owner/repo"`
 *   - `"github.com/owner/repo"`
 *   - `{ owner: "owner", repo: "repo" }` (object form)
 *
 * Returns `null` when the input cannot be resolved.
 */
export function resolveGitHubRepoLocator(
  input: string | { owner?: string; repo?: string } | undefined | null,
): GitHubRepoLocator | null {
  if (!input) return null;

  if (typeof input === 'string') {
    return resolveGitHubRepoLocatorFromString(input);
  }

  const owner = input.owner?.trim();
  const repo = input.repo?.trim();
  if (owner && repo) {
    return { owner, repo };
  }

  return null;
}

function resolveGitHubRepoLocatorFromString(input: string): GitHubRepoLocator | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Full GitHub URL - optional protocol, optional www, then owner/repo
  const urlMatch =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\/.*?\.git)?(?:\/.*)?$/.exec(
      trimmed,
    );
  if (urlMatch) {
    const ownerGroup = urlMatch[1];
    const repoGroup = urlMatch[2];
    if (ownerGroup && repoGroup) {
      return { owner: ownerGroup, repo: repoGroup.replace(/\.git$/, '') };
    }
    return null;
  }

  // owner/repo form
  const parts = trimmed.split('/');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
  }

  return null;
}
