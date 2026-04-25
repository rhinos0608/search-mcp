import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getCodeEmbeddingFallbackWarning, loadConfig, resetConfig } from '../src/config.js';

const ENV_KEYS = ['EMBEDDING_CODE_MODEL', 'SEARCH_MCP_CONFIG_KEY'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetConfig();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prior = saved.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  resetConfig();
});

test('loadConfig exposes code embedding model fallback state', () => {
  const cfg = loadConfig();
  assert.equal(cfg.embeddingSidecar.codeModel, '');

  const warning = getCodeEmbeddingFallbackWarning(cfg);
  assert.ok(warning?.includes('EMBEDDING_CODE_MODEL'));
  assert.ok(warning?.includes('prose embedding model'));
});

test('loadConfig reads EMBEDDING_CODE_MODEL from env', () => {
  process.env.EMBEDDING_CODE_MODEL = 'jinaai/jina-embeddings-v2-base-code';
  resetConfig();

  const cfg = loadConfig();
  assert.equal(cfg.embeddingSidecar.codeModel, 'jinaai/jina-embeddings-v2-base-code');
  assert.equal(getCodeEmbeddingFallbackWarning(cfg), undefined);
});
