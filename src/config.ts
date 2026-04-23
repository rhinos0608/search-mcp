/**
 * Encrypted config loader for API keys.
 *
 * Resolution order:
 *   1. Encrypted config file (config.enc) decrypted via SEARCH_MCP_CONFIG_KEY env var
 *   2. Individual env vars (BRAVE_API_KEY, SEARXNG_BASE_URL, SEARCH_BACKEND)
 *   3. Defaults (Brave as default backend)
 */

import { readFileSync, existsSync } from 'node:fs';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

/** Directory containing this file (dist/ or src/). Go up one level to reach project root. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export type SearchBackend = 'brave' | 'searxng';

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
  const knownKeys = ['recency', 'citations', 'engagement', 'commentEngagement', 'venue', 'hasDeepLinks'] as const;
  const otherWeights = knownKeys
    .map((k) => weights[k])
    .filter((v): v is number => v !== undefined);
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
  academicSearch: { rrfAnchor: 0.5, recency: 0.05, citations: 0.3, venue: 0.15 },
  hackernewsSearch: { rrfAnchor: 0.5, recency: 0.15, engagement: 0.2, commentEngagement: 0.15 },
  redditSearch: { rrfAnchor: 0.5, recency: 0.1, engagement: 0.25, commentEngagement: 0.15 },
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

export interface Crawl4aiConfig {
  baseUrl: string;
  apiToken: string;
}

export interface EmbeddingSidecarConfig {
  baseUrl: string;
  apiToken: string;
  dimensions: number;
}

export interface SemanticCrawlConfig {
  defaultMaxBytes: number;
  maxMaxBytes: number;
}

export interface SearchConfig {
  searchBackend: SearchBackend;
  brave: { apiKey: string };
  searxng: { baseUrl: string };
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
  rescoreWeights: RescoreConfig;
}

const DEFAULTS: Omit<SearchConfig, 'rescoreWeights'> = {
  searchBackend: 'searxng',
  brave: { apiKey: '' },
  searxng: { baseUrl: '' },
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
  embeddingSidecar: { baseUrl: '', apiToken: '', dimensions: 768 },
  semanticCrawl: { defaultMaxBytes: 50_000_000, maxMaxBytes: 200_000_000 },
};

const VALID_BACKENDS = new Set<string>(['brave', 'searxng']);

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

type EnvConfig = Omit<Partial<SearchConfig>, 'reddit' | 'crawl4ai' | 'github' | 'embeddingSidecar' | 'semanticCrawl'> & {
  reddit?: Partial<RedditConfig>;
  crawl4ai?: Partial<Crawl4aiConfig>;
  github?: Partial<GitHubConfig>;
  embeddingSidecar?: Partial<EmbeddingSidecarConfig>;
  semanticCrawl?: Partial<SemanticCrawlConfig>;
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
  if (embeddingSidecarUrl !== undefined || embeddingSidecarToken !== undefined || embeddingDimensions !== undefined) {
    const esc: Partial<EmbeddingSidecarConfig> = {};
    if (embeddingSidecarUrl !== undefined) esc.baseUrl = embeddingSidecarUrl;
    if (embeddingSidecarToken !== undefined) esc.apiToken = embeddingSidecarToken;
    if (embeddingDimensions !== undefined) {
      const dims = Number(embeddingDimensions);
      if ([128, 256, 512, 768].includes(dims)) {
        esc.dimensions = dims;
      }
    }
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
      logger.info({ hasToken: fileConfig.github?.token ? true : false }, 'Loaded encrypted config from config.enc');
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
    searchBackend: envConfig.searchBackend ?? fileConfig.searchBackend ?? DEFAULTS.searchBackend,
    brave: {
      apiKey: envConfig.brave?.apiKey ?? fileConfig.brave?.apiKey ?? DEFAULTS.brave.apiKey,
    },
    searxng: {
      baseUrl:
        envConfig.searxng?.baseUrl ?? fileConfig.searxng?.baseUrl ?? DEFAULTS.searxng.baseUrl,
    },
    nitter: {
      baseUrl: envConfig.nitter?.baseUrl ?? fileConfig.nitter?.baseUrl ?? DEFAULTS.nitter.baseUrl,
    },
    listennotes: {
      apiKey:
        envConfig.listennotes?.apiKey ??
        fileConfig.listennotes?.apiKey ??
        DEFAULTS.listennotes.apiKey,
    },
    producthunt: {
      apiToken:
        envConfig.producthunt?.apiToken ??
        fileConfig.producthunt?.apiToken ??
        DEFAULTS.producthunt.apiToken,
    },
    patentsview: {
      apiKey:
        envConfig.patentsview?.apiKey ??
        fileConfig.patentsview?.apiKey ??
        DEFAULTS.patentsview.apiKey,
    },
    youtube: {
      apiKey: envConfig.youtube?.apiKey ?? fileConfig.youtube?.apiKey ?? DEFAULTS.youtube.apiKey,
    },
    stackexchange: {
      apiKey:
        envConfig.stackexchange?.apiKey ??
        fileConfig.stackexchange?.apiKey ??
        DEFAULTS.stackexchange.apiKey,
    },
    github: {
      token: envConfig.github?.token ?? fileConfig.github?.token ?? DEFAULTS.github.token,
    },
    reddit: resolveRedditConfig(envConfig.reddit, fileConfig.reddit),
    crawl4ai: {
      baseUrl:
        envConfig.crawl4ai?.baseUrl ?? fileConfig.crawl4ai?.baseUrl ?? DEFAULTS.crawl4ai.baseUrl,
      apiToken:
        envConfig.crawl4ai?.apiToken ??
        fileConfig.crawl4ai?.apiToken ??
        DEFAULTS.crawl4ai.apiToken,
    },
    embeddingSidecar: {
      baseUrl: envConfig.embeddingSidecar?.baseUrl ?? fileConfig.embeddingSidecar?.baseUrl ?? DEFAULTS.embeddingSidecar.baseUrl,
      apiToken: envConfig.embeddingSidecar?.apiToken ?? fileConfig.embeddingSidecar?.apiToken ?? DEFAULTS.embeddingSidecar.apiToken,
      dimensions: envConfig.embeddingSidecar?.dimensions ?? fileConfig.embeddingSidecar?.dimensions ?? DEFAULTS.embeddingSidecar.dimensions,
    },
    semanticCrawl: {
      defaultMaxBytes: envConfig.semanticCrawl?.defaultMaxBytes ?? fileConfig.semanticCrawl?.defaultMaxBytes ?? DEFAULTS.semanticCrawl.defaultMaxBytes,
      maxMaxBytes: envConfig.semanticCrawl?.maxMaxBytes ?? fileConfig.semanticCrawl?.maxMaxBytes ?? DEFAULTS.semanticCrawl.maxMaxBytes,
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

  logger.info({ backend: cached.searchBackend }, 'Search config loaded');
  return cached;
}

function resolveRedditConfig(
  envReddit: Partial<RedditConfig> | undefined,
  fileReddit: Partial<RedditConfig> | undefined,
): RedditConfig {
  // Trim whitespace so values like `REDDIT_CLIENT_ID=' '` (common with
  // misquoted .env lines) are treated as unset rather than partial config.
  const clientId = (envReddit?.clientId ?? fileReddit?.clientId ?? DEFAULTS.reddit.clientId).trim();
  const clientSecret = (
    envReddit?.clientSecret ??
    fileReddit?.clientSecret ??
    DEFAULTS.reddit.clientSecret
  ).trim();
  const userAgent = (
    envReddit?.userAgent ??
    fileReddit?.userAgent ??
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
