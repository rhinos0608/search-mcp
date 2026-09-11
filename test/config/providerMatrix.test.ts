import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, resetConfig, resolveScrapeFallbackEnabled } from '../../src/config.js';
import {
  FALLBACK_ORDER,
  STRICT_SAFE_BACKENDS,
  resolveBackends,
} from '../../src/tools/webSearch.js';
import { ConfigManager } from '../../src/config/manager.js';
import { probeSearchBackend, orderedSearchBackends, configHealth } from '../../src/health.js';
import { createMockConfig } from '../helpers/mocks.js';

const ENV_KEYS = [
  'JINA_API_KEY',
  'FIRECRAWL_API_KEY',
  'FIRECRAWL_SCRAPE_FALLBACK_ENABLED',
  'DIFFBOT_API_KEY',
] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void): void {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  try {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      if (values[key] !== undefined) process.env[key] = values[key];
      else delete process.env[key];
    }
    resetConfig();
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      const prior = saved[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    resetConfig();
  }
}

test('config: env keys flow into jina/firecrawl/diffbot config blocks', () => {
  withEnv({ JINA_API_KEY: 'j1', FIRECRAWL_API_KEY: 'f1', DIFFBOT_API_KEY: 'd1' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.jina.apiKey, 'j1');
    assert.equal(cfg.firecrawl.apiKey, 'f1');
    assert.equal(cfg.diffbot.apiKey, 'd1');
  });
});

test('config: FIRECRAWL_SCRAPE_FALLBACK_ENABLED=true enables the flag; absent/empty means false', () => {
  withEnv({ FIRECRAWL_API_KEY: 'f1', FIRECRAWL_SCRAPE_FALLBACK_ENABLED: 'true' }, () => {
    assert.equal(loadConfig().firecrawl.scrapeFallback.enabled, true);
  });
  withEnv({ FIRECRAWL_API_KEY: 'f1' }, () => {
    assert.equal(loadConfig().firecrawl.scrapeFallback.enabled, false);
  });
  withEnv({ FIRECRAWL_API_KEY: 'f1', FIRECRAWL_SCRAPE_FALLBACK_ENABLED: 'false' }, () => {
    assert.equal(loadConfig().firecrawl.scrapeFallback.enabled, false);
  });
});

test('config: empty-string keys mean unconfigured (zero billable calls)', () => {
  withEnv({ JINA_API_KEY: '', FIRECRAWL_API_KEY: '', DIFFBOT_API_KEY: '' }, () => {
    const cfg = loadConfig();
    assert.equal((cfg.jina.apiKey ?? '').length, 0);
    assert.equal((cfg.firecrawl.apiKey ?? '').length, 0);
    assert.equal((cfg.diffbot.apiKey ?? '').length, 0);
  });
});

test('config: env takes precedence over persisted values for new providers (hermetic)', () => {
  // Never touches the repo config.json/config.enc. An isolated ConfigManager
  // in a temp dir proves the precedence chain: env wins over persisted state,
  // and a missing config still resolves to defaults without local files.
  const dir = mkdtempSync(join(tmpdir(), 'smcp-matrix-env-'));
  const priorKey = process.env['SEARCH_MCP_CONFIG_KEY'];
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load();
    mgr.update({ jina: { apiKey: { op: 'set', value: 'file-loses' } } });
    withEnv({ JINA_API_KEY: 'env-wins' }, () => {
      assert.equal(loadConfig().jina.apiKey, 'env-wins');
    });
  } finally {
    rmSync(dir, { recursive: true });
    if (priorKey === undefined) delete process.env['SEARCH_MCP_CONFIG_KEY'];
    else process.env['SEARCH_MCP_CONFIG_KEY'] = priorKey;
    resetConfig();
  }
});

test('config: no env keys → defaults are empty and fallback flag false', () => {
  withEnv({}, () => {
    const cfg = loadConfig();
    assert.equal(cfg.jina.apiKey, '');
    assert.equal(cfg.firecrawl.apiKey, '');
    assert.equal(cfg.firecrawl.scrapeFallback.enabled, false);
    assert.equal(cfg.diffbot.apiKey, '');
  });
});

test('fanout: FALLBACK_ORDER includes the three providers after tavily, before ollama-search', () => {
  const idx = (b: string) => FALLBACK_ORDER.indexOf(b as never);
  assert.ok(idx('jina') > idx('tavily') && idx('jina') < idx('ollama-search'));
  assert.ok(idx('firecrawl') > idx('jina'));
  assert.ok(idx('diffbot') > idx('firecrawl'));
  assert.equal(FALLBACK_ORDER.length, 9);
});

test('fanout: resolveBackends orders new providers and codex stays first when available', () => {
  const cfg = createMockConfig({
    jina: { apiKey: 'k' },
    firecrawl: { apiKey: 'k', scrapeFallback: { enabled: false } },
    diffbot: { apiKey: 'k' },
  });
  const order = resolveBackends(cfg, undefined, true);
  assert.equal(order[0], 'codex');
  // searxng (mock default primary) first, then FALLBACK_ORDER sans searxng:
  // duckduckgo, brave, exa, tavily, jina, firecrawl, diffbot, ollama-search.
  assert.equal(order.indexOf('jina'), 6);
  assert.equal(order.indexOf('firecrawl'), 7);
  assert.equal(order.indexOf('diffbot'), 8);
  // Without codex, searchBackend (searxng mock default) leads, then fallback order.
  const orderNoCodex = resolveBackends(cfg, undefined, false);
  assert.equal(orderNoCodex[0], 'searxng');
  assert.ok(orderNoCodex.indexOf('jina') > 0);
});

test('fanout: strict safe-search excludes all three providers', () => {
  for (const b of ['jina', 'firecrawl', 'diffbot']) {
    assert.equal(STRICT_SAFE_BACKENDS.has(b as never), false);
  }
  // Configured but excluded: strict scope drops them entirely.
  const cfg = createMockConfig({
    jina: { apiKey: 'k' },
    firecrawl: { apiKey: 'k', scrapeFallback: { enabled: false } },
    diffbot: { apiKey: 'k' },
  });
  const order = resolveBackends(cfg, undefined, false);
  // resolveBackends itself includes all candidates; strict filtering happens in
  // the searchWithBackends scope filter (behaviorally asserted in
  // webSearchProviderMatrix.test.ts 'strict safe-search excludes all three').
  assert.ok(order.includes('jina') && order.includes('firecrawl') && order.includes('diffbot'));
});

test('health: orderedSearchBackends includes the three providers', () => {
  const cfg = createMockConfig({
    jina: { apiKey: 'k' },
    firecrawl: { apiKey: 'k', scrapeFallback: { enabled: false } },
    diffbot: { apiKey: 'k' },
  });
  const order = orderedSearchBackends(cfg, false);
  for (const b of ['jina', 'firecrawl', 'diffbot']) assert.ok(order.includes(b as never));
});

test('health: configured jina/firecrawl/diffbot → config-only degraded, NO network call', async () => {
  // Mock fetch to throw — a config-only probe must never reach the network.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('LIVE CALL ATTEMPTED');
  }) as typeof fetch;
  try {
    const cfg = createMockConfig({
      jina: { apiKey: 'k' },
      firecrawl: { apiKey: 'k', scrapeFallback: { enabled: false } },
      diffbot: { apiKey: 'k' },
    });
    for (const backend of ['jina', 'firecrawl', 'diffbot'] as const) {
      const health = await probeSearchBackend(cfg, backend);
      assert.equal(health.status, 'degraded', `${backend} configured → degraded (unverified)`);
      assert.match(health.message, /config-only/i);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('health: unconfigured jina/firecrawl/diffbot → unconfigured with actionable remediation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('LIVE CALL ATTEMPTED');
  }) as typeof fetch;
  try {
    const cfg = createMockConfig();
    for (const backend of ['jina', 'firecrawl', 'diffbot'] as const) {
      const health = await probeSearchBackend(cfg, backend);
      assert.equal(health.status, 'unconfigured');
      assert.match(health.remediation ?? '', /API_KEY/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dashboard: ConfigManager accepts new backends, persists and redacts provider keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smcp-matrix-'));
  const priorKey = process.env['SEARCH_MCP_CONFIG_KEY'];
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load();
    for (const backend of ['jina', 'firecrawl', 'diffbot']) {
      mgr.update({ searchBackend: { op: 'set', value: backend } });
      assert.equal(mgr.get().searchBackend, backend);
    }
    mgr.update({
      jina: { apiKey: { op: 'set', value: 'jk' } },
      firecrawl: { apiKey: { op: 'set', value: 'fk' } },
      diffbot: { apiKey: { op: 'set', value: 'dk' } },
    });
    assert.equal(mgr.get().jina.apiKey, 'jk');
    assert.equal(mgr.get().firecrawl.apiKey, 'fk');
    assert.equal(mgr.get().diffbot.apiKey, 'dk');
    const redacted = mgr.getRedacted() as Record<string, Record<string, unknown>>;
    assert.equal(redacted.jina?.apiKey, '•••');
    assert.equal(redacted.firecrawl?.apiKey, '•••');
    assert.equal(redacted.diffbot?.apiKey, '•••');
    // scrapeFallback.enabled is NOT a secret — stays visible.
    assert.deepEqual(redacted.firecrawl?.scrapeFallback, mgr.get().firecrawl.scrapeFallback);
    // Reload from disk: persisted values survive (manager reads its own enc).
    const mgr2 = new ConfigManager({ configDir: dir });
    mgr2.load();
    assert.equal(mgr2.get().jina.apiKey, 'jk');
    assert.equal((mgr2.get().firecrawl.scrapeFallback as { enabled: boolean }).enabled, false);
  } finally {
    rmSync(dir, { recursive: true });
    if (priorKey === undefined) delete process.env['SEARCH_MCP_CONFIG_KEY'];
    else process.env['SEARCH_MCP_CONFIG_KEY'] = priorKey;
    resetConfig();
  }
});

test('dashboard: unknown top-level keys still rejected (no scope widening)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smcp-matrix-'));
  const priorKey = process.env['SEARCH_MCP_CONFIG_KEY'];
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load();
    assert.throws(
      () => mgr.update({ serper: { apiKey: { op: 'set', value: 'x' } } } as never),
      /not allowed/,
    );
  } finally {
    rmSync(dir, { recursive: true });
    if (priorKey === undefined) delete process.env['SEARCH_MCP_CONFIG_KEY'];
    else process.env['SEARCH_MCP_CONFIG_KEY'] = priorKey;
    resetConfig();
  }
});

test('config.example.json: parses, has empty keys, false fallback flag, no serper/google', () => {
  const raw = readFileSync(join(process.cwd(), 'config.example.json'), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  assert.equal(parsed.jina?.apiKey, '');
  assert.equal(parsed.firecrawl?.apiKey, '');
  assert.equal(
    (parsed.firecrawl?.scrapeFallback as { enabled?: boolean } | undefined)?.enabled,
    false,
  );
  assert.equal(parsed.diffbot?.apiKey, '');
  assert.equal(parsed.serper, undefined);
  assert.equal(parsed.googleGrounding, undefined);
});

test('health: configHealth web_search counts jina/firecrawl/diffbot keys as configured', () => {
  // Single-provider deployments must not report degraded web_search.
  for (const key of ['jina', 'firecrawl', 'diffbot'] as const) {
    const cfg = createMockConfig({
      jina: { apiKey: key === 'jina' ? 'k' : '' },
      firecrawl: { apiKey: key === 'firecrawl' ? 'k' : '', scrapeFallback: { enabled: false } },
      diffbot: { apiKey: key === 'diffbot' ? 'k' : '' },
    });
    assert.equal(configHealth(cfg).web_search?.status, 'healthy', `${key}-only deployment`);
  }
});

test('health: configHealth web_search degraded remediation lists the new provider env keys', () => {
  // Mask local Codex credentials (env token + ~/.codex auth.json) so the
  // all-unconfigured degraded branch is reachable on any machine.
  const savedCodexHome = process.env['CODEX_HOME'];
  const savedCodexToken = process.env['CODEX_ACCESS_TOKEN'];
  process.env['CODEX_HOME'] = join(tmpdir(), 'smcp-no-codex-home');
  delete process.env['CODEX_ACCESS_TOKEN'];
  try {
    const cfg = createMockConfig();
    const health = configHealth(cfg).web_search;
    assert.equal(health?.status, 'degraded');
    for (const envVar of ['JINA_API_KEY', 'FIRECRAWL_API_KEY', 'DIFFBOT_API_KEY']) {
      assert.ok((health?.remediation ?? '').includes(envVar), `mentions ${envVar}`);
    }
  } finally {
    if (savedCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = savedCodexHome;
    if (savedCodexToken === undefined) delete process.env['CODEX_ACCESS_TOKEN'];
    else process.env['CODEX_ACCESS_TOKEN'] = savedCodexToken;
  }
});

test('dashboard: string firecrawl.scrapeFallback.enabled patch is rejected (billable gate stays closed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smcp-matrix-'));
  const priorKey = process.env['SEARCH_MCP_CONFIG_KEY'];
  try {
    process.env['SEARCH_MCP_CONFIG_KEY'] = 'test-key-at-least-32-chars-long!!';
    resetConfig();
    const mgr = new ConfigManager({ configDir: dir });
    mgr.load();
    assert.throws(
      () =>
        mgr.update({
          firecrawl: {
            scrapeFallback: { op: 'set', value: { enabled: 'false' as never } },
          },
        } as never),
      /must be a boolean/,
    );
    assert.equal(mgr.get().firecrawl.scrapeFallback.enabled, false);
  } finally {
    rmSync(dir, { recursive: true });
    if (priorKey === undefined) delete process.env['SEARCH_MCP_CONFIG_KEY'];
    else process.env['SEARCH_MCP_CONFIG_KEY'] = priorKey;
    resetConfig();
  }
});

test('helpers: createMockConfig deep-copies scrapeFallback (no cross-mock mutation leak)', () => {
  const a = createMockConfig();
  a.firecrawl.scrapeFallback.enabled = true;
  // A later mock must still see the default false.
  assert.equal(createMockConfig().firecrawl.scrapeFallback.enabled, false);
});

test('config: scrapeFallback gate — explicit env value overrides config-file value in both directions (hermetic)', () => {
  // resolveScrapeFallbackEnabled takes the already-coerced env boolean
  // (loadFromEnv maps FIRECRAWL_SCRAPE_FALLBACK_ENABLED strictly: 'true'/'1' →
  // true, anything else incl. 'false' → false — covered by the withEnv tests
  // above) and the config-file boolean, with nullish env-over-file precedence.
  // No real config.json or process env is touched.
  assert.equal(resolveScrapeFallbackEnabled(false, true), false, 'env false overrides file true');
  assert.equal(resolveScrapeFallbackEnabled(true, false), true, 'env true overrides file false');
  assert.equal(
    resolveScrapeFallbackEnabled(undefined, true),
    true,
    'file true applies without env',
  );
  assert.equal(
    resolveScrapeFallbackEnabled(undefined, false),
    false,
    'file false applies without env',
  );
  assert.equal(
    resolveScrapeFallbackEnabled(undefined, undefined),
    false,
    'default false (gate closed)',
  );
  // Non-boolean input can never enable the billable gate.
  assert.equal(resolveScrapeFallbackEnabled('false' as never, true as never), false);
});
