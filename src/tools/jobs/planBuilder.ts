import type { AcquisitionPolicyEdge, AcquisitionSlice } from '../../jobs/acquisition/contracts.js';
import type { AcquisitionRunId, AcquisitionSliceId } from '../../jobs/acquisition/ids.js';
import type {
  AcquisitionSlicePlanItem,
  IndexedSlicePlanItem,
  JobSpySlicePlanItem,
} from '../../jobs/acquisition/coordinator.js';
import {
  SEEK_DESTINATION_CLASS,
  supportsIndexedDomainFilter,
} from '../../jobs/acquisition/destinationClass.js';
import type { IndexedProviderPort } from '../../jobs/acquisition/providers/ports.js';

export interface PlanBuilderOptions {
  query: string;
  location?: string | string[];
  workMode?: ('remote' | 'hybrid' | 'onsite')[];
  isRemote?: boolean;
  jobType?: 'fulltime' | 'parttime' | 'contract' | 'temporary' | 'internship';
  sydney?: boolean;
  useJobSpy?: boolean;
  /** Opt-in richer description fetch on JobSpy boards (cost); default false. */
  jobspyFetchDescription?: boolean;
  resultsWanted?: number;
}

export interface DerivedStageBudgets {
  acquisitionCandidates: number;
  indexedEnrichment: number;
  deepExtraction: number;
  finalResults: number;
}

export interface PlanBuilderContext {
  topK: number;
  ports: readonly Pick<IndexedProviderPort, 'providerId' | 'governance' | 'maxDurationMs'>[];
  stageBudgets: DerivedStageBudgets;
  informationalEdgesFor?: (
    sourceId: string,
    providerId: string,
  ) => readonly AcquisitionPolicyEdge[];
}

/** Fair remainder: first ordinals get +1. Zero allowed. */
export function shareBudget(total: number, index: number, count: number): number {
  const n = Math.max(1, count);
  const base = Math.floor(total / n);
  const extra = index < total % n ? 1 : 0;
  return base + extra;
}

export function deriveStageBudgets(topK: number): DerivedStageBudgets {
  const k = Math.min(50, Math.max(1, Math.floor(topK)));
  return {
    acquisitionCandidates: Math.min(100, Math.max(k * 2, 20)),
    indexedEnrichment: Math.min(10, k),
    deepExtraction: 20,
    finalResults: k,
  };
}

function positiveShare(total: number, index: number, count: number): number {
  return Math.max(1, shareBudget(total, index, count));
}

export function buildPlan(
  opts: PlanBuilderOptions,
  runId: string,
  providerIds: readonly string[],
  jobspyBoards: readonly string[],
  ctx?: PlanBuilderContext,
): AcquisitionSlicePlanItem[] {
  const jobspyCount = opts.useJobSpy === false ? 0 : jobspyBoards.length;
  const classProviderIds = providerIds.filter((id) => supportsIndexedDomainFilter(id));
  const sliceCount = providerIds.length + classProviderIds.length + jobspyCount;
  const stage = ctx?.stageBudgets ?? deriveStageBudgets(ctx?.topK ?? 10);
  const candidatePool = stage.acquisitionCandidates;
  const supportingProviderCount = (ctx?.ports ?? []).filter(
    (p) => p.governance.supportsUrlAttributedSummary,
  ).length;
  const logicalTotal = Math.min(32, Math.max(1, sliceCount + supportingProviderCount));
  const reservedTotal = Math.min(10000, Math.max(20, 3 * Math.max(1, sliceCount)));
  const plan: AcquisitionSlicePlanItem[] = [];
  let ordinal = 0;
  const sliceBase = (
    sliceId: string,
    adapterIds: string[],
    queryVariantId: string,
  ): AcquisitionSlice => {
    const sliceIndex = ordinal;
    return {
      schemaVersion: '1.0.0' as const,
      runId: runId as AcquisitionRunId,
      sliceId: sliceId as AcquisitionSliceId,
      ordinal: ordinal++,
      queryVariantId,
      query: opts.query.slice(0, 2048),
      reason: 'mcp jobs_search request',
      adapterIds,
      localePackRefs: opts.sydney === true ? ['locale:au-nsw-sydney:1.0.0'] : [],
      domainPackRefs: opts.sydney === true ? ['domain:nsw-public-admin:1.0.0'] : [],
      budget: {
        logicalRequests: positiveShare(logicalTotal, sliceIndex, Math.max(1, sliceCount)),
        reservedAttempts: positiveShare(reservedTotal, sliceIndex, Math.max(1, sliceCount)),
        candidates: positiveShare(candidatePool, sliceIndex, Math.max(1, sliceCount)),
        bytes: positiveShare(200000, sliceIndex, Math.max(1, sliceCount)),
        milliseconds: 25000,
      },
    };
  };
  for (const providerId of providerIds) {
    const item: IndexedSlicePlanItem = {
      kind: 'indexed',
      slice: sliceBase(
        `slice-indexed-${providerId.replace(/[^A-Za-z0-9_-]/g, '-')}`,
        ['indexed'],
        'qv-broad',
      ),
      providerId,
      safeSearch: 'moderate',
    };
    plan.push(item);
  }
  if (ctx !== undefined) {
    for (const providerId of classProviderIds) {
      const edges = ctx.informationalEdgesFor?.(SEEK_DESTINATION_CLASS.id, providerId) ?? [];
      const item: IndexedSlicePlanItem = {
        kind: 'indexed',
        slice: sliceBase(
          `slice-indexed-${providerId.replace(/[^A-Za-z0-9_-]/g, '-')}-seek`,
          ['indexed'],
          'qv-seek',
        ),
        providerId,
        safeSearch: 'moderate',
        destinationClass: {
          sourceId: SEEK_DESTINATION_CLASS.id,
          targetKind: SEEK_DESTINATION_CLASS.targetKind,
        },
        includeDomains: [...SEEK_DESTINATION_CLASS.includeDomains],
        ...(edges.length > 0 ? { informationalEdges: [...edges] } : {}),
      };
      plan.push(item);
    }
  }
  if (opts.useJobSpy !== false) {
    const loc = Array.isArray(opts.location) ? opts.location[0] : opts.location;
    for (const board of jobspyBoards) {
      const item: JobSpySlicePlanItem = {
        kind: 'jobspy',
        slice: sliceBase(`slice-jobspy-${board}`, ['jobspy'], 'qv-1'),
        board,
        ...(opts.jobspyFetchDescription === true ? { fetchDescription: true } : {}),
        filters: {
          ...(loc ? { location: loc } : {}),
          ...(opts.isRemote !== undefined ? { isRemote: opts.isRemote } : {}),
          ...(opts.jobType ? { jobType: opts.jobType } : {}),
          resultsWanted: opts.resultsWanted ?? 20,
        },
      };
      plan.push(item);
    }
  }
  return plan;
}

export function supportingIndexedProviderCount(
  ports: readonly Pick<IndexedProviderPort, 'governance' | 'enrichUrls'>[],
): number {
  return ports.filter(
    (p) => p.governance.supportsUrlAttributedSummary && typeof p.enrichUrls === 'function',
  ).length;
}

export function deriveJobsRunBudget(
  sliceCount: number,
  supportingProviderCount: number,
  stage: DerivedStageBudgets,
): {
  logicalRequests: number;
  reservedAttempts: number;
  candidates: number;
  bytes: number;
  milliseconds: number;
} {
  const logicalRequests = Math.min(32, Math.max(1, sliceCount + supportingProviderCount));
  const reservedAttempts = Math.min(10000, Math.max(20, 3 * Math.max(1, sliceCount)));
  const milliseconds = Math.min(300000, Math.max(25000 * Math.max(1, sliceCount), 70000));
  return {
    logicalRequests,
    reservedAttempts,
    candidates: stage.acquisitionCandidates,
    bytes: 200000,
    milliseconds,
  };
}

export type JobsRunBudget = ReturnType<typeof deriveJobsRunBudget>;
