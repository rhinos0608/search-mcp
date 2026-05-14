import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchMcpRuntime } from '../../src/config/types.js';
import { HttpTransportManager } from '../../src/server/mcp-transport.js';

// Minimal but structurally complete mock of SearchMcpRuntime.
// Uses `as never` cast to avoid fully replicating every nested type.
const mockRuntime: SearchMcpRuntime = {
  getConfig: () => ({
    searchBackend: 'searxng' as const,
    brave: { apiKey: '' },
    searxng: { baseUrl: '' },
    exa: { apiKey: '' },
    tavily: { apiKey: '' },
    youtube: { apiKey: '' },
    stackexchange: { apiKey: '' },
    github: { token: '' },
    reddit: {
      clientId: '', clientSecret: '', userAgent: '', oauthEnabled: false, oauthConfigValid: true,
    },
    crawl4ai: { baseUrl: '', apiToken: '' },
    embeddingSidecar: {
      provider: 'sidecar' as const, baseUrl: '', apiToken: '', dimensions: 768, codeModel: '',
    },
    semanticCrawl: { defaultMaxBytes: 50_000_000, maxMaxBytes: 50_000_000 },
    domainTrust: { enabled: false, trustedDomains: [], blockedDomains: [] },
    scrubContent: false,
    llm: { provider: '', apiToken: '', baseUrl: '' },
    raga: {
      enabled: false, baseUrl: '', timeoutMs: 30000, maxRetries: 2,
      cacheEnabled: true, defaultParser: 'auto' as const,
    },
    duckduckgo: { region: 'us-en', safeSearch: 'moderate' },
    ollamaSearch: { baseUrl: '', apiKey: '' },
    deepResearch: {
      enabled: false,
      defaultDepth: 'standard' as const,
      maxDepth: 'deep' as const,
      maxToolCalls: 200,
      maxTokens: 500_000,
      maxTimeMs: 300_000,
      baseUrl: '',
      workerBaseUrl: '',
      model: '',
      workerModel: '',
      apiToken: '',
      treeBreadth: 4,
      treeDepth: 2,
      treeConcurrency: 2,
      treeContextWordLimit: 25000,
      agentMaxIterations: 30,
      agentMaxSubIterations: 8,
      agentDefaultFetchMode: 'summary_focus_query' as const,
      autoSave: true,
    },
    challengeLatencyThreshold: 5000,
    mcpApiKey: '',
    access: {
      provider: 'localhost' as const,
      exposeDashboardExternally: false,
      tailscale: { serveConfigured: false, funnelConfigured: false, allowDashboardOverFunnel: false },
    },
    browser: {
      enabled: false, executablePath: '', headless: true,
      viewport: { width: 1280, height: 720 }, userAgent: '', proxyServer: '',
      cdpEndpoint: '', profileDir: '', maxSessionTimeMs: 300_000,
      stealthEnabled: true, rebrowser: false, bypassCSP: false,
      browserEngine: 'playwright' as const, cloakHumanize: false,
      cloakHumanPreset: 'default' as const, cloakLocale: '', cloakTimezone: '',
      cloakGeoip: false, cloakStealthArgs: true, credentials: {},
    },
    rescoreWeights: {
      webSearch: { rrfAnchor: 60 },
      academicSearch: { rrfAnchor: 60 },
      hackernewsSearch: { rrfAnchor: 60 },
      redditSearch: { rrfAnchor: 60 },
    },
  }) as never,
};

test('getOrCreate: creates new session when no sessionId given', async () => {
  const mgr = new HttpTransportManager(mockRuntime);
  const result = await mgr.getOrCreate(undefined);
  assert.ok(result !== null);
  assert.equal(result!.isNew, true);
  assert.ok(result!.sessionId.length > 0);
  mgr.closeAll();
});

test('getOrCreate: returns null for unknown sessionId', async () => {
  const mgr = new HttpTransportManager(mockRuntime);
  const result = await mgr.getOrCreate('nonexistent-session-id');
  assert.equal(result, null);
  mgr.closeAll();
});

test('getOrCreate: returns existing session for known sessionId', async () => {
  const mgr = new HttpTransportManager(mockRuntime);
  const first = await mgr.getOrCreate(undefined);
  const second = await mgr.getOrCreate(first!.sessionId);
  assert.equal(second!.isNew, false);
  assert.equal(second!.sessionId, first!.sessionId);
  mgr.closeAll();
});

test('close: removes session', async () => {
  const mgr = new HttpTransportManager(mockRuntime);
  const s = await mgr.getOrCreate(undefined);
  mgr.close(s!.sessionId);
  const again = await mgr.getOrCreate(s!.sessionId);
  assert.equal(again, null);
});
