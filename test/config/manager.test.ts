import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../../src/config/manager.js';
import { loadConfig, resetConfig } from '../../src/config.js';

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

test('update: accepts codex as a search backend', () => {
  const dir = makeTmpDir();
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load();
    mgr.update({ searchBackend: { op: 'set', value: 'codex' } });
    assert.equal(mgr.get().searchBackend, 'codex');
    // Rejects unknown backends as before
    assert.throws(
      () => mgr.update({ searchBackend: { op: 'set', value: 'not-a-backend' } }),
      /searchBackend/i,
    );
  } finally {
    rmSync(dir, { recursive: true });
    delete process.env['SEARCH_MCP_CONFIG_KEY'];
    resetConfig();
  }
});

test('update: searchBackend patch persists searchBackendExplicit=true across reload', () => {
  // Hermetic: all persistence happens in a tmp configDir. The repo's
  // config.json / config.enc are never renamed, written, or removed.
  const dir = makeTmpDir();
  const savedKey = process.env['SEARCH_MCP_CONFIG_KEY'];
  const savedBackend = process.env.SEARCH_BACKEND;
  delete process.env.SEARCH_BACKEND;
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load();
    mgr.update({ searchBackend: { op: 'set', value: 'codex' } });
    assert.equal(mgr.get().searchBackend, 'codex');
    assert.equal(
      mgr.get().searchBackendExplicit,
      true,
      'dashboard selection must be marked explicit',
    );
    // Reload from encrypted disk: the explicit flag must survive
    resetConfig();
    const mgr2 = new ConfigManager({ configDir: dir });
    mgr2.load();
    assert.equal(mgr2.get().searchBackend, 'codex');
    assert.equal(mgr2.get().searchBackendExplicit, true, 'explicit flag must survive reload');
  } finally {
    rmSync(dir, { recursive: true });
    if (savedBackend === undefined) delete process.env.SEARCH_BACKEND;
    else process.env.SEARCH_BACKEND = savedBackend;
    if (savedKey === undefined) delete process.env['SEARCH_MCP_CONFIG_KEY'];
    else process.env['SEARCH_MCP_CONFIG_KEY'] = savedKey;
    resetConfig();
  }
});

test('update: invalidates the runtime config cache so future loadConfig() sees the change without restart', () => {
  const dir = makeTmpDir();
  const savedKey = process.env['SEARCH_MCP_CONFIG_KEY'];
  const savedBackend = process.env.SEARCH_BACKEND;
  delete process.env.SEARCH_BACKEND;
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load();

    // loadConfig() returns the cached object by reference while the cache is
    // warm. A dashboard persistence must invalidate that cache (resetConfig),
    // so the next loadConfig() re-reads the persisted config.enc. Identity
    // change is the smallest deterministic proof that no restart is needed.
    const cachedBefore = loadConfig();
    mgr.update({ searchBackend: { op: 'set', value: 'brave' } });
    const cachedAfter = loadConfig();

    assert.notEqual(
      cachedAfter,
      cachedBefore,
      'persistence must invalidate the runtime config cache',
    );
    assert.equal(mgr.get().searchBackend, 'brave');
  } finally {
    rmSync(dir, { recursive: true });
    if (savedBackend === undefined) delete process.env.SEARCH_BACKEND;
    else process.env.SEARCH_BACKEND = savedBackend;
    if (savedKey === undefined) delete process.env['SEARCH_MCP_CONFIG_KEY'];
    else process.env['SEARCH_MCP_CONFIG_KEY'] = savedKey;
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
