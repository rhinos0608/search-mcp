/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type { Page } from 'playwright-core';
import type { ExtractionResult } from './types.js';
import { BrowserError } from './types.js';
import { logger } from '../logger.js';
import { callOpenAiChatCompletion } from '../utils/llmChat.js';
import { safeRegex } from 'safe-regex2';
import type {
  ExtractionConfig,
  CssSchemaConfig,
  XpathSchemaConfig,
  RegexConfig,
  LlmExtractionConfig,
} from '../utils/extractionConfig.js';

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Extract structured data from the current page using a schema or instruction.
 * Delegates to the appropriate strategy based on config type.
 *
 * Supports all strategy types from extractionConfig: css_schema, xpath_schema,
 * regex, and llm.
 */
export async function extractStructured(
  page: Page,
  config: ExtractionConfig,
  llmConfig?: { provider: string; apiToken: string; baseUrl?: string },
): Promise<ExtractionResult> {
  try {
    switch (config.type) {
      case 'css_schema': {
        const data = await extractCssSchema(page, config);
        return { data, success: true };
      }
      case 'xpath_schema': {
        const data = await extractXpathSchema(page, config);
        return { data, success: true };
      }
      case 'regex': {
        const text = await page.evaluate(() => document.body.innerText);
        const data = extractRegex(text, config);
        return { data, success: true };
      }
      case 'llm': {
        if (!resolveLlmProvider(config, llmConfig)) {
          return {
            data: null,
            success: false,
            warnings: ['LLM extraction requires LLM configuration (provider and apiToken)'],
          };
        }
        const html = await page.content();
        const data = await extractLlm(html, config, llmConfig);
        return { data, success: true };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, success: false, warnings: [message] };
  }
}

/**
 * Extract content from the page by natural language instruction.
 *
 * Falls back to returning raw page text when no LLM is configured.
 */
export async function extractByInstruction(
  page: Page,
  instruction: string,
  llmConfig?: { provider: string; apiToken: string; baseUrl?: string },
): Promise<ExtractionResult> {
  try {
    const hasLlm = llmConfig?.provider && llmConfig.apiToken;
    if (!hasLlm) {
      const text = await page.evaluate(() => document.body.innerText);
      return {
        data: { text: text.slice(0, 50_000) },
        success: true,
        warnings: ['LLM not configured; returning raw page text'],
      };
    }

    const html = await page.content();
    const config: LlmExtractionConfig = {
      type: 'llm',
      instruction,
      outputSchema: undefined,
    };
    const data = await extractLlm(html, config, llmConfig);
    return { data, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, success: false, warnings: [message] };
  }
}

// ──────────────────────────────────────────────
// CSS Schema strategy
// ──────────────────────────────────────────────

interface SchemaField {
  name: string;
  selector: string;
  attribute?: string;
}

async function extractCssSchema(page: Page, config: CssSchemaConfig): Promise<unknown> {
  const { baseSelector, fields } = config.schema;
  const result: Record<string, unknown> = {};

  for (const raw of fields) {
    const field = raw as unknown as SchemaField;
    const { name, selector, attribute } = field;
    if (!name || !selector) continue;

    try {
      const locator = page.locator(`${baseSelector} ${selector}`);
      const count = await locator.count();

      if (count === 0) {
        result[name] = null;
      } else if (count === 1) {
        const el = locator.first();
        result[name] = attribute ? await el.getAttribute(attribute) : await el.textContent();
      } else {
        const values: (string | null)[] = [];
        for (let i = 0; i < count; i++) {
          const el = locator.nth(i);
          values.push(attribute ? await el.getAttribute(attribute) : await el.textContent());
        }
        result[name] = values;
      }
    } catch {
      result[name] = null;
    }
  }

  return result;
}

// ──────────────────────────────────────────────
// XPath Schema strategy
// ──────────────────────────────────────────────

async function extractXpathSchema(page: Page, config: XpathSchemaConfig): Promise<unknown> {
  const { baseSelector, fields } = config.schema;
  const result: Record<string, unknown> = {};

  for (const raw of fields) {
    const field = raw as unknown as SchemaField;
    const { name, selector, attribute } = field;
    if (!name || !selector) continue;

    try {
      // Build the full XPath: baseSelector/selector
      const fullXpath = `${baseSelector}/${selector}`;

      const values: (string | null)[] = await page.evaluate(
        ({ xpath, attr }) => {
          const evaluator = (
            document as unknown as Document & {
              evaluate: (
                xpath: string,
                context: Node,
                resolver: XPathNSResolver | null,
                type: number,
                result: XPathResult | null,
              ) => XPathResult;
            }
          ).evaluate;

          const iterator = evaluator(
            xpath,
            document,
            null,
            XPathResult.ORDERED_NODE_ITERATOR_TYPE,
            null,
          );
          const results: (string | null)[] = [];
          let node: Node | null;
          while ((node = iterator.iterateNext())) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node as Element;
              results.push(attr ? el.getAttribute(attr) : (el.textContent?.trim() ?? null));
            } else {
              results.push(node.textContent?.trim() ?? null);
            }
          }
          return results;
        },
        { xpath: fullXpath, attr: attribute ?? null },
      );

      if (values.length === 0) {
        result[name] = null;
      } else if (values.length === 1) {
        result[name] = values[0];
      } else {
        result[name] = values;
      }
    } catch {
      result[name] = null;
    }
  }

  return result;
}

// ──────────────────────────────────────────────
// Regex strategy
// ──────────────────────────────────────────────

/**
 * Known regex patterns, matching the standard set from REGEX_PATTERNS.
 */
const KNOWN_PATTERNS: Record<string, string> = {
  email: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}',
  'phone-international':
    '\\+?\\d{1,4}[\\s-]?\\(?\\d{1,}?\\)?[\\s-]?\\d{1,4}[\\s-]?\\d{1,4}[\\s-]?\\d{1,9}',
  'phone-us': '\\(?\\d{3}\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4}',
  url: 'https?://[^\\s"\']+',
  ipv4: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b',
  ipv6: '\\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\\b',
  uuid: '\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b',
  currency: '\\$\\s?\\d{1,3}(?:,?\\d{3})*(?:\\.\\d{2})?',
  percentage: '\\d+(?:\\.\\d+)?%',
  number: '\\d+(?:\\.\\d+)?',
  'date-iso': '\\b\\d{4}-\\d{2}-\\d{2}\\b',
  'date-us': '\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b',
  'time-24h': '\\b\\d{2}:\\d{2}(?::\\d{2})?\\b',
  'postal-us': '\\b\\d{5}(?:-\\d{4})?\\b',
  'postal-uk': '\\b[A-Z]{1,2}\\d{1,2}[A-Z]?\\s?\\d[A-Z]{2}\\b',
  'hex-color': '#[0-9a-fA-F]{3,8}\\b',
  'twitter-handle': '@[a-zA-Z0-9_]{1,15}\\b',
  hashtag: '#[a-zA-Z0-9_]+\\b',
  'mac-address': '\\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\\b',
  iban: '[A-Z]{2}\\d{2}[A-Z0-9]{1,30}\\b',
  'credit-card': '\\b(?:\\d{4}[\\s-]?){3}\\d{4,7}\\b',
  all: '.+',
};

function extractRegex(text: string, config: RegexConfig): Record<string, string[]> {
  const patterns = config.patterns ?? [];
  const customPatterns = config.customPatterns ?? {};
  const allPatterns = { ...KNOWN_PATTERNS, ...customPatterns };
  const result: Record<string, string[]> = {};

  // If 'all' is specified, treat it as a catch-all for every known pattern
  const activePatterns = patterns.includes('all')
    ? Object.keys(KNOWN_PATTERNS).filter((k) => k !== 'all')
    : patterns;

  // Reject patterns that could cause catastrophic backtracking (ReDoS)
  const isSafeRegex = (s: string): boolean => {
    if (s.length > 500) return false;
    try {
      return safeRegex(s);
    } catch {
      return false;
    }
  };

  for (const patternName of activePatterns) {
    const reStr = allPatterns[patternName];
    if (!reStr) continue;
    // Skip unsafe patterns (ReDoS prevention)
    if (!isSafeRegex(reStr)) {
      logger.warn({ patternName }, 'Skipping unsafe regex pattern');
      continue;
    }
    try {
      const re = new RegExp(reStr, 'gi');
      const matches = text.match(re);
      if (matches && matches.length > 0) {
        result[patternName] = [...new Set(matches)]; // deduplicate
      }
    } catch {
      // skip invalid patterns
    }
  }

  return result;
}

// ──────────────────────────────────────────────
// LLM strategy
// ──────────────────────────────────────────────

/**
 * Determine the effective LLM provider string from config and fallback.
 */
function resolveLlmProvider(
  config: LlmExtractionConfig,
  llmConfig?: { provider: string; apiToken: string; baseUrl?: string },
): string | undefined {
  return config.llmProvider ?? llmConfig?.provider;
}

/**
 * Resolve the effective LLM base URL from config and fallback.
 */
function resolveLlmBaseUrl(
  config: LlmExtractionConfig,
  llmConfig?: { provider: string; apiToken: string; baseUrl?: string },
): string | undefined {
  return config.llmBaseUrl ?? llmConfig?.baseUrl;
}

/**
 * Resolve the effective API token from fallback config.
 */
function resolveApiToken(llmConfig?: {
  provider: string;
  apiToken: string;
  baseUrl?: string;
}): string | undefined {
  return llmConfig?.apiToken;
}

async function extractLlm(
  html: string,
  config: LlmExtractionConfig,
  llmConfig?: { provider: string; apiToken: string; baseUrl?: string },
): Promise<unknown> {
  const provider = resolveLlmProvider(config, llmConfig);
  const apiToken = resolveApiToken(llmConfig);
  const baseUrl = resolveLlmBaseUrl(config, llmConfig);

  if (!provider) {
    throw new BrowserError('LLM extraction requires a provider', 'ACTION_FAILED');
  }

  if (!apiToken) {
    throw new BrowserError(
      'LLM extraction requires an API token for authentication',
      'ACTION_FAILED',
    );
  }

  const response = await callOpenAiChatCompletion({
    baseUrl: baseUrl ?? 'https://api.openai.com',
    model: provider,
    apiToken,
    messages: [
      {
        role: 'system',
        content:
          'You are a data extraction assistant. Extract structured data from HTML based on the instruction. Return ONLY valid JSON — no explanation, no markdown fences.',
      },
      {
        role: 'user',
        content: `Instruction: ${config.instruction}\n\nHTML:\n${html.slice(0, 100_000)}`,
      },
    ],
    temperature: 0.3,
    maxTokens: 4096,
  });

  if (!response.success) {
    throw new Error(response.error ?? 'LLM extraction failed');
  }

  const content = response.content;

  // Attempt to parse as JSON; return raw string on failure
  try {
    return JSON.parse(content);
  } catch {
    return { raw: content };
  }
}
