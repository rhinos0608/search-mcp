/**
 * Shared response formatting helpers for tool handlers.
 *
 * Every tool handler returns JSON-RPC content via successResponse / errorResponse.
 * makeResult wraps tool data in a uniform ToolResult envelope with meta timing.
 *
 * This module replaces the locally-defined helpers that were previously
 * defined inside createServer() in server.ts.
 */

import { logger } from '../logger.js';
import { isToolError } from '../errors.js';
import type { ToolResult } from '../types.js';
import type { RateLimitInfo } from '../rateLimit.js';

// ── Large text field detection and hybrid serialization ───────────────────────────────

/** Fields that commonly contain large text content > 8KB */
const LARGE_TEXT_FIELDS = [
  'readme',
  'content',
  'fileContent',
  'transcript',
  'text',
  'body',
  'description',
  'readmeContent',
];

/** Minimum byte size to trigger hybrid serialization */
const LARGE_TEXT_THRESHOLD = 8_000;

/**
 * Type guard: checks if value is a non-null plain object (not array/primitive).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Gets a nested value from an object using dot/bracketed path.
 * Handles paths like "user.bio" or "items[0].content".
 */
function getNestedValue(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const normalized = path.replace(/\[(\d+)\]/g, '.$1');
  const parts = normalized.split('.').filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Deletes a nested key from an object, returning a deep clone without that key.
 * Handles paths like "user.bio" or "items[0].content".
 */
function deleteNestedKey(obj: unknown, path: string): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(obj ?? {})) as Record<string, unknown>;
  if (!path) return cloned;

  const normalized = path.replace(/\[(\d+)\]/g, '.$1');
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length === 0) return cloned;

  let current: unknown = cloned;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current === null || typeof current !== 'object') return cloned;
    const key = parts[i];
    if (key === undefined) return cloned;
    current = (current as Record<string, unknown>)[key];
  }

  if (current !== null && typeof current === 'object') {
    const lastKey = parts[parts.length - 1];
    if (lastKey !== undefined) {
      const target = current as Record<string, unknown>;
      Reflect.deleteProperty(target, lastKey);
    }
  }

  return cloned;
}

/**
 * Checks if a result contains large text fields that should be serialized separately.
 * Returns all field paths to large text, or empty array if under threshold.
 * Uses byte-based size check via estimateBytes.
 */
function findLargeTextFields(obj: unknown, path = ''): string[] {
  const matches: string[] = [];

  if (typeof obj !== 'object' || obj === null) return matches;

  if (Array.isArray(obj)) {
    const arr = obj as unknown[];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      matches.push(...findLargeTextFields(item, `${path}[${String(i)}]`));
    }
    return matches;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string') continue;

    // Use byte-based check to match formatHybridResult
    const byteSize = estimateBytes(value);
    if (
      byteSize > LARGE_TEXT_THRESHOLD &&
      LARGE_TEXT_FIELDS.some((f) => key.toLowerCase().includes(f.toLowerCase()))
    ) {
      matches.push(path ? `${path}.${key}` : key);
    }
  }
  return matches;
}

function estimateBytes(str: string): number {
  return new TextEncoder().encode(str).length;
}

/**
 * Formats a tool result with hybrid serialization for large text fields.
 * Large text is extracted and appended as raw Markdown, while metadata
 * remains structured and indented for LLM readability.
 * Supports multiple large text fields; each is extracted and appended sequentially.
 */
function formatHybridResult(result: ToolResult<unknown>): string {
  // Guard: result.data must be a non-null plain object to extract fields
  if (!isPlainObject(result.data)) {
    return JSON.stringify(result, null, 2);
  }

  const data = result.data;

  // Check if data contains any large text fields
  const largeFieldPaths = findLargeTextFields(data);
  if (largeFieldPaths.length === 0) {
    return JSON.stringify(result, null, 2);
  }

  // Build metadata without the large text fields (clone once, then delete each)
  const metadata = { ...result, data: { ...data } };
  for (const fieldPath of largeFieldPaths) {
    metadata.data = deleteNestedKey(metadata.data, fieldPath);
  }

  // Extract all large texts and build hybrid output
  const sections: string[] = [];
  for (const largeFieldPath of largeFieldPaths) {
    const largeText = getNestedValue(data, largeFieldPath) as string;
    if (!largeText || estimateBytes(largeText) < LARGE_TEXT_THRESHOLD) continue;

    const fieldKey = largeFieldPath.split('.').pop() ?? largeFieldPath;
    const sectionName = fieldKey === 'readmeContent' ? 'README' : fieldKey.toUpperCase();
    sections.push(`\n--- ${sectionName} CONTENT ---\n${largeText}`);
  }

  if (sections.length === 0) {
    return JSON.stringify(result, null, 2);
  }

  return `${JSON.stringify(metadata, null, 2)}${sections.join('')}`;
}

// ── End large text handling ────────────────────────────────────────────────────────────

/**
 * A branded wrapper that signals to handleToolCall that the value
 * contains both data and optional structured warnings, rather than
 * being ambiguous duck-typing on any object that happens to have a `data` key.
 */
export interface ToolWrappedResponse<T> {
  readonly kind: 'wrapped';
  readonly data: T;
  readonly warnings?: readonly string[];
}

/** Convenience factory for creating a wrapped response. */
export function wrapResponse<T>(data: T, warnings?: string[]): ToolWrappedResponse<T> {
  return warnings !== undefined ? { kind: 'wrapped', data, warnings } : { kind: 'wrapped', data };
}

export interface MakeResultOpts {
  warnings?: string[];
  rateLimit?: RateLimitInfo;
}

export function makeResult<T>(
  tool: string,
  data: T,
  durationMs: number,
  opts?: MakeResultOpts,
): ToolResult<T> {
  return {
    data,
    meta: {
      tool,
      durationMs,
      timestamp: new Date().toISOString(),
      ...(opts?.warnings && opts.warnings.length > 0 ? { warnings: opts.warnings } : {}),
      ...(opts?.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    },
  };
}

function sanitizeErrorMessage(err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  // Strip stack traces — only return the first line (the message)
  const baseMessage = error.message.split('\n')[0] ?? 'Unknown error';
  // Append recovery hints for common error patterns
  const hints: Record<string, string> = {
    'API rate limit exceeded':
      'Action required: Fall back to webSearch tool, or wait before retrying.',
    'rate limit exceeded': 'Action required: Fall back to webSearch tool, or wait before retrying.',
    'Not Found':
      'Action required: Verify the resource exists. For GitHub repos, check owner/repo spelling.',
    'Not found':
      'Action required: Verify the resource exists. For GitHub repos, check owner/repo spelling.',
    'Authentication required':
      'Action required: Set required API token in config, or use a different tool.',
    Unauthorized: 'Action required: Set required API token in config, or use a different tool.',
    ENOTFOUND: 'Action required: Check the URL/domain is correct and reachable.',
    ECONNREFUSED: 'Action required: Service may be down. Try again later or use alternative tool.',
    timeout:
      'Action required: Resource may be slow/unresponsive. Try again with smaller parameters.',
    'Too Many Requests': 'Action required: Wait before retrying, or reduce request frequency.',
  };
  for (const [pattern, hint] of Object.entries(hints)) {
    if (baseMessage.toLowerCase().includes(pattern.toLowerCase())) {
      return `${baseMessage} Hint: ${hint}`;
    }
  }
  return baseMessage;
}

export function errorResponse(err: unknown): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const payload: Record<string, unknown> = { error: sanitizeErrorMessage(err) };
  if (isToolError(err)) {
    payload.code = err.code;
    payload.retryable = err.retryable;
    if (err.statusCode !== undefined) payload.statusCode = err.statusCode;
    if (err.backend !== undefined) payload.backend = err.backend;
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    isError: true,
  };
}

export function successResponse<T>(result: ToolResult<T>): {
  content: { type: 'text'; text: string }[];
} {
  // Use hybrid serialization for large text fields (> 8KB), default to indented JSON
  const formatted = formatHybridResult(result);
  return {
    content: [
      {
        type: 'text' as const,
        text: formatted,
      },
    ],
  };
}

/**
 * Standard handler wrapper: logs invocation, times execution, formats result or error.
 * Used by family tool definitions and standalone tool registrations.
 */
export async function handleToolCall<T>(
  tool: string,
  action: string | undefined,
  handler: () => Promise<T>,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const label = action ? `${tool}.${action}` : tool;
  logger.info({ tool, action }, `${label} invoked`);
  const start = Date.now();
  try {
    const data = await handler();
    // Check for branded wrapped response — not just any object with a data key
    const maybeWrapped = data as Record<string, unknown>;
    if (maybeWrapped.kind === 'wrapped') {
      const result = makeResult(
        tool,
        maybeWrapped.data as T,
        Date.now() - start,
        Array.isArray(maybeWrapped.warnings) && (maybeWrapped.warnings as string[]).length > 0
          ? { warnings: [...(maybeWrapped.warnings as string[])] }
          : undefined,
      );
      return successResponse(result);
    }
    const result = makeResult(tool, data as T, Date.now() - start);
    return successResponse(result);
  } catch (err: unknown) {
    logger.error({ err, tool, action }, 'Tool failed');
    return errorResponse(err);
  }
}
