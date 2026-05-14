const BASE = '/dashboard/api';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type UnauthorizedHandler = () => void;
let _onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  _onUnauthorized = fn;
}

/**
 * Create a typed request with optional runtime response validation.
 * If `validate` is provided, the parsed JSON is run through it before returning.
 * On validation failure, an ApiError with status 502 is thrown.
 */
async function request<T>(
  path: string,
  init: RequestInit = {},
  validate?: (data: unknown) => T,
): Promise<T> {
  const shouldSetContentType =
    init.body !== undefined &&
    !(init.body instanceof FormData) &&
    !(init.body instanceof Blob) &&
    !(init.body instanceof URLSearchParams);
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...(shouldSetContentType ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) {
    _onUnauthorized?.();
    throw new ApiError(401, 'Not authenticated');
  }
  if (!res.ok) {
    const parsed = await res.json().catch(() => null);
    const body: { error?: string } =
      parsed !== null && typeof parsed === 'object' && parsed !== null && ('error' in parsed)
        ? { error: String((parsed as Record<string, unknown>).error) }
        : { error: res.statusText };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  const data: unknown = await res.json();
  if (validate) return validate(data);
  // For callers that pass a validate function, validated data is returned above.
  // Without validation, cast at the call site via a proper schema.
  return data as unknown as T;
}

// ---- Setup (first-run, no auth required) ----

export function checkSetup(): Promise<{ claimed: boolean; apiKey?: string }> {
  return request('/setup');
}

export function claimKey(): Promise<{ ok: boolean }> {
  return request('/setup/claim', { method: 'POST', body: JSON.stringify({}) });
}

// ---- Auth ----

export function checkSession(): Promise<{ authenticated: boolean }> {
  return request('/session');
}

export function login(apiKey: string): Promise<{ ok: boolean }> {
  return request('/login', { method: 'POST', body: JSON.stringify({ apiKey }) });
}

export function logout(): Promise<{ ok: boolean }> {
  return request('/logout', { method: 'POST', body: JSON.stringify({}) });
}

// ---- Config ----

/** Backend config status response — group → field key → value. */
export interface ConfigStatus {
  [group: string]: Record<string, string>;
}

export function getConfigStatus(): Promise<{ config: ConfigStatus }> {
  return request('/config/status');
}

export function getProviders(): Promise<{ providers: { id: string; configured: boolean }[] }> {
  return request('/providers');
}

export function updateConfig(patch: Record<string, unknown>): Promise<{ ok: boolean }> {
  return request('/config/update', { method: 'POST', body: JSON.stringify(patch) });
}

export function testConnection(provider: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  return request('/config/test-connection', { method: 'POST', body: JSON.stringify({ provider }) });
}

// ---- Access ----

export interface AccessConfig {
  provider: 'localhost' | 'manual' | 'tailscale';
  manualBaseUrl?: string;
  manualVisibility?: string;
  exposeDashboardExternally: boolean;
  tailscale: {
    serveConfigured: boolean;
    funnelConfigured: boolean;
    allowDashboardOverFunnel: boolean;
  };
}

export function getAccess(): Promise<{ access: AccessConfig }> {
  return request('/access');
}

export function updateAccess(patch: Partial<AccessConfig>): Promise<{ ok: boolean }> {
  return request('/access/update', { method: 'POST', body: JSON.stringify(patch) });
}

// ---- Key rotation ----

export function rotateApiKey(): Promise<{ newKey: string; warning: string }> {
  return request('/rotate-key', { method: 'POST', body: JSON.stringify({}) });
}

// ---- Connection info ----

export function getConnectionInfo(): Promise<{ mcpUrl: string; apiKey: string; allowQueryKey: boolean; localPort: number }> {
  return request('/connection-info');
}

// ---- Tailscale status ----

export interface TailscaleStatusInfo {
  detected: boolean;
  hostname?: string;
  magicDnsName?: string;
  selfIp?: string;
  serveActive?: boolean;
  inspectedVia: 'localapi' | 'cli' | 'none';
}

export function getTailscaleStatus(): Promise<{ tailscale: TailscaleStatusInfo }> {
  return request('/tailscale-status');
}
