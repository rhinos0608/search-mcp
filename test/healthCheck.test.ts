import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';
import { loadConfig, resetConfig } from '../src/config.js';
import { resetTrackers } from '../src/rateLimit.js';

import { codexConfigured } from '../src/tools/codexSearch.js';

const ENV_KEYS = ['SEARCH_BACKEND', 'BRAVE_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_HOME'] as const;
const originalFetch = globalThis.fetch;
const saved = new Map<string, string | undefined>();

/**
 * Replace network fetch with a stub so the health_check handler's probes
 * never hit real endpoints (hermetic). Brave gets an empty-results response so
 * its probe reports healthy; everything else gets a generic 200 JSON body.
 */
function stubNetworkFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('api.search.brave.com')
      ? JSON.stringify({ web: { results: [] } })
      : JSON.stringify({ ok: true });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

interface ToolHealthEntry {
  status?: string;
  activeBackend?: string;
}

interface HealthCheckResponse {
  structuredContent?: { tools?: Record<string, ToolHealthEntry> };
}

type HealthCheckHandler = (args: unknown) => Promise<HealthCheckResponse>;

function getHealthCheckHandler(
  server: ReturnType<typeof createServer>['server'],
): HealthCheckHandler {
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, { handler?: HealthCheckHandler }>;
    }
  )._registeredTools;
  const entry = tools['health_check'];
  assert.ok(entry, 'health_check tool should be registered');
  assert.ok(entry.handler, 'health_check handler should be exposed by the SDK registration');
  return entry.handler;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  // Force Codex credential discovery to fail even when the host has
  // ~/.codex/auth.json: point CODEX_HOME at a path that cannot exist.
  process.env.CODEX_HOME = '/nonexistent/search-mcp-health-test-codex-home';
  resetConfig();
  resetTrackers();
  stubNetworkFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const prior = saved.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  resetConfig();
  resetTrackers();
});

test('health_check handler probes with reloaded persisted config, not registration-time cfg', async () => {
  // Registration-time config: explicit Codex with no credentials. Handler must
  // reload dashboard changes before probing every provider candidate.
  assert.equal(
    codexConfigured(process.env),
    false,
    'host ~/.codex/auth.json must not be discovered in tests',
  );
  process.env.SEARCH_BACKEND = 'codex';
  resetConfig();
  const startupCfg = loadConfig();
  assert.equal(startupCfg.searchBackend, 'codex');

  const { server } = createServer(startupCfg);
  const handler = getHealthCheckHandler(server);

  // Simulate a dashboard config update: a new persisted backend plus the
  // loadConfig cache invalidation that ConfigManager performs on write.
  process.env.SEARCH_BACKEND = 'brave';
  process.env.BRAVE_API_KEY = 'test-key';
  resetConfig();

  const out = await handler({});
  const tools = out.structuredContent?.tools ?? {};

  // Reloaded brave config drives fallback preference. All provider candidates
  // are probed, so Codex is present but correctly reported unconfigured.
  assert.ok(tools['web_search.brave'], 'brave backend should be probed from reloaded config');
  assert.equal(tools['web_search.codex']?.status, 'unconfigured');
  assert.equal(tools.web_search?.status, 'healthy');
  assert.equal(tools.web_search?.activeBackend, 'brave');
});
