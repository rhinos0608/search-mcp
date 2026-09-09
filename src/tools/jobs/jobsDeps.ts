/**
 * Shared jobs MCP dependency builder (Checkpoint D product surface).
 *
 * Additive wiring only: builds real JobsSearchDeps from SearchConfig —
 * policy registry from source-class entries, capability registry from
 * configured adapters, indexed provider ports from enabled backends, and
 * jobspy scrapeJobs from the jobspy-js client. Consumes jobsAcquisition
 * config safely: configured ATS tenants and destination-fetch flow only
 * through policy/registry authorization — never arbitrary hosts. SEEK
 * direct search/fetch remain blocked via the frozen SEEK source-class entry.
 */

import type { SearchConfig } from '../../config.js';
import { SourcePolicyRegistry } from '../../jobs/acquisition/policy/registry.js';
import { AdapterCapabilityRegistry } from '../../jobs/acquisition/adapterRegistry.js';
import {
  createDefaultIndexedProviderPorts,
  indexedProviderCapabilities,
} from '../../jobs/acquisition/providers/ports.js';
import { JOBSPY_ADAPTER_ID, JOBSPY_CAPABILITY } from '../../jobs/acquisition/adapters/jobspy.js';
import { MANUAL_IMPORT_ADAPTER_ID } from '../../jobs/acquisition/adapters/manualImport.js';
import { buildSeekEntry } from '../../jobs/acquisition/sourceClass/seek.js';
import {
  SEEK_POLICY_EVIDENCE,
  boardPolicyEvidence,
  indexedProviderEvidence,
  manualImportEvidence,
  requireLiveEvidenceRefs,
} from '../../jobs/acquisition/sourceClass/evidence/livePolicyEvidence.js';
import { AtsTenantRegistry } from '../../jobs/acquisition/sourceClass/atsTenants.js';
import { SourceClassRegistry } from '../../jobs/acquisition/sourceClass/registry.js';
import { destinationFetchCapabilities } from '../../jobs/acquisition/sourceClass/destinationFetchFlag.js';
import {
  SourcePolicySchema,
  type SourcePolicy,
} from '../../jobs/acquisition/policy/sourcePolicy.js';
import type { JobsSearchDeps } from '../../jobs/orchestration/searchContracts.js';
import { scrapeJobs as jobspyScrape } from 'jobspy-js';
import type { JobSpyScrapeResult } from '../../jobs/acquisition/adapters/jobspy.js';

type ScrapeJobsFn = (
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<JobSpyScrapeResult>;

function automatedSearchPolicy(sourceId: string): SourcePolicy {
  const evidence = sourceId.startsWith('board:')
    ? boardPolicyEvidence(sourceId.slice('board:'.length))
    : indexedProviderEvidence(sourceId);
  requireLiveEvidenceRefs(sourceId, [evidence.evidenceId]);
  return SourcePolicySchema.parse({
    sourceId,
    revision: 'jobs-mcp/1.0.0',
    modes: {
      automatedSearch: 'permitted',
      automatedFetch: 'not_supported',
      userSuppliedContent: 'not_supported',
      manualImport: 'not_supported',
      employerApi: 'not_supported',
    },
    evidenceRefs: [evidence.evidenceId],
    reviewedAt: evidence.reviewedAt ?? evidence.capturedAt,
  });
}

function manualPolicy(): SourcePolicy {
  const evidence = manualImportEvidence();
  requireLiveEvidenceRefs(MANUAL_IMPORT_ADAPTER_ID, [evidence.evidenceId]);
  return SourcePolicySchema.parse({
    sourceId: MANUAL_IMPORT_ADAPTER_ID,
    revision: 'jobs-mcp/1.0.0',
    modes: {
      automatedSearch: 'not_supported',
      automatedFetch: 'not_supported',
      userSuppliedContent: 'permitted',
      manualImport: 'permitted',
      employerApi: 'not_supported',
    },
    evidenceRefs: [evidence.evidenceId],
    reviewedAt: evidence.reviewedAt ?? evidence.capturedAt,
  });
}

export interface JobsMcpDependencies extends JobsSearchDeps {
  /** Configured ATS tenants (enabled only, policy-governed). */
  readonly atsTenants: readonly { sourceId: string; enabled: boolean }[];
  /** Whether destination fetch capability is present (flag + per-source). */
  readonly destinationFetchCapable: boolean;
  /** Frozen SEEK entry revision marker (direct always blocked). */
  readonly seekBlocked: boolean;
  /** Configured indexed provider IDs (degraded when empty). */
  readonly providerIds: readonly string[];
  /** JobSpy boards available to acquisition planner. */
  readonly jobspyBoards: readonly string[];
}

/**
 * Build live JobsSearchDeps from SearchConfig. Never throws for missing
 * optional config — degrades (empty ports) with explicit capability flags
 * so handlers can return actionable errors.
 */
export function buildJobsMcpDeps(cfg: SearchConfig): JobsMcpDependencies {
  const ports = createDefaultIndexedProviderPorts(cfg);

  const policies: SourcePolicy[] = [];
  for (const p of ports) policies.push(automatedSearchPolicy(p.providerId));
  for (const b of cfg.jobsAcquisition.jobspyBoards)
    policies.push(automatedSearchPolicy(`board:${b}`));
  policies.push(manualPolicy());

  const destFetchCapabilities = destinationFetchCapabilities(cfg.jobsAcquisition);
  const capabilityRegistry = new AdapterCapabilityRegistry([
    ...indexedProviderCapabilities(ports),
    JOBSPY_CAPABILITY,
    {
      schemaVersion: '1.0.0',
      adapterId: MANUAL_IMPORT_ADAPTER_ID,
      adapterVersion: '1.0.0',
      edges: [
        { operation: 'manualImport', route: 'user_supplied', targetKind: 'adapter' },
        { operation: 'userSuppliedContent', route: 'user_supplied', targetKind: 'adapter' },
      ],
    },
    ...destFetchCapabilities,
  ]);
  const sourceClassRegistry = new SourceClassRegistry();
  for (const ev of SEEK_POLICY_EVIDENCE) sourceClassRegistry.registerEvidence(ev);
  const seekEntry = buildSeekEntry(SEEK_POLICY_EVIDENCE);
  requireLiveEvidenceRefs(seekEntry.sourceId, seekEntry.evidenceRefs);
  sourceClassRegistry.register(seekEntry);
  const seekPolicies = sourceClassRegistry.materializeEdgePolicies({
    capabilityRegistry,
    availableCredentialRefs: new Set<string>(),
    destinationFetchEnabled: cfg.jobsAcquisition.destinationFetchEnabled,
  });
  const policyRegistry = new SourcePolicyRegistry(policies, seekPolicies);

  const tenantRegistry = new AtsTenantRegistry(cfg.jobsAcquisition.atsTenants);
  const tenants = tenantRegistry.list().map((t) => ({ sourceId: t.sourceId, enabled: t.enabled }));

  return {
    policyRegistry,
    capabilityRegistry,
    ports,
    scrapeJobs: async (params: Record<string, unknown>, signal?: AbortSignal) =>
      (jobspyScrape as unknown as ScrapeJobsFn)(params, signal),
    providerIds: ports.map((p) => p.providerId),
    atsTenants: tenants,
    destinationFetchCapable: destFetchCapabilities.length > 0,
    seekBlocked: true,
    jobspyBoards: [...cfg.jobsAcquisition.jobspyBoards],
  };
}

/** Adapter ID constant re-export for plan builders. */
export { JOBSPY_ADAPTER_ID };

/**
 * True when JobSpy is requested but zero boards are authorized — callers must
 * surface `jobspy_unconfigured` instead of silently returning fewer sources.
 */
export function jobspyUnconfigured(
  deps: Pick<JobsMcpDependencies, 'jobspyBoards'>,
  useJobSpy?: boolean,
): boolean {
  return useJobSpy !== false && deps.jobspyBoards.length === 0;
}
