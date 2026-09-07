/**
 * W4 ATS tenant config registry.
 *
 * Validates and stores ATS tenant configurations. Unknown/disabled tenant
 * or non-allowlisted host produces no request object.
 * Credentials remain keychain references (never secrets in config).
 */
import { AtsTenantConfigSchema, type AtsTenantConfig } from './contracts.js';

function deepFreeze<T>(value: T, seen = new WeakSet()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child, seen);
    }
    Object.freeze(value);
  }
  return value;
}

export class AtsTenantRegistry {
  private readonly tenants = new Map<string, AtsTenantConfig>();
  private readonly hostIndex = new Map<string, string>();

  constructor(configs: readonly unknown[] = []) {
    for (const raw of configs) {
      this.register(raw);
    }
  }

  register(input: unknown): AtsTenantConfig {
    const parsed = AtsTenantConfigSchema.parse(input);
    if (this.tenants.has(parsed.sourceId)) {
      throw new Error(`duplicate ATS tenant: ${parsed.sourceId}`);
    }
    for (const host of parsed.hosts) {
      if (this.hostIndex.has(host)) {
        throw new Error(`duplicate ATS host: ${host}`);
      }
      this.hostIndex.set(host, parsed.sourceId);
    }
    const frozen = deepFreeze(structuredClone(parsed));
    this.tenants.set(frozen.sourceId, frozen);
    return frozen;
  }

  get(sourceId: string): AtsTenantConfig | undefined {
    const tenant = this.tenants.get(sourceId);
    return tenant === undefined ? undefined : deepFreeze(structuredClone(tenant));
  }

  getByHost(host: string): AtsTenantConfig | undefined {
    const sourceId = this.hostIndex.get(host);
    if (sourceId === undefined) return undefined;
    return this.get(sourceId);
  }

  list(): readonly AtsTenantConfig[] {
    const sorted = [...this.tenants.values()].sort((a, b) =>
      a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0,
    );
    return deepFreeze(sorted.map((t) => deepFreeze(structuredClone(t))));
  }

  /**
   * Validate a request context against tenant config.
   * Returns the tenant if valid, undefined otherwise.
   * Caller URL/host cannot select tenant (host must be in allowlist).
   */
  validateRequestContext(
    sourceId: string,
    adapterId: string,
    requestHost: string,
  ): AtsTenantConfig | undefined {
    const tenant = this.tenants.get(sourceId);
    if (!tenant) return undefined;
    if (!tenant.enabled) return undefined;
    if (!tenant.enabledAdapterIds.includes(adapterId)) return undefined;
    if (!tenant.hosts.includes(requestHost)) return undefined;
    return deepFreeze(structuredClone(tenant));
  }

  /**
   * Build a request object for a valid ATS tenant.
   * Returns undefined for unknown/disabled tenant or non-allowlisted host.
   * Credential refs are included only when configured.
   */
  buildRequest(
    sourceId: string,
    adapterId: string,
    host: string,
  ): { sourceId: string; platform: string; credentialRef?: string } | undefined {
    const tenant = this.validateRequestContext(sourceId, adapterId, host);
    if (!tenant) return undefined;
    const result: { sourceId: string; platform: string; credentialRef?: string } = {
      sourceId: tenant.sourceId,
      platform: tenant.platform,
    };
    if (tenant.credentialRef) {
      result.credentialRef = tenant.credentialRef;
    }
    return result;
  }
}
