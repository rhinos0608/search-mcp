/**
 *
 * Resolution order (each layer overrides the previous):
 *   1. config.json — human-editable base config
 *   2. config.enc — encrypted config, decrypted via SEARCH_MCP_CONFIG_KEY env var
 *   3. Individual env vars — 12-factor overrides for deployment (highest priority)
 *   4. Hard-coded defaults
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { DEFAULT_SEMANTIC_MAX_BYTES } from './semanticLimits.js';
import type { AccessConfig } from './config/types.js';
import { decryptConfig } from './config/crypto.js';
import type { KnowledgeGraphConfig } from './knowledge/types.js';
import { DEFAULT_KG_CONFIG } from './knowledge/config.js';

/** Load .env from the project root if present. Only sets vars not already in the environment. */
function loadDotEnv(pkgRoot: string): void {
  const envPath = join(pkgRoot, '.env');
  if (!existsSync(envPath)) return;
  try {
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    let loaded = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      let value = line.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
        loaded++;
      }
    }
    if (loaded > 0) {
      logger.debug({ envPath, loaded }, 'Loaded .env file');
    }
  } catch (err) {
    logger.warn({ err, envPath }, 'Failed to read .env file');
  }
}

/** Directory containing this file (dist/ or src/). Go up one level to reach project root. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export type SearchBackend = 'brave' | 'searxng' | 'exa' | 'duckduckgo' | 'ollama-search' | 'tavily';

export interface RescoreWeights {
  rrfAnchor: number;
  recency?: number;
  citations?: number;
  engagement?: number;
  commentEngagement?: number;
  venue?: number;
  hasDeepLinks?: number;
  [key: string]: number | undefined;
}

export interface RescoreConfig {
  webSearch: RescoreWeights;
  academicSearch: RescoreWeights;
  hackernewsSearch: RescoreWeights;
  redditSearch: RescoreWeights;
}

function validateRescoreWeights(weights: RescoreWeights, toolName: string): void {
  const knownKeys = [
    'recency',
    'citations',
    'engagement',
    'commentEngagement',
    'venue',
    'hasDeepLinks',
  ] as const;
  const otherWeights = knownKeys.map((k) => weights[k]).filter((v): v is number => v !== undefined);
  const maxOther = otherWeights.length > 0 ? Math.max(...otherWeights) : 0;
  if (weights.rrfAnchor < maxOther) {
    logger.warn(
      { tool: toolName, rrfAnchor: weights.rrfAnchor, maxOther },
      'Rescore weights warning: rrfAnchor should dominate any single other signal',
    );
  }
}

const DEFAULT_RESCORE_WEIGHTS: RescoreConfig = {
  webSearch: { rrfAnchor: 0.5, recency: 0.2, hasDeepLinks: 0.05 },
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
};

export interface GitHubConfig {
  token?: string;
}

export interface RedditConfig {
  clientId?: string;
  clientSecret?: string;
  userAgent?: string;
  /** True iff both clientId and clientSecret are present. */
  oauthEnabled: boolean;
  /** False iff exactly one of clientId/clientSecret is present (partial config). */
  oauthConfigValid: boolean;
}

export interface ExaConfig {
  apiKey?: string;
}

export interface Crawl4aiConfig {
  baseUrl: string;
  apiToken?: string;
}

export interface EmbeddingSidecarConfig {
  provider: 'sidecar' | 'ollama' | 'transformers' | 'openai';
  baseUrl: string;
  apiToken?: string;
  dimensions: number;
  codeModel: string;
}

export interface SemanticCrawlConfig {
  defaultMaxBytes: number;
  maxMaxBytes: number;
}

export interface DomainTrustConfig {
  enabled: boolean;
  trustedDomains: string[];
  blockedDomains: string[];
}

export interface LlmConfig {
  provider: string;
  apiToken?: string;
  baseUrl: string;
}

export interface RAGAConfig {
  enabled: boolean;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  cacheEnabled: boolean;
  defaultParser: 'auto' | 'docling' | 'paddleocr' | 'mineru';
}

export type ResearchDepth = 'quick' | 'standard' | 'deep' | 'exhaustive' | 'tree';

export interface DeepResearchConfig {
  enabled: boolean;
  defaultDepth: ResearchDepth;
  maxDepth: ResearchDepth;
  maxToolCalls: number;
  maxTokens: number;
  maxTimeMs: number;
  /** OpenAI-compatible base URL for the orchestrator LLM. */
  baseUrl: string;
  /** Optional separate base URL for the worker LLM. Falls back to baseUrl if not set. */
  workerBaseUrl: string;
  /** Main orchestrator model (mid-tier: planning, gap analysis, synthesis). */
  model: string;
  /** Worker model (cheap: search, extraction notes, classification). */
  workerModel: string;
  /** Optional API token for authenticated LLM endpoints. */
  apiToken: string;
  treeBreadth: number;
  treeDepth: number;
  treeConcurrency: number;
  treeContextWordLimit: number;
  /** Max ReAct loop iterations for agent strategy (default 30). */
  agentMaxIterations: number;
  /** Max iterations per sub-agent (default 8). */
  agentMaxSubIterations: number;
  /** Default fetch mode: full | summary_focus_query | disabled (default summary_focus_query). */
  agentDefaultFetchMode: string;
  /** Automatically save results to disk when research completes (unless optOut is set). Default: true. */
  autoSave: boolean;
}

export type BrowserMode = 'stealth' | 'user' | 'profile';
export type BrowserEngine = 'playwright' | 'cloak';

export interface BrowserConfig {
  enabled: boolean;
  executablePath: string;
  headless: boolean;
  viewport: { width: number; height: number };
  userAgent: string;
  proxyServer: string;
  cdpEndpoint: string;
  profileDir: string;
  maxSessionTimeMs: number;
  stealthEnabled: boolean;
  rebrowser: boolean;
  bypassCSP: boolean;
  /** Browser automation backend. 'cloak' requires the optional cloakbrowser package. */
  browserEngine: BrowserEngine;
  /** Enable CloakBrowser wrapper-level human-like input patches. */
  cloakHumanize: boolean;
  /** CloakBrowser humanization preset. */
  cloakHumanPreset: 'default' | 'careful';
  /** CloakBrowser locale flag, e.g. en-US. Empty = wrapper default. */
  cloakLocale: string;
  /** CloakBrowser timezone flag, e.g. America/New_York. Empty = wrapper default. */
  cloakTimezone: string;
  /** Auto-detect locale/timezone from proxy IP via CloakBrowser. */
  cloakGeoip: boolean;
  /** Include CloakBrowser default stealth fingerprint flags. */
  cloakStealthArgs: boolean;
  /** domain -> { username, password, totpSecret? } */
  credentials: Record<string, { username: string; password: string; totpSecret?: string }>;
  /** Browser launch mode. 'stealth' = headless CDP stealth; 'user' = connect to user's existing browser; 'profile' = launch with persistent profile. */
  mode: BrowserMode;
  /** CDP port for user-browser mode (default: 9222). */
  browserPort: number;
  /** Auto-connect to user browser on startup (default: false). */
  autoConnect: boolean;
}

export interface SearchConfig {
  searchBackend: SearchBackend;
  brave: { apiKey?: string };
  searxng: { baseUrl: string };
  exa: ExaConfig;
  tavily: { apiKey?: string };
  youtube: { apiKey?: string };
  stackexchange: { apiKey?: string };
  github: GitHubConfig;
  reddit: RedditConfig;
  crawl4ai: Crawl4aiConfig;
  embeddingSidecar: EmbeddingSidecarConfig;
  semanticCrawl: SemanticCrawlConfig;
  domainTrust: DomainTrustConfig;
  scrubContent: boolean;
  llm: LlmConfig;
  raga: RAGAConfig;
  duckduckgo: { region: string; safeSearch: string };
  ollamaSearch: { baseUrl: string; apiKey?: string };
  deepResearch: DeepResearchConfig;
  browser: BrowserConfig;
  rescoreWeights: RescoreConfig;
  challengeLatencyThreshold: number;
  mcpApiKey?: string;   // Generated on first run; stored encrypted.
  apiKeyClaimed: boolean; // True once the setup screen has been dismissed.
  access: AccessConfig; // External access configuration.
  knowledgeGraph: KnowledgeGraphConfig;}

const DEFAULTS: Omit<SearchConfig, 'rescoreWeights'> = {
  searchBackend: 'searxng',
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
  embeddingSidecar: {
    provider: 'sidecar',
    baseUrl: '',
    apiToken: '',
    dimensions: 768,
    codeModel: '',
  },
  semanticCrawl: {
    defaultMaxBytes: DEFAULT_SEMANTIC_MAX_BYTES,
    maxMaxBytes: DEFAULT_SEMANTIC_MAX_BYTES,
  },
  domainTrust: {
    enabled: false,
    trustedDomains: [],
    blockedDomains: [],
  },
  scrubContent: false,
  llm: { provider: '', apiToken: '', baseUrl: '' },
  raga: {
    enabled: false,
    baseUrl: '',
    timeoutMs: 30000,
    maxRetries: 2,
    cacheEnabled: true,
    defaultParser: 'auto',
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
    agentDefaultFetchMode: 'summary_focus_query',
    autoSave: true,
  },
  challengeLatencyThreshold: 5000,
  mcpApiKey: '',
  apiKeyClaimed: true, // Existing installs already have the key; only first-run sets false.
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
    browserEngine: 'playwright' as const,
    cloakHumanize: false,
    cloakHumanPreset: 'default' as const,
    cloakLocale: '',
    cloakTimezone: '',
    cloakGeoip: false,
    cloakStealthArgs: true,
    credentials: {},
    mode: 'stealth' as const,
    browserPort: 9222,
    autoConnect: false,
  },
  knowledgeGraph: DEFAULT_KG_CONFIG,
};

const VALID_BACKENDS = new Set<string>([
  'brave',
  'searxng',
  'exa',
  'duckduckgo',
  'ollama-search',
  'tavily',
]);


type EnvConfig = Omit<
  Partial<SearchConfig>,
  | 'reddit'
  | 'crawl4ai'
  | 'github'
  | 'embeddingSidecar'
  | 'semanticCrawl'
  | 'domainTrust'
  | 'llm'
  | 'raga'
  | 'scrubContent'
  | 'exa'
  | 'duckduckgo'
  | 'ollamaSearch'
  | 'browser'
> & {
  challengeLatencyThreshold?: number;
  browser?: Partial<BrowserConfig>;
  deepResearch?: Partial<DeepResearchConfig>;
  reddit?: Partial<RedditConfig>;
  crawl4ai?: Partial<Crawl4aiConfig>;
  github?: Partial<GitHubConfig>;
  exa?: Partial<ExaConfig>;
  tavily?: Partial<{ apiKey: string }>;
  embeddingSidecar?: Partial<EmbeddingSidecarConfig>;
  semanticCrawl?: Partial<SemanticCrawlConfig>;
  domainTrust?: Partial<DomainTrustConfig>;
  llm?: Partial<LlmConfig>;
  raga?: Partial<RAGAConfig>;
  scrubContent?: boolean;
  duckduckgo?: Partial<{ region: string; safeSearch: string }>;
  ollamaSearch?: Partial<{ baseUrl: string; apiKey: string }>;
  knowledgeGraph?: Partial<KnowledgeGraphConfig>;
};

function loadFromEnv(): EnvConfig {
  const cfg: EnvConfig = {};

  const backend = process.env.SEARCH_BACKEND;
  if (backend && VALID_BACKENDS.has(backend)) {
    cfg.searchBackend = backend as SearchBackend;
  }

  const braveKey = process.env.BRAVE_API_KEY;
  if (braveKey) {
    cfg.brave = { apiKey: braveKey };
    cfg.searchBackend ??= 'brave';
  }

  const searxngUrl = process.env.SEARXNG_BASE_URL;
  if (searxngUrl) {
    cfg.searxng = { baseUrl: searxngUrl };
    if (!cfg.searchBackend && !braveKey) cfg.searchBackend = 'searxng';
  }

  const exaKey = process.env.EXA_API_KEY;
  if (exaKey) {
    cfg.exa = { apiKey: exaKey };
    cfg.searchBackend ??= 'exa';
  }

  const tavilyKey = process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    cfg.tavily = { apiKey: tavilyKey };
    cfg.searchBackend ??= 'tavily';
  }

  const ytKey = process.env.YOUTUBE_API_KEY;
  if (ytKey) {
    cfg.youtube = { apiKey: ytKey };
  }

  const seKey = process.env.STACKEXCHANGE_API_KEY;
  if (seKey) {
    cfg.stackexchange = { apiKey: seKey };
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    cfg.github = { token: githubToken };
  }

  const redditClientId = process.env.REDDIT_CLIENT_ID;
  const redditClientSecret = process.env.REDDIT_CLIENT_SECRET;
  const redditUserAgent = process.env.REDDIT_USER_AGENT;
  if (
    redditClientId !== undefined ||
    redditClientSecret !== undefined ||
    redditUserAgent !== undefined
  ) {
    const redditCfg: Partial<RedditConfig> = {};
    if (redditClientId !== undefined) redditCfg.clientId = redditClientId;
    if (redditClientSecret !== undefined) redditCfg.clientSecret = redditClientSecret;
    if (redditUserAgent !== undefined) redditCfg.userAgent = redditUserAgent;
    cfg.reddit = redditCfg;
  }

  const crawl4aiUrl = process.env.CRAWL4AI_BASE_URL;
  const crawl4aiToken = process.env.CRAWL4AI_API_TOKEN;
  if (crawl4aiUrl !== undefined || crawl4aiToken !== undefined) {
    const crawl4aiCfg: Partial<Crawl4aiConfig> = {};
    if (crawl4aiUrl !== undefined) crawl4aiCfg.baseUrl = crawl4aiUrl;
    if (crawl4aiToken !== undefined) crawl4aiCfg.apiToken = crawl4aiToken;
    cfg.crawl4ai = crawl4aiCfg;
  }

  const embeddingSidecarUrl = process.env.EMBEDDING_SIDECAR_BASE_URL;
  const embeddingSidecarToken = process.env.EMBEDDING_SIDECAR_API_TOKEN;
  const embeddingDimensions = process.env.EMBEDDING_DIMENSIONS;
  const embeddingCodeModel = process.env.EMBEDDING_CODE_MODEL;

  const rawProvider = process.env.EMBEDDING_PROVIDER?.toLowerCase().trim();
  const allowedProviders = ['sidecar', 'ollama', 'transformers', 'openai'] as const;
  let embeddingProvider: (typeof allowedProviders)[number] = 'sidecar';
  if (rawProvider && allowedProviders.includes(rawProvider as (typeof allowedProviders)[number])) {
    embeddingProvider = rawProvider as (typeof allowedProviders)[number];
  } else if (rawProvider) {
    logger.error({ rawProvider }, 'Invalid EMBEDDING_PROVIDER specified; defaulting to sidecar');
  }

  if (
    embeddingProvider !== 'sidecar' ||
    embeddingSidecarUrl !== undefined ||
    embeddingSidecarToken !== undefined ||
    embeddingDimensions !== undefined ||
    embeddingCodeModel !== undefined
  ) {
    const esc: Partial<EmbeddingSidecarConfig> = {};
    if (embeddingProvider !== 'sidecar') esc.provider = embeddingProvider;
    if (embeddingSidecarUrl !== undefined) esc.baseUrl = embeddingSidecarUrl;
    if (embeddingSidecarToken !== undefined) esc.apiToken = embeddingSidecarToken;
    if (embeddingDimensions !== undefined) {
      const dims = Number(embeddingDimensions);
      if ([128, 256, 512, 768].includes(dims)) {
        esc.dimensions = dims;
      }
    }
    if (embeddingCodeModel !== undefined) esc.codeModel = embeddingCodeModel;
    cfg.embeddingSidecar = esc;
  }

  const semanticCrawlDefaultMaxBytes = process.env.SEMANTIC_CRAWL_DEFAULT_MAX_BYTES;
  const semanticCrawlMaxMaxBytes = process.env.SEMANTIC_CRAWL_MAX_MAX_BYTES;
  if (semanticCrawlDefaultMaxBytes !== undefined || semanticCrawlMaxMaxBytes !== undefined) {
    const scc: Partial<SemanticCrawlConfig> = {};
    if (semanticCrawlDefaultMaxBytes !== undefined) {
      const n = Number(semanticCrawlDefaultMaxBytes);
      if (!isNaN(n)) scc.defaultMaxBytes = n;
    }
    if (semanticCrawlMaxMaxBytes !== undefined) {
      const n = Number(semanticCrawlMaxMaxBytes);
      if (!isNaN(n)) scc.maxMaxBytes = n;
    }
    cfg.semanticCrawl = scc;
  }

  const domainTrustEnabled = process.env.DOMAIN_TRUST_ENABLED;
  const trustedDomains = process.env.TRUSTED_DOMAINS;
  const blockedDomains = process.env.BLOCKED_DOMAINS;
  if (
    domainTrustEnabled !== undefined ||
    trustedDomains !== undefined ||
    blockedDomains !== undefined
  ) {
    const dt: Partial<DomainTrustConfig> = {};
    if (domainTrustEnabled !== undefined) dt.enabled = domainTrustEnabled === 'true';
    if (trustedDomains !== undefined) {
      dt.trustedDomains = trustedDomains
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    if (blockedDomains !== undefined) {
      dt.blockedDomains = blockedDomains
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    cfg.domainTrust = dt;
  }

  const llmProvider = process.env.LLM_PROVIDER;
  const llmApiToken = process.env.LLM_API_TOKEN;
  const llmBaseUrl = process.env.LLM_BASE_URL;
  if (llmProvider !== undefined || llmApiToken !== undefined || llmBaseUrl !== undefined) {
    // Intentionally partial: missing keys are resolved via ?? chaining
    // in the final merge block below.
    const llmCfg: Partial<LlmConfig> = {};
    if (llmProvider !== undefined) llmCfg.provider = llmProvider;
    if (llmApiToken !== undefined) llmCfg.apiToken = llmApiToken;
    if (llmBaseUrl !== undefined) llmCfg.baseUrl = llmBaseUrl;
    cfg.llm = llmCfg;
  }

  // Content scrubbing
  const scrubContent = process.env.SCRUB_CONTENT;
  if (scrubContent !== undefined) {
    cfg.scrubContent = scrubContent === 'true';
  }

  // RAG-Anything Bridge configuration
  const ragaBridgeUrl = process.env.RAGA_BRIDGE_URL;
  const ragaEnabled = process.env.RAGA_ENABLED;
  const ragaParser = process.env.RAGA_DEFAULT_PARSER;
  if (ragaBridgeUrl !== undefined || ragaEnabled !== undefined || ragaParser !== undefined) {
    const ragaCfg: Partial<RAGAConfig> = {};
    if (ragaBridgeUrl !== undefined) ragaCfg.baseUrl = ragaBridgeUrl;
    if (ragaEnabled !== undefined) ragaCfg.enabled = ragaEnabled === 'true';
    if (ragaParser !== undefined) {
      const validParsers = ['auto', 'docling', 'paddleocr', 'mineru'] as const;
      if (validParsers.includes(ragaParser as (typeof validParsers)[number])) {
        ragaCfg.defaultParser = ragaParser as RAGAConfig['defaultParser'];
      }
    }
    cfg.raga = ragaCfg;
  }

  // DuckDuckGo — optional region/safesearch knobs (zero-key backend, always-on)
  const ddgRegion = process.env.SEARCH_DUCKDUCKGO_REGION;
  const ddgSafeSearch = process.env.SEARCH_DUCKDUCKGO_SAFESEARCH;
  if (ddgRegion !== undefined || ddgSafeSearch !== undefined) {
    const ddgCfg: Partial<{ region: string; safeSearch: string }> = {};
    if (ddgRegion !== undefined) ddgCfg.region = ddgRegion;
    if (ddgSafeSearch !== undefined) ddgCfg.safeSearch = ddgSafeSearch;
    cfg.duckduckgo = ddgCfg;
  }

  // Ollama search config — distinct from EMBEDDING_OLLAMA_* vars
  const ollamaSearchUrl = process.env.SEARCH_OLLAMA_BASE_URL;
  const ollamaSearchKey = process.env.SEARCH_OLLAMA_API_KEY;
  if (ollamaSearchUrl !== undefined || ollamaSearchKey !== undefined) {
    const osc: Partial<{ baseUrl: string; apiKey: string }> = {};
    if (ollamaSearchUrl !== undefined) osc.baseUrl = ollamaSearchUrl;
    if (ollamaSearchKey !== undefined) osc.apiKey = ollamaSearchKey;
    cfg.ollamaSearch = osc;
  }

  // ── Browser env vars ──────────────────────────────────────────────────
  {
    const bEnabled = process.env.BROWSER_ENABLED;
    const bExecPath = process.env.BROWSER_EXECUTABLE_PATH;
    const bHeadless = process.env.BROWSER_HEADLESS;
    const bViewportW = process.env.BROWSER_VIEWPORT_WIDTH;
    const bViewportH = process.env.BROWSER_VIEWPORT_HEIGHT;
    const bUserAgent = process.env.BROWSER_USER_AGENT;
    const bProxy = process.env.BROWSER_PROXY_SERVER;
    const bCdp = process.env.BROWSER_CDP_ENDPOINT;
    const bProfile = process.env.BROWSER_PROFILE_DIR;
    const bTimeout = process.env.BROWSER_TIMEOUT;
    const bStealth = process.env.BROWSER_STEALTH_ENABLED;
    const bRebrowser = process.env.BROWSER_REBROWSER;
    const bBypassCSP = process.env.BROWSER_BYPASS_CSP;
    const bCreds = process.env.BROWSER_CREDENTIALS;
    const bMode = process.env.BROWSER_MODE;
    const bPort = process.env.BROWSER_CDP_PORT;
    const bAuto = process.env.BROWSER_AUTO_CONNECT;
    const bEngine = process.env.BROWSER_ENGINE;
    const bCloakHumanize = process.env.CLOAKBROWSER_HUMANIZE;
    const bCloakHumanPreset = process.env.CLOAKBROWSER_HUMAN_PRESET;
    const bCloakLocale = process.env.CLOAKBROWSER_LOCALE;
    const bCloakTimezone = process.env.CLOAKBROWSER_TIMEZONE;
    const bCloakGeoip = process.env.CLOAKBROWSER_GEOIP;
    const bCloakStealthArgs = process.env.CLOAKBROWSER_STEALTH_ARGS;

    if (
      bEnabled !== undefined ||
      bExecPath !== undefined ||
      bHeadless !== undefined ||
      bViewportW !== undefined ||
      bViewportH !== undefined ||
      bUserAgent !== undefined ||
      bProxy !== undefined ||
      bCdp !== undefined ||
      bProfile !== undefined ||
      bTimeout !== undefined ||
      bStealth !== undefined ||
      bRebrowser !== undefined ||
      bBypassCSP !== undefined ||
      bCreds !== undefined ||
      bMode !== undefined ||
      bPort !== undefined ||
      bAuto !== undefined ||
      bEngine !== undefined ||
      bCloakHumanize !== undefined ||
      bCloakHumanPreset !== undefined ||
      bCloakLocale !== undefined ||
      bCloakTimezone !== undefined ||
      bCloakGeoip !== undefined ||
      bCloakStealthArgs !== undefined
    ) {
      const browserCfg: Partial<BrowserConfig> = {};
      if (bEnabled !== undefined) browserCfg.enabled = bEnabled === 'true';
      if (bExecPath !== undefined) browserCfg.executablePath = bExecPath;
      if (bHeadless !== undefined) browserCfg.headless = bHeadless !== 'false';
      if (bViewportW !== undefined) {
        const w = parseInt(bViewportW, 10);
        if (!isNaN(w))
          browserCfg.viewport = { ...(browserCfg.viewport ?? DEFAULTS.browser.viewport), width: w };
      }
      if (bViewportH !== undefined) {
        const h = parseInt(bViewportH, 10);
        if (!isNaN(h))
          browserCfg.viewport = {
            ...(browserCfg.viewport ?? DEFAULTS.browser.viewport),
            height: h,
          };
      }
      if (bUserAgent !== undefined) browserCfg.userAgent = bUserAgent;
      if (bProxy !== undefined) browserCfg.proxyServer = bProxy;
      if (bCdp !== undefined) browserCfg.cdpEndpoint = bCdp;
      if (bProfile !== undefined) browserCfg.profileDir = bProfile;
      if (bTimeout !== undefined) {
        const t = parseInt(bTimeout, 10);
        if (!isNaN(t)) browserCfg.maxSessionTimeMs = t;
      }
      if (bStealth !== undefined) browserCfg.stealthEnabled = bStealth !== 'false';
      if (bRebrowser !== undefined) browserCfg.rebrowser = bRebrowser === 'true';
      if (bBypassCSP !== undefined) browserCfg.bypassCSP = bBypassCSP === 'true';
      if (bCreds !== undefined) {
        try {
          const parsed = JSON.parse(bCreds) as Record<
            string,
            { username: string; password: string; totpSecret?: string }
          >;
          browserCfg.credentials = parsed;
        } catch {
          /* keep default */
        }
      }
      if (bMode !== undefined) {
        const m = bMode.toLowerCase();
        if (m === 'stealth' || m === 'user' || m === 'profile') {
          browserCfg.mode = m;
        }
      }
      if (bPort !== undefined) {
        const p = parseInt(bPort, 10);
        if (!isNaN(p) && p > 0 && p <= 65535) browserCfg.browserPort = p;
      }
      if (bAuto !== undefined) browserCfg.autoConnect = bAuto === 'true';
      if (bEngine !== undefined) {
        const engine = bEngine.toLowerCase();
        if (engine === 'playwright' || engine === 'cloak') {
          browserCfg.browserEngine = engine;
        }
      }
      if (bCloakHumanize !== undefined) browserCfg.cloakHumanize = bCloakHumanize === 'true';
      if (bCloakHumanPreset !== undefined) {
        const preset = bCloakHumanPreset.toLowerCase();
        if (preset === 'default' || preset === 'careful') {
          browserCfg.cloakHumanPreset = preset;
        }
      }
      if (bCloakLocale !== undefined) browserCfg.cloakLocale = bCloakLocale;
      if (bCloakTimezone !== undefined) browserCfg.cloakTimezone = bCloakTimezone;
      if (bCloakGeoip !== undefined) browserCfg.cloakGeoip = bCloakGeoip === 'true';
      if (bCloakStealthArgs !== undefined)
        browserCfg.cloakStealthArgs = bCloakStealthArgs !== 'false';
      cfg.browser = browserCfg;
    }
  }

  // ── Deep Research env vars ────────────────────────────────────────────
  {
    const partial: Partial<DeepResearchConfig> = {};
    let hasAny = false;
    const e = process.env.DEEP_RESEARCH_ENABLED;
    if (e !== undefined) {
      partial.enabled = e === 'true';
    }
    const u = process.env.DEEP_RESEARCH_BASE_URL;
    if (u !== undefined) {
      partial.baseUrl = u;
      hasAny = true;
    }
    const wu = process.env.DEEP_RESEARCH_WORKER_BASE_URL;
    if (wu !== undefined) {
      partial.workerBaseUrl = wu;
      hasAny = true;
    }
    const m = process.env.DEEP_RESEARCH_MODEL;
    if (m !== undefined) {
      partial.model = m;
      hasAny = true;
    }
    const w = process.env.DEEP_RESEARCH_WORKER_MODEL;
    if (w !== undefined) {
      partial.workerModel = w;
      hasAny = true;
    }
    const tok = process.env.DEEP_RESEARCH_API_TOKEN;
    if (tok !== undefined) {
      partial.apiToken = tok;
      hasAny = true;
    }
    const d = process.env.DEEP_RESEARCH_DEFAULT_DEPTH;
    if (d !== undefined && ['quick', 'standard', 'deep', 'exhaustive', 'tree'].includes(d)) {
      partial.defaultDepth = d as ResearchDepth;
      hasAny = true;
    }
    const maxIters = process.env.DEEP_RESEARCH_AGENT_MAX_ITERATIONS;
    if (maxIters !== undefined) {
      const n = Number(maxIters);
      if (!isNaN(n) && n > 0) {
        partial.agentMaxIterations = n;
        hasAny = true;
      }
    }
    const maxSubIters = process.env.DEEP_RESEARCH_AGENT_MAX_SUB_ITERATIONS;
    if (maxSubIters !== undefined) {
      const n = Number(maxSubIters);
      if (!isNaN(n) && n > 0) {
        partial.agentMaxSubIterations = n;
        hasAny = true;
      }
    }
    const fetchMode = process.env.DEEP_RESEARCH_AGENT_DEFAULT_FETCH_MODE;
    if (
      fetchMode !== undefined &&
      ['full', 'summary_focus_query', 'disabled'].includes(fetchMode)
    ) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      partial.agentDefaultFetchMode = fetchMode as 'full' | 'summary_focus_query' | 'disabled';
      hasAny = true;
    }
    if (hasAny) {
      cfg.deepResearch = {
        ...(cfg.deepResearch ?? {}),
        ...partial,
      } as unknown as DeepResearchConfig;
    }
  }

  const challengeLatencyThreshold = process.env.CHALLENGE_LATENCY_THRESHOLD;
  if (challengeLatencyThreshold !== undefined) {
    const n = Number(challengeLatencyThreshold);
    if (!isNaN(n)) cfg.challengeLatencyThreshold = n;
  }

  // ── Knowledge Graph env vars ────────────────────────────────────────────
  {
    const partial: Partial<KnowledgeGraphConfig> = {};
    let hasAny = false;
    const kgEnabled = process.env.KG_ENABLED;
    if (kgEnabled !== undefined) {
      partial.enabled = kgEnabled === 'true';
      hasAny = true;
    }
    const kgDbPath = process.env.KG_DB_PATH;
    if (kgDbPath !== undefined) {
      partial.dbPath = kgDbPath;
      hasAny = true;
    }
    if (hasAny) {
      cfg.knowledgeGraph = {
        ...(cfg.knowledgeGraph ?? {}),
        ...partial,
      } as unknown as KnowledgeGraphConfig;
    }
  }

  return cfg;
}

let cached: SearchConfig | undefined;

export function loadConfig(): SearchConfig {
  if (cached) return cached;

  loadDotEnv(PKG_ROOT);

  let fileConfig: EnvConfig = {};
  const encPath = join(PKG_ROOT, 'config.enc');
  const jsonPath = join(PKG_ROOT, 'config.json');
  const configKey = process.env.SEARCH_MCP_CONFIG_KEY;

  if (existsSync(jsonPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(jsonPath, 'utf8')) as EnvConfig;
      logger.info('Loaded base config from config.json');
    } catch (err) {
      logger.warn({ err }, 'Failed to parse config.json');
    }
  }

  if (existsSync(encPath) && configKey) {
    try {
      const buf = readFileSync(encPath);
      const encryptedConfig = decryptConfig(buf, configKey) as SearchConfig;
      // Deep merge encrypted config over JSON config with safety checks
      fileConfig = {
        ...fileConfig,
        ...encryptedConfig,
        github: {
          ...(fileConfig.github ?? {}),
          ...encryptedConfig.github,
        },
        reddit: {
          ...(fileConfig.reddit ?? {}),
          ...encryptedConfig.reddit,
        },
        embeddingSidecar: {
          ...(fileConfig.embeddingSidecar ?? {}),
          ...encryptedConfig.embeddingSidecar,
        },
      };
      logger.info(
        { hasToken: !!encryptedConfig.github.token },
        'Merged encrypted config from config.enc',
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to decrypt config.enc — falling back to base config');
    }
  }

  const envConfig = loadFromEnv();

  cached = {
    searchBackend: envConfig.searchBackend ?? fileConfig.searchBackend ?? DEFAULTS.searchBackend,
    brave: {
      apiKey: envConfig.brave?.apiKey ?? fileConfig.brave?.apiKey ?? DEFAULTS.brave.apiKey ?? '',
    },
    searxng: {
      baseUrl:
        envConfig.searxng?.baseUrl ?? fileConfig.searxng?.baseUrl ?? DEFAULTS.searxng.baseUrl,
    },
    exa: {
      apiKey: envConfig.exa?.apiKey ?? fileConfig.exa?.apiKey ?? DEFAULTS.exa.apiKey ?? '',
    },
    tavily: {
      apiKey: envConfig.tavily?.apiKey ?? fileConfig.tavily?.apiKey ?? DEFAULTS.tavily.apiKey ?? '',
    },
    youtube: {
      apiKey:
        envConfig.youtube?.apiKey ?? fileConfig.youtube?.apiKey ?? DEFAULTS.youtube.apiKey ?? '',
    },
    stackexchange: {
      apiKey:
        envConfig.stackexchange?.apiKey ?? fileConfig.stackexchange?.apiKey ??
        DEFAULTS.stackexchange.apiKey ??
        '',
    },
    github: {
      token: envConfig.github?.token ?? fileConfig.github?.token ?? DEFAULTS.github.token ?? '',
    },
    reddit: resolveRedditConfig(fileConfig.reddit, envConfig.reddit),
    crawl4ai: {
      baseUrl:
        envConfig.crawl4ai?.baseUrl ?? fileConfig.crawl4ai?.baseUrl ?? DEFAULTS.crawl4ai.baseUrl,
      apiToken:
        envConfig.crawl4ai?.apiToken ?? fileConfig.crawl4ai?.apiToken ??
        DEFAULTS.crawl4ai.apiToken ??
        '',
    },
    embeddingSidecar: {
      provider:
        envConfig.embeddingSidecar?.provider ?? fileConfig.embeddingSidecar?.provider ??
        DEFAULTS.embeddingSidecar.provider,
      baseUrl:
        envConfig.embeddingSidecar?.baseUrl ?? fileConfig.embeddingSidecar?.baseUrl ??
        DEFAULTS.embeddingSidecar.baseUrl,
      apiToken:
        envConfig.embeddingSidecar?.apiToken ?? fileConfig.embeddingSidecar?.apiToken ??
        DEFAULTS.embeddingSidecar.apiToken ??
        '',
      dimensions:
        envConfig.embeddingSidecar?.dimensions ?? fileConfig.embeddingSidecar?.dimensions ??
        DEFAULTS.embeddingSidecar.dimensions,
      codeModel:
        envConfig.embeddingSidecar?.codeModel ?? fileConfig.embeddingSidecar?.codeModel ??
        DEFAULTS.embeddingSidecar.codeModel,
    },
    semanticCrawl: {
      defaultMaxBytes:
        envConfig.semanticCrawl?.defaultMaxBytes ?? fileConfig.semanticCrawl?.defaultMaxBytes ??
        DEFAULTS.semanticCrawl.defaultMaxBytes,
      maxMaxBytes:
        envConfig.semanticCrawl?.maxMaxBytes ?? fileConfig.semanticCrawl?.maxMaxBytes ??
        DEFAULTS.semanticCrawl.maxMaxBytes,
    },
    domainTrust: {
      enabled:
        envConfig.domainTrust?.enabled ?? fileConfig.domainTrust?.enabled ??
        DEFAULTS.domainTrust.enabled,
      trustedDomains:
        envConfig.domainTrust?.trustedDomains ?? fileConfig.domainTrust?.trustedDomains ??
        DEFAULTS.domainTrust.trustedDomains,
      blockedDomains:
        envConfig.domainTrust?.blockedDomains ?? fileConfig.domainTrust?.blockedDomains ??
        DEFAULTS.domainTrust.blockedDomains,
    },
    scrubContent: envConfig.scrubContent ?? fileConfig.scrubContent ?? DEFAULTS.scrubContent,
    llm: {
      provider: envConfig.llm?.provider ?? fileConfig.llm?.provider ?? DEFAULTS.llm.provider,
      apiToken: envConfig.llm?.apiToken ?? fileConfig.llm?.apiToken ?? DEFAULTS.llm.apiToken ?? '',
      baseUrl: envConfig.llm?.baseUrl ?? fileConfig.llm?.baseUrl ?? DEFAULTS.llm.baseUrl,
    },
    raga: {
      enabled: envConfig.raga?.enabled ?? fileConfig.raga?.enabled ?? DEFAULTS.raga.enabled,
      baseUrl: envConfig.raga?.baseUrl ?? fileConfig.raga?.baseUrl ?? DEFAULTS.raga.baseUrl,
      timeoutMs: envConfig.raga?.timeoutMs ?? fileConfig.raga?.timeoutMs ?? DEFAULTS.raga.timeoutMs,
      maxRetries:
        envConfig.raga?.maxRetries ?? fileConfig.raga?.maxRetries ?? DEFAULTS.raga.maxRetries,
      cacheEnabled:
        envConfig.raga?.cacheEnabled ?? fileConfig.raga?.cacheEnabled ?? DEFAULTS.raga.cacheEnabled,
      defaultParser:
        envConfig.raga?.defaultParser ?? fileConfig.raga?.defaultParser ??
        DEFAULTS.raga.defaultParser,
    },
    duckduckgo: {
      region:
        envConfig.duckduckgo?.region ?? fileConfig.duckduckgo?.region ?? DEFAULTS.duckduckgo.region,
      safeSearch:
        envConfig.duckduckgo?.safeSearch ?? fileConfig.duckduckgo?.safeSearch ??
        DEFAULTS.duckduckgo.safeSearch,
    },
    ollamaSearch: {
      baseUrl:
        envConfig.ollamaSearch?.baseUrl ?? fileConfig.ollamaSearch?.baseUrl ??
        DEFAULTS.ollamaSearch.baseUrl,
      apiKey:
        envConfig.ollamaSearch?.apiKey ?? fileConfig.ollamaSearch?.apiKey ??
        DEFAULTS.ollamaSearch.apiKey ??
        '',
    },
    challengeLatencyThreshold:
      envConfig.challengeLatencyThreshold ?? fileConfig.challengeLatencyThreshold ??
      DEFAULTS.challengeLatencyThreshold,
    browser: {
      enabled:
        envConfig.browser?.enabled ?? fileConfig.browser?.enabled ?? DEFAULTS.browser.enabled,
      executablePath:
        envConfig.browser?.executablePath ?? fileConfig.browser?.executablePath ??
        DEFAULTS.browser.executablePath,
      headless:
        envConfig.browser?.headless ?? fileConfig.browser?.headless ?? DEFAULTS.browser.headless,
      viewport: {
        width:
          envConfig.browser?.viewport?.width ?? fileConfig.browser?.viewport?.width ??
          DEFAULTS.browser.viewport.width,
        height:
          envConfig.browser?.viewport?.height ?? fileConfig.browser?.viewport?.height ??
          DEFAULTS.browser.viewport.height,
      },
      userAgent:
        envConfig.browser?.userAgent ?? fileConfig.browser?.userAgent ?? DEFAULTS.browser.userAgent,
      proxyServer:
        envConfig.browser?.proxyServer ?? fileConfig.browser?.proxyServer ??
        DEFAULTS.browser.proxyServer,
      cdpEndpoint:
        envConfig.browser?.cdpEndpoint ?? fileConfig.browser?.cdpEndpoint ??
        DEFAULTS.browser.cdpEndpoint,
      profileDir:
        envConfig.browser?.profileDir ?? fileConfig.browser?.profileDir ??
        DEFAULTS.browser.profileDir,
      maxSessionTimeMs:
        envConfig.browser?.maxSessionTimeMs ?? fileConfig.browser?.maxSessionTimeMs ??
        DEFAULTS.browser.maxSessionTimeMs,
      stealthEnabled:
        envConfig.browser?.stealthEnabled ?? fileConfig.browser?.stealthEnabled ??
        DEFAULTS.browser.stealthEnabled,
      rebrowser:
        envConfig.browser?.rebrowser ?? fileConfig.browser?.rebrowser ?? DEFAULTS.browser.rebrowser,
      bypassCSP:
        envConfig.browser?.bypassCSP ?? fileConfig.browser?.bypassCSP ?? DEFAULTS.browser.bypassCSP,
      browserEngine:
        envConfig.browser?.browserEngine ?? fileConfig.browser?.browserEngine ??
        DEFAULTS.browser.browserEngine,
      cloakHumanize:
        envConfig.browser?.cloakHumanize ?? fileConfig.browser?.cloakHumanize ??
        DEFAULTS.browser.cloakHumanize,
      cloakHumanPreset:
        envConfig.browser?.cloakHumanPreset ?? fileConfig.browser?.cloakHumanPreset ??
        DEFAULTS.browser.cloakHumanPreset,
      cloakLocale:
        envConfig.browser?.cloakLocale ?? fileConfig.browser?.cloakLocale ??
        DEFAULTS.browser.cloakLocale,
      cloakTimezone:
        envConfig.browser?.cloakTimezone ?? fileConfig.browser?.cloakTimezone ??
        DEFAULTS.browser.cloakTimezone,
      cloakGeoip:
        envConfig.browser?.cloakGeoip ?? fileConfig.browser?.cloakGeoip ??
        DEFAULTS.browser.cloakGeoip,
      cloakStealthArgs:
        envConfig.browser?.cloakStealthArgs ?? fileConfig.browser?.cloakStealthArgs ??
        DEFAULTS.browser.cloakStealthArgs,
      credentials:
        envConfig.browser?.credentials ?? fileConfig.browser?.credentials ??
        DEFAULTS.browser.credentials,
      mode: envConfig.browser?.mode ?? fileConfig.browser?.mode ?? DEFAULTS.browser.mode,
      browserPort:
        envConfig.browser?.browserPort ?? fileConfig.browser?.browserPort ??
        DEFAULTS.browser.browserPort,
      autoConnect:
        envConfig.browser?.autoConnect ?? fileConfig.browser?.autoConnect ??
        DEFAULTS.browser.autoConnect,
    },
    deepResearch: {
      enabled:
        envConfig.deepResearch?.enabled ?? fileConfig.deepResearch?.enabled ??
        DEFAULTS.deepResearch.enabled,
      defaultDepth:
        envConfig.deepResearch?.defaultDepth ?? fileConfig.deepResearch?.defaultDepth ??
        DEFAULTS.deepResearch.defaultDepth,
      maxDepth:
        envConfig.deepResearch?.maxDepth ?? fileConfig.deepResearch?.maxDepth ??
        DEFAULTS.deepResearch.maxDepth,
      maxToolCalls:
        envConfig.deepResearch?.maxToolCalls ?? fileConfig.deepResearch?.maxToolCalls ??
        DEFAULTS.deepResearch.maxToolCalls,
      maxTokens:
        envConfig.deepResearch?.maxTokens ?? fileConfig.deepResearch?.maxTokens ??
        DEFAULTS.deepResearch.maxTokens,
      maxTimeMs:
        envConfig.deepResearch?.maxTimeMs ?? fileConfig.deepResearch?.maxTimeMs ??
        DEFAULTS.deepResearch.maxTimeMs,
      baseUrl:
        envConfig.deepResearch?.baseUrl ?? fileConfig.deepResearch?.baseUrl ??
        DEFAULTS.deepResearch.baseUrl,
      workerBaseUrl:
        envConfig.deepResearch?.workerBaseUrl ?? fileConfig.deepResearch?.workerBaseUrl ??
        DEFAULTS.deepResearch.workerBaseUrl,
      model:
        envConfig.deepResearch?.model ?? fileConfig.deepResearch?.model ??
        DEFAULTS.deepResearch.model,
      workerModel:
        envConfig.deepResearch?.workerModel ?? fileConfig.deepResearch?.workerModel ??
        DEFAULTS.deepResearch.workerModel,
      apiToken:
        envConfig.deepResearch?.apiToken ?? fileConfig.deepResearch?.apiToken ??
        DEFAULTS.deepResearch.apiToken,
      treeBreadth:
        envConfig.deepResearch?.treeBreadth ?? fileConfig.deepResearch?.treeBreadth ??
        DEFAULTS.deepResearch.treeBreadth,
      treeDepth:
        envConfig.deepResearch?.treeDepth ?? fileConfig.deepResearch?.treeDepth ??
        DEFAULTS.deepResearch.treeDepth,
      treeConcurrency:
        envConfig.deepResearch?.treeConcurrency ?? fileConfig.deepResearch?.treeConcurrency ??
        DEFAULTS.deepResearch.treeConcurrency,
      treeContextWordLimit:
        envConfig.deepResearch?.treeContextWordLimit ?? fileConfig.deepResearch?.treeContextWordLimit ??
        DEFAULTS.deepResearch.treeContextWordLimit,
      agentMaxIterations:
        envConfig.deepResearch?.agentMaxIterations ?? fileConfig.deepResearch?.agentMaxIterations ??
        DEFAULTS.deepResearch.agentMaxIterations,
      agentMaxSubIterations:
        envConfig.deepResearch?.agentMaxSubIterations ?? fileConfig.deepResearch?.agentMaxSubIterations ??
        DEFAULTS.deepResearch.agentMaxSubIterations,
      agentDefaultFetchMode:
        envConfig.deepResearch?.agentDefaultFetchMode ?? fileConfig.deepResearch?.agentDefaultFetchMode ??
        DEFAULTS.deepResearch.agentDefaultFetchMode,
      autoSave:
        envConfig.deepResearch?.autoSave ?? fileConfig.deepResearch?.autoSave ??
        DEFAULTS.deepResearch.autoSave,
    },
    knowledgeGraph: {
      ...DEFAULTS.knowledgeGraph,
      ...fileConfig.knowledgeGraph,
      ...envConfig.knowledgeGraph,
      projection: {
        ...DEFAULTS.knowledgeGraph.projection,
        ...(fileConfig.knowledgeGraph?.projection ?? {}),
        ...(envConfig.knowledgeGraph?.projection ?? {}),
      },
      solidification: {
        ...DEFAULTS.knowledgeGraph.solidification,
        ...(fileConfig.knowledgeGraph?.solidification ?? {}),
        ...(envConfig.knowledgeGraph?.solidification ?? {}),
      },
      session: {
        ...DEFAULTS.knowledgeGraph.session,
        ...(fileConfig.knowledgeGraph?.session ?? {}),
        ...(envConfig.knowledgeGraph?.session ?? {}),
      },
      consolidation: {
        ...DEFAULTS.knowledgeGraph.consolidation,
        ...(fileConfig.knowledgeGraph?.consolidation ?? {}),
        ...(envConfig.knowledgeGraph?.consolidation ?? {}),
      },
    },
    rescoreWeights: DEFAULT_RESCORE_WEIGHTS,
    mcpApiKey: (fileConfig as Partial<SearchConfig>).mcpApiKey ?? '',
    apiKeyClaimed: (fileConfig as Partial<SearchConfig>).apiKeyClaimed ?? DEFAULTS.apiKeyClaimed,
    access: {
      provider:
        ((fileConfig as Partial<SearchConfig>).access?.provider) ??
        DEFAULTS.access.provider,
      exposeDashboardExternally:
        ((fileConfig as Partial<SearchConfig>).access?.exposeDashboardExternally) ??
        DEFAULTS.access.exposeDashboardExternally,
      tailscale: {
        serveConfigured:
          ((fileConfig as { access?: { tailscale?: Partial<AccessConfig['tailscale']> } }).access?.tailscale?.serveConfigured) ??
          DEFAULTS.access.tailscale.serveConfigured,
        funnelConfigured:
          ((fileConfig as { access?: { tailscale?: Partial<AccessConfig['tailscale']> } }).access?.tailscale?.funnelConfigured) ??
          DEFAULTS.access.tailscale.funnelConfigured,
        allowDashboardOverFunnel:
          ((fileConfig as { access?: { tailscale?: Partial<AccessConfig['tailscale']> } }).access?.tailscale?.allowDashboardOverFunnel) ??
          DEFAULTS.access.tailscale.allowDashboardOverFunnel,
      },
    },
  };

  // Validate weights
  for (const [tool, weights] of Object.entries(cached.rescoreWeights)) {
    validateRescoreWeights(weights as RescoreWeights, tool);
  }

  if (!cached.reddit.oauthConfigValid) {
    logger.warn(
      {
        hasClientId: cached.reddit.clientId !== '',
        hasClientSecret: cached.reddit.clientSecret !== '',
      },
      'Reddit OAuth is partially configured; both REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are required',
    );
  }

  const codeEmbeddingWarning = getCodeEmbeddingFallbackWarning(cached);
  if (codeEmbeddingWarning !== undefined) {
    logger.warn({ env: 'EMBEDDING_CODE_MODEL' }, codeEmbeddingWarning);
  }

  logger.info({ backend: cached.searchBackend }, 'Search config loaded');
  return cached;
}

export function getCodeEmbeddingFallbackWarning(config: SearchConfig): string | undefined {
  return config.embeddingSidecar.codeModel.trim().length === 0
    ? 'EMBEDDING_CODE_MODEL is not configured; code retrieval will fall back to the prose embedding model and rely more heavily on lexical ranking.'
    : undefined;
}

function resolveRedditConfig(
  fileReddit: Partial<RedditConfig> | undefined,
  envReddit: Partial<RedditConfig> | undefined,
): RedditConfig {
  // Trim whitespace so values like `REDDIT_CLIENT_ID=' '` (common with
  // misquoted .env lines) are treated as unset rather than partial config.
  const clientId = (
    envReddit?.clientId ??
    fileReddit?.clientId ??
    DEFAULTS.reddit.clientId ??
    ''
  ).trim();
  const clientSecret = (
    envReddit?.clientSecret ??
    fileReddit?.clientSecret ??
    DEFAULTS.reddit.clientSecret ??
    ''
  ).trim();
  const userAgent = (
    envReddit?.userAgent ??
    fileReddit?.userAgent ??
    DEFAULTS.reddit.userAgent ??
    ''
  ).trim();

  const hasId = clientId !== '';
  const hasSecret = clientSecret !== '';
  const oauthEnabled = hasId && hasSecret;
  const oauthConfigValid = hasId === hasSecret;

  return {
    clientId,
    clientSecret,
    userAgent,
    oauthEnabled,
    oauthConfigValid,
  };
}

/** Reset cached config (for testing). */
export function resetConfig(): void {
  cached = undefined;
}
