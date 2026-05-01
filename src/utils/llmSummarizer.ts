/**
 * LLM-based summarization service for oversized responses.
 * Provides intelligent content summarization when responses exceed size limits.
 */

import { logger } from '../logger.js';
import type { LlmConfig } from '../config.js';

interface SummarizationOptions {
  maxTokens?: number;
  temperature?: number;
  preserveStructure?: boolean;
  focus?: string;
}

interface SummarizationResult {
  summary: string;
  originalLength: number;
  summaryLength: number;
  compressionRatio: number;
  preserved: boolean;
  error?: string;
}

/**
 * Estimates token count from text (rough approximation).
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English
  return Math.ceil(text.length / 4);
}

/**
 * Truncates text to approximate token limit while preserving structure.
 */
function truncateToTokens(text: string, maxTokens: number): string {
  const estimatedTokens = estimateTokens(text);

  if (estimatedTokens <= maxTokens) {
    return text;
  }

  // Try to find a good breaking point (paragraph or sentence)
  const targetChars = maxTokens * 4;
  let breakPoint = targetChars;

  // Look for paragraph break
  const nextNewline = text.indexOf('\n\n', breakPoint - 100);
  if (nextNewline !== -1 && nextNewline < breakPoint + 100) {
    breakPoint = nextNewline;
  } else {
    // Look for sentence end
    const sentenceEnd = text.slice(breakPoint - 50).search(/[.!?]\s+/);
    if (sentenceEnd !== -1 && sentenceEnd < breakPoint + 50) {
      breakPoint = sentenceEnd + 1;
    }
  }

  return text.substring(0, breakPoint) + '\n\n[Content truncated due to length...]';
}

/**
 * Summarizes content using LLM if available, otherwise uses truncation.
 */
export async function summarizeContent(
  content: string,
  llmConfig: LlmConfig | undefined,
  options: SummarizationOptions = {},
): Promise<SummarizationResult> {
  const { maxTokens = 4000, temperature = 0.3, preserveStructure = true, focus } = options;

  const originalLength = content.length;

  // If content is already within limits, no summarization needed
  if (estimateTokens(content) <= maxTokens) {
    return {
      summary: content,
      originalLength,
      summaryLength: originalLength,
      compressionRatio: 1,
      preserved: true,
    };
  }

  // If no LLM configured, use truncation
  if (!llmConfig?.baseUrl || !llmConfig.apiToken) {
    logger.debug('No LLM configured for summarization, using truncation');
    const truncated = truncateToTokens(content, maxTokens);

    return {
      summary: truncated,
      originalLength,
      summaryLength: truncated.length,
      compressionRatio: truncated.length / originalLength,
      preserved: false,
      error: 'LLM not configured - content truncated instead of summarized',
    };
  }

  // Attempt LLM-based summarization
  try {
    const prompt = buildSummarizationPrompt(content, maxTokens, focus);
    const summary = await callLlm(llmConfig, prompt, maxTokens, temperature);

    return {
      summary,
      originalLength,
      summaryLength: summary.length,
      compressionRatio: summary.length / originalLength,
      preserved: preserveStructure,
    };
  } catch (error) {
    logger.warn({ error }, 'LLM summarization failed, falling back to truncation');

    const truncated = truncateToTokens(content, maxTokens);

    return {
      summary: truncated,
      originalLength,
      summaryLength: truncated.length,
      compressionRatio: truncated.length / originalLength,
      preserved: false,
      error: `LLM summarization failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Builds a summarization prompt for the LLM.
 */
function buildSummarizationPrompt(content: string, maxTokens: number, focus?: string): string {
  const focusInstruction = focus ? ` Focus on aspects related to: ${focus}.` : '';

  return `Please provide a comprehensive summary of the following web content. 
Aim for approximately ${String(Math.floor(maxTokens * 0.75))} words.
Preserve the key information, main arguments, and important details.${focusInstruction}

If the content includes structured data (tables, lists, code), preserve the structure in your summary.

Content to summarize:
---
${content}
---

Summary:`;
}

/**
 * Calls the LLM with the given prompt.
 */
async function callLlm(
  config: LlmConfig,
  prompt: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  // Caller (summarizeText) already guards apiToken — narrow for TS
  if (!config.apiToken) {
    throw new Error('llmSummarizer: apiToken required but not provided');
  }
  const apiToken: string = config.apiToken;
  const endpoint = config.baseUrl.replace(/\/$/, '') + '/v1/chat/completions';

  const body = {
    model: config.provider || 'default',
    messages: [
      {
        role: 'system',
        content:
          'You are a helpful assistant that summarizes web content accurately and comprehensively.',
      },
      { role: 'user', content: prompt },
    ],
    max_tokens: maxTokens,
    temperature: temperature,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`LLM API error: ${String(response.status)} - ${error}`);
  }

  const data = (await response.json()) as {
    choices?: [{ message?: { content?: string } }];
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM response missing content');
  }

  return content;
}

/**
 * Checks if LLM summarization is available.
 */
export function isLlmSummarizationAvailable(config: LlmConfig | undefined): boolean {
  return !!config && !!config.baseUrl && !!config.apiToken;
}
