import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resetConfig } from '../src/config.js';

const LLM_ENV_KEYS = [
  'LLM_PROVIDER',
  'LLM_API_TOKEN',
  'LLM_BASE_URL',
  'SEARCH_MCP_CONFIG_KEY',
  'SEARCH_BACKEND',
  'EXA_API_KEY',
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of LLM_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetConfig();
});

afterEach(() => {
  for (const key of LLM_ENV_KEYS) {
    const prior = saved.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  resetConfig();
});

test('loadConfig picks up LLM_PROVIDER and LLM_API_TOKEN from env', () => {
  process.env.LLM_PROVIDER = 'openai/gpt-4o';
  process.env.LLM_API_TOKEN = 'sk-test123';
  resetConfig();
  const cfg = loadConfig();

  assert.equal(cfg.llm.provider, 'openai/gpt-4o');
  assert.equal(cfg.llm.apiToken, 'sk-test123');
});

test('loadConfig defaults llm provider, apiToken, and baseUrl to empty string when env vars missing', () => {
  const cfg = loadConfig();
  assert.equal(cfg.llm.provider, '');
  assert.equal(cfg.llm.apiToken, '');
  assert.equal(cfg.llm.baseUrl, '');
});

test('loadConfig partial env: only LLM_PROVIDER set falls back to defaults for apiToken and baseUrl', () => {
  process.env.LLM_PROVIDER = 'openai/gpt-4o';
  resetConfig();
  const cfg = loadConfig();

  assert.equal(cfg.llm.provider, 'openai/gpt-4o');
  assert.equal(cfg.llm.apiToken, '');
  assert.equal(cfg.llm.baseUrl, '');
});

test('loadConfig partial env: only LLM_API_TOKEN set falls back to defaults for provider and baseUrl', () => {
  process.env.LLM_API_TOKEN = 'sk-test123';
  resetConfig();
  const cfg = loadConfig();

  assert.equal(cfg.llm.provider, '');
  assert.equal(cfg.llm.apiToken, 'sk-test123');
  assert.equal(cfg.llm.baseUrl, '');
});

test('loadConfig picks up LLM_BASE_URL from env', () => {
  process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
  resetConfig();
  const cfg = loadConfig();

  assert.equal(cfg.llm.baseUrl, 'http://localhost:11434/v1');
});

test('loadConfig picks up all LLM env vars together', () => {
  process.env.LLM_PROVIDER = 'openai/gpt-4o';
  process.env.LLM_API_TOKEN = 'sk-test123';
  process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
  resetConfig();
  const cfg = loadConfig();

  assert.equal(cfg.llm.provider, 'openai/gpt-4o');
  assert.equal(cfg.llm.apiToken, 'sk-test123');
  assert.equal(cfg.llm.baseUrl, 'http://localhost:11434/v1');
});

test('resetConfig clears cached config so env changes are picked up', () => {
  process.env.LLM_PROVIDER = 'openai/gpt-4o';
  process.env.LLM_API_TOKEN = 'sk-test123';
  resetConfig();
  const cfg1 = loadConfig();
  assert.equal(cfg1.llm.provider, 'openai/gpt-4o');

  process.env.LLM_PROVIDER = 'anthropic/claude-3';
  resetConfig();
  const cfg2 = loadConfig();
  assert.equal(cfg2.llm.provider, 'anthropic/claude-3');
});

test('loadConfig supports Exa search backend and API key from env', () => {
  process.env.SEARCH_BACKEND = 'exa';
  process.env.EXA_API_KEY = 'exa-test-key';
  resetConfig();
  const cfg = loadConfig();

  assert.equal(cfg.searchBackend, 'exa');
  assert.equal(cfg.exa.apiKey, 'exa-test-key');
});
