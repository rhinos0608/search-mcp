/**
 * Encrypted config loader for API keys.
 *
 * Resolution order:
 *   1. Encrypted config file (config.enc) decrypted via SEARCH_MCP_CONFIG_KEY env var
 *   2. Individual env vars (BRAVE_API_KEY, SEARXNG_BASE_URL, EXA_API_KEY, SEARCH_BACKEND)
 *   3. Defaults (SearXNG as default backend)
 */

import { readFileSync, existsSync } from 'node:fs';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { DEFAULT_SEMANTIC_MAX_BYTES } from './semanticLimits.js';

/** Directory containing this file (dist/ or src/). Go up one level to reach project root. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export type SearchBackend = 'brave' | 'searxng' | 'exa';

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
  token: string;
}

export interface RedditConfig {
  clientId: string;
  clientSecret: string;
  userAgent: string;
  /** True iff both clientId and clientSecret are present. */
  oauthEnabled: boolean;
  /** False iff exactly one of clientId/clientSecret is present (partial config). */
  oauthConfigValid: boolean;
}

export interface ExaConfig {
  apiKey: string;
}

export interface Crawl4aiConfig {
  baseUrl: string;
  apiToken: string;
}

export interface EmbeddingSidecarConfig {
  baseUrl: string;
  apiToken: string;
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
  apiToken: string;
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

export interface SearchConfig {
  searchBackend: SearchBackend;
  brave: { apiKey: string };
  searxng: { baseUrl: string };
  exa: ExaConfig;
  nitter: { baseUrl: string };
  listennotes: { apiKey: string };
  producthunt: { apiToken: string };
  patentsview: { apiKey: string };
  youtube: { apiKey: string };
  stackexchange: { apiKey: string };
  github: GitHubConfig;
  reddit: RedditConfig;
  crawl4ai: Crawl4aiConfig;
  embeddingSidecar: EmbeddingSidecarConfig;
  semanticCrawl: SemanticCrawlConfig;
  domainTrust: DomainTrustConfig;
  scrubContent: boolean;
  llm: LlmConfig;
  raga: RAGAConfig;
  rescoreWeights: RescoreConfig;
}

const DEFAULTS: Omit<SearchConfig, 'rescoreWeights'> = {
  searchBackend: 'searxng',
  brave: { apiKey: '' },
  searxng: { baseUrl: '' },
  exa: { apiKey: '' },
  nitter: { baseUrl: '' },
  listennotes: { apiKey: '' },
  producthunt: { apiToken: '' },
  patentsview: { apiKey: '' },
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
};

const VALID_BACKENDS = new Set<string>(['brave', 'searxng', 'exa']);

/**
 * Decrypt config.enc using AES-256-GCM.
 *
 * File format (binary):
 *   [16 bytes salt][12 bytes IV][16 bytes auth tag][...ciphertext]
 *
 * Key derivation: PBKDF2(password, salt, 100_000, 32, sha512)
 */
function decryptConfigFile(filePath: string, password: string): SearchConfig {
  const buf = readFileSync(filePath);

  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const authTag = buf.subarray(28, 44);
  const ciphertext = buf.subarray(44);

  const key = pbkdf2Sync(password, salt, 100_000, 32, 'sha512');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as SearchConfig;
}

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
> & {
  reddit?: Partial<RedditConfig>;
  crawl4ai?: Partial<Crawl4aiConfig>;
  github?: Partial<GitHubConfig>;
  exa?: Partial<ExaConfig>;
  embeddingSidecar?: Partial<EmbeddingSidecarConfig>;
  semanticCrawl?: Partial<SemanticCrawlConfig>;
  domainTrust?: Partial<DomainTrustConfig>;
  llm?: Partial<LlmConfig>;
  raga?: Partial<RAGAConfig>;
  scrubContent?: boolean;
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

  const nitterUrl = process.env.NITTER_BASE_URL;
  if (nitterUrl) {
    cfg.nitter = { baseUrl: nitterUrl };
  }

  const listennotesKey = process.env.LISTENNOTES_API_KEY;
  if (listennotesKey) {
    cfg.listennotes = { apiKey: listennotesKey };
  }

  const phToken = process.env.PRODUCTHUNT_API_TOKEN;
  if (phToken) {
    cfg.producthunt = { apiToken: phToken };
  }

  const pvKey = process.env.PATENTSVIEW_API_KEY;
  if (pvKey) {
    cfg.patentsview = { apiKey: pvKey };
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
  if (
    embeddingSidecarUrl !== undefined ||
    embeddingSidecarToken !== undefined ||
    embeddingDimensions !== undefined ||
    embeddingCodeModel !== undefined
  ) {
    const esc: Partial<EmbeddingSidecarConfig> = {};
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

  return cfg;
}

let cached: SearchConfig | undefined;

export function loadConfig(): SearchConfig {
  if (cached) return cached;

  let fileConfig: EnvConfig = {};

  const encPath = join(PKG_ROOT, 'config.enc');
  const configKey = process.env.SEARCH_MCP_CONFIG_KEY;

  if (existsSync(encPath) && configKey) {
    try {
      fileConfig = decryptConfigFile(encPath, configKey);
      logger.info(
        { hasToken: fileConfig.github?.token ? true : false },
        'Loaded encrypted config from config.enc',
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to decrypt config.enc — falling back to env vars');
    }
  } else {
    if (!existsSync(encPath)) {
      logger.debug('No config.enc found');
    }
    if (!configKey) {
      logger.debug('No SEARCH_MCP_CONFIG_KEY env var set');
    }
  }

  const envConfig = loadFromEnv();

  cached = {
    searchBackend: fileConfig.searchBackend ?? envConfig.searchBackend ?? DEFAULTS.searchBackend,
    brave: {
      apiKey: fileConfig.brave?.apiKey ?? envConfig.brave?.apiKey ?? DEFAULTS.brave.apiKey,
    },
    searxng: {
      baseUrl:
        fileConfig.searxng?.baseUrl ?? envConfig.searxng?.baseUrl ?? DEFAULTS.searxng.baseUrl,
    },
    exa: {
      apiKey: fileConfig.exa?.apiKey ?? envConfig.exa?.apiKey ?? DEFAULTS.exa.apiKey,
    },
    nitter: {
      baseUrl: fileConfig.nitter?.baseUrl ?? envConfig.nitter?.baseUrl ?? DEFAULTS.nitter.baseUrl,
    },
    listennotes: {
      apiKey:
        fileConfig.listennotes?.apiKey ??
        envConfig.listennotes?.apiKey ??
        DEFAULTS.listennotes.apiKey,
    },
    producthunt: {
      apiToken:
        fileConfig.producthunt?.apiToken ??
        envConfig.producthunt?.apiToken ??
        DEFAULTS.producthunt.apiToken,
    },
    patentsview: {
      apiKey:
        fileConfig.patentsview?.apiKey ??
        envConfig.patentsview?.apiKey ??
        DEFAULTS.patentsview.apiKey,
    },
    youtube: {
      apiKey: fileConfig.youtube?.apiKey ?? envConfig.youtube?.apiKey ?? DEFAULTS.youtube.apiKey,
    },
    stackexchange: {
      apiKey:
        fileConfig.stackexchange?.apiKey ??
        envConfig.stackexchange?.apiKey ??
        DEFAULTS.stackexchange.apiKey,
    },
    github: {
      token: fileConfig.github?.token ?? envConfig.github?.token ?? DEFAULTS.github.token,
    },
    reddit: resolveRedditConfig(fileConfig.reddit, envConfig.reddit),
    crawl4ai: {
      baseUrl:
        fileConfig.crawl4ai?.baseUrl ?? envConfig.crawl4ai?.baseUrl ?? DEFAULTS.crawl4ai.baseUrl,
      apiToken:
        fileConfig.crawl4ai?.apiToken ?? envConfig.crawl4ai?.apiToken ?? DEFAULTS.crawl4ai.apiToken,
    },
    embeddingSidecar: {
      baseUrl:
        fileConfig.embeddingSidecar?.baseUrl ??
        envConfig.embeddingSidecar?.baseUrl ??
        DEFAULTS.embeddingSidecar.baseUrl,
      apiToken:
        fileConfig.embeddingSidecar?.apiToken ??
        envConfig.embeddingSidecar?.apiToken ??
        DEFAULTS.embeddingSidecar.apiToken,
      dimensions:
        fileConfig.embeddingSidecar?.dimensions ??
        envConfig.embeddingSidecar?.dimensions ??
        DEFAULTS.embeddingSidecar.dimensions,
      codeModel:
        fileConfig.embeddingSidecar?.codeModel ??
        envConfig.embeddingSidecar?.codeModel ??
        DEFAULTS.embeddingSidecar.codeModel,
    },
    semanticCrawl: {
      defaultMaxBytes:
        fileConfig.semanticCrawl?.defaultMaxBytes ??
        envConfig.semanticCrawl?.defaultMaxBytes ??
        DEFAULTS.semanticCrawl.defaultMaxBytes,
      maxMaxBytes:
        fileConfig.semanticCrawl?.maxMaxBytes ??
        envConfig.semanticCrawl?.maxMaxBytes ??
        DEFAULTS.semanticCrawl.maxMaxBytes,
    },
    domainTrust: {
      enabled:
        fileConfig.domainTrust?.enabled ??
        envConfig.domainTrust?.enabled ??
        DEFAULTS.domainTrust.enabled,
      trustedDomains:
        fileConfig.domainTrust?.trustedDomains ??
        envConfig.domainTrust?.trustedDomains ??
        DEFAULTS.domainTrust.trustedDomains,
      blockedDomains:
        fileConfig.domainTrust?.blockedDomains ??
        envConfig.domainTrust?.blockedDomains ??
        DEFAULTS.domainTrust.blockedDomains,
    },
    scrubContent: fileConfig.scrubContent ?? envConfig.scrubContent ?? DEFAULTS.scrubContent,
    llm: {
      provider: fileConfig.llm?.provider ?? envConfig.llm?.provider ?? DEFAULTS.llm.provider,
      apiToken: fileConfig.llm?.apiToken ?? envConfig.llm?.apiToken ?? DEFAULTS.llm.apiToken,
      baseUrl: fileConfig.llm?.baseUrl ?? envConfig.llm?.baseUrl ?? DEFAULTS.llm.baseUrl,
    },
    raga: {
      enabled: fileConfig.raga?.enabled ?? envConfig.raga?.enabled ?? DEFAULTS.raga.enabled,
      baseUrl: fileConfig.raga?.baseUrl ?? envConfig.raga?.baseUrl ?? DEFAULTS.raga.baseUrl,
      timeoutMs: fileConfig.raga?.timeoutMs ?? envConfig.raga?.timeoutMs ?? DEFAULTS.raga.timeoutMs,
      maxRetries:
        fileConfig.raga?.maxRetries ?? envConfig.raga?.maxRetries ?? DEFAULTS.raga.maxRetries,
      cacheEnabled:
        fileConfig.raga?.cacheEnabled ?? envConfig.raga?.cacheEnabled ?? DEFAULTS.raga.cacheEnabled,
      defaultParser:
        fileConfig.raga?.defaultParser ??
        envConfig.raga?.defaultParser ??
        DEFAULTS.raga.defaultParser,
    },
    rescoreWeights: DEFAULT_RESCORE_WEIGHTS,
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
  const clientId = (fileReddit?.clientId ?? envReddit?.clientId ?? DEFAULTS.reddit.clientId).trim();
  const clientSecret = (
    fileReddit?.clientSecret ??
    envReddit?.clientSecret ??
    DEFAULTS.reddit.clientSecret
  ).trim();
  const userAgent = (
    fileReddit?.userAgent ??
    envReddit?.userAgent ??
    DEFAULTS.reddit.userAgent
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
