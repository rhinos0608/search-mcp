import { SourcePolicyRegistry } from '../../src/jobs/acquisition/policy/registry.js';
import { AdapterCapabilityRegistry } from '../../src/jobs/acquisition/adapterRegistry.js';
import {
  INDEXED_PROVIDER_DEFINITIONS,
  indexedProviderCapabilities,
} from '../../src/jobs/acquisition/providers/ports.js';
import type { IndexedProviderPort } from '../../src/jobs/acquisition/providers/ports.js';
import type { SourcePolicy } from '../../src/jobs/acquisition/policy/sourcePolicy.js';
import type { JobsSearchRequest } from '../../src/jobs/orchestration/searchContracts.js';
import type { SearchIntent } from '../../src/jobs/domain/intent.js';

export function policy(sourceId: string, state: string = 'permitted'): SourcePolicy {
  return {
    sourceId,
    revision: 'rev-1',
    modes: {
      automatedSearch: state as never,
      automatedFetch: state as never,
      userSuppliedContent: state as never,
      manualImport: state as never,
      employerApi: 'not_supported' as never,
    },
    evidenceRefs: [],
    reviewedAt: '2026-01-01T00:00:00Z',
  } as unknown as SourcePolicy;
}

export function makeRegistries(ports: readonly IndexedProviderPort[]) {
  const policies: SourcePolicy[] = [];
  for (const p of ports) policies.push(policy(p.providerId, 'permitted'));
  for (const b of [
    'linkedin',
    'indeed',
    'zip_recruiter',
    'glassdoor',
    'google',
    'google_careers',
    'bayt',
    'naukri',
    'bdjobs',
  ] as const)
    policies.push(policy(b, 'permitted'));
  policies.push(policy('manual', 'permitted'));
  policies.push(policy('publisher:acme', 'permitted'));
  const reg = new SourcePolicyRegistry(policies);
  const caps = new AdapterCapabilityRegistry([
    ...indexedProviderCapabilities(ports as unknown as IndexedProviderPort[]),
    {
      schemaVersion: '1.0.0',
      adapterId: 'jobspy',
      adapterVersion: '1.7.0',
      edges: [{ operation: 'automatedSearch', route: 'direct', targetKind: 'board' }],
    } as unknown as never,
    {
      schemaVersion: '1.0.0',
      adapterId: 'manual',
      adapterVersion: '1.0.0',
      edges: [
        { operation: 'manualImport', route: 'user_supplied', targetKind: 'adapter' },
        { operation: 'userSuppliedContent', route: 'user_supplied', targetKind: 'adapter' },
      ],
    } as unknown as never,
  ]);
  return { reg, caps };
}

export function mockPort(
  providerId = 'search-provider:brave',
  searchFn: IndexedProviderPort['search'] = async () => [],
): IndexedProviderPort {
  const def = INDEXED_PROVIDER_DEFINITIONS.find((d) => d.providerId === providerId);
  if (def === undefined) {
    const known = INDEXED_PROVIDER_DEFINITIONS.map((d) => d.providerId).join(', ');
    throw new RangeError(`unknown indexed provider '${providerId}'; known providers: ${known}`);
  }
  return {
    backend: def.backend,
    adapterId: def.adapterId,
    providerId: def.providerId,
    governance: def.governance,
    maxDurationMs: def.maxDurationMs,
    search: searchFn,
  };
}

export function baseIntent(overrides: Partial<SearchIntent> = {}): SearchIntent {
  return {
    query: 'software engineer',
    localePackIds: [],
    domainPackIds: [],
    requestedRoleFamilies: [],
    sectors: [],
    locations: [],
    workModes: [],
    employmentTypes: [],
    compensation: [],
    sourceIds: [],
    explorationBreadth: 'balanced',
    strictness: 'normal',
    unknownPolicy: 'include',
    topK: 10,
    budgets: {
      requests: 10,
      pages: 10,
      bytes: 200000,
      milliseconds: 60000,
      enrichment: 0,
      reasoning: 0,
    },
    evidenceRefs: [],
    ...overrides,
  };
}

/** Structural fixture view of AcquisitionSlice (contract run/slice IDs are branded in src). */
export interface SliceFixture {
  schemaVersion: '1.0.0';
  runId: string;
  sliceId: string;
  ordinal: number;
  queryVariantId: string;
  query: string;
  reason: string;
  adapterIds: string[];
  localePackRefs: string[];
  domainPackRefs: string[];
  budget: {
    logicalRequests: number;
    reservedAttempts: number;
    candidates: number;
    bytes: number;
    milliseconds: number;
  };
}

export function baseSlice(overrides: Partial<SliceFixture> = {}): SliceFixture {
  return {
    schemaVersion: '1.0.0',
    runId: 'run-1',
    sliceId: 'slice-1',
    ordinal: 0,
    queryVariantId: 'qv-1',
    query: 'software engineer',
    reason: 'test',
    adapterIds: ['indexed-adapter'],
    localePackRefs: [],
    domainPackRefs: [],
    budget: {
      logicalRequests: 2,
      reservedAttempts: 5,
      candidates: 10,
      bytes: 100000,
      milliseconds: 70000,
    },
    ...overrides,
  };
}

/**
 * baseRequest returns the full JobsSearchRequest contract. Overrides stay typed
 * Partial<JobsSearchRequest> except plan, which is loosened because test plan
 * literals are validated downstream by the coordinator's zod schemas.
 */
export function baseRequest(
  overrides: Partial<Omit<JobsSearchRequest, 'plan'>> & { plan?: readonly unknown[] } = {},
): JobsSearchRequest {
  return {
    intent: baseIntent(),
    plan: [],
    runId: 'run-1',
    capturedAt: '2026-01-02T00:00:00Z',
    budget: {
      logicalRequests: 10,
      reservedAttempts: 20,
      candidates: 10,
      bytes: 200000,
      milliseconds: 70000,
    },
    ...overrides,
  } as unknown as JobsSearchRequest;
}

export function baseDeps(ports: readonly IndexedProviderPort[]) {
  const { reg, caps } = makeRegistries(ports);
  return {
    policyRegistry: reg,
    capabilityRegistry: caps,
    ports,
    scrapeJobs: async () => ({ jobs: [], totalScraped: 0, newCount: 0 }) as unknown as never,
  };
}

export function jobspyScrape(jobs: unknown[]) {
  return async () =>
    ({ jobs, totalScraped: jobs.length, newCount: jobs.length }) as unknown as never;
}

/** Structural fixture view of a JobSpy job payload (snake_case per jobspy output). */
export interface JobRecordFixture {
  title: string;
  company: string;
  location: string;
  job_url: string;
  job_url_direct: null;
  description: string;
  site: string;
}

export function jobRecord(
  overrides: Partial<JobRecordFixture> & { salary?: string } = {},
): JobRecordFixture & { salary?: string } {
  return {
    title: 'Software Engineer',
    company: 'Acme Corp',
    location: 'Melbourne VIC',
    job_url: 'https://example.test/jobs/1',
    job_url_direct: null,
    description: 'Build things with TypeScript.',
    site: 'linkedin',
    ...overrides,
  };
}

type SnippetRecord = {
  title: string;
  url: string;
  description: string;
  position: number;
  domain: string;
  source: 'brave' | 'searxng' | 'exa' | 'tavily' | 'duckduckgo' | 'codex' | 'ollama-search';
  age: null;
  ageKind: 'unknown';
  extraSnippet: null;
  deepLinks: null;
  contentKind: 'snippet';
  generatedSummary: null;
};

export function snippetRecord(overrides: Partial<SnippetRecord> = {}): SnippetRecord {
  return {
    title: 'Test Engineer',
    url: 'https://example.test/snippet/1',
    description: 'snippet text',
    position: 1,
    domain: 'example.test',
    source: 'brave',
    age: null,
    ageKind: 'unknown',
    extraSnippet: null,
    deepLinks: null,
    contentKind: 'snippet',
    generatedSummary: null,
    ...overrides,
  };
}
