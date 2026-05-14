import type { SearchConfig } from '../config.js';

// ---------- Patch semantics ----------

export type FieldPatch =
  | { op: 'keep' }
  | { op: 'set'; value: string }
  | { op: 'clear' };

/** Allowed top-level mutable config keys. Unknown keys rejected by ConfigManager.update(). */
export const MUTABLE_CONFIG_KEYS = new Set([
  'searchBackend', 'brave', 'searxng', 'exa', 'tavily', 'youtube',
  'stackexchange', 'github', 'reddit', 'crawl4ai', 'embeddingSidecar',
  'domainTrust', 'scrubContent', 'llm', 'raga', 'duckduckgo',
  'ollamaSearch', 'access',
] as const);

export type MutableConfigKey = typeof MUTABLE_CONFIG_KEYS extends Set<infer K> ? K : never;

export type ConfigPatch = Partial<Record<MutableConfigKey, Record<string, FieldPatch> | FieldPatch>>;

// ---------- Access block ----------

export type Visibility = 'loopback' | 'tailnet' | 'public' | 'custom';

export interface TailscaleAccessConfig {
  serveConfigured: boolean;
  funnelConfigured: boolean;
  allowDashboardOverFunnel: boolean;
}

export interface AccessConfig {
  provider: 'localhost' | 'manual' | 'tailscale';
  manualBaseUrl?: string;
  manualVisibility?: Visibility | 'unknown';
  exposeDashboardExternally: boolean;
  tailscale: TailscaleAccessConfig;
}

export const ACCESS_DEFAULTS: AccessConfig = {
  provider: 'localhost',
  exposeDashboardExternally: false,
  tailscale: {
    serveConfigured: false,
    funnelConfigured: false,
    allowDashboardOverFunnel: false,
  },
};

// ---------- Provider test result ----------

export interface ProviderTestResult {
  provider: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

// ---------- Redacted config ----------

/** Config as returned by the dashboard API — secrets replaced with "•••". */
export type RedactedConfig = Record<string, unknown>;

// ---------- Runtime ----------

export interface SearchMcpRuntime {
  /** Live config accessor. Call on each request — ConfigManager keeps it fresh. */
  getConfig(): Readonly<SearchConfig>;
}
