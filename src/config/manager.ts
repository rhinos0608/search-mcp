import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptConfig, decryptConfig } from './crypto.js';
import { loadConfig, resetConfig } from '../config.js';
import type { SearchConfig } from '../config.js';
import { MUTABLE_CONFIG_KEYS } from './types.js';
import type { AccessConfig, ConfigPatch, FieldPatch, ProviderTestResult, RedactedConfig } from './types.js';

/** Fields whose string values are redacted in getRedacted() output. */
const SECRET_LEAF_PATHS = new Set([
  'mcpApiKey',
  'brave.apiKey', 'exa.apiKey', 'tavily.apiKey', 'youtube.apiKey',
  'stackexchange.apiKey', 'github.token',
  'reddit.clientId', 'reddit.clientSecret',
  'crawl4ai.apiToken', 'embeddingSidecar.apiToken',
  'llm.apiToken', 'raga.apiToken',
]);

function redactValue(path: string, value: unknown): unknown {
  if (typeof value === 'string' && value.length > 0 && SECRET_LEAF_PATHS.has(path)) {
    return '•••';
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        redactValue(path ? `${path}.${k}` : k, v),
      ]),
    );
  }
  return value;
}

function applyFieldPatch(existing: unknown, patch: FieldPatch): unknown {
  switch (patch.op) {
    case 'keep': return existing;
    case 'set':  return patch.value;
    case 'clear': return '';
  }
}

export interface ConfigManagerOptions {
  configDir?: string;  // defaults to process.cwd()
}

export class ConfigKeyMissingError extends Error {
  constructor() {
    super(
      'SEARCH_MCP_CONFIG_KEY env var is required when config.enc exists. ' +
      'Set it to your encryption password and restart.',
    );
    this.name = 'ConfigKeyMissingError';
  }
}

export class ConfigManager {
  private config: SearchConfig | undefined;
  private readonly configPath: string;

  constructor(opts: ConfigManagerOptions = {}) {
    const dir = opts.configDir ?? process.cwd();
    this.configPath = join(dir, 'config.enc');
  }

  load(): void {
    const password = process.env.SEARCH_MCP_CONFIG_KEY;
    const encExists = existsSync(this.configPath);

    if (!password) {
      throw new ConfigKeyMissingError();
    }

    if (!encExists) {
      // First run: generate fresh config + API key; key is shown via dashboard setup screen
      resetConfig();
      const fresh = loadConfig();
      fresh.mcpApiKey = randomBytes(32).toString('base64url');
      fresh.apiKeyClaimed = false;
      this._writeEncrypted(fresh, password);
      this.config = fresh;
      return;
    }

    const buf = readFileSync(this.configPath);
    const raw = decryptConfig(buf, password) as Partial<SearchConfig>;
    // Merge with defaults to handle any new fields added after this file was created
    resetConfig();
    this.config = { ...loadConfig(), ...raw };
  }

  get(): Readonly<SearchConfig> {
    if (!this.config) throw new Error('ConfigManager.load() must be called before get()');
    return this.config;
  }

  getRedacted(): RedactedConfig {
    return redactValue('', this.get()) as RedactedConfig;
  }

  /** Write encrypted config to disk and update in-memory cache. */
  private persistEncryptedConfig(cfg: SearchConfig): void {
    const password = process.env.SEARCH_MCP_CONFIG_KEY;
    if (!password) throw new Error('SEARCH_MCP_CONFIG_KEY not set; cannot persist config update');
    this._writeEncrypted(cfg, password);
    this.config = cfg;
  }

  update(patch: ConfigPatch): void {
    // Validate: no unknown keys
    for (const key of Object.keys(patch)) {
      if (!MUTABLE_CONFIG_KEYS.has(key as never)) {
        throw new Error(`Config key "${key}" is not allowed via dashboard update`);
      }
    }

    const cfg = { ...this.get() } as Record<string, unknown>;
    for (const [topKey, fieldPatch] of Object.entries(patch)) {
      const existing = cfg[topKey] as Record<string, unknown> | undefined;
      if ('op' in fieldPatch) {
        // Top-level scalar patch
        cfg[topKey] = applyFieldPatch(existing, fieldPatch as FieldPatch);
      } else {
        // Nested object patch
        const nested = { ...(existing ?? {}) } as Record<string, unknown>;
        for (const [subKey, subPatch] of Object.entries(fieldPatch)) {
          nested[subKey] = applyFieldPatch(nested[subKey], subPatch);
        }
        cfg[topKey] = nested;
      }
    }

    const updated = cfg as unknown as SearchConfig;
    this.persistEncryptedConfig(updated);
  }

  setAccess(access: AccessConfig): void {
    this.persistEncryptedConfig({ ...this.get(), access });
  }

  claimApiKey(): void {
    this.persistEncryptedConfig({ ...this.get(), apiKeyClaimed: true });
  }

  rotateApiKey(): string {
    const newKey = randomBytes(32).toString('base64url');
    this.persistEncryptedConfig({ ...this.get(), mcpApiKey: newKey });
    return newKey;
  }

  async testConnection(provider: string): Promise<ProviderTestResult> {
    const cfg = this.get();
    const start = Date.now();
    try {
      switch (provider) {
        case 'searxng': {
          const url = cfg.searxng.baseUrl;
          if (!url) return { provider, ok: false, error: 'Not configured' };
          const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
          return { provider, ok: r.ok, latencyMs: Date.now() - start };
        }
        case 'crawl4ai': {
          const url = cfg.crawl4ai.baseUrl;
          if (!url) return { provider, ok: false, error: 'Not configured' };
          const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
          return { provider, ok: r.ok, latencyMs: Date.now() - start };
        }
        case 'brave': {
          if (!cfg.brave.apiKey) return { provider, ok: false, error: 'Not configured' };
          const r = await fetch('https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
            headers: { 'X-Subscription-Token': cfg.brave.apiKey },
            signal: AbortSignal.timeout(5000),
          });
          return { provider, ok: r.ok, latencyMs: Date.now() - start };
        }
        default:
          return { provider, ok: false, error: `No test available for provider "${provider}"` };
      }
    } catch (err) {
      return { provider, ok: false, error: String(err), latencyMs: Date.now() - start };
    }
  }

  private _writeEncrypted(cfg: SearchConfig, password: string): void {
    const buf = encryptConfig(cfg, password);
    const tmp = `${this.configPath}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, this.configPath); // atomic on most OS
  }
}
