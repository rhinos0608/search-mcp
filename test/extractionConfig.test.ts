import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapToCrawl4ai,
  validateExtractionConfig,
  REGEX_BITFLAGS,
} from '../src/utils/extractionConfig.js';

test('mapToCrawl4ai maps css_schema correctly', () => {
  const config = {
    type: 'css_schema' as const,
    schema: {
      name: 'Jobs',
      baseSelector: 'article.job',
      fields: [{ name: 'title', selector: 'h2', type: 'text' }],
    },
  };
  const mapped = mapToCrawl4ai(config);
  assert.deepEqual(mapped, {
    type: 'JsonCssExtractionStrategy',
    params: {
      schema: config.schema,
    },
  });
});

test('mapToCrawl4ai maps regex with single pattern to correct bitflag', () => {
  const config: { type: 'regex'; patterns: Array<'email' | 'url'> } = {
    type: 'regex' as const,
    patterns: ['email', 'url'],
  };
  const mapped = mapToCrawl4ai(config) as { type: string; params: { pattern: number; custom: Record<string, string> } };
  assert.equal(mapped.type, 'RegexExtractionStrategy');
  assert.equal(mapped.params.pattern, REGEX_BITFLAGS.email | REGEX_BITFLAGS.url);
  assert.deepEqual(mapped.params.custom, {});
});

test('mapToCrawl4ai maps regex with customPatterns only (no built-in patterns)', () => {
  const config = {
    type: 'regex' as const,
    customPatterns: { price: '\\$\\d+' },
  };
  const mapped = mapToCrawl4ai(config) as { type: string; params: { pattern: number; custom: Record<string, string> } };
  assert.equal(mapped.type, 'RegexExtractionStrategy');
  assert.equal(mapped.params.pattern, 0);
  assert.equal(mapped.params.custom.price, '\\$\\d+');
});

test('mapToCrawl4ai maps llm config with resolved provider and token', () => {
  const config = {
    type: 'llm' as const,
    instruction: 'Extract all jobs',
    outputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  };
  const mapped = mapToCrawl4ai(config, { provider: 'openai/gpt-4o', apiToken: 'sk-test' });
  assert.deepEqual(mapped, {
    type: 'LLMExtractionStrategy',
    params: {
      instruction: 'Extract all jobs',
      schema: { type: 'object', properties: { title: { type: 'string' } } },
      llm_config: {
        provider: 'openai/gpt-4o',
        api_token: 'sk-test',
      },
    },
  });
});

test('mapToCrawl4ai maps llm config with baseUrl for local providers', () => {
  const config = {
    type: 'llm' as const,
    instruction: 'Extract all jobs',
  };
  const mapped = mapToCrawl4ai(config, { provider: 'ollama/llama3', apiToken: '', baseUrl: 'http://localhost:11434/v1' });
  assert.deepEqual(mapped, {
    type: 'LLMExtractionStrategy',
    params: {
      instruction: 'Extract all jobs',
      schema: undefined,
      llm_config: {
        provider: 'ollama/llama3',
        base_url: 'http://localhost:11434/v1',
      },
    },
  });
});

test('mapToCrawl4ai prefers per-request llmBaseUrl over server fallback', () => {
  const config = {
    type: 'llm' as const,
    instruction: 'Extract all jobs',
    llmBaseUrl: 'http://override.local:8000/v1',
  };
  const mapped = mapToCrawl4ai(config, { provider: 'openai/gpt-4o', apiToken: 'sk-test', baseUrl: 'http://server.local:8000/v1' });
  assert.deepEqual(mapped, {
    type: 'LLMExtractionStrategy',
    params: {
      instruction: 'Extract all jobs',
      schema: undefined,
      llm_config: {
        provider: 'openai/gpt-4o',
        api_token: 'sk-test',
        base_url: 'http://override.local:8000/v1',
      },
    },
  });
});

test('validateExtractionConfig throws for regex with neither patterns nor customPatterns', () => {
  assert.throws(
    () => validateExtractionConfig({ type: 'regex' }),
    /regex extractionConfig requires at least one of patterns or customPatterns/,
  );
});

test('validateExtractionConfig throws for llm without provider or server config', () => {
  assert.throws(
    () => validateExtractionConfig({ type: 'llm', instruction: 'test' }),
    /llm extractionConfig requires llmProvider/,
  );
});

test('validateExtractionConfig throws for llm without api token and no baseUrl', () => {
  assert.throws(
    () => validateExtractionConfig({ type: 'llm', instruction: 'test', llmProvider: 'openai/gpt-4o' }),
    /LLM_API_TOKEN/,
  );
});

test('validateExtractionConfig passes for llm with baseUrl but no apiToken (local provider)', () => {
  assert.doesNotThrow(() =>
    validateExtractionConfig(
      { type: 'llm', instruction: 'test', llmProvider: 'ollama/llama3' },
      { provider: '', apiToken: '', baseUrl: 'http://localhost:11434/v1' },
    ),
  );
});

test('validateExtractionConfig passes for llm with per-request llmBaseUrl only', () => {
  assert.doesNotThrow(() =>
    validateExtractionConfig(
      { type: 'llm', instruction: 'test', llmProvider: 'ollama/llama3', llmBaseUrl: 'http://localhost:11434/v1' },
    ),
  );
});

test('validateExtractionConfig passes for css_schema with valid schema', () => {
  assert.doesNotThrow(() =>
    validateExtractionConfig({
      type: 'css_schema',
      schema: { name: 'Test', baseSelector: 'div', fields: [{ name: 'x', selector: 'p' }] },
    }),
  );
});

test('mapToCrawl4ai maps xpath_schema correctly', () => {
  const config = {
    type: 'xpath_schema' as const,
    schema: {
      name: 'Items',
      baseSelector: '//div[@class="item"]',
      fields: [{ name: 'title', selector: 'h2', type: 'text' }],
    },
  };
  const mapped = mapToCrawl4ai(config);
  assert.deepEqual(mapped, {
    type: 'JsonXPathExtractionStrategy',
    params: {
      schema: config.schema,
    },
  });
});

test('validateExtractionConfig throws for xpath_schema with empty baseSelector', () => {
  assert.throws(
    () =>
      validateExtractionConfig({
        type: 'xpath_schema',
        schema: { name: 'Test', baseSelector: '', fields: [{ name: 'x', selector: 'p' }] },
      }),
    /xpath_schema extractionConfig requires schema\.baseSelector/,
  );
});