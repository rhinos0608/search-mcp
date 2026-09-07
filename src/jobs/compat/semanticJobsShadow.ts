/* eslint-disable @typescript-eslint/no-unnecessary-condition -- runtime guards for untyped caller input */
/**
 * W3-I semantic_jobs shadow comparison.
 *
 * Frozen contract: sequential path isolation (one legacy multi-site searchJobSpy
 * call, then runAcquisition with the same plan), aggregate-only canonical-URL
 * set comparison, zero telemetry, zero persistence, no cutover. See
 * docs/jobs/indexed-discovery-amendment.md.
 */
import { z } from 'zod/v4';
import {
  AcquisitionRunBudgetSchema,
  AcquisitionRunResultSchema,
  runAcquisition,
  type AcquisitionRunOptions,
  type AcquisitionRunResult,
} from '../acquisition/coordinator.js';
import {
  JOBSPY_BOARDS,
  type JobSpyBoard,
  type JobSpyScrapeResult,
} from '../acquisition/adapters/jobspy.js';
import { acquiredContentHash, normalizeHttpUrlMetadata } from '../acquisition/adapterSupport.js';
import { AcquisitionSliceSchema, type AcquisitionCoverage } from '../acquisition/contracts.js';
import { InstantSchema } from '../domain/ids.js';
import { isToolError, validationError, type ToolErrorCode } from '../../errors.js';
import type { SourcePolicyRegistry } from '../acquisition/policy/registry.js';
import type { AdapterCapabilityRegistry } from '../acquisition/adapterRegistry.js';
import type { FlatJobRecord, JobSpyAcquisitionParams } from '../../utils/jobspyClient.js';

export const SEMANTIC_JOBS_SHADOW_VERSION = '1.0.0' as const;

const JobSpyBoardSchema = z.enum(JOBSPY_BOARDS);

const toolErrorCodeSchema = z.enum([
  'RATE_LIMIT',
  'NOT_FOUND',
  'TIMEOUT',
  'NETWORK_ERROR',
  'PARSE_ERROR',
  'UNAVAILABLE',
  'VALIDATION_ERROR',
  'CONFIG_ERROR',
  'ERROR',
]);

export const SemanticJobsShadowPlanItemSchema = z
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
        resultsWanted: z.number().int().min(1).max(50),
        country: z.string().max(512).optional(),
        hoursOld: z.number().min(1).max(720),
        enforceAnnualSalary: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
export type SemanticJobsShadowPlanItem = z.infer<typeof SemanticJobsShadowPlanItemSchema>;

export const SemanticJobsShadowRequestSchema = z
  .object({
    runId: z.string().trim().min(1).max(256),
    capturedAt: InstantSchema,
    budget: AcquisitionRunBudgetSchema,
    plan: z.array(SemanticJobsShadowPlanItemSchema).min(1).max(9),
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
export type SemanticJobsShadowRequest = z.infer<typeof SemanticJobsShadowRequestSchema>;

const coverageStateSchema = z.enum([
  'succeeded',
  'partial',
  'failed',
  'disabled',
  'policy_blocked',
  'not_supported',
]);

export const SemanticJobsShadowResultSchema = z
  .object({
    schemaVersion: z.literal(SEMANTIC_JOBS_SHADOW_VERSION),
    status: z.enum(['completed', 'partial', 'aborted']),
    legacy: z
      .object({
        status: z.enum(['completed', 'failed', 'aborted']),
        callCount: z.number().int().min(0).max(1),
        recordCount: z.number().int().min(0).max(1_000_000),
        keyedCount: z.number().int().min(0).max(1_000_000),
        unkeyedCount: z.number().int().min(0).max(1_000_000),
        unplannedBoardCount: z.number().int().min(0).max(1_000_000),
        errorCode: toolErrorCodeSchema.optional(),
      })
      .strict(),
    coordinator: z
      .object({
        status: z.enum([
          'completed',
          'budget_exhausted',
          'deadline_exceeded',
          'aborted',
          'failed',
          'not_run',
        ]),
        sliceCount: z.number().int().min(0).max(9),
        skippedCount: z.number().int().min(0).max(9),
        candidateCount: z.number().int().min(0).max(100_000),
        duplicateGroupCount: z.number().int().min(0).max(50_000),
        policyBlockedSliceCount: z.number().int().min(0).max(9),
        coverageCalls: z.number().int().min(0).max(10_000),
        warningCodes: z.array(z.string().trim().min(1).max(1024)).max(100),
        budgetConsumed: AcquisitionRunResultSchema.shape.budgetConsumed.optional(),
        errorCode: toolErrorCodeSchema.optional(),
      })
      .strict(),
    boards: z
      .array(
        z
          .object({
            board: JobSpyBoardSchema,
            legacyRecordCount: z.number().int().min(0).max(1_000_000),
            coordinatorCandidateCount: z.number().int().min(0).max(100_000),
            coordinatorCoverageState: coverageStateSchema.optional(),
          })
          .strict(),
      )
      .max(9),
    comparison: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('computed'),
          key: z.literal('canonical_url_sha256'),
          shared: z.number().int().min(0).max(1_000_000),
          legacyOnly: z.number().int().min(0).max(1_000_000),
          coordinatorOnly: z.number().int().min(0).max(1_000_000),
          union: z.number().int().min(0).max(1_000_000),
          jaccardMillis: z.number().int().min(0).max(1000).nullable(),
        })
        .strict(),
      z
        .object({
          status: z.literal('not_computed'),
          reason: z.enum([
            'legacy_failed',
            'coordinator_failed',
            'coordinator_incomplete',
            'aborted',
          ]),
        })
        .strict(),
    ]),
  })
  .strict();
export type SemanticJobsShadowResult = z.infer<typeof SemanticJobsShadowResultSchema>;

export type SemanticJobsShadowComparison = SemanticJobsShadowResult['comparison'];

export interface SemanticJobsShadowDeps {
  policyRegistry: SourcePolicyRegistry;
  capabilityRegistry: AdapterCapabilityRegistry;
  scrapeJobs: (params: Record<string, unknown>) => Promise<JobSpyScrapeResult>;
  searchJobSpy: (params: JobSpyAcquisitionParams) => Promise<readonly FlatJobRecord[]>;
  monotonicNow?: () => number;
}

interface ShadowBoardRow {
  board: JobSpyBoard;
  legacyRecordCount: number;
  coordinatorCandidateCount: number;
  coordinatorCoverageState?: AcquisitionCoverage['state'];
}

function throwValidation(): never {
  throw validationError('VALIDATION_ERROR');
}

function errorCodeFor(err: unknown): ToolErrorCode | 'ERROR' {
  return isToolError(err) ? err.code : 'ERROR';
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function requireFunction(value: unknown): boolean {
  return typeof value === 'function';
}

export async function runSemanticJobsShadow(
  request: unknown,
  deps: SemanticJobsShadowDeps,
): Promise<SemanticJobsShadowResult> {
  // ----- validation before either path -----
  let parsed: SemanticJobsShadowRequest;
  try {
    parsed = SemanticJobsShadowRequestSchema.parse(request);
  } catch {
    throwValidation();
  }
  if (
    !deps ||
    !requireFunction((deps.policyRegistry as unknown as { decide?: unknown })?.decide) ||
    !requireFunction((deps.capabilityRegistry as unknown as { supports?: unknown })?.supports) ||
    !requireFunction(deps.scrapeJobs) ||
    !requireFunction(deps.searchJobSpy) ||
    (deps.monotonicNow !== undefined && !requireFunction(deps.monotonicNow))
  ) {
    throwValidation();
  }

  const plan = parsed.plan;
  const first = plan[0];
  if (!first) throwValidation();
  const seenBoards = new Set<string>();
  const seenSliceIds = new Set<string>();
  for (const item of plan) {
    if (item.slice.runId !== parsed.runId) throwValidation();
    if (seenBoards.has(item.board)) throwValidation();
    seenBoards.add(item.board);
    if (seenSliceIds.has(item.slice.sliceId)) throwValidation();
    seenSliceIds.add(item.slice.sliceId);
    if (item.slice.adapterIds.length !== 1 || item.slice.adapterIds[0] !== 'jobspy') {
      throwValidation();
    }
  }
  const commonQuery = first.slice.query;
  const commonFiltersJson = canonicalJson(first.filters);
  for (const item of plan) {
    if (item.slice.query !== commonQuery) throwValidation();
    if (canonicalJson(item.filters) !== commonFiltersJson) throwValidation();
  }

  const boardRows: ShadowBoardRow[] = plan.map((item) => ({
    board: item.board,
    legacyRecordCount: 0,
    coordinatorCandidateCount: 0,
  }));
  const rowByBoard = new Map<string, ShadowBoardRow>();
  for (const row of boardRows) rowByBoard.set(row.board, row);
  const boardBySliceId = new Map<string, JobSpyBoard>();
  for (const item of plan) boardBySliceId.set(item.slice.sliceId, item.board);

  const finish = (
    status: SemanticJobsShadowResult['status'],
    legacy: SemanticJobsShadowResult['legacy'],
    coordinator: SemanticJobsShadowResult['coordinator'],
    comparison: SemanticJobsShadowComparison,
  ): SemanticJobsShadowResult => {
    return SemanticJobsShadowResultSchema.parse({
      schemaVersion: SEMANTIC_JOBS_SHADOW_VERSION,
      status,
      legacy,
      coordinator,
      boards: boardRows,
      comparison,
    });
  };

  // ----- abort precheck (before legacy) -----
  if (parsed.abortSignal?.aborted) {
    return finish(
      'aborted',
      {
        status: 'aborted',
        callCount: 0,
        recordCount: 0,
        keyedCount: 0,
        unkeyedCount: 0,
        unplannedBoardCount: 0,
      },
      {
        status: 'not_run',
        sliceCount: 0,
        skippedCount: 0,
        candidateCount: 0,
        duplicateGroupCount: 0,
        policyBlockedSliceCount: 0,
        coverageCalls: 0,
        warningCodes: [],
      },
      { status: 'not_computed', reason: 'aborted' },
    );
  }

  // ----- legacy acquisition: exactly one multi-site searchJobSpy call -----
  let legacy: SemanticJobsShadowResult['legacy'];
  const legacyKeys = new Set<string>();
  const f = first.filters;
  const legacyParams: JobSpyAcquisitionParams = {
    query: commonQuery,
    sites: plan.map((item) => item.board),
    resultsWanted: f.resultsWanted,
    hoursOld: f.hoursOld,
    ...(f.location !== undefined ? { location: f.location } : {}),
    ...(f.isRemote !== undefined ? { isRemote: f.isRemote } : {}),
    ...(f.jobType !== undefined ? { jobType: f.jobType } : {}),
    ...(f.country !== undefined ? { country: f.country } : {}),
    ...(f.enforceAnnualSalary !== undefined ? { enforceAnnualSalary: f.enforceAnnualSalary } : {}),
  };
  try {
    const records = await deps.searchJobSpy(legacyParams);
    let keyed = 0;
    let unkeyed = 0;
    let unplanned = 0;
    let recordCount = 0;
    for (const rec of records) {
      recordCount += 1;
      const site = typeof rec.site === 'string' ? rec.site : '';
      const row = rowByBoard.get(site);
      if (!row) {
        unplanned += 1;
        continue;
      }
      row.legacyRecordCount += 1;
      // W3-E selection: valid job_url, else valid job_url_direct (credential-free HTTP(S) canonical)
      const meta =
        normalizeHttpUrlMetadata(rec.job_url ?? '') ??
        normalizeHttpUrlMetadata(rec.job_url_direct ?? '');
      if (!meta) {
        unkeyed += 1;
        continue;
      }
      keyed += 1;
      legacyKeys.add(acquiredContentHash(meta.canonicalUrl));
    }
    legacy = {
      status: 'completed',
      callCount: 1,
      recordCount,
      keyedCount: keyed,
      unkeyedCount: unkeyed,
      unplannedBoardCount: unplanned,
    };
  } catch (err) {
    legacy = {
      status: 'failed',
      callCount: 1,
      recordCount: 0,
      keyedCount: 0,
      unkeyedCount: 0,
      unplannedBoardCount: 0,
      errorCode: errorCodeFor(err),
    };
  }

  // ----- abort precheck (before coordinator) -----
  if (parsed.abortSignal?.aborted) {
    return finish(
      'aborted',
      legacy,
      {
        status: 'not_run',
        sliceCount: 0,
        skippedCount: 0,
        candidateCount: 0,
        duplicateGroupCount: 0,
        policyBlockedSliceCount: 0,
        coverageCalls: 0,
        warningCodes: [],
      },
      { status: 'not_computed', reason: 'aborted' },
    );
  }

  // ----- coordinator acquisition via runAcquisition (same plan/budget/abort) -----
  let coordResult: AcquisitionRunResult | undefined;
  let coordFailure: { errorCode: ToolErrorCode | 'ERROR' } | undefined;
  try {
    const runOptions: AcquisitionRunOptions = {
      runId: parsed.runId,
      capturedAt: parsed.capturedAt,
      budget: parsed.budget,
      plan: plan,
    };
    if (parsed.abortSignal !== undefined) runOptions.abortSignal = parsed.abortSignal;
    const runDeps: Parameters<typeof runAcquisition>[1] = {
      policyRegistry: deps.policyRegistry,
      capabilityRegistry: deps.capabilityRegistry,
      ports: [],
      scrapeJobs: deps.scrapeJobs,
    };
    if (deps.monotonicNow !== undefined) runDeps.monotonicNow = deps.monotonicNow;
    coordResult = await runAcquisition(runOptions, runDeps);
  } catch (err) {
    coordFailure = { errorCode: errorCodeFor(err) };
  }

  const aborted = legacy.status === 'aborted' || coordResult?.status === 'aborted';

  if (coordFailure !== undefined || coordResult === undefined) {
    const coordinator: SemanticJobsShadowResult['coordinator'] = {
      status: 'failed',
      sliceCount: 0,
      skippedCount: 0,
      candidateCount: 0,
      duplicateGroupCount: 0,
      policyBlockedSliceCount: 0,
      coverageCalls: 0,
      warningCodes: [],
      errorCode: coordFailure?.errorCode ?? 'ERROR',
    };
    const reason = aborted
      ? 'aborted'
      : legacy.status === 'failed'
        ? 'legacy_failed'
        : 'coordinator_failed';
    return finish(aborted ? 'aborted' : 'partial', legacy, coordinator, {
      status: 'not_computed',
      reason,
    });
  }

  // ----- aggregate coordinator counts (aggregate only; never raw values) -----
  let candidateCount = 0;
  let policyBlockedSliceCount = 0;
  let coverageCalls = 0;
  for (const s of coordResult.slices) {
    candidateCount += s.candidates.length;
    if (s.coverage.some((c) => c.state === 'policy_blocked')) policyBlockedSliceCount += 1;
    for (const c of s.coverage) coverageCalls += c.logicalRequestsUsed;
    const row = rowByBoard.get(boardBySliceId.get(s.sliceId) ?? '');
    if (row) row.coordinatorCandidateCount += s.candidates.length;
  }
  for (const row of boardRows) {
    const slice = coordResult.slices.find((s) => boardBySliceId.get(s.sliceId) === row.board);
    const cov = slice?.coverage[0];
    if (cov) row.coordinatorCoverageState = cov.state;
  }
  const coordinator: SemanticJobsShadowResult['coordinator'] = {
    status: coordResult.status,
    sliceCount: coordResult.slices.length,
    skippedCount: coordResult.skipped.length,
    candidateCount,
    duplicateGroupCount: coordResult.duplicates.length,
    policyBlockedSliceCount,
    coverageCalls,
    warningCodes: [...coordResult.warnings],
    budgetConsumed: coordResult.budgetConsumed,
  };

  // ----- comparison: internal SHA-256 canonical-URL key sets, counts only -----
  const coordinatorKeys = new Set<string>();
  for (const s of coordResult.slices) {
    for (const cand of s.candidates) {
      const destination = (
        cand.provenance as unknown as { destination?: { canonicalUrl?: string } } | undefined
      )?.destination;
      const url = destination?.canonicalUrl;
      if (typeof url !== 'string') continue;
      coordinatorKeys.add(acquiredContentHash(url));
    }
  }

  const comparisonComputed =
    legacy.status === 'completed' &&
    coordResult.status === 'completed' &&
    coordResult.skipped.length === 0 &&
    coordResult.slices.length === plan.length;

  let comparison: SemanticJobsShadowComparison;
  if (comparisonComputed) {
    let shared = 0;
    for (const key of legacyKeys) if (coordinatorKeys.has(key)) shared += 1;
    const union = new Set<string>([...legacyKeys, ...coordinatorKeys]).size;
    comparison = {
      status: 'computed',
      key: 'canonical_url_sha256',
      shared,
      legacyOnly: legacyKeys.size - shared,
      coordinatorOnly: coordinatorKeys.size - shared,
      union,
      jaccardMillis: union === 0 ? null : Math.floor((1000 * shared) / union),
    };
  } else {
    const reason = aborted
      ? 'aborted'
      : legacy.status === 'failed'
        ? 'legacy_failed'
        : 'coordinator_incomplete';
    comparison = { status: 'not_computed', reason };
  }

  const status: SemanticJobsShadowResult['status'] = aborted
    ? 'aborted'
    : legacy.status === 'failed' || coordResult.status !== 'completed'
      ? 'partial'
      : 'completed';
  return finish(status, legacy, coordinator, comparison);
}
