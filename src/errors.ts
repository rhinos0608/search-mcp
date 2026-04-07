/**
 * Structured error types for tool failures.
 *
 * ToolError enriches the JSON-RPC error response with a machine-readable
 * `code` and `retryable` flag so MCP clients can react programmatically.
 */

export type ToolErrorCode =
  | 'RATE_LIMIT'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'PARSE_ERROR'
  | 'UNAVAILABLE'
  | 'VALIDATION_ERROR';

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number | undefined;
  readonly backend: string | undefined;

  constructor(
    message: string,
    options: {
      code: ToolErrorCode;
      retryable: boolean;
      statusCode?: number;
      backend?: string;
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ToolError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
    this.backend = options.backend;
  }
}

export function isToolError(err: unknown): err is ToolError {
  return err instanceof ToolError;
}

// ── Factory functions ──────────────────────────────────────────────────────

interface FactoryOpts {
  statusCode?: number;
  backend?: string;
  cause?: unknown;
}

export function rateLimitError(message: string, opts?: FactoryOpts): ToolError {
  return new ToolError(message, { code: 'RATE_LIMIT', retryable: true, ...opts });
}

export function notFoundError(message: string, opts?: FactoryOpts): ToolError {
  return new ToolError(message, { code: 'NOT_FOUND', retryable: false, ...opts });
}

export function timeoutError(message: string, opts?: FactoryOpts): ToolError {
  return new ToolError(message, { code: 'TIMEOUT', retryable: true, ...opts });
}

export function networkError(message: string, opts?: FactoryOpts): ToolError {
  return new ToolError(message, { code: 'NETWORK_ERROR', retryable: true, ...opts });
}

export function parseError(message: string, opts?: FactoryOpts): ToolError {
  return new ToolError(message, { code: 'PARSE_ERROR', retryable: false, ...opts });
}

export function unavailableError(message: string, opts?: FactoryOpts): ToolError {
  return new ToolError(message, { code: 'UNAVAILABLE', retryable: true, ...opts });
}

export function validationError(message: string, opts?: FactoryOpts): ToolError {
  return new ToolError(message, { code: 'VALIDATION_ERROR', retryable: false, ...opts });
}
