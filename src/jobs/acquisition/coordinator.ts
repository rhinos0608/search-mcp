/* eslint-disable @typescript-eslint/no-unnecessary-condition -- runtime guards for untyped caller input */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- branded/cast needed for exactOptional and policy types */
import { z } from 'zod/v4';
import {
  ACQUISITION_CONTRACT_VERSION,
  AcquisitionPolicyEdgeSchema,
  AcquisitionSliceResultSchema,
  AcquisitionSliceSchema,
  PolicyTargetSchema,
  type AcquisitionPolicyEdge,
  type AcquisitionSliceResult,
} from './contracts.js';
import { acquiredContentHash } from './adapterSupport.js';
import { resolveExecutionPolicyEdge } from './policy/edgeCoordinator.js';
import { runIndexedProvider } from './providers/indexed.js';
import { runJobSpyBoard, JOBSPY_BOARDS } from './adapters/jobspy.js';
import { runManualImport } from './adapters/manualImport.js';
import { validationError } from '../../errors.js';
import { InstantSchema } from '../domain/ids.js';
import type { SourcePolicyRegistry } from './policy/registry.js';
import type { AdapterCapabilityRegistry } from './adapterRegistry.js';
import type {
  IndexedProviderPort,
  IndexedSafeSearch,
  IndexedSummaryMode,
} from './providers/ports.js';
import type { JobSpyScrapeResult } from './adapters/jobspy.js';

export const ACQUISITION_COORDINATOR_VERSION = '1.0.0' as const;

const text256 = z.string().trim().min(1).max(256);
const warnText = z.string().trim().min(1).max(1024);

export const AcquisitionRunBudgetSchema = z
  .object({
    logicalRequests: z.number().int().min(1).max(10000),
    reservedAttempts: z.number().int().min(1).max(10000),
    candidates: z.number().int().min(1).max(10000),
    bytes: z.number().int().min(1).max(100_000_000),
    milliseconds: z.number().int().min(1).max(86_400_000),
  })
  .strict();
export type AcquisitionRunBudget = z.infer<typeof AcquisitionRunBudgetSchema>;

const SafeSearchSchema = z.enum([
  'strict',
  'moderate',
  'off',
]) satisfies z.ZodType<IndexedSafeSearch>;
const SummaryModeSchema = z.enum(['no', 'yes', 'only']) satisfies z.ZodType<IndexedSummaryMode>;

const JobSpyBoardSchema = z.enum(JOBSPY_BOARDS as unknown as [string, ...string[]]);

const ManualContentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('inline_text'),
      text: z.string().trim().min(1).max(32768),
      destinationUrl: z.string().trim().min(1).max(8192).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('structured_fields'),
      title: z.string().trim().min(1).max(1024).optional(),
      company: z.string().trim().min(1).max(1024).optional(),
      location: z.string().trim().min(1).max(1024).optional(),
      description: z.string().trim().min(1).max(32768).optional(),
      salary: z.string().trim().min(1).max(1024).optional(),
      requirements: z.array(z.string().trim().min(1).max(1024)).max(32).optional(),
      destinationUrl: z.string().trim().min(1).max(8192).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('url_only'),
      destinationUrl: z.string().trim().min(1).max(8192),
    })
    .strict(),
]);

export const IndexedSlicePlanItemSchema = z
  .object({
    kind: z.literal('indexed'),
    slice: AcquisitionSliceSchema,
    providerId: text256,
    safeSearch: SafeSearchSchema,
    aiSummary: SummaryModeSchema.optional(),
    informationalEdges: z.array(AcquisitionPolicyEdgeSchema).max(99).optional(),
  })
  .strict();
export type IndexedSlicePlanItem = z.infer<typeof IndexedSlicePlanItemSchema>;

export const JobSpySlicePlanItemSchema = z
  .object({
    kind: z.literal('jobspy'),
    slice: AcquisitionSliceSchema,
    board: JobSpyBoardSchema,
    filters: z
      .object({
        location: z.string().max(512).optional(),
        isRemote: z.boolean().optional(),
        jobType: z
          .enum([
            'fulltime',
            'parttime',
            'contract',
            'temporary',
            'internship',
            'perdiem',
            'nights',
            'other',
            'summer',
            'volunteer',
          ])
          .optional(),
        resultsWanted: z.number().int().min(1).max(50).optional(),
        country: z.string().max(512).optional(),
        hoursOld: z.number().min(0).max(720).optional(),
        enforceAnnualSalary: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type JobSpySlicePlanItem = z.infer<typeof JobSpySlicePlanItemSchema>;

export const ManualSlicePlanItemSchema = z
  .object({
    kind: z.literal('manual'),
    slice: AcquisitionSliceSchema,
    submittedBy: z
      .object({
        namespace: z.string().trim().min(1).max(128),
        id: z.string().trim().min(1).max(256),
      })
      .strict(),
    content: ManualContentSchema,
    publisherTarget: PolicyTargetSchema.optional(),
    destinationFetchEdge: AcquisitionPolicyEdgeSchema.optional(),
  })
  .strict();
export type ManualSlicePlanItem = z.infer<typeof ManualSlicePlanItemSchema>;

export const AcquisitionSlicePlanItemSchema = z.discriminatedUnion('kind', [
  IndexedSlicePlanItemSchema,
  JobSpySlicePlanItemSchema,
  ManualSlicePlanItemSchema,
]);
export type AcquisitionSlicePlanItem = z.infer<typeof AcquisitionSlicePlanItemSchema>;

export const AcquisitionRunOptionsSchema = z
  .object({
    runId: text256,
    capturedAt: InstantSchema,
    budget: AcquisitionRunBudgetSchema,
    plan: z.array(AcquisitionSlicePlanItemSchema).max(100),
    abortSignal: z
      .custom<AbortSignal>(
        (v) =>
          v === undefined ||
          (v !== null && typeof v === 'object' && 'aborted' in (v as Record<string, unknown>)),
        'invalid abortSignal',
      )
      .optional(),
  })
  .strict();
export type AcquisitionRunOptions = z.infer<typeof AcquisitionRunOptionsSchema>;

export interface AcquisitionRunDeps {
  policyRegistry: SourcePolicyRegistry;
  capabilityRegistry: AdapterCapabilityRegistry;
  ports: readonly IndexedProviderPort[];
  scrapeJobs: (params: Record<string, unknown>) => Promise<JobSpyScrapeResult>;
  monotonicNow?: () => number;
}

export const AcquisitionRunStatusSchema = z.enum([
  'completed',
  'budget_exhausted',
  'deadline_exceeded',
  'aborted',
]);
export type AcquisitionRunStatus = z.infer<typeof AcquisitionRunStatusSchema>;

export const AcquisitionSkippedSliceSchema = z
  .object({
    sliceId: z.string().trim().min(1).max(256),
    reason: z.enum(['budget_exhausted', 'deadline_exceeded', 'aborted']),
  })
  .strict();
export type AcquisitionSkippedSlice = z.infer<typeof AcquisitionSkippedSliceSchema>;

export const AcquisitionDestinationFetchReviewSchema = z
  .object({
    sliceId: z.string().trim().min(1).max(256),
    priorFetchEdgeRef: text256,
    recheckEdgeRef: text256,
    recheckState: z.enum([
      'permitted',
      'blocked',
      'requires_configuration',
      'requires_review',
      'not_supported',
    ]),
    disposition: z.enum(['fetch_pending', 'fetch_not_permitted']),
  })
  .strict();
export type AcquisitionDestinationFetchReview = z.infer<
  typeof AcquisitionDestinationFetchReviewSchema
>;

export const AcquisitionDuplicateGroupSchema = z
  .object({
    canonicalUrl: z.string().min(1).max(8192),
    retainedCandidateId: text256,
    superseded: z.array(
      z
        .object({
          candidateId: text256,
          sliceId: z.string().trim().min(1).max(256),
        })
        .strict(),
    ),
  })
  .strict();
export type AcquisitionDuplicateGroup = z.infer<typeof AcquisitionDuplicateGroupSchema>;

export const AcquisitionRunResultSchema = z
  .object({
    status: AcquisitionRunStatusSchema,
    slices: z.array(AcquisitionSliceResultSchema).max(100),
    skipped: z.array(AcquisitionSkippedSliceSchema).max(100),
    destinationFetchReviews: z.array(AcquisitionDestinationFetchReviewSchema).max(100),
    duplicates: z.array(AcquisitionDuplicateGroupSchema).max(50000),
    warnings: z.array(warnText).max(100),
    budgetConsumed: z
      .object({
        logicalRequests: z.number().int().min(0).max(10000),
        reservedAttempts: z.number().int().min(0).max(10000),
        candidates: z.number().int().min(0).max(10000),
        bytes: z.number().int().min(0).max(100_000_000),
        milliseconds: z.number().int().min(0).max(86_400_000),
      })
      .strict(),
  })
  .strict();
export type AcquisitionRunResult = z.infer<typeof AcquisitionRunResultSchema>;

function throwValidation(): never {
  throw validationError('VALIDATION_ERROR');
}

function clampedDurationMs(startMs: number, nowMs: number): number {
  const raw = Math.floor(nowMs - startMs);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  if (raw > 86_400_000) return 86_400_000;
  return raw;
}

function edgeIdFor(
  runId: string,
  sliceId: string,
  adapterId: string,
  operation: string,
  purpose: 'execution' | 'recheck',
): string {
  return acquiredContentHash(
    JSON.stringify(['acquisition-edge', runId, sliceId, adapterId, operation, purpose]),
  );
}

// mirrors compareCodePoints in adapterRegistry.ts; local copy honors coordinator import allowlist
function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) ?? 0;
    const cb = b.codePointAt(j) ?? 0;
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i >= a.length && j >= b.length) return 0;
  return i >= a.length ? -1 : 1;
}

function stateRank(state: string): number {
  if (state === 'adapter_acquired') return 4;
  if (state === 'destination_fetched') return 3;
  if (state === 'manual_content') return 2;
  if (state === 'indexed_only') return 1;
  return 0;
}

function buildBudgetConsumed(): AcquisitionRunResult['budgetConsumed'] {
  return { logicalRequests: 0, reservedAttempts: 0, candidates: 0, bytes: 0, milliseconds: 0 };
}

export async function runAcquisition(
  options: AcquisitionRunOptions,
  deps: AcquisitionRunDeps,
): Promise<AcquisitionRunResult> {
  const monotonicNow = deps.monotonicNow ?? (() => Date.now());
  const runStart = monotonicNow();

  // ----- pre-run validation before any resolution -----
  let parsedOptions: AcquisitionRunOptions;
  try {
    parsedOptions = AcquisitionRunOptionsSchema.parse(options);
  } catch {
    throwValidation();
  }
  // runId must equal every slice.runId
  for (const item of parsedOptions.plan) {
    if (item.slice.runId !== parsedOptions.runId) throwValidation();
  }
  // duplicate sliceId rejection pre-run
  {
    const seen = new Set<string>();
    for (const item of parsedOptions.plan) {
      const sid = item.slice.sliceId;
      if (seen.has(sid)) throwValidation();
      seen.add(sid);
    }
  }
  // each slice already parsed via AcquisitionSliceSchema inside plan schema
  // budget caps already validated via schema
  // every indexed item must have matching dep port
  const portByProvider = new Map<string, (typeof deps.ports)[number]>();
  for (const p of deps.ports) portByProvider.set(p.providerId, p);
  for (const item of parsedOptions.plan) {
    if (item.kind === 'indexed' && !portByProvider.has(item.providerId)) throwValidation();
  }
  // deps validation minimal
  if (
    !deps.policyRegistry ||
    typeof (deps.policyRegistry as unknown as { decide: unknown }).decide !== 'function'
  ) {
    throwValidation();
  }
  if (
    !deps.capabilityRegistry ||
    typeof (deps.capabilityRegistry as unknown as { supports: unknown }).supports !== 'function'
  ) {
    throwValidation();
  }
  if (!Array.isArray(deps.ports)) throwValidation();
  if (typeof deps.scrapeJobs !== 'function') throwValidation();

  const slices: AcquisitionSliceResult[] = [];
  const skipped: AcquisitionSkippedSlice[] = [];
  const destinationFetchReviews: AcquisitionDestinationFetchReview[] = [];
  const warnings: string[] = [];
  const budgetConsumed = buildBudgetConsumed();
  let remaining = { ...parsedOptions.budget };

  const updateRemaining = () => {
    remaining = {
      logicalRequests: parsedOptions.budget.logicalRequests - budgetConsumed.logicalRequests,
      reservedAttempts: parsedOptions.budget.reservedAttempts - budgetConsumed.reservedAttempts,
      candidates: parsedOptions.budget.candidates - budgetConsumed.candidates,
      bytes: parsedOptions.budget.bytes - budgetConsumed.bytes,
      milliseconds: parsedOptions.budget.milliseconds - budgetConsumed.milliseconds,
    };
  };

  const consumeCoverage = (coverageArray: AcquisitionSliceResult['coverage']) => {
    let logical = 0;
    let attempts = 0;
    let bytes = 0;
    let ms = 0;
    let cand = 0;
    for (const c of coverageArray) {
      logical += c.logicalRequestsUsed;
      attempts += c.attemptsReserved;
      bytes += c.bytesUsed;
      ms += c.durationMs;
      cand += c.candidatesProduced;
    }
    budgetConsumed.logicalRequests += logical;
    budgetConsumed.reservedAttempts += attempts;
    budgetConsumed.bytes += bytes;
    budgetConsumed.milliseconds += ms;
    budgetConsumed.candidates += cand;

    let overrun = false;
    if (budgetConsumed.logicalRequests > parsedOptions.budget.logicalRequests) {
      budgetConsumed.logicalRequests = parsedOptions.budget.logicalRequests;
      overrun = true;
    }
    if (budgetConsumed.reservedAttempts > parsedOptions.budget.reservedAttempts) {
      budgetConsumed.reservedAttempts = parsedOptions.budget.reservedAttempts;
      overrun = true;
    }
    if (budgetConsumed.candidates > parsedOptions.budget.candidates) {
      budgetConsumed.candidates = parsedOptions.budget.candidates;
      overrun = true;
    }
    if (budgetConsumed.bytes > parsedOptions.budget.bytes) {
      budgetConsumed.bytes = parsedOptions.budget.bytes;
      overrun = true;
    }
    if (budgetConsumed.milliseconds > parsedOptions.budget.milliseconds) {
      budgetConsumed.milliseconds = parsedOptions.budget.milliseconds;
      overrun = true;
    }
    if (overrun && !warnings.includes('budget_overrun')) warnings.push('budget_overrun');
    updateRemaining();
  };

  // track flags for status precedence
  let seenAborted = false;
  let seenDeadline = false;
  let seenBudget = false;

  for (const item of parsedOptions.plan) {
    // abort/deadline checked between slices only
    const elapsed = Math.max(0, monotonicNow() - runStart);
    if (parsedOptions.abortSignal?.aborted) {
      skipped.push({ sliceId: item.slice.sliceId, reason: 'aborted' });
      seenAborted = true;
      continue;
    }
    if (elapsed >= parsedOptions.budget.milliseconds) {
      skipped.push({ sliceId: item.slice.sliceId, reason: 'deadline_exceeded' });
      seenDeadline = true;
      continue;
    }
    // budget precheck per-slice using slice.budget vs remaining
    const sb = item.slice.budget;
    if (
      sb.logicalRequests > remaining.logicalRequests ||
      sb.reservedAttempts > remaining.reservedAttempts ||
      sb.candidates > remaining.candidates ||
      sb.bytes > remaining.bytes ||
      sb.milliseconds > remaining.milliseconds
    ) {
      skipped.push({ sliceId: item.slice.sliceId, reason: 'budget_exhausted' });
      seenBudget = true;
      continue;
    }

    // derive and resolve edges, then execute via adapters strictly sequential
    const sliceStart = monotonicNow();
    let sliceResult: AcquisitionSliceResult | undefined;
    let resolvedEdges: AcquisitionPolicyEdge[] = [];
    let adapterIdForFabrication = 'unknown';

    try {
      if (item.kind === 'indexed') {
        const existingPort = portByProvider.get(item.providerId);
        if (!existingPort) throw new Error('missing port');
        const port = existingPort;
        adapterIdForFabrication = port.adapterId;
        const edgeId = edgeIdFor(
          parsedOptions.runId,
          item.slice.sliceId,
          port.adapterId,
          'automatedSearch',
          'execution',
        );
        const req = {
          edgeId,
          actor: { kind: 'provider' as const, namespace: 'search-provider', id: item.providerId },
          operation: 'automatedSearch' as const,
          route: 'indexed' as const,
          target: { kind: 'discovery_provider' as const, sourceId: item.providerId },
        };
        const edge = resolveExecutionPolicyEdge(deps.policyRegistry as never, req as never, {
          decidedAt: parsedOptions.capturedAt,
        });
        resolvedEdges = [edge];
        const indexedReq: Record<string, unknown> = {
          slice: item.slice,
          executionEdge: edge,
          safeSearch: item.safeSearch,
          capturedAt: parsedOptions.capturedAt,
        };
        if (item.informationalEdges !== undefined)
          indexedReq.informationalEdges = item.informationalEdges;
        if (item.aiSummary !== undefined) indexedReq.aiSummary = item.aiSummary;
        const result = await runIndexedProvider(indexedReq as never, {
          capabilityRegistry: deps.capabilityRegistry as never,
          port: port as never,
          monotonicNow,
        });
        const parsed = AcquisitionSliceResultSchema.safeParse(result.sliceResult);
        if (!parsed.success) throw new Error('slice parse failed');
        sliceResult = parsed.data;
      } else if (item.kind === 'jobspy') {
        adapterIdForFabrication = 'jobspy';
        const edgeId = edgeIdFor(
          parsedOptions.runId,
          item.slice.sliceId,
          'jobspy',
          'automatedSearch',
          'execution',
        );
        const req = {
          edgeId,
          actor: { kind: 'adapter' as const, namespace: 'adapter', id: 'jobspy' },
          operation: 'automatedSearch' as const,
          route: 'direct' as const,
          target: { kind: 'board' as const, sourceId: item.board },
        };
        const edge = resolveExecutionPolicyEdge(deps.policyRegistry as never, req as never, {
          decidedAt: parsedOptions.capturedAt,
        });
        resolvedEdges = [edge];
        const result = await runJobSpyBoard(
          {
            slice: item.slice,
            board: item.board as never,
            executionEdge: edge,
            capturedAt: parsedOptions.capturedAt,
            filters: item.filters as never,
          },
          {
            capabilityRegistry: deps.capabilityRegistry as never,
            scrapeJobs: deps.scrapeJobs as never,
            monotonicNow,
          },
        );
        const parsed = AcquisitionSliceResultSchema.safeParse(result);
        if (!parsed.success) throw new Error('slice parse failed');
        sliceResult = parsed.data;
      } else {
        adapterIdForFabrication = 'manual';
        const target = item.publisherTarget ?? { kind: 'adapter' as const, sourceId: 'manual' };
        const edgeId1 = edgeIdFor(
          parsedOptions.runId,
          item.slice.sliceId,
          'manual',
          'manualImport',
          'execution',
        );
        const edgeId2 = edgeIdFor(
          parsedOptions.runId,
          item.slice.sliceId,
          'manual',
          'userSuppliedContent',
          'execution',
        );
        const req1 = {
          edgeId: edgeId1,
          actor: {
            kind: 'user' as const,
            namespace: item.submittedBy.namespace,
            id: item.submittedBy.id,
          },
          operation: 'manualImport' as const,
          route: 'user_supplied' as const,
          target: target as never,
        };
        const req2 = {
          edgeId: edgeId2,
          actor: {
            kind: 'user' as const,
            namespace: item.submittedBy.namespace,
            id: item.submittedBy.id,
          },
          operation: 'userSuppliedContent' as const,
          route: 'user_supplied' as const,
          target: target as never,
        };
        const e1 = resolveExecutionPolicyEdge(deps.policyRegistry as never, req1 as never, {
          decidedAt: parsedOptions.capturedAt,
        });
        const e2 = resolveExecutionPolicyEdge(deps.policyRegistry as never, req2 as never, {
          decidedAt: parsedOptions.capturedAt,
        });
        resolvedEdges = [e1, e2];
        // destinationFetchEdge is pre-resolved passthrough, do not re-resolve here
        const manualReq: Record<string, unknown> = {
          slice: item.slice,
          capturedAt: parsedOptions.capturedAt,
          submittedBy: item.submittedBy,
          content: item.content,
          manualImportEdge: e1,
          userSuppliedContentEdge: e2,
        };
        if (item.destinationFetchEdge) manualReq.destinationFetchEdge = item.destinationFetchEdge;
        const manualResult = runManualImport(manualReq as never) as unknown as {
          status: string;
          sliceResult: AcquisitionSliceResult;
          destination?: unknown;
          priorFetchEdgeRef?: string;
        };
        const parsed = AcquisitionSliceResultSchema.safeParse(manualResult.sliceResult);
        if (!parsed.success) throw new Error('slice parse failed');
        sliceResult = parsed.data;

        // handle destination_fetch_required re-resolution
        if (manualResult.status === 'destination_fetch_required') {
          const prior = item.destinationFetchEdge;
          if (!prior) {
            // fabricated failure with unexpected_fetch_review
            const dur = clampedDurationMs(sliceStart, monotonicNow());
            const cov = {
              schemaVersion: ACQUISITION_CONTRACT_VERSION,
              adapterId: 'manual',
              state: 'failed' as const,
              resultState: 'unknown' as const,
              candidatesProduced: 0,
              logicalRequestsUsed: 0,
              attemptsReserved: 0,
              bytesUsed: 0,
              durationMs: dur,
              errorCode: 'ERROR',
              policyEdgeRefs: resolvedEdges.map((e) => e.edgeId),
            };
            const fabricated = {
              schemaVersion: ACQUISITION_CONTRACT_VERSION,
              runId: item.slice.runId,
              sliceId: item.slice.sliceId,
              candidates: [],
              coverage: [cov],
              warnings: ['slice_execution_error'],
              evidence: [],
              observations: [],
              policyEdges: resolvedEdges,
            };
            const fabParsed = AcquisitionSliceResultSchema.parse(fabricated);
            if (!warnings.includes('unexpected_fetch_review'))
              warnings.push('unexpected_fetch_review');
            sliceResult = fabParsed;
          } else {
            const recheckId = edgeIdFor(
              parsedOptions.runId,
              item.slice.sliceId,
              'manual',
              'automatedFetch',
              'recheck',
            );
            const recheckReq = {
              edgeId: recheckId,
              actor: prior.actor,
              operation: prior.operation,
              route: prior.route,
              target: prior.target,
            };
            const decidedAt = new Date(monotonicNow()).toISOString();
            const recheckEdge = resolveExecutionPolicyEdge(
              deps.policyRegistry as never,
              recheckReq as never,
              { decidedAt },
            );
            const disposition =
              recheckEdge.state === 'permitted' ? 'fetch_pending' : 'fetch_not_permitted';
            const review: AcquisitionDestinationFetchReview = {
              sliceId: item.slice.sliceId,
              priorFetchEdgeRef: prior.edgeId,
              recheckEdgeRef: recheckEdge.edgeId,
              recheckState: recheckEdge.state,
              disposition,
            };
            AcquisitionDestinationFetchReviewSchema.parse(review);
            destinationFetchReviews.push(review);
            if (
              disposition === 'fetch_not_permitted' &&
              !warnings.includes('destination_fetch_not_permitted')
            ) {
              warnings.push('destination_fetch_not_permitted');
            }
          }
        }
      }
    } catch {
      const dur = clampedDurationMs(sliceStart, monotonicNow());
      const policyRefs = resolvedEdges.length > 0 ? resolvedEdges.map((e) => e.edgeId) : [];
      const cov = {
        schemaVersion: ACQUISITION_CONTRACT_VERSION,
        adapterId: adapterIdForFabrication,
        state: 'failed' as const,
        resultState: 'unknown' as const,
        candidatesProduced: 0,
        logicalRequestsUsed: 0,
        attemptsReserved: 0,
        bytesUsed: 0,
        durationMs: dur,
        errorCode: 'ERROR',
        policyEdgeRefs: policyRefs,
      };
      const fabricated = {
        schemaVersion: ACQUISITION_CONTRACT_VERSION,
        runId: item.slice.runId,
        sliceId: item.slice.sliceId,
        candidates: [],
        coverage: [cov],
        warnings: ['slice_execution_error'],
        evidence: [],
        observations: [],
        policyEdges: resolvedEdges,
      };
      const parsed = AcquisitionSliceResultSchema.safeParse(fabricated);
      if (!parsed.success) {
        // fallback minimal with empty policyEdges if still invalid (e.g., empty policyEdgeRefs allowed)
        const fallback = {
          ...fabricated,
          coverage: [{ ...cov, policyEdgeRefs: [] }],
          policyEdges: [],
        };
        sliceResult = AcquisitionSliceResultSchema.parse(fallback);
      } else {
        sliceResult = parsed.data;
      }
      if (!warnings.includes('slice_execution_error')) warnings.push('slice_execution_error');
    }

    if (!sliceResult) continue;
    // defensive safeParse already done; but ensure again
    const safe = AcquisitionSliceResultSchema.safeParse(sliceResult);
    if (!safe.success) {
      const dur = clampedDurationMs(sliceStart, monotonicNow());
      const cov = {
        schemaVersion: ACQUISITION_CONTRACT_VERSION,
        adapterId: adapterIdForFabrication,
        state: 'failed' as const,
        resultState: 'unknown' as const,
        candidatesProduced: 0,
        logicalRequestsUsed: 0,
        attemptsReserved: 0,
        bytesUsed: 0,
        durationMs: dur,
        errorCode: 'ERROR',
        policyEdgeRefs: resolvedEdges.map((e) => e.edgeId),
      };
      const fabricated = {
        schemaVersion: ACQUISITION_CONTRACT_VERSION,
        runId: item.slice.runId,
        sliceId: item.slice.sliceId,
        candidates: [],
        coverage: [cov],
        warnings: ['slice_execution_error'],
        evidence: [],
        observations: [],
        policyEdges: resolvedEdges,
      };
      sliceResult = AcquisitionSliceResultSchema.parse(fabricated);
      if (!warnings.includes('slice_execution_error')) warnings.push('slice_execution_error');
    }

    slices.push(sliceResult);
    consumeCoverage(sliceResult.coverage);
  }

  // cross-slice dedup annotation-only
  const duplicates: AcquisitionDuplicateGroup[] = [];
  const groups = new Map<
    string,
    { candidateId: string; sliceId: string; state: string; planIndex: number }[]
  >();
  for (const [sIdx, sr] of slices.entries()) {
    const planIndex = parsedOptions.plan.findIndex((p) => p.slice.sliceId === sr.sliceId);
    for (const cand of sr.candidates) {
      const dest = (cand.provenance as unknown as { destination?: { canonicalUrl?: string } })
        .destination;
      const url = dest?.canonicalUrl;
      if (!url) continue;
      const arr = groups.get(url) ?? [];
      arr.push({
        candidateId: cand.candidateId,
        sliceId: sr.sliceId,
        state: cand.state,
        planIndex: planIndex >= 0 ? planIndex : sIdx,
      });
      groups.set(url, arr);
    }
  }
  for (const [canonicalUrl, entries] of groups) {
    if (entries.length <= 1) continue;
    const sorted = [...entries].sort((a, b) => {
      const ra = stateRank(a.state);
      const rb = stateRank(b.state);
      if (ra !== rb) return rb - ra;
      if (a.planIndex !== b.planIndex) return a.planIndex - b.planIndex;
      return compareCodePoints(a.candidateId, b.candidateId);
    });
    const retained = sorted[0];
    if (!retained) continue;
    const superseded = sorted
      .slice(1)
      .map((e) => ({ candidateId: e.candidateId, sliceId: e.sliceId }));
    const group: AcquisitionDuplicateGroup = {
      canonicalUrl,
      retainedCandidateId: retained.candidateId,
      superseded,
    };
    // validate
    AcquisitionDuplicateGroupSchema.parse(group);
    duplicates.push(group);
  }

  // status precedence aborted > deadline_exceeded > budget_exhausted > completed
  let status: AcquisitionRunStatus = 'completed';
  if (seenAborted) status = 'aborted';
  else if (seenDeadline) status = 'deadline_exceeded';
  else if (seenBudget) status = 'budget_exhausted';

  // handle warnings for budget/deadline/aborted
  if (seenBudget && !warnings.includes('budget_exhausted')) warnings.push('budget_exhausted');
  if (seenDeadline && !warnings.includes('deadline_exceeded')) warnings.push('deadline_exceeded');
  if (seenAborted && !warnings.includes('aborted')) warnings.push('aborted');

  const result = {
    status,
    slices,
    skipped,
    destinationFetchReviews,
    duplicates,
    warnings: warnings.slice(0, 100),
    budgetConsumed,
  };
  try {
    return AcquisitionRunResultSchema.parse(result);
  } catch {
    throw validationError('VALIDATION_ERROR');
  }
}
