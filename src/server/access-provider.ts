import type * as http from 'node:http';
import type { AccessConfig, Visibility } from '../config/types.js';

export type ExternalAccessProviderType = 'localhost' | 'manual' | 'tailscale';
export type ProviderStatus =
  | 'active' | 'configured_unverified' | 'detected_mismatch'
  | 'unconfigured' | 'unavailable';
export type RequestOrigin = 'loopback' | 'tailscale_serve' | 'public' | 'unknown';

export interface ExternalAccessProvider {
  type: ExternalAccessProviderType;
  baseUrl: string;
  mcpUrl: string;
  dashboardUrl: string;
  visibility: Visibility;
  status: ProviderStatus;
  authRequired: true;
  reason?: string;
  warnings?: string[];
}

export type NormalizeResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export function normalizeBaseUrl(input: string): NormalizeResult {
  let parsed: URL;
  try { parsed = new URL(input); } catch { return { ok: false, error: 'Invalid URL' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return { ok: false, error: 'URL must use http: or https:' };
  if (parsed.username || parsed.password)
    return { ok: false, error: 'URL must not contain credentials' };
  if (parsed.search || parsed.hash)
    return { ok: false, error: 'URL must not contain query string or fragment' };
  if (parsed.pathname !== '/' && parsed.pathname !== '')
    return { ok: false, error: 'URL path must be empty (e.g. https://example.com, not https://example.com/mcp)' };
  return { ok: true, url: parsed.origin };
}

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function classifyRequestOrigin(req: http.IncomingMessage): RequestOrigin {
  const addr = req.socket.remoteAddress ?? '';
  if (LOOPBACK_ADDRS.has(addr)) {
    if (req.headers['x-tailscale-user'] || req.headers['x-tailscale-user-login']) {
      return 'tailscale_serve';
    }
    return 'loopback';
  }
  if (addr) return 'public';
  return 'unknown';
}

export function buildMcpConnectionUrl(provider: Pick<ExternalAccessProvider, 'baseUrl'>): string {
  return `${provider.baseUrl}/mcp`;
}

export function buildProvider(
  type: ExternalAccessProviderType,
  baseUrl: string,
  visibility: Visibility,
  status: ProviderStatus,
  opts: { reason?: string; warnings?: string[] } = {},
): ExternalAccessProvider {
  return {
    type,
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    dashboardUrl: `${baseUrl}/dashboard`,
    visibility,
    status,
    authRequired: true,
    ...opts,
  };
}

export function resolveAccessProvider(
  access: AccessConfig,
  port: number,
  tailscaleHostname?: string,
): ExternalAccessProvider {
  const localhost = `http://localhost:${String(port)}`;

  if (access.provider === 'localhost') {
    return buildProvider('localhost', localhost, 'loopback', 'active');
  }

  if (access.provider === 'manual') {
    const raw = access.manualBaseUrl ?? '';
    if (!raw) return buildProvider('manual', localhost, 'loopback', 'unconfigured', { reason: 'manual_url_missing' });
    const norm = normalizeBaseUrl(raw);
    if (!norm.ok) return buildProvider('manual', localhost, 'loopback', 'unconfigured', { reason: norm.error });
    const vis: Visibility = access.manualVisibility === 'unknown' ? 'custom' : (access.manualVisibility ?? 'custom');
    const opts = access.manualVisibility === 'unknown'
      ? { warnings: ['Visibility unknown — treat as custom; confirm with your network administrator'] }
      : {};
    return buildProvider('manual', norm.url, vis, 'configured_unverified', opts);
  }

  // tailscale
  if (!tailscaleHostname) {
    return buildProvider('tailscale', localhost, 'loopback', 'unconfigured', {
      reason: 'tailscale_not_installed',
    });
  }

  const ts = access.tailscale;
  const tsBase = `https://${tailscaleHostname}`;

  if (!ts.serveConfigured) {
    return buildProvider('tailscale', localhost, 'loopback', 'unconfigured', {
      reason: 'serve_not_detected',
    });
  }

  if (ts.funnelConfigured) {
    return buildProvider('tailscale', tsBase, 'public', 'configured_unverified', {
      warnings: ['Funnel active: endpoint is publicly reachable on the internet'],
    });
  }

  return buildProvider('tailscale', tsBase, 'tailnet', 'active');
}

export function dashboardAllowed(
  origin: RequestOrigin,
  access: AccessConfig,
): boolean {
  if (origin === 'loopback' || origin === 'tailscale_serve') return true;
  if (origin === 'public' && access.exposeDashboardExternally) return true;
  if (origin === 'public' && access.tailscale.allowDashboardOverFunnel) return true;
  return false;
}
