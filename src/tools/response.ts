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

// ── Branded wrapped response type ──────────────────────────────────────────

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
export function wrapResponse<T>(
  data: T,
  warnings?: string[],
): ToolWrappedResponse<T> {
  return warnings !== undefined
    ? { kind: 'wrapped', data, warnings }
    : { kind: 'wrapped', data };
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
  return error.message.split('\n')[0] ?? 'Unknown error';
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
        text: JSON.stringify(payload),
      },
    ],
    isError: true,
  };
}

export function successResponse<T>(result: ToolResult<T>): {
  content: { type: 'text'; text: string }[];
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result),
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
): Promise<
  { content: { type: 'text'; text: string }[]; isError?: true }
> {
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
