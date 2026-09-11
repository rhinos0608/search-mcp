import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { encryptConfig, decryptConfig } from './crypto.js';
import { loadConfig, resetConfig } from '../config.js';
import type { SearchConfig } from '../config.js';
import { safeFetch } from '../httpGuards.js';
import type { SafeFetchOptions } from '../httpGuards.js';
import { MUTABLE_CONFIG_KEYS } from './types.js';
import type {
  AccessConfig,
  ConfigPatch,
  FieldPatch,
  ProviderTestResult,
  RedactedConfig,
} from './types.js';

/** Fields whose string values are redacted in getRedacted() output. */
const SECRET_LEAF_PATHS = new Set([
  'mcpApiKey',
  'brave.apiKey',
  'exa.apiKey',
  'tavily.apiKey',
  'jina.apiKey',
  'firecrawl.apiKey',
  'diffbot.apiKey',
  'youtube.apiKey',
  'stackexchange.apiKey',
  'github.token',
  'reddit.clientId',
  'reddit.clientSecret',
  'crawl4ai.apiToken',
  'embeddingSidecar.apiToken',
  'llm.apiToken',
]);

/** Key-name suffixes that indicate a credential value to redact under browser.credentials. */
const CREDENTIAL_KEY_PATTERN = /^(password|totpSecret|totp)$/i;

/**
 * Build the health-check endpoint URL for an operator-configured sidecar.
 * Returns null for malformed or non-http(s) base URLs.
 */
function buildHealthUrl(baseUrl: string, path: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${path}`;
  } catch {
    return null;
  }
}

/**
 * Map testConnection failures to sanitized, actionable messages.
 * Never includes internal error detail, URLs, headers, or tokens.
 */
function sanitizeTestConnectionError(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (
    /Invalid URL|Blocked|private|reserved|allowlist|requires configured endpoint|No DNS answers|invalid address or family/i.test(
      message,
    )
  ) {
    return 'Blocked unsafe URL';
  }
  if (/deadline|aborted|timeout|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return 'Connection timed out';
  }
  if (/size limit/i.test(message)) {
    return 'Response too large';
  }
  return 'Connection failed';
}

/**
 * Deep merge two config objects.
 *
 * Rules:
 * - String fields: raw takes priority when non-empty; empty raw strings
 *   leave the default in place. This prevents an older config.enc with empty
 *   placeholder strings from erasing values added to config.json or env vars.
 * - Null in raw: treated as "absent" for string defaults — the non-empty
 *   default is kept. For non-string defaults, null overrides (explicitly
 *   clearing a value is intentional).
 * - Nested objects: recursed.
 * - Arrays: replaced wholesale (not merged). If you need partial array
 *   updates, apply them before calling this function.
 */
function deepMergePreferNonEmpty<T extends object>(defaults: T, raw: Partial<T>): T {
  const result = { ...defaults } as Record<string, unknown>;
  for (const [key, rawVal] of Object.entries(raw as Record<string, unknown>)) {
    if (rawVal === undefined) continue; // treat absent-in-raw as "use default"
    const defVal = (defaults as Record<string, unknown>)[key];
    if (
      typeof rawVal === 'string' &&
      rawVal === '' &&
      typeof defVal === 'string' &&
      defVal !== ''
    ) {
      // Empty raw placeholder — keep the default value from config.json/env
    } else if (rawVal === null && typeof defVal === 'string' && defVal !== '') {
      // Null raw with non-empty string default — keep the default
    } else if (
      rawVal !== null &&
      typeof rawVal === 'object' &&
      !Array.isArray(rawVal) &&
      defVal !== null &&
      typeof defVal === 'object' &&
      !Array.isArray(defVal)
    ) {
      result[key] = deepMergePreferNonEmpty(
        defVal as Record<string, unknown>,
        rawVal as Record<string, unknown>,
      );
    } else {
      result[key] = rawVal;
    }
  }
  return result as unknown as T;
}

function redactValue(path: string, value: unknown): unknown {
  if (typeof value === 'string' && value.length > 0) {
    if (SECRET_LEAF_PATHS.has(path)) return '•••';
    // Redact credential keys under browser.credentials (password, totpSecret, totp)
    if (
      path.includes('.credentials.') &&
      CREDENTIAL_KEY_PATTERN.test(path.split('.').pop() ?? '')
    ) {
      return '•••';
    }
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
    case 'keep':
      return existing;
    case 'set':
      return patch.value;
    case 'clear':
      return '';
  }
}

// ── Config value validation ────────────────────────────────────────────

const VALID_SEARCH_BACKENDS = new Set([
  'brave',
  'searxng',
  'exa',
  'duckduckgo',
  'ollama-search',
  'tavily',
  'codex',
  'jina',
  'firecrawl',
  'diffbot',
]);

const VALID_EMBEDDING_PROVIDERS = new Set(['sidecar', 'ollama', 'transformers', 'openai']);

/**
 * Validate critical config values after a dashboard patch.
 * Returns null if valid, or an error message string.
 *
 * This is a lightweight gate — it doesn't check every field exhaustively.
 * The goal is to catch obviously-wrong values before they're persisted
 * (e.g. a bad search backend name set via the dashboard).
 */
function validateConfigValues(cfg: Record<string, unknown>): string | null {
  // searchBackend MUST be a recognized value
  if (typeof cfg.searchBackend === 'string') {
    if (!VALID_SEARCH_BACKENDS.has(cfg.searchBackend)) {
      return `searchBackend must be one of: ${[...VALID_SEARCH_BACKENDS].join(', ')}`;
    }
  }

  // embeddingSidecar.provider
  const esc = cfg.embeddingSidecar as Record<string, unknown> | undefined;
  if (esc && typeof esc.provider === 'string') {
    if (!VALID_EMBEDDING_PROVIDERS.has(esc.provider)) {
      return `embeddingSidecar.provider must be one of: ${[...VALID_EMBEDDING_PROVIDERS].join(', ')}`;
    }
  }

  // Boolean fields must actually be booleans (not strings like "true")
  const booleanFields = ['scrubContent', 'apiKeyClaimed'];
  for (const field of booleanFields) {
    const val = cfg[field];
    if (val !== undefined && val !== null && typeof val !== 'boolean') {
      return `${field} must be a boolean, got ${typeof val}`;
    }
  }

  // firecrawl.scrapeFallback.enabled gates the billable web_crawl Firecrawl
  // fallback; a string value (e.g. "false" from a dashboard patch) would be
  // truthy-coerced at the runtime gate, silently opening the gate.
  const firecrawl = cfg.firecrawl as Record<string, unknown> | undefined;
  const scrapeFallback = firecrawl?.scrapeFallback as Record<string, unknown> | undefined;
  const fallbackEnabled = scrapeFallback?.enabled;
  if (
    fallbackEnabled !== undefined &&
    fallbackEnabled !== null &&
    typeof fallbackEnabled !== 'boolean'
  ) {
    return `firecrawl.scrapeFallback.enabled must be a boolean, got ${typeof fallbackEnabled}`;
  }

  // URL-ish fields: empty string is fine (not configured), but non-empty
  // strings should not be obviously garbage
  const urlFields: [string, string | undefined][] = [];
  if (esc) {
    urlFields.push(['embeddingSidecar.baseUrl', esc.baseUrl as string | undefined]);
  }
  const crawl4ai = cfg.crawl4ai as Record<string, unknown> | undefined;
  if (crawl4ai) {
    urlFields.push(['crawl4ai.baseUrl', crawl4ai.baseUrl as string | undefined]);
  }
  const searxng = cfg.searxng as Record<string, unknown> | undefined;
  if (searxng) {
    urlFields.push(['searxng.baseUrl', searxng.baseUrl as string | undefined]);
  }
  for (const [name, value] of urlFields) {
    if (typeof value === 'string' && value.length > 0) {
      if (!value.startsWith('http://') && !value.startsWith('https://')) {
        return `${name} must start with http:// or https://`;
      }
    }
  }

  return null;
}

// Project root: dist/config/manager.js → resolve two levels up
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface ConfigManagerOptions {
  configDir?: string; // defaults to directory containing this module's project root
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
    const dir = opts.configDir ?? MODULE_ROOT;
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
    // Merge with defaults (config.json + env vars) so:
    // 1. New fields added after config.enc was created get their defaults.
    // 2. Non-empty values from config.json/env show through when config.enc has
    //    an empty placeholder (e.g. crawl4ai.baseUrl added to config.json after
    //    config.enc was first created).
    resetConfig();
    const defaults = loadConfig();
    this.config = deepMergePreferNonEmpty<SearchConfig>(defaults, raw);
  }

  get(): Readonly<SearchConfig> {
    if (!this.config) throw new Error('ConfigManager.load() must be called before get()');
    return this.config;
  }

  getRedacted(): RedactedConfig {
    return redactValue('', this.get()) as RedactedConfig;
  }

  /** Write encrypted config to disk, update in-memory manager state, and invalidate the runtime cache. */
  private persistEncryptedConfig(cfg: SearchConfig): void {
    const password = process.env.SEARCH_MCP_CONFIG_KEY;
    if (!password) throw new Error('SEARCH_MCP_CONFIG_KEY not set; cannot persist config update');
    this._writeEncrypted(cfg, password);
    this.config = cfg;
    // The runtime config cache (loadConfig) must observe the persisted change
    // on the next read without a restart. Env vars still take precedence in
    // the reload merge, so no other dynamic config behavior changes.
    resetConfig();
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

    // Preserve marker for readers of older encrypted config. Backend selection
    // now controls fallback order only; all configured providers still run.
    const backendPatch = patch.searchBackend;
    if (backendPatch !== undefined && 'op' in backendPatch && backendPatch.op === 'set') {
      updated.searchBackendExplicit = true;
    }

    // Validate the patched config before persisting.
    // This catches invalid values that MUTABLE_CONFIG_KEYS alone doesn't guard.
    const validationError = validateConfigValues(updated as unknown as Record<string, unknown>);
    if (validationError !== null) {
      throw new Error(`Invalid config: ${validationError}`);
    }

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

  async testConnection(
    provider: string,
    inject: {
      /** Test hooks mirroring SafeFetchOptions; production callers omit these. */
      resolver?: SafeFetchOptions['resolver'];
      request?: SafeFetchOptions['request'];
    } = {},
  ): Promise<ProviderTestResult> {
    const cfg = this.get();
    const start = Date.now();
    const fail = (error: string): ProviderTestResult => ({
      provider,
      ok: false,
      error,
      latencyMs: Date.now() - start,
    });
    try {
      switch (provider) {
        case 'searxng':
          return await this.testSidecarHealth(
            provider,
            cfg.searxng.baseUrl,
            '/healthz',
            start,
            inject,
          );
        case 'crawl4ai':
          return await this.testSidecarHealth(
            provider,
            cfg.crawl4ai.baseUrl,
            '/health',
            start,
            inject,
          );
        case 'brave': {
          if (!cfg.brave.apiKey) return { provider, ok: false, error: 'Not configured' };
          // Brave is a public API, not an operator sidecar: public policy so a
          // redirect to loopback/private/metadata is re-checked and blocked.
          const opts: SafeFetchOptions = {
            timeoutMs: 5000,
            maxBytes: 64 * 1024,
            networkPolicy: 'public',
          };
          if (inject.resolver !== undefined) opts.resolver = inject.resolver;
          if (inject.request !== undefined) opts.request = inject.request;
          const r = await safeFetch(
            'https://api.search.brave.com/res/v1/web/search?q=test&count=1',
            { headers: { 'X-Subscription-Token': cfg.brave.apiKey } },
            opts,
          );
          const ok = r.status >= 200 && r.status < 300;
          return ok
            ? { provider, ok, latencyMs: Date.now() - start }
            : {
                provider,
                ok,
                error: `HTTP ${String(r.status)}`,
                latencyMs: Date.now() - start,
              };
        }
        default:
          return { provider, ok: false, error: `No test available for provider "${provider}"` };
      }
    } catch (err) {
      return fail(sanitizeTestConnectionError(err));
    }
  }

  /**
   * Shared health-check probe for operator-configured sidecars (searxng,
   * crawl4ai). Pins the operator_internal network policy to the configured
   * hostname, forwards test hooks, and reports the HTTP status on non-2xx
   * responses. Transport errors propagate to the caller's sanitizer.
   */
  private async testSidecarHealth(
    provider: string,
    baseUrl: string,
    path: string,
    start: number,
    inject: {
      resolver?: SafeFetchOptions['resolver'];
      request?: SafeFetchOptions['request'];
    },
  ): Promise<ProviderTestResult> {
    if (!baseUrl) return { provider, ok: false, error: 'Not configured' };
    const health = buildHealthUrl(baseUrl, path);
    if (!health) {
      return { provider, ok: false, error: 'Invalid URL', latencyMs: Date.now() - start };
    }
    // operator_internal: operator-configured sidecar, hostname-pinned to
    // the configured base URL. Redirects to any other host fail the allowlist.
    const opts: SafeFetchOptions = {
      timeoutMs: 5000,
      maxBytes: 64 * 1024,
      networkPolicy: 'operator_internal',
      internalAllowlist: [new URL(health).hostname],
    };
    if (inject.resolver !== undefined) opts.resolver = inject.resolver;
    if (inject.request !== undefined) opts.request = inject.request;
    const r = await safeFetch(health, {}, opts);
    const ok = r.status >= 200 && r.status < 300;
    return ok
      ? { provider, ok, latencyMs: Date.now() - start }
      : { provider, ok, error: `HTTP ${String(r.status)}`, latencyMs: Date.now() - start };
  }

  private _writeEncrypted(cfg: SearchConfig, password: string): void {
    const buf = encryptConfig(cfg, password);
    const tmp = `${this.configPath}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, this.configPath); // atomic on most OS
  }
}
