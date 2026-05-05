/**
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

/** Load .env from the project root if present. Only sets vars not already in the environment. */
function loadDotEnv(pkgRoot: string): void {
   const envPath = join(pkgRoot, '.env');
   if (!existsSync(envPath)) return;
   try {
      const lines = readFileSync(envPath, 'utf8').split('\n');
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
   /** OpenAI-compatible base URL for the LLM used by deep research. */
   baseUrl: string;
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
   rescoreWeights: RescoreConfig;
   challengeLatencyThreshold: number;
}

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
      model: '',
      workerModel: '',
      apiToken: '',
      treeBreadth: 4,
      treeDepth: 2,
      treeConcurrency: 2,
      treeContextWordLimit: 25000,
   },
   challengeLatencyThreshold: 5000,
};

const VALID_BACKENDS = new Set<string>([
   'brave',
   'searxng',
   'exa',
   'duckduckgo',
   'ollama-search',
   'tavily',
]);

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
   | 'duckduckgo'
   | 'ollamaSearch'
> & {
   challengeLatencyThreshold?: number;
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

   // ── Deep Research env vars ────────────────────────────────────────────
   {
      const partial: Record<string, unknown> = {};
      let hasAny = false;
      const e = process.env.DEEP_RESEARCH_ENABLED;
      if (e !== undefined) {
         partial.enabled = e === 'true';
         hasAny = true;
      }
      const u = process.env.DEEP_RESEARCH_BASE_URL;
      if (u !== undefined) {
         partial.baseUrl = u;
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
         partial.defaultDepth = d;
         hasAny = true;
      }
      if (hasAny) {
         // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
         cfg.deepResearch = { ...(cfg.deepResearch ?? {}), ...partial } as any;
      }
   }

   const challengeLatencyThreshold = process.env.CHALLENGE_LATENCY_THRESHOLD;
   if (challengeLatencyThreshold !== undefined) {
      const n = Number(challengeLatencyThreshold);
      if (!isNaN(n)) cfg.challengeLatencyThreshold = n;
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
         const encryptedConfig = decryptConfigFile(encPath, configKey);
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
      searchBackend: fileConfig.searchBackend ?? envConfig.searchBackend ?? DEFAULTS.searchBackend,
      brave: {
         apiKey: fileConfig.brave?.apiKey ?? envConfig.brave?.apiKey ?? DEFAULTS.brave.apiKey ?? '',
      },
      searxng: {
         baseUrl:
            fileConfig.searxng?.baseUrl ?? envConfig.searxng?.baseUrl ?? DEFAULTS.searxng.baseUrl,
      },
      exa: {
         apiKey: fileConfig.exa?.apiKey ?? envConfig.exa?.apiKey ?? DEFAULTS.exa.apiKey ?? '',
      },
      tavily: {
         apiKey: fileConfig.tavily?.apiKey ?? envConfig.tavily?.apiKey ?? DEFAULTS.tavily.apiKey ?? '',
      },
      youtube: {
         apiKey:
            fileConfig.youtube?.apiKey ?? envConfig.youtube?.apiKey ?? DEFAULTS.youtube.apiKey ?? '',
      },
      stackexchange: {
         apiKey:
            fileConfig.stackexchange?.apiKey ??
            envConfig.stackexchange?.apiKey ??
            DEFAULTS.stackexchange.apiKey ??
            '',
      },
      github: {
         token: fileConfig.github?.token ?? envConfig.github?.token ?? DEFAULTS.github.token ?? '',
      },
      reddit: resolveRedditConfig(fileConfig.reddit, envConfig.reddit),
      crawl4ai: {
         baseUrl:
            fileConfig.crawl4ai?.baseUrl ?? envConfig.crawl4ai?.baseUrl ?? DEFAULTS.crawl4ai.baseUrl,
         apiToken:
            fileConfig.crawl4ai?.apiToken ??
            envConfig.crawl4ai?.apiToken ??
            DEFAULTS.crawl4ai.apiToken ??
            '',
      },
      embeddingSidecar: {
         provider:
            fileConfig.embeddingSidecar?.provider ??
            envConfig.embeddingSidecar?.provider ??
            DEFAULTS.embeddingSidecar.provider,
         baseUrl:
            fileConfig.embeddingSidecar?.baseUrl ??
            envConfig.embeddingSidecar?.baseUrl ??
            DEFAULTS.embeddingSidecar.baseUrl,
         apiToken:
            fileConfig.embeddingSidecar?.apiToken ??
            envConfig.embeddingSidecar?.apiToken ??
            DEFAULTS.embeddingSidecar.apiToken ??
            '',
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
         apiToken: fileConfig.llm?.apiToken ?? envConfig.llm?.apiToken ?? DEFAULTS.llm.apiToken ?? '',
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
      duckduckgo: {
         region:
            fileConfig.duckduckgo?.region ?? envConfig.duckduckgo?.region ?? DEFAULTS.duckduckgo.region,
         safeSearch:
            fileConfig.duckduckgo?.safeSearch ??
            envConfig.duckduckgo?.safeSearch ??
            DEFAULTS.duckduckgo.safeSearch,
      },
      ollamaSearch: {
         baseUrl:
            fileConfig.ollamaSearch?.baseUrl ??
            envConfig.ollamaSearch?.baseUrl ??
            DEFAULTS.ollamaSearch.baseUrl,
         apiKey:
            fileConfig.ollamaSearch?.apiKey ??
            envConfig.ollamaSearch?.apiKey ??
            DEFAULTS.ollamaSearch.apiKey ??
            '',
      },
      challengeLatencyThreshold:
         fileConfig.challengeLatencyThreshold ??
         envConfig.challengeLatencyThreshold ??
         DEFAULTS.challengeLatencyThreshold,
      deepResearch: {
         enabled:
            fileConfig.deepResearch?.enabled ??
            envConfig.deepResearch?.enabled ??
            DEFAULTS.deepResearch.enabled,
         defaultDepth:
            fileConfig.deepResearch?.defaultDepth ??
            envConfig.deepResearch?.defaultDepth ??
            DEFAULTS.deepResearch.defaultDepth,
         maxDepth:
            fileConfig.deepResearch?.maxDepth ??
            envConfig.deepResearch?.maxDepth ??
            DEFAULTS.deepResearch.maxDepth,
         maxToolCalls:
            fileConfig.deepResearch?.maxToolCalls ??
            envConfig.deepResearch?.maxToolCalls ??
            DEFAULTS.deepResearch.maxToolCalls,
         maxTokens:
            fileConfig.deepResearch?.maxTokens ??
            envConfig.deepResearch?.maxTokens ??
            DEFAULTS.deepResearch.maxTokens,
         maxTimeMs:
            fileConfig.deepResearch?.maxTimeMs ??
            envConfig.deepResearch?.maxTimeMs ??
            DEFAULTS.deepResearch.maxTimeMs,
         baseUrl:
            fileConfig.deepResearch?.baseUrl ??
            envConfig.deepResearch?.baseUrl ??
            DEFAULTS.deepResearch.baseUrl,
         model:
            fileConfig.deepResearch?.model ??
            envConfig.deepResearch?.model ??
            DEFAULTS.deepResearch.model,
         workerModel:
            fileConfig.deepResearch?.workerModel ??
            envConfig.deepResearch?.workerModel ??
            DEFAULTS.deepResearch.workerModel,
         apiToken:
            fileConfig.deepResearch?.apiToken ??
            envConfig.deepResearch?.apiToken ??
            DEFAULTS.deepResearch.apiToken,
         treeBreadth:
            fileConfig.deepResearch?.treeBreadth ??
            envConfig.deepResearch?.treeBreadth ??
            DEFAULTS.deepResearch.treeBreadth,
         treeDepth:
            fileConfig.deepResearch?.treeDepth ??
            envConfig.deepResearch?.treeDepth ??
            DEFAULTS.deepResearch.treeDepth,
         treeConcurrency:
            fileConfig.deepResearch?.treeConcurrency ??
            envConfig.deepResearch?.treeConcurrency ??
            DEFAULTS.deepResearch.treeConcurrency,
         treeContextWordLimit:
            fileConfig.deepResearch?.treeContextWordLimit ??
            envConfig.deepResearch?.treeContextWordLimit ??
            DEFAULTS.deepResearch.treeContextWordLimit,
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
   const clientId = (
      fileReddit?.clientId ??
      envReddit?.clientId ??
      DEFAULTS.reddit.clientId ??
      ''
   ).trim();
   const clientSecret = (
      fileReddit?.clientSecret ??
      envReddit?.clientSecret ??
      DEFAULTS.reddit.clientSecret ??
      ''
   ).trim();
   const userAgent = (
      fileReddit?.userAgent ??
      envReddit?.userAgent ??
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
