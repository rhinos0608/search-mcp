import { assertSafeUrl } from '../httpGuards.js';

export type OpenAiChatRole = 'system' | 'user' | 'assistant';

export interface OpenAiChatMessage {
  role: OpenAiChatRole;
  content: string;
}

export interface OpenAiChatCompletionOptions {
  baseUrl: string;
  model: string;
  messages: OpenAiChatMessage[];
  apiToken?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json_object';
  /** Total wall-clock budget for one logical call, including retries and backoff. */
  totalTimeoutMs?: number;
  /** Number of retries after the first attempt. */
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffMultiplier?: number;
  signal?: AbortSignal;
  /** LLM endpoints are operator-configured and commonly point at localhost. */
  allowInternalUrls?: boolean;
}

export interface OpenAiChatCompletionResult {
  content: string;
  success: boolean;
  attempts: number;
  durationMs: number;
  status?: number;
  error?: string;
}

export const LLM_DEFAULT_TOTAL_TIMEOUT_MS = 300_000;
export const LLM_DEFAULT_MAX_RETRIES = 8;
export const LLM_DEFAULT_INITIAL_BACKOFF_MS = 1_000;
export const LLM_DEFAULT_MAX_BACKOFF_MS = 30_000;
export const LLM_DEFAULT_BACKOFF_MULTIPLIER = 2;

export const LLM_RETRYABLE_HTTP_STATUSES = new Set([
  408,
  409,
  425,
  429,
  500,
  502,
  503,
  504,
]);

function normalizeOpenAiBaseUrl(baseUrl: string): string {
  return baseUrl
    .replace(/\/+$/, '')
    .replace(/\/v1\/chat\/completions$/u, '')
    .replace(/\/v1$/u, '');
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function retryDelayMs(
  attemptIndex: number,
  options: Required<
    Pick<
      OpenAiChatCompletionOptions,
      'initialBackoffMs' | 'maxBackoffMs' | 'backoffMultiplier'
    >
  >,
): number {
  const exponential = options.initialBackoffMs * options.backoffMultiplier ** attemptIndex;
  return Math.min(exponential, options.maxBackoffMs);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRetryableHttpStatus(status: number): boolean {
  return LLM_RETRYABLE_HTTP_STATUSES.has(status);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let abortListener: (() => void) | null = null;
    const timeout = setTimeout(() => {
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      resolve();
    }, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timeout);
      reject(new Error('LLM retry sleep aborted'));
      return;
    }
    abortListener = () => {
      clearTimeout(timeout);
      reject(new Error('LLM retry sleep aborted'));
    };
    signal.addEventListener('abort', abortListener, { once: true });
  });
}

function buildErrorResult(
  error: string,
  startedAt: number,
  attempts: number,
  status?: number,
): OpenAiChatCompletionResult {
  const result: OpenAiChatCompletionResult = {
    content: '',
    success: false,
    attempts,
    durationMs: Date.now() - startedAt,
    error,
  };
  if (status !== undefined) result.status = status;
  return result;
}

export async function callOpenAiChatCompletion(
  options: OpenAiChatCompletionOptions,
): Promise<OpenAiChatCompletionResult> {
  const totalTimeoutMs = positiveNumber(
    options.totalTimeoutMs,
    LLM_DEFAULT_TOTAL_TIMEOUT_MS,
  );
  const maxRetries = nonNegativeInteger(options.maxRetries, LLM_DEFAULT_MAX_RETRIES);
  const initialBackoffMs = nonNegativeInteger(
    options.initialBackoffMs,
    LLM_DEFAULT_INITIAL_BACKOFF_MS,
  );
  const maxBackoffMs = nonNegativeInteger(options.maxBackoffMs, LLM_DEFAULT_MAX_BACKOFF_MS);
  const backoffMultiplier = positiveNumber(
    options.backoffMultiplier,
    LLM_DEFAULT_BACKOFF_MULTIPLIER,
  );
  const maxTokens = nonNegativeInteger(options.maxTokens, 4096);
  const temperature = nonNegativeNumber(options.temperature, 0.3);
  const endpoint = `${normalizeOpenAiBaseUrl(options.baseUrl)}/v1/chat/completions`;
  const startedAt = Date.now();
  const deadline = startedAt + totalTimeoutMs;
  const maxAttempts = maxRetries + 1;
  let lastError = 'LLM call did not run';
  let lastStatus: number | undefined;

  try {
    assertSafeUrl(endpoint, options.allowInternalUrls ?? true);
  } catch (err) {
    return buildErrorResult(`Invalid LLM endpoint: ${errorMessage(err)}`, startedAt, 0);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.apiToken) {
    headers.Authorization = `Bearer ${options.apiToken}`;
  }

  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (options.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attempts = attempt + 1;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return buildErrorResult(
        `LLM call timed out after ${String(totalTimeoutMs)}ms and ${String(attempt)} attempt(s): ${lastError}`,
        startedAt,
        attempt,
        lastStatus,
      );
    }

    if (options.signal?.aborted) {
      return buildErrorResult('LLM call aborted', startedAt, attempt, lastStatus);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error('LLM request timed out'));
    }, remainingMs);
    let abortListener: (() => void) | undefined;
    if (options.signal) {
      abortListener = () => {
        controller.abort(options.signal?.reason);
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      lastStatus = response.status;
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        lastError = `LLM returned HTTP ${String(response.status)}: ${errorText.slice(0, 500)}`;
        if (!isRetryableHttpStatus(response.status) || attempt === maxAttempts - 1) {
          return buildErrorResult(lastError, startedAt, attempts, response.status);
        }
      } else {
        const data = (await response.json()) as {
          choices?: [{ message?: { content?: string } }];
        };
        const content = data.choices?.[0]?.message?.content ?? '';
        if (content) {
          return {
            content,
            success: true,
            attempts,
            durationMs: Date.now() - startedAt,
            status: response.status,
          };
        }

        lastError = 'LLM returned empty content';
        if (attempt === maxAttempts - 1) {
          return buildErrorResult(lastError, startedAt, attempts, response.status);
        }
      }
    } catch (err) {
      lastError = `LLM call failed: ${errorMessage(err)}`;
      if (attempt === maxAttempts - 1 || options.signal?.aborted) {
        return buildErrorResult(lastError, startedAt, attempts, lastStatus);
      }
    } finally {
      clearTimeout(timeout);
      if (abortListener && options.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }
    }

    const delayMs = Math.min(
      retryDelayMs(attempt, { initialBackoffMs, maxBackoffMs, backoffMultiplier }),
      Math.max(0, deadline - Date.now()),
    );
    try {
      await sleep(delayMs, options.signal);
    } catch (err) {
      return buildErrorResult(errorMessage(err), startedAt, attempts, lastStatus);
    }
  }

  return buildErrorResult(
    `LLM call failed after ${String(maxAttempts)} attempt(s): ${lastError}`,
    startedAt,
    maxAttempts,
    lastStatus,
  );
}
