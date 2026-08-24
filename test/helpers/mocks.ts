import type { SearchMcpRuntime } from '../../src/config/types.js';
import type { SearchConfig } from '../../src/config.js';

const baseConfig: SearchConfig = {
  searchBackend: 'searxng',
  searchBackendExplicit: false,
  brave: { apiKey: '' },
  searxng: { baseUrl: '' },
  exa: { apiKey: '' },
  tavily: { apiKey: '' },
  youtube: { apiKey: '' },
  stackexchange: { apiKey: '' },
  github: { token: '' },
  reddit: {
    clientId: '',
    clientSecret: '',
    userAgent: '',
    oauthEnabled: false,
    oauthConfigValid: true,
  },
  crawl4ai: { baseUrl: '', apiToken: '' },
  documentParsing: { enabled: false, multimodal: false, maxEnrich: 3 },
  embeddingSidecar: {
    provider: 'sidecar',
    baseUrl: '',
    apiToken: '',
    dimensions: 768,
    codeModel: '',
  },
  semanticCrawl: { defaultMaxBytes: 50_000_000, maxMaxBytes: 50_000_000 },
  domainTrust: { enabled: false, trustedDomains: [], blockedDomains: [] },
  scrubContent: false,
  duckduckgo: { region: 'us-en', safeSearch: 'moderate' },
  ollamaSearch: { baseUrl: '', apiKey: '' },
  llm: {
    provider: '',
    enabled: false,
    defaultDepth: 'standard',
    maxDepth: 'deep',
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
    agentDefaultFetchMode: 'summary_focus_query',
    autoSave: true,
  },
  challengeLatencyThreshold: 5000,
  mcpApiKey: '',
  apiKeyClaimed: true,
  access: {
    provider: 'localhost',
    exposeDashboardExternally: false,
    tailscale: {
      serveConfigured: false,
      funnelConfigured: false,
      allowDashboardOverFunnel: false,
    },
  },
  browser: {
    enabled: false,
    executablePath: '',
    headless: true,
    viewport: { width: 1280, height: 720 },
    userAgent: '',
    proxyServer: '',
    cdpEndpoint: '',
    profileDir: '',
    maxSessionTimeMs: 300_000,
    stealthEnabled: true,
    rebrowser: false,
    bypassCSP: false,
    browserEngine: 'playwright',
    cloakHumanize: false,
    cloakHumanPreset: 'default',
    cloakLocale: '',
    cloakTimezone: '',
    cloakGeoip: false,
    cloakStealthArgs: true,
    credentials: {},
    mode: 'stealth',
    browserPort: 9222,
    autoConnect: false,
  },
  rescoreWeights: {
    webSearch: {
      rrfAnchor: 0.45,
      domainAuthority: 0.25,
      recency: 0.12,
      yearAlignment: 0.12,
      hasDeepLinks: 0.05,
    },
    academicSearch: {
      rrfAnchor: 0.5,
      recency: 0.05,
      citations: 0.3,
      venue: 0.15,
    },
    hackernewsSearch: {
      rrfAnchor: 0.5,
      recency: 0.15,
      engagement: 0.2,
      commentEngagement: 0.15,
    },
    redditSearch: {
      rrfAnchor: 0.5,
      recency: 0.1,
      engagement: 0.25,
      commentEngagement: 0.15,
    },
  },
};

/**
 * Create a minimal SearchConfig for tests — deterministic defaults merged with
 * any overrides. Lets tests exercise backend ordering / dedup without reading
 * (or mutating) the repo's config.json / config.enc.
 */
export function createMockConfig(
  overrides?: Partial<Omit<SearchConfig, 'rescoreWeights'>> & {
    rescoreWeights?: Partial<SearchConfig['rescoreWeights']>;
  },
): SearchConfig {
  return {
    ...baseConfig,
    ...overrides,
    brave: { ...baseConfig.brave, ...(overrides?.brave ?? {}) },
    searxng: { ...baseConfig.searxng, ...(overrides?.searxng ?? {}) },
    exa: { ...baseConfig.exa, ...(overrides?.exa ?? {}) },
    tavily: { ...baseConfig.tavily, ...(overrides?.tavily ?? {}) },
    duckduckgo: { ...baseConfig.duckduckgo, ...(overrides?.duckduckgo ?? {}) },
    ollamaSearch: { ...baseConfig.ollamaSearch, ...(overrides?.ollamaSearch ?? {}) },
    rescoreWeights: { ...baseConfig.rescoreWeights, ...(overrides?.rescoreWeights ?? {}) },
  } satisfies SearchConfig;
}

/**
 * Create a minimal SearchMcpRuntime for tests.
 * Returns a runtime whose getConfig() returns the defaults merged with any overrides.
 */
export function createMockRuntime(overrides?: Partial<SearchMcpRuntime>): SearchMcpRuntime {
  return {
    ...overrides,
    getConfig: () => overrides?.getConfig?.() ?? baseConfig,
  } satisfies SearchMcpRuntime;
}
