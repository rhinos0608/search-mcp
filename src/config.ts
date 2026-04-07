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
}

const DEFAULTS: SearchConfig = {
  searchBackend: 'brave',
  brave: { apiKey: '' },
  searxng: { baseUrl: '' },
  nitter: { baseUrl: '' },
  listennotes: { apiKey: '' },
  producthunt: { apiToken: '' },
  patentsview: { apiKey: '' },
  youtube: { apiKey: '' },
  stackexchange: { apiKey: '' },
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

function loadFromEnv(): Partial<SearchConfig> {
  const cfg: Partial<SearchConfig> = {};

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

  return cfg;
}

let cached: SearchConfig | undefined;

export function loadConfig(): SearchConfig {
  if (cached) return cached;

  let fileConfig: Partial<SearchConfig> = {};

  const encPath = join(PKG_ROOT, 'config.enc');
  const configKey = process.env.SEARCH_MCP_CONFIG_KEY;

  if (existsSync(encPath) && configKey) {
    try {
      fileConfig = decryptConfigFile(encPath, configKey);
      logger.info('Loaded encrypted config from config.enc');
    } catch (err) {
      logger.warn({ err }, 'Failed to decrypt config.enc — falling back to env vars');
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
  };

  logger.info({ backend: cached.searchBackend }, 'Search config loaded');
  return cached;
}

/** Reset cached config (for testing). */
export function resetConfig(): void {
  cached = undefined;
}
