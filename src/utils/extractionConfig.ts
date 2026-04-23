import { z } from 'zod/v4';
import { validationError } from '../errors.js';

export const REGEX_PATTERNS = [
  'email', 'phone-international', 'phone-us', 'url', 'ipv4', 'ipv6',
  'uuid', 'currency', 'percentage', 'number', 'date-iso', 'date-us',
  'time-24h', 'postal-us', 'postal-uk', 'hex-color', 'twitter-handle',
  'hashtag', 'mac-address', 'iban', 'credit-card', 'all',
] as const;

export type RegexPattern = (typeof REGEX_PATTERNS)[number];

// Verified against Crawl4AI RegexExtractionStrategy._B IntFlag (v0.8.x)
export const REGEX_BITFLAGS: Record<RegexPattern, number> = {
  email: 1,
  'phone-international': 2,
  'phone-us': 4,
  url: 8,
  ipv4: 16,
  ipv6: 32,
  uuid: 64,
  currency: 128,
  percentage: 256,
  number: 512,
  'date-iso': 1024,
  'date-us': 2048,
  'time-24h': 4096,
  'postal-us': 8192,
  'postal-uk': 16384,
  'hex-color': 32768,
  'twitter-handle': 65536,
  hashtag: 131072,
  'mac-address': 262144,
  iban: 524288,
  'credit-card': 1048576,
  all: 2097151, // bitwise OR of all individual flags
};

export type CssSchemaConfig = z.infer<typeof cssSchemaSchema>;
export type XpathSchemaConfig = z.infer<typeof xpathSchemaSchema>;
export type RegexConfig = z.infer<typeof regexSchema>;
export type LlmExtractionConfig = z.infer<typeof llmSchema>;
export type ExtractionConfig = z.infer<typeof singleExtractionConfigSchema>;

// Zod schemas for server.ts tool registration
export const cssSchemaSchema = z.object({
  type: z.literal('css_schema'),
  schema: z.object({
    name: z.string(),
    baseSelector: z.string(),
    fields: z.array(z.record(z.string(), z.unknown())),
  }),
});

export const xpathSchemaSchema = z.object({
  type: z.literal('xpath_schema'),
  schema: z.object({
    name: z.string(),
    baseSelector: z.string(),
    fields: z.array(z.record(z.string(), z.unknown())),
  }),
});

export const regexSchema = z.object({
  type: z.literal('regex'),
  patterns: z.array(z.enum(REGEX_PATTERNS)).optional(),
  customPatterns: z.record(z.string(), z.string()).optional(),
});

export const llmSchema = z.object({
  type: z.literal('llm'),
  instruction: z.string().min(1),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  llmProvider: z.string().optional(),
});

export const singleExtractionConfigSchema = z.union([
  cssSchemaSchema,
  xpathSchemaSchema,
  regexSchema,
  llmSchema,
]);

// Crawl4AI only accepts a single extraction strategy per request.
// Arrays can be added later without a type-level breaking change.
export const extractionConfigSchema = singleExtractionConfigSchema;

export function validateExtractionConfig(
  config: ExtractionConfig,
  serverLlm?: { provider: string; apiToken: string },
): void {
  if (config.type === 'css_schema' || config.type === 'xpath_schema') {
    if (!config.schema.baseSelector || config.schema.baseSelector.trim().length === 0) {
      throw validationError(`${config.type} extractionConfig requires schema.baseSelector`);
    }
    if (!Array.isArray(config.schema.fields) || config.schema.fields.length === 0) {
      throw validationError(`${config.type} extractionConfig requires schema.fields array with at least one field`);
    }
  }

  if (config.type === 'regex') {
    const hasPatterns = config.patterns !== undefined && config.patterns.length > 0;
    const hasCustom = config.customPatterns !== undefined && Object.keys(config.customPatterns).length > 0;
    if (!hasPatterns && !hasCustom) {
      throw validationError('regex extractionConfig requires at least one of patterns or customPatterns');
    }
  }

  if (config.type === 'llm') {
    if (!config.instruction || config.instruction.trim().length === 0) {
      throw validationError('llm extractionConfig requires a non-empty instruction');
    }
    const provider = config.llmProvider ?? serverLlm?.provider ?? '';
    if (!provider) {
      throw validationError('llm extractionConfig requires llmProvider (tool param) or LLM_PROVIDER env var');
    }
    if (!serverLlm?.apiToken) {
      throw validationError('llm extractionConfig requires LLM_API_TOKEN env var (not accepted as tool parameter)');
    }
  }
}

export function mapToCrawl4ai(
  config: ExtractionConfig,
  resolvedLlm?: { provider: string; apiToken: string },
): unknown {
  switch (config.type) {
    case 'css_schema':
      return {
        type: 'JsonCssExtractionStrategy',
        params: { schema: config.schema },
      };
    case 'xpath_schema':
      return {
        type: 'JsonXPathExtractionStrategy',
        params: { schema: config.schema },
      };
    case 'regex': {
      let bitflag = 0;
      if (config.patterns) {
        for (const p of config.patterns) {
          bitflag |= REGEX_BITFLAGS[p];
        }
      }
      return {
        type: 'RegexExtractionStrategy',
        params: {
          pattern: bitflag,
          custom: config.customPatterns ?? {},
        },
      };
    }
    case 'llm': {
      const provider = config.llmProvider ?? resolvedLlm?.provider ?? '';
      const apiToken = resolvedLlm?.apiToken;
      return {
        type: 'LLMExtractionStrategy',
        params: {
          instruction: config.instruction,
          schema: config.outputSchema,
          llm_config: {
            provider,
            api_token: apiToken,
          },
        },
      };
    }
  }
}
