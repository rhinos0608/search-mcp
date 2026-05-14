const BASE = '/dashboard/api';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  });
  if (res.status === 401) throw new ApiError(401, 'Not authenticated');
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ---- Auth ----

export function checkSession(): Promise<{ authenticated: boolean }> {
  return request('/session');
}

export function login(apiKey: string): Promise<{ ok: boolean }> {
  return request('/login', { method: 'POST', body: JSON.stringify({ apiKey }) });
}

export function logout(): Promise<{ ok: boolean }> {
  return request('/logout', { method: 'POST', body: '{}' });
}

// ---- Config ----

export function getConfigStatus(): Promise<{ config: Record<string, unknown> }> {
  return request('/config/status');
}

export function getProviders(): Promise<{ providers: Array<{ id: string; configured: boolean }> }> {
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
  return request('/rotate-key', { method: 'POST', body: '{}' });
}
