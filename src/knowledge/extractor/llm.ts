/**
 * V7.0.0 — Simple fetch-based LLM client for knowledge graph extraction.
 *
 * Lightweight alternative to DeepResearchLlmClient (which is coupled to
 * budget tracking, model routing, and retry logic). This client handles
 * the basic call-and-parse pattern the extractor needs.
 */

import type { LlmConfig } from '../../config.js';
import {
  callOpenAiChatCompletion,
  LLM_DEFAULT_BACKOFF_MULTIPLIER,
  LLM_DEFAULT_INITIAL_BACKOFF_MS,
  LLM_DEFAULT_MAX_BACKOFF_MS,
  LLM_DEFAULT_MAX_RETRIES,
  LLM_DEFAULT_TOTAL_TIMEOUT_MS,
  type OpenAiChatCompletionOptions,
} from '../../utils/llmChat.js';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface SimpleLlmResponse {
  content: string;
  success: boolean;
  error?: string;
}

export type SimpleLlmCallOptions = Pick<
  OpenAiChatCompletionOptions,
  | 'totalTimeoutMs'
  | 'maxRetries'
  | 'initialBackoffMs'
  | 'maxBackoffMs'
  | 'backoffMultiplier'
  | 'maxTokens'
  | 'temperature'
  | 'signal'
>;

// ────────────────────────────────────────────────────────────────────
// Defaults
// ────────────────────────────────────────────────────────────────────

export const SIMPLE_LLM_DEFAULT_TOTAL_TIMEOUT_MS = LLM_DEFAULT_TOTAL_TIMEOUT_MS;
export const SIMPLE_LLM_DEFAULT_MAX_RETRIES = LLM_DEFAULT_MAX_RETRIES;
export const SIMPLE_LLM_DEFAULT_INITIAL_BACKOFF_MS = LLM_DEFAULT_INITIAL_BACKOFF_MS;
export const SIMPLE_LLM_DEFAULT_MAX_BACKOFF_MS = LLM_DEFAULT_MAX_BACKOFF_MS;
export const SIMPLE_LLM_DEFAULT_BACKOFF_MULTIPLIER = LLM_DEFAULT_BACKOFF_MULTIPLIER;

// ────────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────────

/**
 * Call the configured LLM with a system prompt and user message.
 *
 * Uses a simple fetch-based approach with bounded retries. A logical call
 * has a 5 minute wall-clock budget by default, including up to 8 retries
 * and exponential backoff.
 */
export async function callSimpleLlm(
  llm: LlmConfig,
  systemPrompt: string,
  userMessage: string,
  options: SimpleLlmCallOptions | number = {},
): Promise<SimpleLlmResponse> {
  const normalizedOptions: SimpleLlmCallOptions =
    typeof options === 'number' ? { totalTimeoutMs: options } : options;
  const request: OpenAiChatCompletionOptions = {
    ...normalizedOptions,
    baseUrl: llm.baseUrl,
    model: llm.provider,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  };
  if (llm.apiToken) request.apiToken = llm.apiToken;

  const result = await callOpenAiChatCompletion(request);

  if (!result.success) {
    return { content: '', success: false, error: result.error ?? 'LLM call failed' };
  }

  return { content: result.content, success: true };
}
