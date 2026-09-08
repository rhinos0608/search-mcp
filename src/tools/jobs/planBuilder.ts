import type { AcquisitionSlicePlanItem } from '../../jobs/acquisition/coordinator.js';

export interface PlanBuilderOptions {
  query: string;
  location?: string | string[];
  workMode?: ('remote' | 'hybrid' | 'onsite')[];
  isRemote?: boolean;
  jobType?: 'fulltime' | 'parttime' | 'contract' | 'temporary' | 'internship';
  sydney?: boolean;
  useJobSpy?: boolean;
  resultsWanted?: number;
}

export function buildPlan(
  opts: PlanBuilderOptions,
  runId: string,
  providerIds: readonly string[],
  jobspyBoards: readonly string[],
): AcquisitionSlicePlanItem[] {
  const plan: AcquisitionSlicePlanItem[] = [];
  let ordinal = 0;
  const sliceCount = providerIds.length + (opts.useJobSpy === false ? 0 : jobspyBoards.length);
  const share = (total: number, index: number) => {
    const count = Math.max(1, sliceCount);
    const base = Math.floor(total / count);
    return Math.max(1, base + (index < total % count ? 1 : 0));
  };
  const sliceBase = (sliceId: string, adapterIds: string[]) => {
    const sliceIndex = ordinal;
    return {
      schemaVersion: '1.0.0' as const,
      runId,
      sliceId,
      ordinal: ordinal++,
      queryVariantId: 'qv-1',
      query: opts.query.slice(0, 2048),
      reason: 'mcp jobs_search request',
      adapterIds,
      localePackRefs: opts.sydney === true ? ['locale:au-nsw-sydney:1.0.0'] : [],
      domainPackRefs: opts.sydney === true ? ['domain:nsw-public-admin:1.0.0'] : [],
      budget: {
        logicalRequests: share(10, sliceIndex),
        reservedAttempts: share(20, sliceIndex),
        candidates: share(10, sliceIndex),
        bytes: share(200000, sliceIndex),
        // Indexed adapters require their declared maxDurationMs; coordinator
        // bounds aggregate work with run budget.
        milliseconds: 70000,
      },
    };
  };
  for (const providerId of providerIds) {
    plan.push({
      kind: 'indexed',
      slice: sliceBase(`slice-indexed-${providerId.replace(/[^A-Za-z0-9_-]/g, '-')}`, ['indexed']),
      providerId,
      safeSearch: 'moderate',
    } as unknown as AcquisitionSlicePlanItem);
  }
  if (opts.useJobSpy !== false) {
    const loc = Array.isArray(opts.location) ? opts.location[0] : opts.location;
    for (const board of jobspyBoards) {
      plan.push({
        kind: 'jobspy',
        slice: sliceBase(`slice-jobspy-${board}`, ['jobspy']),
        board,
        filters: {
          ...(loc ? { location: loc } : {}),
          ...(opts.isRemote !== undefined ? { isRemote: opts.isRemote } : {}),
          ...(opts.jobType ? { jobType: opts.jobType } : {}),
          resultsWanted: opts.resultsWanted ?? 20,
        },
      } as unknown as AcquisitionSlicePlanItem);
    }
  }
  return plan;
}
