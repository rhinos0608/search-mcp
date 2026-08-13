import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resetConfig } from '../../src/config.js';

const ENV_KEYS = [
  'DOCUMENT_PARSING_ENABLED',
  'DOCUMENT_PARSING_MULTIMODAL',
  'DOCUMENT_PARSING_MAX_ENRICH',
] as const;

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function setEnv(key: string, value: string) {
  process.env[key] = value;
}

test('default config: documentParsing enabled, non-multimodal, maxEnrich 3', () => {
  clearEnv();
  resetConfig();
  try {
    const cfg = loadConfig();
    assert.equal(cfg.documentParsing.enabled, true);
    assert.equal(cfg.documentParsing.multimodal, false);
    assert.equal(cfg.documentParsing.maxEnrich, 3);
  } finally {
    clearEnv();
    resetConfig();
  }
});

test('env DOCUMENT_PARSING_ENABLED=false yields enabled:false', () => {
  clearEnv();
  setEnv('DOCUMENT_PARSING_ENABLED', 'false');
  resetConfig();
  try {
    const cfg = loadConfig();
    assert.equal(cfg.documentParsing.enabled, false);
  } finally {
    clearEnv();
    resetConfig();
  }
});

test('env DOCUMENT_PARSING_ENABLED=0 yields enabled:false', () => {
  clearEnv();
  setEnv('DOCUMENT_PARSING_ENABLED', '0');
  resetConfig();
  try {
    const cfg = loadConfig();
    assert.equal(cfg.documentParsing.enabled, false);
  } finally {
    clearEnv();
    resetConfig();
  }
});

test('env DOCUMENT_PARSING_ENABLED=true yields enabled:true', () => {
  clearEnv();
  setEnv('DOCUMENT_PARSING_ENABLED', 'true');
  resetConfig();
  try {
    const cfg = loadConfig();
    assert.equal(cfg.documentParsing.enabled, true);
  } finally {
    clearEnv();
    resetConfig();
  }
});

test('env DOCUMENT_PARSING_ENABLED=1 also yields enabled:true', () => {
  clearEnv();
  setEnv('DOCUMENT_PARSING_ENABLED', '1');
  resetConfig();
  try {
    const cfg = loadConfig();
    assert.equal(cfg.documentParsing.enabled, true);
  } finally {
    clearEnv();
    resetConfig();
  }
});

test('env DOCUMENT_PARSING_MAX_ENRICH overrides default maxEnrich', () => {
  clearEnv();
  setEnv('DOCUMENT_PARSING_MAX_ENRICH', '7');
  resetConfig();
  try {
    const cfg = loadConfig();
    assert.equal(cfg.documentParsing.maxEnrich, 7);
  } finally {
    clearEnv();
    resetConfig();
  }
});
