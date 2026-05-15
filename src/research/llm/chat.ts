/**
 * V4.0.0 Deep Research — LLM chat client.
 *
 * OpenAI-compatible HTTP client with model routing between an expensive
 * orchestrator model (planning, evaluation, synthesis) and a cheap worker
 * model (extraction, classification).
 * `{ success: false, error: <string> }` — never throws.
 */

import { logger } from '../../logger.js';
import { assertSafeUrl, safeResponseJson } from '../../httpGuards.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LlmClientConfig {
  baseUrl: string;
  /** Optional separate base URL for the worker model. Falls back to baseUrl if not set. */
  workerBaseUrl?: string;
  /** Orchestrator model name (mid-tier: planning, evaluation, synthesis). */
  model: string;
  /** Worker model name (cheap: extraction, classification). */
  workerModel: string;
  /** Optional API token for authenticated endpoints. */
  apiToken?: string;
}

export interface LlmCallOptions {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  /** Default 0.7 for orchestrator, 0.3 for worker. */
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object';
  /** AbortSignal to cancel in-flight requests. Merged with the internal timeout. */
  signal?: AbortSignal;
  /** Total logical call timeout in ms. Defaults to REQUEST_TIMEOUT_MS (300s / 5 min). */
  timeoutMs?: number;
}

export interface LlmResponse {
  content: string;
  model: string;
  /** Estimated token count (content.length / 4 heuristic). */
  tokensUsed: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

/**
 * Budget callback contract.
 * `recordTokens` is called after each successful completion with the estimated
 * total tokens. Return `false` to signal the budget is exhausted.
 */
export interface TokenBudget {
  recordTokens(count: number): boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Default logical call timeout (can be overridden per-call via LlmCallOptions.timeoutMs). */
const REQUEST_TIMEOUT_MS = 300_000; // 5 minutes
const ORCHESTRATOR_DEFAULT_TEMPERATURE = 0.7;
const WORKER_DEFAULT_TEMPERATURE = 0.3;
const MAX_RETRIES = 8;
/** Base delay for exponential backoff in ms. */
const RETRY_BASE_DELAY_MS = 1_000;
/** Cap on exponential backoff delay in ms. */
const RETRY_MAX_DELAY_MS = 60_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Compute exponential backoff delay: min(base * 2^attempt, maxDelay). */
function backoffDelay(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
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

// ── Token estimation ─────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token for English text. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Client ────────────────────────────────────────────────────────────────────

export class DeepResearchLlmClient {
  private readonly baseUrl: string;
  private readonly workerBaseUrl: string;
  private readonly model: string;
  private readonly workerModel: string;
  private readonly apiToken: string | undefined;
  private readonly budget: TokenBudget | undefined;

  constructor(config: LlmClientConfig, budget?: TokenBudget) {
    // Normalize: strip trailing slashes and any /v1 or /v1/chat/completions
    // suffix, since we always append /v1/chat/completions to form the endpoint.
    this.baseUrl = config.baseUrl
      .replace(/\/+$/, '')
      .replace(/\/v1\/chat\/completions$/, '')
      .replace(/\/v1$/, '');
    this.workerBaseUrl = (config.workerBaseUrl ?? config.baseUrl)
      .replace(/\/+$/, '')
      .replace(/\/v1\/chat\/completions$/, '')
      .replace(/\/v1$/, '');
    this.model = config.model;
    this.workerModel = config.workerModel;
    this.apiToken = config.apiToken;
    this.budget = budget;
  }

  /**
   * Call the orchestrator model (mid-tier: planning, evaluation, synthesis).
   * Default temperature: 0.7.
   */
  async callOrchestrator(options: LlmCallOptions): Promise<LlmResponse> {
    return this.callModel(
      this.model,
      options,
      options.temperature ?? ORCHESTRATOR_DEFAULT_TEMPERATURE,
    );
  }

  /**
   * Call the worker model (cheap: extraction, classification).
   * Default temperature: 0.3.
   */
  async callWorker(options: LlmCallOptions): Promise<LlmResponse> {
    return this.callModel(
      this.workerModel,
      options,
      options.temperature ?? WORKER_DEFAULT_TEMPERATURE,
      this.workerBaseUrl,
    );
  }

  /**
   * Call either model and parse JSON from the response.
   *
   * First attempts a direct `JSON.parse`. On failure, searches for a JSON
   * block within markdown code fences. Returns the parsed data alongside the
   * raw `LlmResponse`.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- used by callers for return type inference
  async callJSON<T>(
    options: LlmCallOptions & { model: 'orchestrator' | 'worker' },
  ): Promise<
    | { success: true; data: T; response: LlmResponse }
    | { success: false; response: LlmResponse; parseError?: string }
  > {
    const callFn =
      options.model === 'orchestrator'
        ? this.callOrchestrator.bind(this)
        : this.callWorker.bind(this);

    const { model: _, ...callOptions } = options;

    const response = await callFn({
      ...callOptions,
      responseFormat: 'json_object' as const,
    });

    if (!response.success) {
      return { success: false, response };
    }

    // ── Guiding Parsers ──────────────────────────────────────────────────

    // Attempt 1: Direct parse
    try {
      const data = JSON.parse(response.content) as T;
      return { success: true, data, response };
    } catch {
      // Attempt 2: Extract JSON from markdown code blocks or loose braces
      const jsonMatch =
        /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(response.content) ??
        /(\{[\s\S]*\})/.exec(response.content);

      if (jsonMatch?.[1]) {
        try {
          const data = JSON.parse(jsonMatch[1]) as T;
          return { success: true, data, response };
        } catch {
          // fall through
        }
      }

      // Attempt 3: If no JSON structure can be retrieved, return success: false
      // This protects callers from type-errors while still providing raw content in result.response.
      logger.warn('LLM returned non-JSON content');
      return {
        success: false,
        response,
        parseError: 'LLM returned non-JSON content',
      };
    }
  }
  /**
   * Call orchestrator with one retry.
   */
  async callWithFallback(options: LlmCallOptions): Promise<LlmResponse> {
    const result = await this.callOrchestrator(options);
    if (result.success) return result;

    logger.warn({ error: result.error }, 'Primary LLM call failed, retrying once...');
    return this.callOrchestrator(options);
  }

  /**
   * Call JSON with one retry.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- used by callers for return type inference
  async callJSONWithFallback<T>(
    options: LlmCallOptions,
  ): Promise<
    | { success: true; data: T; response: LlmResponse }
    | { success: false; response: LlmResponse; parseError?: string }
  > {
    const result = await this.callJSON<T>({ ...options, model: 'orchestrator' });
    if (result.success) return result;

    logger.warn(
      { error: result.parseError ?? result.response.error ?? 'Unknown parse error' },
      'Primary JSON call failed, retrying once...',
    );
    return this.callJSON<T>({ ...options, model: 'orchestrator' });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Core HTTP call with retry logic.
   *
   * Retry policy:
   *   - Up to 8 retries with exponential backoff (1s, 2s, 4s, …, 60s cap).
   *   - Retries on: 408/409/425/429/5xx/network errors.
   *   - Total logical call timeout: 5 minutes (300s), including retries/backoff.
   * All other statuses return immediately with `success: false`.
   */
  private async callModel(
    model: string,
    options: LlmCallOptions,
    temperature: number,
    baseUrl?: string,
  ): Promise<LlmResponse> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const deadline = startTime + timeoutMs;
    const endpoint = `${baseUrl ?? this.baseUrl}/v1/chat/completions`;
    logger.info(
      { endpoint, model, baseUrl, hasWorkerBaseUrl: !!this.workerBaseUrl },
      'LLM callModel endpoint debug',
    );

    const promptTokens = options.messages.reduce(
      (sum, msg) => sum + estimateTokens(msg.content),
      0,
    );

    const body: Record<string, unknown> = {
      model,
      messages: options.messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature,
    };

    // Only include response_format when explicitly requested — avoids
    // OpenAI schema errors when the model does not support it.
    if (options.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' };
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          const durationMs = Date.now() - startTime;
          return {
            content: '',
            model,
            tokensUsed: 0,
            durationMs,
            success: false,
            error: `LLM request timed out after ${String(timeoutMs)}ms`,
          };
        }

        assertSafeUrl(endpoint, true);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort(new Error('LLM request timed out'));
        }, remainingMs);

        // Merge external abort signal with local timeout
        const externalSignal = options.signal;
        let abortListener: (() => void) | undefined;
        if (externalSignal) {
          if (externalSignal.aborted) {
            controller.abort(externalSignal.reason);
          } else {
            abortListener = () => {
              controller.abort(externalSignal.reason);
            };
            externalSignal.addEventListener('abort', abortListener, { once: true });
          }
        }

        let response: Response | undefined;
        try {
          response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
          if (abortListener && externalSignal) {
            externalSignal.removeEventListener('abort', abortListener);
          }
        }

        if (!response.ok) {
          const status = response.status;
          const errorText = await response.text().catch(() => '');

          // Retry with exponential backoff on transient gateway, rate-limit, or server errors.
          if (attempt < MAX_RETRIES && RETRYABLE_HTTP_STATUSES.has(status)) {
            const delay = Math.min(backoffDelay(attempt), Math.max(0, deadline - Date.now()));
            logger.warn({ status, attempt, delay }, 'LLM request returned error; retrying with backoff');
            try {
              await sleep(delay, options.signal);
            } catch (err) {
              const durationMs = Date.now() - startTime;
              return {
                content: '',
                model,
                tokensUsed: 0,
                durationMs,
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
            continue;
          }

          const durationMs = Date.now() - startTime;
          return {
            content: '',
            model,
            tokensUsed: 0,
            durationMs,
            success: false,
            error: `HTTP ${String(status)}: ${errorText.slice(0, 500)}`,
          };
        }

        const data = (await safeResponseJson(response, endpoint)) as {
          choices?: [{ message?: { content?: string } }];
        };
        const rawContent = data.choices?.[0]?.message?.content ?? '';

        const completionTokens = estimateTokens(rawContent);
        const totalTokens = promptTokens + completionTokens;

        // Note: recordTokens() return value (false=exhausted) is intentionally not checked here — the caller pre-checks budget via isExhausted() before calling.
        this.budget?.recordTokens(totalTokens);

        const durationMs = Date.now() - startTime;
        return {
          content: rawContent,
          model,
          tokensUsed: totalTokens,
          durationMs,
          success: true,
        };
      } catch (err) {
        const isLastAttempt = attempt >= MAX_RETRIES;
        if (!isLastAttempt && !options.signal?.aborted) {
          const delay = Math.min(backoffDelay(attempt), Math.max(0, deadline - Date.now()));
          logger.warn({ err, attempt, delay }, 'LLM request threw; retrying with backoff');
          try {
            await sleep(delay, options.signal);
          } catch (sleepErr) {
            const durationMs = Date.now() - startTime;
            return {
              content: '',
              model,
              tokensUsed: 0,
              durationMs,
              success: false,
              error: sleepErr instanceof Error ? sleepErr.message : String(sleepErr),
            };
          }
          continue;
        }

        const durationMs = Date.now() - startTime;
        return {
          content: '',
          model,
          tokensUsed: 0,
          durationMs,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Unreachable — both paths in the loop return or continue.
    const durationMs = Date.now() - startTime;
    return {
      content: '',
      model,
      tokensUsed: 0,
      durationMs,
      success: false,
      error: 'Unexpected exit from retry loop',
    };
  }
}
