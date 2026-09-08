/* eslint-disable @typescript-eslint/no-unnecessary-condition -- runtime guards for untyped caller input */
import { z } from 'zod/v4';
import {
  ACQUISITION_CONTRACT_VERSION,
  AcquiredObservationEnvelopeSchema,
  AcquisitionCandidateSchema,
  AcquisitionCoverageSchema,
  DiscoveryEvidenceSchema,
  type AcquisitionCandidate,
  type AcquisitionPolicyEdge,
  type AcquisitionSliceResult,
} from './contracts.js';
import { AcquisitionEdgeIdSchema } from './ids.js';
import {
  AcquisitionDuplicateGroupSchema,
  AcquisitionRunBudgetSchema,
  AcquisitionRunResultSchema,
  type AcquisitionRunBudget,
  type AcquisitionRunResult,
} from './coordinator.js';
import {
  acquiredContentHash,
  deterministicAcquisitionId,
  normalizeHttpUrlMetadata,
} from './adapterSupport.js';
import {
  ADAPTER_CAPABILITY_CONTRACT_VERSION,
  AdapterCapabilitySchema,
  type AdapterCapability,
} from './adapterCapability.js';
import type { AdapterCapabilityRegistry } from './adapterRegistry.js';
import type { SourcePolicyRegistry } from './policy/registry.js';
import { executeIfPolicyPermitted, resolveExecutionPolicyEdge } from './policy/edgeCoordinator.js';
import type { SafeFetchOptions, SafeFetchResult } from '../../httpGuards.js';
import { validationError } from '../../errors.js';

export const DESTINATION_FETCH_ENRICHMENT_VERSION = '1.0.0' as const;
export const DESTINATION_FETCH_ADAPTER_ID = 'destination-fetch' as const;

export const DESTINATION_FETCH_CAPABILITY: AdapterCapability = AdapterCapabilitySchema.parse({
  schemaVersion: ADAPTER_CAPABILITY_CONTRACT_VERSION,
  adapterId: DESTINATION_FETCH_ADAPTER_ID,
  adapterVersion: DESTINATION_FETCH_ENRICHMENT_VERSION,
  edges: [
    { operation: 'automatedFetch', route: 'direct', targetKind: 'publisher' },
    { operation: 'automatedFetch', route: 'direct', targetKind: 'board' },
    { operation: 'automatedFetch', route: 'direct', targetKind: 'ats_tenant' },
  ],
});

export type DestinationFetchCandidateStatus =
  | 'upgraded'
  | 'publisher_identity_missing'
  | 'capability_missing'
  | 'not_permitted'
  | 'fetch_failed'
  | 'redirect_host_mismatch'
  | 'unsupported_content_type'
  | 'capacity_exhausted';

export interface DestinationFetchCandidateAttempt {
  readonly kind: 'candidate';
  readonly sliceId: string;
  readonly candidateId: string;
  readonly status: DestinationFetchCandidateStatus;
  readonly fetchEdgeRef?: string | undefined;
}

export interface DestinationFetchManualHandoffAttempt {
  readonly kind: 'manual_handoff';
  readonly sliceId: string;
  readonly priorFetchEdgeRef: string;
  readonly status: 'unsupported_v1_manual_handoff';
}

export type DestinationFetchAttempt =
  | DestinationFetchCandidateAttempt
  | DestinationFetchManualHandoffAttempt;

export interface DestinationFetchBudgetConsumed {
  logicalRequests: number;
  reservedAttempts: number;
  candidates: number;
  bytes: number;
  milliseconds: number;
}

export interface DestinationFetchEnrichmentOptions {
  run: AcquisitionRunResult;
  budget: AcquisitionRunBudget;
  abortSignal?: AbortSignal | undefined;
}

export interface DestinationFetchEnrichmentDeps {
  policyRegistry: SourcePolicyRegistry;
  capabilityRegistry: AdapterCapabilityRegistry;
  safeFetch: (
    url: string,
    init?: RequestInit,
    options?: SafeFetchOptions,
  ) => Promise<SafeFetchResult>;
  now?: () => Date;
  monotonicNow?: () => number;
}

export interface DestinationFetchEnrichmentResult {
  schemaVersion: typeof DESTINATION_FETCH_ENRICHMENT_VERSION;
  status: 'completed' | 'partial' | 'budget_exhausted' | 'deadline_exceeded' | 'aborted';
  run: AcquisitionRunResult;
  attempts: readonly DestinationFetchAttempt[];
  budgetConsumed: DestinationFetchBudgetConsumed;
}

const candidateAttemptSchema = z
  .object({
    kind: z.literal('candidate'),
    sliceId: z.string().trim().min(1).max(256),
    candidateId: z.string().trim().min(1).max(256),
    status: z.enum([
      'upgraded',
      'publisher_identity_missing',
      'capability_missing',
      'not_permitted',
      'fetch_failed',
      'redirect_host_mismatch',
      'unsupported_content_type',
      'capacity_exhausted',
    ]),
    fetchEdgeRef: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

const manualHandoffAttemptSchema = z
  .object({
    kind: z.literal('manual_handoff'),
    sliceId: z.string().trim().min(1).max(256),
    priorFetchEdgeRef: z.string().trim().min(1).max(256),
    status: z.literal('unsupported_v1_manual_handoff'),
  })
  .strict();

const DestinationFetchAttemptSchema = z.discriminatedUnion('kind', [
  candidateAttemptSchema,
  manualHandoffAttemptSchema,
]);

export const DestinationFetchEnrichmentOptionsSchema: z.ZodType<DestinationFetchEnrichmentOptions> =
  z
    .object({
      run: AcquisitionRunResultSchema,
      budget: AcquisitionRunBudgetSchema,
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

export const DestinationFetchEnrichmentResultSchema: z.ZodType<DestinationFetchEnrichmentResult> = z
  .object({
    schemaVersion: z.literal(DESTINATION_FETCH_ENRICHMENT_VERSION),
    status: z.enum(['completed', 'partial', 'budget_exhausted', 'deadline_exceeded', 'aborted']),
    run: AcquisitionRunResultSchema,
    attempts: z.array(DestinationFetchAttemptSchema).max(10101),
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

const FETCH_ACCEPT_HEADER = 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1';
const FETCH_TIMEOUT_MS_CAP = 10_000;
const FETCH_MAX_BYTES_CAP = 262_144;
const BOUNDED_TEXT_CAP = 32_768;
const MAX_FRESH_FETCH_EDGES_PER_SLICE = 32;

/** Caveats removed on destination_fetched upgrade; all others preserved verbatim. */
const CAVEATS_REMOVED_ON_UPGRADE: ReadonlySet<string> = new Set([
  'provider_index_only',
  'publisher_not_fetched',
  'destination_fetch_blocked',
  'direct_access_not_permitted',
  'publisher_policy_unknown',
]);

function throwValidation(): never {
  throw validationError('VALIDATION_ERROR');
}

// mirrors coordinator.ts stateRank (frozen W3-G duplicate ranking)
function stateRank(state: string): number {
  if (state === 'adapter_acquired') return 4;
  if (state === 'destination_fetched') return 3;
  if (state === 'manual_content') return 2;
  if (state === 'indexed_only') return 1;
  return 0;
}

// mirrors compareCodePoints in adapterRegistry.ts
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

// W3-H slice accounting: explicit per-slice candidate attempt counts/classes.
// `requests` counts actual safeFetch calls; blocked/disabled/notSupported classify
// not_permitted by resolved edge state; capability_missing counts as not-supported;
// publisher_identity_missing and capacity_exhausted are unclassified failures.
interface SliceStats {
  attempts: number;
  upgrades: number;
  requests: number;
  bytes: number;
  blocked: number;
  disabled: number;
  notSupported: number;
  unclassified: number;
  edges: string[];
  startMs: number;
}

// W3-H coverage precedence matrix (oracle addendum); evaluate in this exact order.
function coverageMapping(st: SliceStats): {
  state: 'succeeded' | 'partial' | 'failed' | 'disabled' | 'policy_blocked' | 'not_supported';
  resultState: 'results' | 'no_results' | 'unknown';
} {
  if (st.attempts > 0 && st.upgrades === st.attempts) {
    return { state: 'succeeded', resultState: 'results' };
  }
  if (st.upgrades > 0) return { state: 'partial', resultState: 'results' };
  if (st.requests > 0) return { state: 'failed', resultState: 'no_results' };
  if (st.attempts > 0 && st.blocked === st.attempts) {
    return { state: 'policy_blocked', resultState: 'unknown' };
  }
  if (st.attempts > 0 && st.disabled === st.attempts) {
    return { state: 'disabled', resultState: 'unknown' };
  }
  if (st.attempts > 0 && st.notSupported === st.attempts) {
    return { state: 'not_supported', resultState: 'unknown' };
  }
  return { state: 'partial', resultState: 'no_results' };
}

function recomputeDuplicates(
  slices: readonly AcquisitionSliceResult[],
): AcquisitionRunResult['duplicates'] {
  const groups = new Map<
    string,
    { candidateId: string; sliceId: string; state: string; ordinal: number }[]
  >();
  for (const [sIdx, sr] of slices.entries()) {
    for (const cand of sr.candidates) {
      const url = cand.provenance.destination?.canonicalUrl;
      if (!url) continue;
      const arr = groups.get(url) ?? [];
      arr.push({
        candidateId: cand.candidateId,
        sliceId: sr.sliceId,
        state: cand.state,
        ordinal: sIdx,
      });
      groups.set(url, arr);
    }
  }
  const duplicates: AcquisitionRunResult['duplicates'] = [];
  for (const [canonicalUrl, entries] of groups) {
    if (entries.length <= 1) continue;
    const sorted = [...entries].sort((a, b) => {
      const ra = stateRank(a.state);
      const rb = stateRank(b.state);
      if (ra !== rb) return rb - ra;
      if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
      return compareCodePoints(a.candidateId, b.candidateId);
    });
    const retained = sorted[0];
    if (!retained) continue;
    const group = {
      canonicalUrl,
      retainedCandidateId: retained.candidateId,
      superseded: sorted.slice(1).map((e) => ({ candidateId: e.candidateId, sliceId: e.sliceId })),
    };
    duplicates.push(AcquisitionDuplicateGroupSchema.parse(group));
  }
  return duplicates;
}

export async function enrichDestinationFetches(
  options: DestinationFetchEnrichmentOptions,
  deps: DestinationFetchEnrichmentDeps,
): Promise<DestinationFetchEnrichmentResult> {
  // ----- pre-network validation: options, deps, clocks -----
  let parsedOptions: DestinationFetchEnrichmentOptions;
  try {
    parsedOptions = DestinationFetchEnrichmentOptionsSchema.parse(options);
  } catch {
    throwValidation();
  }
  if (!deps || typeof deps !== 'object') throwValidation();
  if (!deps.policyRegistry || typeof deps.policyRegistry.decide !== 'function') throwValidation();
  if (
    !deps.capabilityRegistry ||
    typeof deps.capabilityRegistry.supports !== 'function' ||
    typeof deps.capabilityRegistry.get !== 'function'
  ) {
    throwValidation();
  }
  if (typeof deps.safeFetch !== 'function') throwValidation();
  if (deps.now !== undefined && typeof deps.now !== 'function') throwValidation();
  if (deps.monotonicNow !== undefined && typeof deps.monotonicNow !== 'function') throwValidation();

  const now = deps.now ?? (() => new Date());
  const monotonicNow = deps.monotonicNow ?? (() => Date.now());
  // every clock read is validated at the read site: finite Date / finite number
  const readNow = (): Date => {
    let d: Date;
    try {
      d = now();
    } catch {
      throwValidation();
    }
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) throwValidation();
    return d;
  };
  const readMonotonic = (): number => {
    let m: number;
    try {
      m = monotonicNow();
    } catch {
      throwValidation();
    }
    if (typeof m !== 'number' || !Number.isFinite(m)) throwValidation();
    return m;
  };
  const startMs = readMonotonic();
  readNow();

  const budget: AcquisitionRunBudget = parsedOptions.budget;
  const abortSignal = parsedOptions.abortSignal;

  // JSON deep copy: never mutate the input run; drops frozen-object semantics.
  const run: AcquisitionRunResult = JSON.parse(
    JSON.stringify(parsedOptions.run),
  ) as AcquisitionRunResult;

  const attempts: DestinationFetchAttempt[] = [];
  const consumed: DestinationFetchBudgetConsumed = {
    logicalRequests: 0,
    reservedAttempts: 0,
    candidates: 0,
    bytes: 0,
    milliseconds: 0,
  };
  let aborted = false;
  let deadlineHit = false;
  let budgetHit = false;
  let anyFailure = false;
  let totalUpgrades = 0;
  let candidateAttemptCount = 0;
  const sliceStats = new Map<string, SliceStats>();
  const getStats = (sliceId: string): SliceStats => {
    let stats = sliceStats.get(sliceId);
    if (!stats) {
      stats = {
        attempts: 0,
        upgrades: 0,
        requests: 0,
        bytes: 0,
        blocked: 0,
        disabled: 0,
        notSupported: 0,
        unclassified: 0,
        edges: [],
        startMs: readMonotonic(),
      };
      sliceStats.set(sliceId, stats);
    }
    return stats;
  };

  // manual handoffs: one unsupported attempt each, zero HTTP, zero resolution
  for (const review of run.destinationFetchReviews) {
    attempts.push({
      kind: 'manual_handoff',
      sliceId: review.sliceId,
      priorFetchEdgeRef: review.priorFetchEdgeRef,
      status: 'unsupported_v1_manual_handoff',
    });
  }

  outer: for (const slice of run.slices) {
    let freshFetchEdges = 0;
    let skipRestOfSlice = false;
    for (const [candIdx, cand] of slice.candidates.entries()) {
      if (cand.state !== 'indexed_only' && cand.state !== 'fetch_eligible') continue;

      // --- prechecks before any policy resolution ---
      if (abortSignal?.aborted) {
        aborted = true;
        break outer;
      }
      const elapsed = Math.max(0, readMonotonic() - startMs);
      if (elapsed >= budget.milliseconds) {
        deadlineHit = true;
        break outer;
      }
      if (
        consumed.candidates + 1 > budget.candidates ||
        consumed.logicalRequests + 1 > budget.logicalRequests ||
        consumed.reservedAttempts + 1 > budget.reservedAttempts ||
        consumed.bytes + 1 > budget.bytes
      ) {
        // budget-dimension capacity_exhausted: emitted candidate attempt, budget run status
        const stats = getStats(slice.sliceId);
        stats.attempts += 1;
        stats.unclassified += 1;
        candidateAttemptCount += 1;
        attempts.push({
          kind: 'candidate',
          sliceId: slice.sliceId,
          candidateId: cand.candidateId,
          status: 'capacity_exhausted',
        });
        anyFailure = true;
        budgetHit = true;
        break outer;
      }
      consumed.candidates += 1;
      const stats = getStats(slice.sliceId);

      const candidateAttempt = (status: DestinationFetchCandidateStatus, fetchEdgeRef?: string) => {
        candidateAttemptCount += 1;
        stats.attempts += 1;
        attempts.push({
          kind: 'candidate',
          sliceId: slice.sliceId,
          candidateId: cand.candidateId,
          status,
          ...(fetchEdgeRef !== undefined ? { fetchEdgeRef } : {}),
        });
        if (status !== 'upgraded' && cand.state === 'fetch_eligible') {
          // failed fetch_eligible attempts downgrade to indexed_only
          const { fetchEdgeRef: _stale, ...rest } = cand;
          slice.candidates[candIdx] = AcquisitionCandidateSchema.parse({
            ...rest,
            state: 'indexed_only',
          });
        }
      };

      // --- publisher identity (zero policy/network calls when missing) ---
      const prov = cand.provenance;
      const publisher = prov.kind === 'indexed_discovery' ? prov.publisher : undefined;
      if (!publisher) {
        candidateAttempt('publisher_identity_missing');
        anyFailure = true;
        stats.unclassified += 1;
        continue;
      }

      // --- capability exactly per publisher kind (zero policy/network calls when missing) ---
      const capable = deps.capabilityRegistry.supports(DESTINATION_FETCH_ADAPTER_ID, {
        operation: 'automatedFetch',
        route: 'direct',
        targetKind: publisher.kind,
      });
      if (!capable) {
        candidateAttempt('capability_missing');
        anyFailure = true;
        stats.notSupported += 1;
        continue;
      }

      // --- slice schema capacity room (edge + evidence + envelope + coverage row) ---
      const existingDestCoverage = slice.coverage.filter(
        (c) => c.adapterId === DESTINATION_FETCH_ADAPTER_ID,
      ).length;
      if (
        freshFetchEdges >= MAX_FRESH_FETCH_EDGES_PER_SLICE ||
        slice.policyEdges.length + 1 > 100 ||
        (existingDestCoverage === 0 && slice.coverage.length + 1 > 100) ||
        slice.evidence.length + 1 > 2000 ||
        slice.observations.length + 1 > 1000 ||
        cand.evidenceRefs.length + 1 > 32 ||
        cand.policyEdgeRefs.length + 1 > 32
      ) {
        candidateAttempt('capacity_exhausted');
        anyFailure = true;
        stats.unclassified += 1;
        skipRestOfSlice = true;
        break;
      }

      // --- fresh call-time execution edge resolution ---
      const decidedAt = readNow().toISOString();
      const fetchEdgeId = acquiredContentHash(
        JSON.stringify([
          'acquisition-edge',
          slice.runId,
          slice.sliceId,
          DESTINATION_FETCH_ADAPTER_ID,
          cand.candidateId,
          'automatedFetch',
          'execution',
          decidedAt,
        ]),
      );
      let edge: AcquisitionPolicyEdge;
      try {
        edge = resolveExecutionPolicyEdge(
          deps.policyRegistry,
          {
            edgeId: AcquisitionEdgeIdSchema.parse(fetchEdgeId),
            actor: {
              kind: 'adapter',
              namespace: 'adapter',
              id: DESTINATION_FETCH_ADAPTER_ID,
            },
            operation: 'automatedFetch',
            route: 'direct',
            target: {
              kind: publisher.kind,
              sourceId: publisher.sourceId,
              normalizedHost: prov.destination.normalizedHost,
            },
          },
          { decidedAt },
        );
      } catch {
        throwValidation();
      }

      // store the resolved execution edge (permitted or not) for candidate/coverage references.
      // Repeated enrichment runs with an identical decidedAt re-resolve the same edge ID and
      // the slice schema rejects duplicate edge IDs, so append only when absent.
      if (!slice.policyEdges.some((e) => e.edgeId === edge.edgeId)) {
        slice.policyEdges.push(edge);
        freshFetchEdges += 1;
      }
      // coverage authorization ref: count the touched edge even when it was already
      // present in the slice (repeated identical-edge run), deduped within stats
      if (!stats.edges.includes(edge.edgeId)) {
        stats.edges.push(edge.edgeId);
      }

      // recheck remaining deadline immediately before execution: exit without safeFetch
      if (budget.milliseconds - Math.max(0, readMonotonic() - startMs) <= 0) {
        deadlineHit = true;
        break outer;
      }
      // abort detected after policy resolution but before safeFetch: stop, no attempt
      if (abortSignal?.aborted) {
        aborted = true;
        break outer;
      }

      let fetched: SafeFetchResult | undefined;
      let requestedRemainingBytes = 0;
      try {
        const execution = await executeIfPolicyPermitted(edge, async () => {
          // logical request + reserved attempt consumed immediately before safeFetch
          consumed.logicalRequests += 1;
          consumed.reservedAttempts += 1;
          stats.requests += 1;
          const elapsedNow = Math.max(0, readMonotonic() - startMs);
          const remainingMs = budget.milliseconds - elapsedNow;
          const remainingBytes = budget.bytes - consumed.bytes;
          requestedRemainingBytes = remainingBytes;
          const res = await deps.safeFetch(
            prov.destination.canonicalUrl,
            {
              method: 'GET',
              headers: { accept: FETCH_ACCEPT_HEADER },
            },
            {
              maxRedirects: 5,
              timeoutMs: Math.max(1, Math.min(FETCH_TIMEOUT_MS_CAP, remainingMs)),
              maxBytes: Math.max(1, Math.min(FETCH_MAX_BYTES_CAP, remainingBytes)),
              ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
            },
          );
          // executeIfPolicyPermitted deep-freezes the execution value; a frozen
          // Uint8Array body throws, so keep the body non-enumerable.
          const shielded = {
            finalUrl: res.finalUrl,
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
            redirectCount: res.redirectCount,
          };
          Object.defineProperty(shielded, 'body', {
            value: res.body,
            enumerable: false,
            writable: false,
            configurable: true,
          });
          return shielded as SafeFetchResult;
        });
        if (execution.status !== 'executed') {
          candidateAttempt('not_permitted');
          anyFailure = true;
          // retain resolved edge classification: blocked / disabled / not-supported
          if (edge.state === 'blocked') stats.blocked += 1;
          else if (edge.state === 'requires_configuration' || edge.state === 'requires_review')
            stats.disabled += 1;
          else stats.notSupported += 1;
          continue;
        }
        fetched = execution.value;
      } catch {
        candidateAttempt('fetch_failed');
        anyFailure = true;
        // W3-H frozen addendum: post-settlement control recheck (same rule as failFetch)
        if (abortSignal?.aborted) aborted = true;
        if (budget.milliseconds - Math.max(0, readMonotonic() - startMs) <= 0) {
          deadlineHit = true;
        }
        continue;
      }

      // response bytes counted including non-2xx
      const responseBytes = fetched.body.byteLength;
      consumed.bytes += responseBytes;
      stats.bytes += responseBytes;

      // --- fetch acceptance checks ---
      const failFetch = (status: DestinationFetchCandidateStatus) => {
        candidateAttempt(status);
        anyFailure = true;
        // W3-H frozen addendum: settled failure + tripped abort/elapsed deadline
        // → run status aborted/deadline_exceeded; the settled outcome and coverage
        // stats are preserved and next-iteration prechecks stop further candidates.
        if (abortSignal?.aborted) aborted = true;
        if (budget.milliseconds - Math.max(0, readMonotonic() - startMs) <= 0) {
          deadlineHit = true;
        }
      };
      if (fetched.status < 200 || fetched.status > 299) {
        failFetch('fetch_failed');
        continue;
      }
      if (responseBytes === 0) {
        failFetch('fetch_failed');
        continue;
      }
      if (responseBytes > requestedRemainingBytes || responseBytes > FETCH_MAX_BYTES_CAP) {
        failFetch('fetch_failed');
        continue;
      }
      const contentType = fetched.headers.get('content-type');
      if (contentType !== null) {
        const media = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
        if (!(media.startsWith('text/') || media === 'application/xhtml+xml')) {
          failFetch('unsupported_content_type');
          continue;
        }
      }
      const finalMeta = normalizeHttpUrlMetadata(fetched.finalUrl);
      if (finalMeta?.normalizedHost !== prov.destination.normalizedHost) {
        failFetch('redirect_host_mismatch');
        continue;
      }
      let boundedText = new TextDecoder().decode(fetched.body);
      boundedText = boundedText.replaceAll('\u0000', '');
      boundedText = boundedText.trim();
      if (boundedText.length > BOUNDED_TEXT_CAP) {
        boundedText = boundedText.slice(0, BOUNDED_TEXT_CAP);
      }
      if (boundedText.length === 0) {
        failFetch('fetch_failed');
        continue;
      }

      // --- deterministic IDs ---
      const contentHash = acquiredContentHash(boundedText);
      const listingId = deterministicAcquisitionId('listing', [
        DESTINATION_FETCH_ADAPTER_ID,
        publisher.kind,
        publisher.sourceId,
        prov.destination.canonicalUrl,
      ]);
      const observationId = deterministicAcquisitionId('observation', [
        listingId,
        contentHash,
        decidedAt,
      ]);
      const evidenceId = deterministicAcquisitionId('evidence', [
        listingId,
        observationId,
        contentHash,
      ]);
      const envelopeId = deterministicAcquisitionId('envelope', [cand.candidateId, observationId]);

      const destinationEvidence = {
        evidenceId,
        kind: 'destination_content' as const,
        targetCanonicalUrl: prov.destination.canonicalUrl,
        boundedText,
        contentHash,
        capturedAt: decidedAt,
        observationId,
        sourceListingId: listingId,
      };
      const listing = {
        sourceListingId: listingId,
        adapterId: DESTINATION_FETCH_ADAPTER_ID,
        canonicalUrl: prov.destination.canonicalUrl,
        firstSeenAt: decidedAt,
        lastSeenAt: decidedAt,
        currentObservationId: observationId,
      };
      const observation = {
        observationId,
        sourceListingId: listingId,
        fetchedAt: decidedAt,
        contentHash,
        evidenceRefs: [evidenceId],
        extractionVersion: 'none',
        adapterVersion: DESTINATION_FETCH_ENRICHMENT_VERSION,
        fetchOutcome: 'success' as const,
        sourceConfidence: { destination_fetch: 1 },
        immutable: true as const,
      };
      let envelope: z.infer<typeof AcquiredObservationEnvelopeSchema>;
      let evidence: AcquisitionSliceResult['evidence'][number];
      try {
        envelope = AcquiredObservationEnvelopeSchema.parse({
          schemaVersion: ACQUISITION_CONTRACT_VERSION,
          envelopeId,
          listing,
          observation,
          acquisition: {
            captureKind: 'destination_fetch' as const,
            publisherSourceId: publisher.sourceId,
            discoveryCandidateIds: [cand.candidateId],
            policyEdgeRefs: [fetchEdgeId],
            evidenceRefs: [evidenceId],
            fetchEdgeRef: fetchEdgeId,
          },
        });
      } catch {
        throwValidation();
      }
      try {
        evidence = DiscoveryEvidenceSchema.parse(destinationEvidence);
      } catch {
        throwValidation();
      }
      const upgradedRaw = {
        ...cand,
        state: 'destination_fetched' as const,
        evidenceRefs: [...cand.evidenceRefs, evidenceId],
        policyEdgeRefs: cand.policyEdgeRefs.some((r) => r === fetchEdgeId)
          ? cand.policyEdgeRefs
          : [...cand.policyEdgeRefs, fetchEdgeId],
        fetchEdgeRef: fetchEdgeId,
        destinationEvidenceRef: evidenceId,
        observationEnvelopeRef: envelopeId,
        caveats: cand.caveats.filter((c) => !CAVEATS_REMOVED_ON_UPGRADE.has(c)),
      };
      let upgraded: AcquisitionCandidate;
      try {
        upgraded = AcquisitionCandidateSchema.parse(upgradedRaw);
      } catch {
        throwValidation();
      }
      slice.candidates[candIdx] = upgraded;
      slice.evidence.push(evidence);
      slice.observations.push(envelope);

      candidateAttempt('upgraded', fetchEdgeId);
      stats.upgrades += 1;
      totalUpgrades += 1;

      // W3-H frozen addendum: after in-flight settlement, a tripped abort or an
      // elapsed deadline overrides the run status (aborted > deadline per
      // precedence) while the settled upgrade and coverage stats stay intact;
      // no further candidates are processed.
      if (abortSignal?.aborted) {
        aborted = true;
        break outer;
      }
      if (budget.milliseconds - Math.max(0, readMonotonic() - startMs) <= 0) {
        deadlineHit = true;
        break outer;
      }
    }

    if (skipRestOfSlice) continue;
  }

  // --- coverage rows: one destination-fetch row per touched slice ---
  for (const slice of run.slices) {
    const stats = sliceStats.get(slice.sliceId);
    if (!stats) continue;
    // coverage row boundary: >=1 emitted candidate attempt or >=1 consumed request;
    // policy-resolution-then-abort/deadline with no outcome creates no coverage
    if (stats.attempts === 0 && stats.requests === 0) continue;
    const mapping = coverageMapping(stats);
    const durationRaw = Math.max(0, readMonotonic() - stats.startMs);
    const durationMs = Math.min(Math.max(0, Math.floor(durationRaw)), 86_400_000);
    const kept = slice.coverage.filter((c) => c.adapterId !== DESTINATION_FETCH_ADAPTER_ID);
    let coverageRow: AcquisitionSliceResult['coverage'][number];
    try {
      coverageRow = AcquisitionCoverageSchema.parse({
        schemaVersion: ACQUISITION_CONTRACT_VERSION,
        adapterId: DESTINATION_FETCH_ADAPTER_ID,
        state: mapping.state,
        resultState: mapping.resultState,
        candidatesProduced: stats.upgrades,
        logicalRequestsUsed: stats.requests,
        attemptsReserved: stats.requests,
        bytesUsed: stats.bytes,
        durationMs,
        policyEdgeRefs: stats.edges,
      });
    } catch {
      throwValidation();
    }
    // if the slice has literally no room for the row (capacity_exhausted case),
    // record the attempt but skip the coverage row to keep the result schema-valid
    if (kept.length + 1 <= 100) {
      kept.push(coverageRow);
      slice.coverage = kept;
    }
  }

  // --- recompute duplicates with frozen W3-G ranking; W3-G budgetConsumed untouched ---
  run.duplicates = recomputeDuplicates(run.slices);

  consumed.milliseconds = Math.min(
    Math.max(0, Math.floor(readMonotonic() - startMs)),
    budget.milliseconds,
  );

  let status: DestinationFetchEnrichmentResult['status'];
  if (aborted) status = 'aborted';
  else if (deadlineHit) status = 'deadline_exceeded';
  else if (budgetHit) status = 'budget_exhausted';
  else if (anyFailure || (candidateAttemptCount > 0 && totalUpgrades === 0)) status = 'partial';
  else status = 'completed';

  const result: DestinationFetchEnrichmentResult = {
    schemaVersion: DESTINATION_FETCH_ENRICHMENT_VERSION,
    status,
    run,
    attempts,
    budgetConsumed: consumed,
  };
  try {
    return DestinationFetchEnrichmentResultSchema.parse(result);
  } catch {
    throwValidation();
  }
}
