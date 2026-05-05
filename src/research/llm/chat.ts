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

const REQUEST_TIMEOUT_MS = 60_000;
const ORCHESTRATOR_DEFAULT_TEMPERATURE = 0.7;
const WORKER_DEFAULT_TEMPERATURE = 0.3;
const MAX_RETRIES = 1;

// ── Token estimation ─────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token for English text. */
function estimateTokens(text: string): number {
   return Math.ceil(text.length / 4);
}

// ── Client ────────────────────────────────────────────────────────────────────

export class DeepResearchLlmClient {
   private readonly baseUrl: string;
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

      // Direct parse
      try {
         const data = JSON.parse(response.content);
         return { success: true, data, response };
      } catch {
         // Fallback: extract JSON from markdown code blocks
         const jsonMatch = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(response.content);
         if (jsonMatch?.[1]) {
            try {
               const data = JSON.parse(jsonMatch[1]);
               return { success: true, data, response };
            } catch {
               // fall through to parseError
            }
         }

         return {
            success: false,
            response,
            parseError: 'Failed to parse JSON from response content',
         };
      }
   }
   /**
    * Call orchestrator model with worker model fallback.
    * Tries orchestrator first; on failure, tries the cheaper worker model.
    * Returns the first successful response, or the last failure if both fail.
    */
   async callWithFallback(options: LlmCallOptions): Promise<LlmResponse> {
      const orchestratorResult = await this.callOrchestrator(options)
      if (orchestratorResult.success) {
         return orchestratorResult
      }
      logger.warn(
         { error: orchestratorResult.error },
         'Orchestrator LLM call failed, falling back to worker model',
      )
      const workerResult = await this.callWorker(options)
      if (workerResult.success) {
         return workerResult
      }
      logger.warn(
         { error: workerResult.error },
         'Worker LLM call also failed',
      )
      return workerResult
   }

   /**
    * Call orchestrator JSON with worker fallback.
    * Tries orchestrator JSON first; on failure, tries the cheaper worker model.
    * Returns the first successful JSON parse, or the last failure if both fail.
    */
   // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- used by callers for return type inference
   async callJSONWithFallback<T>(
      options: LlmCallOptions,
   ): Promise<
      | { success: true; data: T; response: LlmResponse }
      | { success: false; response: LlmResponse; parseError?: string }
   > {
      const orchestratorResult = await this.callJSON<T>({ ...options, model: 'orchestrator' });
      if (orchestratorResult.success) {
         return orchestratorResult;
      }
      logger.warn(
         { error: orchestratorResult.response.error },
         'Orchestrator JSON call failed, falling back to worker model',
      );
      const workerResult = await this.callJSON<T>({ ...options, model: 'worker' });
      if (workerResult.success) {
         return workerResult;
      }
      logger.warn(
         { error: workerResult.response.error },
         'Worker JSON call also failed',
      );
      return workerResult;
   }


   // ── Internal ──────────────────────────────────────────────────────────────

   /**
    * Core HTTP call with retry logic.
    *
    * Retry policy:
    *   - 429 (rate limit): retry once after 1 000 ms
    *   - 5xx (server error): retry once after 500 ms
    *   - Network error: retry once after 500 ms
    * All other statuses return immediately with `success: false`.
    */
   private async callModel(
      model: string,
      options: LlmCallOptions,
      temperature: number,
   ): Promise<LlmResponse> {
      const startTime = Date.now();
      const endpoint = `${this.baseUrl}/v1/chat/completions`;

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
            assertSafeUrl(endpoint, true);
            const headers: Record<string, string> = {
               'Content-Type': 'application/json',
               ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
            };

            const controller = new AbortController();
            const timeout = setTimeout(() => {
               controller.abort();
            }, REQUEST_TIMEOUT_MS);

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
            }

            if (!response.ok) {
               const status = response.status;
               const errorText = await response.text().catch(() => '');

               // Retry once on rate-limit or server errors
               if (attempt < MAX_RETRIES && (status === 429 || status >= 500)) {
                  const delay = status === 429 ? 1000 : 500;
                  logger.warn({ status, attempt, delay }, 'LLM request returned error; retrying');
                  await new Promise((resolve) => setTimeout(resolve, delay));
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
            if (!isLastAttempt) {
               logger.warn({ err }, 'LLM request threw; retrying once');
               await new Promise((resolve) => setTimeout(resolve, 500));
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
