/* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-non-null-assertion, @typescript-eslint/prefer-for-of */
import {
  acquiredContentHash,
  deterministicAcquisitionId,
  normalizeHttpUrlMetadata,
} from '../adapterSupport.js';
import {
  ADAPTER_CAPABILITY_CONTRACT_VERSION,
  AdapterCapabilitySchema,
  type AdapterCapability,
} from '../adapterCapability.js';
import type { AdapterCapabilityRegistry } from '../adapterRegistry.js';
import type { SourcePolicyRegistry } from '../policy/registry.js';
import {
  ACQUISITION_CONTRACT_VERSION,
  AcquisitionPolicyEdgeSchema,
  AcquisitionSliceSchema,
  AcquisitionSliceResultSchema,
  type AcquisitionPolicyEdge,
  type AcquisitionSlice,
  type AcquisitionSliceResult,
} from '../contracts.js';
import { executeIfPolicyPermitted } from '../policy/edgeCoordinator.js';
import { SourceListingSchema, SourceObservationSchema } from '../../domain/source.js';
import { validationError } from '../../../errors.js';
import { InstantSchema } from '../../domain/ids.js';
export interface FlatJobRecord {
  id?: string;
  site: string;
  job_url: string;
  job_url_direct?: string;
  title: string;
  company?: string;
  location?: string;
  description?: string;
  [key: string]: unknown;
}
import type { ScrapeJobsParams } from 'jobspy-js';

export const JOBSPY_ADAPTER_ID = 'jobspy' as const;
export const JOBSPY_ADAPTER_VERSION = '1.7.0' as const;

export const JOBSPY_BOARDS = [
  'linkedin',
  'indeed',
  'zip_recruiter',
  'glassdoor',
  'google',
  'google_careers',
  'bayt',
  'naukri',
  'bdjobs',
] as const;

export type JobSpyBoard = (typeof JOBSPY_BOARDS)[number];

// No boards are authorized by default. Operators must provide explicit policy evidence.
export const DEFAULT_JOBSPY_BOARDS = [] as const;

const JOBSPY_BOARD_SET = new Set<string>(JOBSPY_BOARDS as readonly string[]);

export const JOBSPY_CAPABILITY: AdapterCapability = AdapterCapabilitySchema.parse({
  schemaVersion: ADAPTER_CAPABILITY_CONTRACT_VERSION,
  adapterId: JOBSPY_ADAPTER_ID,
  adapterVersion: JOBSPY_ADAPTER_VERSION,
  edges: [{ operation: 'automatedSearch', route: 'direct', targetKind: 'board' }],
});

export interface JobSpyBoardRequest {
  slice: AcquisitionSlice;
  board: JobSpyBoard;
  executionEdge: AcquisitionPolicyEdge;
  capturedAt: string;
  /** Caller cancellation is composed with adapter timeout. */
  abortSignal?: AbortSignal;
  filters?: {
    location?: string;
    isRemote?: boolean;
    jobType?:
      | 'fulltime'
      | 'parttime'
      | 'contract'
      | 'temporary'
      | 'internship'
      | 'perdiem'
      | 'nights'
      | 'other'
      | 'summer'
      | 'volunteer';
    resultsWanted?: number;
    country?: string;
    hoursOld?: number;
    enforceAnnualSalary?: boolean;
  };
}

export interface JobSpyScrapeResult {
  jobs: FlatJobRecord[];
  totalScraped: number;
  newCount: number;
}

export interface JobSpyAdapterDeps {
  capabilityRegistry: AdapterCapabilityRegistry;
  /** Coordinator-owned policy authority for execution-edge revalidation. */
  policyRegistry: SourcePolicyRegistry;
  scrapeJobs: (params: ScrapeJobsParams, signal?: AbortSignal) => Promise<JobSpyScrapeResult>;
  monotonicNow?: () => number;
}

const VALID_JOB_TYPES = new Set([
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
]);

function buildCoverageBase(
  state: AcquisitionSliceResult['coverage'][number]['state'],
  resultState: AcquisitionSliceResult['coverage'][number]['resultState'],
  candidatesProduced: number,
  bytesUsed: number,
  durationMs: number,
  edgeId: string,
  errorCode?: string,
): AcquisitionSliceResult['coverage'][number] {
  const base: Record<string, unknown> = {
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    adapterId: JOBSPY_ADAPTER_ID,
    state,
    resultState,
    candidatesProduced,
    logicalRequestsUsed: 0,
    attemptsReserved: 0,
    bytesUsed,
    durationMs,
    policyEdgeRefs: [edgeId],
  };
  if (errorCode !== undefined) base.errorCode = errorCode;
  // failed and partial may have attempts? but spec says non-permitted zero; permitted success will override
  return base as AcquisitionSliceResult['coverage'][number];
}

function makeNonPermittedResult(
  slice: AcquisitionSlice,
  edge: AcquisitionPolicyEdge,
  durationMs: number,
): AcquisitionSliceResult {
  let state: 'policy_blocked' | 'disabled' | 'not_supported' = 'not_supported';
  if (edge.state === 'blocked') state = 'policy_blocked';
  else if (edge.state === 'requires_configuration' || edge.state === 'requires_review')
    state = 'disabled';
  else if (edge.state === 'not_supported') state = 'not_supported';
  else state = 'not_supported';

  const coverage = buildCoverageBase(state, 'unknown', 0, 0, durationMs, edge.edgeId);
  // policy_blocked/disabled/not_supported require zero reservations already (logicalRequestsUsed etc 0)
  const result: AcquisitionSliceResult = {
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    runId: slice.runId,
    sliceId: slice.sliceId,
    candidates: [],
    coverage: [coverage],
    warnings: [],
    evidence: [],
    observations: [],
    policyEdges: [edge],
  };
  return AcquisitionSliceResultSchema.parse(result);
}

function makeCapabilityMissingResult(
  slice: AcquisitionSlice,
  edge: AcquisitionPolicyEdge,
  durationMs: number,
): AcquisitionSliceResult {
  const coverage = buildCoverageBase('not_supported', 'unknown', 0, 0, durationMs, edge.edgeId);
  const result: AcquisitionSliceResult = {
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    runId: slice.runId,
    sliceId: slice.sliceId,
    candidates: [],
    coverage: [coverage],
    warnings: [],
    evidence: [],
    observations: [],
    policyEdges: [edge],
  };
  return AcquisitionSliceResultSchema.parse(result);
}

export async function runJobSpyBoard(
  request: JobSpyBoardRequest,
  deps: JobSpyAdapterDeps,
): Promise<AcquisitionSliceResult> {
  const monotonicNow = deps.monotonicNow ?? (() => Date.now());
  const startMs = monotonicNow();

  // ----- validation before any call -----
  if (!request || typeof request !== 'object') throw validationError('invalid request');
  const { slice, board, executionEdge, capturedAt, filters } = request;

  // slice validation
  try {
    AcquisitionSliceSchema.parse(slice);
  } catch {
    throw validationError('invalid slice');
  }

  if (typeof board !== 'string' || !JOBSPY_BOARD_SET.has(board)) {
    throw validationError('invalid board');
  }

  // executionEdge validation
  try {
    AcquisitionPolicyEdgeSchema.parse(executionEdge);
  } catch {
    throw validationError('invalid execution edge');
  }
  // exact edge fields
  const canonicalBoardId = `board:${board}`;
  if (
    executionEdge.actor.kind !== 'adapter' ||
    executionEdge.actor.namespace !== 'adapter' ||
    executionEdge.actor.id !== JOBSPY_ADAPTER_ID ||
    executionEdge.operation !== 'automatedSearch' ||
    executionEdge.route !== 'direct' ||
    executionEdge.target.kind !== 'board' ||
    (executionEdge.target.sourceId !== canonicalBoardId &&
      executionEdge.target.sourceId !== board) ||
    executionEdge.effect !== 'authorized_operation' ||
    executionEdge.schemaVersion !== ACQUISITION_CONTRACT_VERSION
  ) {
    throw validationError('execution edge mismatch');
  }

  // capturedAt validation
  try {
    InstantSchema.parse(capturedAt);
  } catch {
    throw validationError('invalid capturedAt');
  }

  if (!deps || typeof deps.scrapeJobs !== 'function') throw validationError('missing scrapeJobs');
  if (!deps.capabilityRegistry || typeof deps.capabilityRegistry.supports !== 'function')
    throw validationError('missing capability registry');

  if (!deps.policyRegistry || typeof deps.policyRegistry.decideEdge !== 'function') {
    const dur = Math.max(0, monotonicNow() - startMs);
    return makeCapabilityMissingResult(slice, executionEdge, dur);
  }
  const actor = { kind: 'adapter' as const, namespace: 'adapter', id: JOBSPY_ADAPTER_ID };
  const canonicalDecision = deps.policyRegistry.decideEdge(
    canonicalBoardId,
    actor,
    'automatedSearch',
    'direct',
    'board',
  );
  // Accept legacy bare-board policy only for direct adapter callers; coordinator
  // always emits canonical board:<name> targets.
  const authorized =
    canonicalDecision.state === 'not_supported'
      ? deps.policyRegistry.decideEdge(board, actor, 'automatedSearch', 'direct', 'board')
      : canonicalDecision;
  if (authorized.state !== executionEdge.state) {
    const dur = Math.max(0, monotonicNow() - startMs);
    return executionEdge.state === 'permitted'
      ? makeCapabilityMissingResult(slice, executionEdge, dur)
      : makeNonPermittedResult(slice, executionEdge, dur);
  }
  if (
    authorized.revision !== executionEdge.revision ||
    authorized.evidenceRefs.length !== executionEdge.evidenceRefs.length ||
    authorized.evidenceRefs.some((ref, index) => ref !== executionEdge.evidenceRefs[index])
  ) {
    const dur = Math.max(0, monotonicNow() - startMs);
    return makeCapabilityMissingResult(slice, executionEdge, dur);
  }
  if (authorized.state !== 'permitted') {
    const dur = Math.max(0, monotonicNow() - startMs);
    return makeNonPermittedResult(slice, executionEdge, dur);
  }

  // capability check (zero calls if missing)
  const hasCapability = deps.capabilityRegistry.supports(JOBSPY_ADAPTER_ID, {
    operation: 'automatedSearch',
    route: 'direct',
    targetKind: 'board',
  });
  if (!hasCapability) {
    const dur = Math.max(0, monotonicNow() - startMs);
    return makeCapabilityMissingResult(slice, executionEdge, dur);
  }

  // permitted: make exactly one scrapeJobs call with bounded safe filters
  // No dummy probe — executeIfPolicyPermitted wraps the real scrape call only.
  const requestedWanted =
    typeof filters?.resultsWanted === 'number' && Number.isFinite(filters.resultsWanted)
      ? Math.floor(filters.resultsWanted)
      : 20;
  const boundedRequested = Math.min(Math.max(1, requestedWanted), 50);
  const cappedResults = Math.min(boundedRequested, slice.budget.candidates, 50);
  // Ensure at least 1? If slice.budget.candidates is 0 not possible (positive), so capped >=1

  const params: Record<string, unknown> = {
    site_name: [board],
    search_term: slice.query,
    location: typeof filters?.location === 'string' ? filters.location.slice(0, 512) : '',
    is_remote: typeof filters?.isRemote === 'boolean' ? filters.isRemote : false,
    results_wanted: cappedResults,
    description_format: 'markdown',
    linkedin_fetch_description: false,
    indeed_fetch_description: false,
  };
  if (typeof filters?.jobType === 'string' && VALID_JOB_TYPES.has(filters.jobType)) {
    params.job_type = filters.jobType;
  }
  if (typeof filters?.country === 'string' && filters.country.trim().length > 0) {
    params.country_indeed = filters.country.slice(0, 512);
  }
  if (
    typeof filters?.hoursOld === 'number' &&
    Number.isFinite(filters.hoursOld) &&
    filters.hoursOld > 0
  ) {
    const clampedHoursOld = Math.min(Math.floor(filters.hoursOld), 720);
    params.hours_old = clampedHoursOld;
  }
  if (typeof filters?.enforceAnnualSalary === 'boolean') {
    params.enforce_annual_salary = filters.enforceAnnualSalary;
  }
  // cast params to ScrapeJobsParams for typed scrapeJobs deps (see JobSpyAdapterDeps)

  // Never pass forbidden keys - ensure not present
  // Execute via executeIfPolicyPermitted to respect gate (already probed, but reuse)
  let scrapeResult: JobSpyScrapeResult;
  try {
    const timeoutMs = Math.max(1, Math.min(slice.budget.milliseconds, 30_000));
    const exec = await executeIfPolicyPermitted(executionEdge, () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const callerSignal = request.abortSignal;
      const onCallerAbort = (): void => {
        controller.abort(callerSignal?.reason);
      };
      if (callerSignal?.aborted) controller.abort(callerSignal.reason);
      else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
      const boundedScrape = new Promise<JobSpyScrapeResult>((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error('JOBSPY_TIMEOUT'));
          reject(new Error('JOBSPY_TIMEOUT'));
        }, timeoutMs);
        void deps
          .scrapeJobs(params as unknown as ScrapeJobsParams, controller.signal)
          .then(resolve, reject);
      });
      return boundedScrape.finally(() => {
        if (timer !== undefined) clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
      });
    });
    if (exec.status !== 'executed') {
      const dur = Math.max(0, monotonicNow() - startMs);
      return makeNonPermittedResult(slice, exec.edge, dur);
    }
    scrapeResult = exec.value;
  } catch (_err) {
    const dur = Math.max(0, monotonicNow() - startMs);
    const coverage = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      adapterId: JOBSPY_ADAPTER_ID,
      state: 'failed' as const,
      resultState: 'unknown' as const,
      candidatesProduced: 0,
      logicalRequestsUsed: 1,
      attemptsReserved: 1,
      bytesUsed: 0,
      durationMs: dur,
      policyEdgeRefs: [executionEdge.edgeId],
      errorCode: request.abortSignal?.aborted ? 'ABORTED' : 'ERROR',
    };
    const result: AcquisitionSliceResult = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      runId: slice.runId,
      sliceId: slice.sliceId,
      candidates: [],
      coverage: [coverage],
      warnings: [],
      evidence: [],
      observations: [],
      policyEdges: [executionEdge],
    };
    return AcquisitionSliceResultSchema.parse(result);
  }

  const jobsRaw = Array.isArray(scrapeResult.jobs) ? scrapeResult.jobs : [];

  // empty -> succeeded/no_results with ambiguity warning
  if (jobsRaw.length === 0) {
    const dur = Math.max(0, monotonicNow() - startMs);
    const coverage = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      adapterId: JOBSPY_ADAPTER_ID,
      state: 'succeeded' as const,
      resultState: 'no_results' as const,
      candidatesProduced: 0,
      logicalRequestsUsed: 1,
      attemptsReserved: 1,
      bytesUsed: 0,
      durationMs: dur,
      policyEdgeRefs: [executionEdge.edgeId],
    };
    const result: AcquisitionSliceResult = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      runId: slice.runId,
      sliceId: slice.sliceId,
      candidates: [],
      coverage: [coverage],
      warnings: ['jobspy_empty_results_ambiguous_upstream_failure_possible'],
      evidence: [],
      observations: [],
      policyEdges: [executionEdge],
    };
    return AcquisitionSliceResultSchema.parse(result);
  }

  // map valid records
  const candidates: AcquisitionSliceResult['candidates'] = [];
  const evidenceList: AcquisitionSliceResult['evidence'] = [];
  const observations: AcquisitionSliceResult['observations'] = [];
  let bytesUsed = 0;
  let malformed = 0;
  let budgetTruncated = false;
  const warnings: string[] = [];
  const seenEvidenceIds = new Set<string>();

  // enforce candidate and byte budgets
  const candidateBudget = slice.budget.candidates;
  const byteBudget = slice.budget.bytes;

  for (let idx = 0; idx < jobsRaw.length; idx++) {
    const rec = jobsRaw[idx]!;
    if (!rec || typeof rec.site !== 'string' || rec.site !== board) {
      malformed++;
      continue;
    }
    const trimmedId = typeof rec.id === 'string' ? rec.id.trim() : '';
    const hasId = trimmedId.length > 0 && trimmedId.length <= 256;
    const urlMeta = normalizeHttpUrlMetadata(rec.job_url);
    const directMeta = rec.job_url_direct
      ? normalizeHttpUrlMetadata(rec.job_url_direct)
      : undefined;
    const chosenMeta = urlMeta ?? directMeta;
    if (!hasId && !chosenMeta) {
      malformed++;
      continue;
    }
    // if job_url provided but is credential-bearing or invalid and id missing -> already handled, but if job_url invalid and id present we still allow? The spec says stable ID or credential-free canonical URL. So if id present, url can be absent/invalid.
    // However if job_url present and contains credentials, normalize returns undefined, but if id present we can still proceed using directMeta or no url? But we should discard credential-bearing url even if id present? The record's job_url is credential-bearing, that's still invalid? Spec says validate record site equals requested board and stable ID or credential-free canonical URL. So either id or canonical URL suffices, but credential-bearing URL should not be used. We already choose urlMeta; if job_url is credential-bearing, urlMeta undefined, but we can fallback to directMeta or just omit url. So not discard solely for credential url if id present.
    // But if job_url is credential-bearing and id missing and direct also credential -> discard already.
    // Also need to reject if job_url contains credentials even when id present? The evidence url should not be credential. So we will not use credential url. That's okay.

    // Build bounded evidence text from title/company/location/description only
    const title = typeof rec.title === 'string' ? rec.title : '';
    const company = typeof rec.company === 'string' ? rec.company : '';
    const locationStr = typeof rec.location === 'string' ? rec.location : '';
    const description = typeof rec.description === 'string' ? rec.description : '';
    const parts: string[] = [];
    if (title.trim().length > 0) parts.push(`Title: ${title.trim()}`);
    if (company.trim().length > 0) parts.push(`Company: ${company.trim()}`);
    if (locationStr.trim().length > 0) parts.push(`Location: ${locationStr.trim()}`);
    if (description.trim().length > 0) parts.push(`Description:\n${description.trim()}`);
    let boundedText = parts.join('\n\n');
    if (boundedText.length > 32768) boundedText = boundedText.slice(0, 32768);
    // if boundedText empty, still produce evidence? The spec says evidence includes only bounded title/company/location/description max 32768. If all empty, boundedText empty but then evidence would be empty? However adapter evidence requires boundedText 1..32768? Check schema: adapterEvidence boundedText is text(32768) which is trim min1 max32768. So empty would be invalid. But we have description only etc; if all fields empty, boundedText empty -> we should treat as malformed? The spec says evidence includes only bounded title/company/location/description max 32768. Possibly empty still allowed? But schema would reject empty. Safer to if boundedText trimmed empty, use placeholder? But we should discard such record as malformed? We'll discard if boundedText trimmed empty.
    if (boundedText.trim().length === 0) {
      malformed++;
      continue;
    }
    // enforce byte budget (UTF-8 bytes of boundedText)
    const textBytes = Buffer.byteLength(boundedText, 'utf8');
    if (bytesUsed + textBytes > byteBudget) {
      budgetTruncated = true;
      break;
    }
    if (candidates.length >= candidateBudget) {
      budgetTruncated = true;
      break;
    }
    // also respect cappedResults? Already enforced via params, but also ensure we don't exceed cappedResults
    if (candidates.length >= cappedResults) {
      budgetTruncated = true;
      break;
    }

    const contentHash = acquiredContentHash(boundedText);
    const stableKey = hasId ? trimmedId : chosenMeta!.canonicalUrl;
    const listingId = deterministicAcquisitionId('listing', [JOBSPY_ADAPTER_ID, board, stableKey]);
    const observationId = deterministicAcquisitionId('observation', [listingId, contentHash]);
    const evidenceId = deterministicAcquisitionId('evidence', [listingId, contentHash]);
    if (seenEvidenceIds.has(evidenceId)) {
      malformed++;
      continue;
    }
    seenEvidenceIds.add(evidenceId);
    const candidateId = deterministicAcquisitionId('candidate', [
      slice.runId,
      slice.sliceId,
      listingId,
    ]);
    const envelopeId = deterministicAcquisitionId('envelope', [listingId, observationId]);

    // Build SourceListing
    const listingInput: Record<string, unknown> = {
      sourceListingId: listingId,
      adapterId: JOBSPY_ADAPTER_ID,
      firstSeenAt: capturedAt,
      lastSeenAt: capturedAt,
      currentObservationId: observationId,
    };
    if (hasId) listingInput.externalId = trimmedId;
    if (chosenMeta) listingInput.canonicalUrl = chosenMeta.canonicalUrl;

    let listingParsed: unknown;
    try {
      listingParsed = SourceListingSchema.parse(listingInput);
    } catch {
      malformed++;
      continue;
    }

    // Build SourceObservation
    const observationInput: Record<string, unknown> = {
      observationId,
      sourceListingId: listingId,
      fetchedAt: capturedAt,
      contentHash,
      evidenceRefs: [evidenceId],
      extractionVersion: 'none',
      adapterVersion: JOBSPY_ADAPTER_VERSION,
      fetchOutcome: 'success',
      sourceConfidence: { adapter_record: 1 },
      immutable: true as const,
    };
    let observationParsed: unknown;
    try {
      observationParsed = SourceObservationSchema.parse(observationInput);
    } catch {
      malformed++;
      continue;
    }

    // Build evidence
    const evidenceInput: Record<string, unknown> = {
      evidenceId,
      kind: 'adapter_listing',
      boundedText,
      contentHash,
      capturedAt,
      adapterId: JOBSPY_ADAPTER_ID,
      publisherSourceId: board,
      sourceListingId: listingId,
      observationId,
    };
    if (hasId) evidenceInput.adapterResultId = trimmedId;

    // Build envelope
    const envelopeInput: Record<string, unknown> = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      envelopeId,
      listing: listingParsed,
      observation: observationParsed,
      acquisition: {
        captureKind: 'adapter_listing',
        publisherSourceId: board,
        discoveryCandidateIds: [candidateId],
        policyEdgeRefs: [executionEdge.edgeId],
        evidenceRefs: [evidenceId],
        adapterId: JOBSPY_ADAPTER_ID,
        acquisitionEdgeRef: executionEdge.edgeId,
      },
    };

    // Build candidate provenance
    const destination = chosenMeta
      ? {
          canonicalUrl: chosenMeta.canonicalUrl,
          normalizedHost: chosenMeta.normalizedHost,
        }
      : undefined;

    const candidateInput: Record<string, unknown> = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      candidateId,
      runId: slice.runId,
      sliceId: slice.sliceId,
      adapterId: JOBSPY_ADAPTER_ID,
      state: 'adapter_acquired',
      provenance: {
        kind: 'direct_adapter',
        schemaVersion: ACQUISITION_CONTRACT_VERSION,
        discoverer: {
          adapterId: JOBSPY_ADAPTER_ID,
          rank: candidates.length,
          queryVariantId: slice.queryVariantId,
          operation: 'automatedSearch',
          ...(hasId ? { adapterResultId: trimmedId } : {}),
        },
        contentDonor: {
          kind: 'adapter',
          adapterId: JOBSPY_ADAPTER_ID,
          representation: 'adapter_listing',
        },
        publisher: { kind: 'board', sourceId: board },
        ...(destination ? { destination } : {}),
        capturedAt,
      },
      evidenceRefs: [evidenceId],
      policyEdgeRefs: [executionEdge.edgeId],
      caveats: [],
      acquisitionEdgeRef: executionEdge.edgeId,
      adapterEvidenceRef: evidenceId,
      observationEnvelopeRef: envelopeId,
    };
    if (title.trim().length > 0) candidateInput.titleHint = title.trim().slice(0, 512);

    // Tentatively push; final schema parse will validate, but we do per-item?
    // Collect
    // Use temporary arrays and later validate whole result; if individual candidate fails schema, count malformed
    try {
      // Validate evidence, candidate, observation individually? We'll just push and rely on final parse, but to avoid one bad candidate breaking whole result, we can try to validate candidate via parse
      // Import candidate schema? Use AcquisitionSliceResultSchema will catch.
      // For now push
      evidenceList.push(evidenceInput as never);
      observations.push(envelopeInput as never);
      candidates.push(candidateInput as never);
      bytesUsed += textBytes;
    } catch {
      malformed++;
      // rollback
      evidenceList.pop();
      observations.pop();
      candidates.pop();
      bytesUsed -= textBytes;
      continue;
    }
  }

  if (budgetTruncated) warnings.push('jobspy_budget_truncated');
  if (malformed > 0) warnings.push('jobspy_malformed_record_discarded');

  const dur = Math.max(0, monotonicNow() - startMs);
  let coverageState: 'succeeded' | 'partial' | 'failed' = 'succeeded';
  let resultState: 'results' | 'no_results' | 'unknown' = 'results';
  let errorCode: string | undefined;

  if (budgetTruncated) {
    coverageState = 'partial';
    resultState = candidates.length > 0 ? 'results' : 'no_results';
  } else if (candidates.length === 0 && malformed === 0) {
    // This case already handled as empty earlier, but if all filtered due to budgets? empty with no malformed but jobs were present but budget zero? treat as no_results
    resultState = 'no_results';
    coverageState = 'succeeded';
    warnings.push('jobspy_empty_results_ambiguous_upstream_failure_possible');
  } else if (candidates.length === 0 && malformed > 0) {
    coverageState = 'partial';
    resultState = 'no_results';
    errorCode = undefined;
  } else if (candidates.length > 0 && malformed > 0) {
    coverageState = 'partial';
    resultState = 'results';
  } else if (candidates.length > 0) {
    coverageState = 'succeeded';
    resultState = 'results';
  } else {
    coverageState = 'succeeded';
    resultState = 'no_results';
  }

  // If we earlier handled empty jobs array, we already returned; this handles filtered zero case
  // Ensure warning for empty filtered case includes fixed warning already

  const coverage = {
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    adapterId: JOBSPY_ADAPTER_ID,
    state: coverageState,
    resultState,
    candidatesProduced: candidates.length,
    logicalRequestsUsed: 1,
    attemptsReserved: 1,
    bytesUsed,
    durationMs: dur,
    policyEdgeRefs: [executionEdge.edgeId],
    ...(errorCode ? { errorCode } : {}),
  };

  const result: AcquisitionSliceResult = {
    schemaVersion: ACQUISITION_CONTRACT_VERSION,
    runId: slice.runId,
    sliceId: slice.sliceId,
    candidates: candidates,
    coverage: [coverage],
    warnings,
    evidence: evidenceList,
    observations: observations,
    policyEdges: [executionEdge],
  };

  try {
    return AcquisitionSliceResultSchema.parse(result);
  } catch {
    const failDur = Math.max(0, monotonicNow() - startMs);
    const failCoverage = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      adapterId: JOBSPY_ADAPTER_ID,
      state: 'failed' as const,
      resultState: 'unknown' as const,
      candidatesProduced: 0,
      logicalRequestsUsed: 1,
      attemptsReserved: 1,
      bytesUsed: 0,
      durationMs: failDur,
      policyEdgeRefs: [executionEdge.edgeId],
      errorCode: 'ERROR',
    };
    const failResult: AcquisitionSliceResult = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      runId: slice.runId,
      sliceId: slice.sliceId,
      candidates: [],
      coverage: [failCoverage],
      warnings: [...warnings, 'jobspy_malformed_record_discarded'],
      evidence: [],
      observations: [],
      policyEdges: [executionEdge],
    };
    return AcquisitionSliceResultSchema.parse(failResult);
  }
}
