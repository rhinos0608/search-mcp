import { AU_NSW_SYDNEY_LOCALE_PACK } from '../../jobs/packs/auNswSydney.locale.js';
import { NSW_PUBLIC_ADMIN_DOMAIN_PACK } from '../../jobs/packs/nswPublicAdmin.domain.js';
import type { AcquisitionSlicePlanItem } from '../../jobs/acquisition/coordinator.js';
import type {
  JobsSearchCandidate,
  JobsSearchRequest,
} from '../../jobs/orchestration/searchContracts.js';
import type { DerivedStageBudgets, JobsRunBudget } from './planBuilder.js';
import type { MappedProfile } from './profileMapping.js';

export interface JobsSearchRequestBuilderParams {
  query: string;
  topK: number;
  sydney: boolean;
  locations?: readonly { city: string }[];
  workModes?: readonly ('remote' | 'hybrid' | 'onsite')[];
  plan: readonly AcquisitionSlicePlanItem[];
  runId: string;
  capturedAt: string;
  runBudget: JobsRunBudget;
  stageBudgets: DerivedStageBudgets;
  mappedProfile?: MappedProfile | undefined;
}

export function buildJobsSearchExecutionRequest(
  params: JobsSearchRequestBuilderParams,
): JobsSearchRequest {
  const {
    query,
    topK,
    sydney,
    locations = [],
    workModes = [],
    plan,
    runId,
    capturedAt,
    runBudget,
    stageBudgets,
    mappedProfile,
  } = params;

  return {
    intent: {
      query,
      localePackIds: sydney ? ['au-nsw-sydney'] : [],
      domainPackIds: sydney ? ['nsw-public-admin'] : [],
      requestedRoleFamilies: [],
      sectors: [],
      locations: [...locations],
      workModes: [...workModes],
      employmentTypes: [],
      compensation: [],
      sourceIds: [],
      explorationBreadth: 'balanced',
      strictness: 'normal',
      unknownPolicy: 'include',
      topK,
      budgets: {
        requests: runBudget.logicalRequests,
        pages: 10,
        bytes: 200000,
        milliseconds: runBudget.milliseconds,
        enrichment: stageBudgets.indexedEnrichment,
        reasoning: 0,
      },
      evidenceRefs: [],
    },
    plan: [...plan],
    runId,
    capturedAt,
    budget: runBudget,
    ...(sydney
      ? { localePack: AU_NSW_SYDNEY_LOCALE_PACK, domainPack: NSW_PUBLIC_ADMIN_DOMAIN_PACK }
      : {}),
    ...(mappedProfile !== undefined
      ? {
          profileInput: mappedProfile.profileInput,
          allowedProfileTermRefs: mappedProfile.allowedTermRefs,
        }
      : {}),
  };
}

export interface ProjectedJobsCandidate {
  rank: number;
  title: string | null;
  organisation: string | null;
  utility: number;
  coverage: number;
  confidence: number;
  eligibility: string;
  evidenceState: string;
  listingUrl?: string;
  applyUrl?: string;
  location?: string;
  salaryText?: string;
  description?: string;
  provenance: readonly string[];
  sourceListingIds: readonly string[];
  observationIds: readonly string[];
  flags: readonly string[];
  caveats: readonly string[];
}

export function projectJobsCandidate(c: JobsSearchCandidate): ProjectedJobsCandidate {
  return {
    rank: c.rank,
    title: c.title,
    organisation: c.organisation,
    utility: Math.round(c.utility * 1000) / 1000,
    coverage: Math.round(c.coverage * 1000) / 1000,
    confidence: Math.round(c.confidence * 1000) / 1000,
    eligibility: c.eligibility,
    evidenceState: c.evidenceState,
    ...(c.listingUrl !== undefined ? { listingUrl: c.listingUrl } : {}),
    ...(c.applyUrl !== undefined ? { applyUrl: c.applyUrl } : {}),
    ...(c.location !== undefined ? { location: c.location } : {}),
    ...(c.salaryText !== undefined ? { salaryText: c.salaryText } : {}),
    ...(c.description !== undefined ? { description: c.description } : {}),
    provenance: c.provenance.slice(0, 8),
    sourceListingIds: c.sourceListingIds.slice(0, 16),
    observationIds: c.observationIds.slice(0, 16),
    flags: c.flags,
    caveats: c.caveats,
  };
}
