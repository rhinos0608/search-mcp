import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../../src/config/manager.js';
import { resetConfig } from '../../src/config.js';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'smcp-test-'));
}

test('first run: generates config.enc and mcpApiKey when file absent', async () => {
  const dir = makeTmpDir();
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load();
    const cfg = mgr.get();
    assert.ok(cfg.mcpApiKey, 'mcpApiKey should be generated');
    assert.equal(typeof cfg.mcpApiKey === 'string' && cfg.mcpApiKey.length > 20, true);
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(join(dir, 'config.enc')));
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env['SEARCH_MCP_CONFIG_KEY'];
    resetConfig();
  }
});

test('load: throws ConfigKeyMissingError when config.enc exists but key is absent', () => {
  const dir = makeTmpDir();
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load(); // creates config.enc
    delete process.env['SEARCH_MCP_CONFIG_KEY'];
    const mgr2 = new ConfigManager({ configDir: dir });
    assert.throws(() => mgr2.load(), /SEARCH_MCP_CONFIG_KEY/);
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env['SEARCH_MCP_CONFIG_KEY'];
    resetConfig();
  }
});

test('getRedacted: masks mcpApiKey and known secret fields', () => {
  const dir = makeTmpDir();
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load();
    const r = mgr.getRedacted();
    assert.equal((r as { mcpApiKey: string }).mcpApiKey, '•••');
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env['SEARCH_MCP_CONFIG_KEY'];
    resetConfig();
  }
});

test('update: rejects unknown top-level keys', () => {
  const dir = makeTmpDir();
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load();
    assert.throws(
      () => mgr.update({ unknownKey: { op: 'set', value: 'x' } } as never),
      /not allowed/i,
    );
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env['SEARCH_MCP_CONFIG_KEY'];
    resetConfig();
  }
});

test('update: set brave.apiKey persists after reload', () => {
  const dir = makeTmpDir();
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load();
    mgr.update({ brave: { apiKey: { op: 'set', value: 'sk-brave-test' } } });
    resetConfig();
    const mgr2 = new ConfigManager({ configDir: dir });
    mgr2.load();
    assert.equal(mgr2.get().brave.apiKey, 'sk-brave-test');
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env['SEARCH_MCP_CONFIG_KEY'];
    resetConfig();
  }
});

test('rotateApiKey: returns new key and invalidates old', () => {
  const dir = makeTmpDir();
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load();
    const oldKey = mgr.get().mcpApiKey;
    const newKey = mgr.rotateApiKey();
    assert.notEqual(newKey, oldKey);
    assert.equal(mgr.get().mcpApiKey, newKey);
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env['SEARCH_MCP_CONFIG_KEY'];
    resetConfig();
  }
});
