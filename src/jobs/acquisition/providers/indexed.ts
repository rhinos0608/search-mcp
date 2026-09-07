/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unnecessary-condition -- provider adapter needs controlled assertions */
import { z } from 'zod/v4';
import {
  deterministicAcquisitionId,
  acquiredContentHash,
  normalizeHttpUrlMetadata,
} from '../adapterSupport.js';
import {
  ACQUISITION_CONTRACT_VERSION,
  AcquisitionPolicyEdgeSchema,
  AcquisitionSliceSchema,
  AcquisitionSliceResultSchema,
  ProviderGovernanceSchema,
  type AcquisitionPolicyEdge,
  type AcquisitionSlice,
  type AcquisitionSliceResult,
  type AcquisitionCandidate,
  type DiscoveryEvidence,
  type ProviderGovernance,
} from '../contracts.js';
import type { AdapterCapabilityRegistry } from '../adapterRegistry.js';
import type { IndexedProviderPort, IndexedSafeSearch, IndexedSummaryMode } from './ports.js';
import { validationError, isToolError } from '../../../errors.js';
import { caveatsForInformationalEdges } from '../policy/edgeCoordinator.js';
import { InstantSchema } from '../../domain/ids.js';
import type { SearchResult } from '../../../types.js';

export const INDEXED_PROVIDER_ADAPTER_VERSION = '1.0.0' as const;
export type { IndexedSafeSearch, IndexedSummaryMode, IndexedProviderPort } from './ports.js';

export interface IndexedProviderRequest {
  slice: AcquisitionSlice;
  executionEdge: AcquisitionPolicyEdge;
  informationalEdges?: readonly AcquisitionPolicyEdge[];
  safeSearch: IndexedSafeSearch;
  aiSummary?: IndexedSummaryMode;
  capturedAt: string;
}

export interface IndexedProviderDeps {
  capabilityRegistry: AdapterCapabilityRegistry;
  port: IndexedProviderPort;
  monotonicNow?: () => number;
}

export interface IndexedProviderAdapterResult {
  governance: ProviderGovernance;
  sliceResult: AcquisitionSliceResult;
}

const SafeSearchSchema = z.enum(['strict', 'moderate', 'off']);
const SummaryModeSchema = z.enum(['no', 'yes', 'only']);

function throwValidation(message: string): never {
  throw validationError(message);
}

function sanitizeErrorCode(err: unknown): string {
  if (isToolError(err)) {
    const allowed = new Set([
      'RATE_LIMIT',
      'NOT_FOUND',
      'TIMEOUT',
      'NETWORK_ERROR',
      'PARSE_ERROR',
      'UNAVAILABLE',
      'VALIDATION_ERROR',
      'CONFIG_ERROR',
    ]);
    if (allowed.has(err.code)) return err.code;
    return 'ERROR';
  }
  return 'ERROR';
}

function sanitizeWarning(): string {
  return 'indexed_malformed_record_discarded';
}

function capText(text: string): string {
  return text.length > 8192 ? text.slice(0, 8192) : text;
}

function inferPublisher(
  informationalEdges: readonly AcquisitionPolicyEdge[],
): { kind: string; sourceId: string } | undefined {
  const candidates: { kind: string; sourceId: string }[] = [];
  for (const e of informationalEdges) {
    if (e.effect !== 'informational_capability') continue;
    if (e.route !== 'direct') continue;
    if (
      e.target.kind !== 'publisher' &&
      e.target.kind !== 'board' &&
      e.target.kind !== 'ats_tenant'
    )
      continue;
    candidates.push({ kind: e.target.kind, sourceId: e.target.sourceId });
  }
  if (candidates.length === 0) return undefined;
  const first = candidates[0]!;
  for (const c of candidates) {
    if (c.kind !== first.kind || c.sourceId !== first.sourceId) return undefined;
  }
  return first;
}

export async function runIndexedProvider(
  request: IndexedProviderRequest,
  deps: IndexedProviderDeps,
): Promise<IndexedProviderAdapterResult> {
  // validate request shapes
  let slice: AcquisitionSlice;
  try {
    slice = AcquisitionSliceSchema.parse(request.slice);
  } catch {
    throwValidation('invalid slice');
  }
  let executionEdge: AcquisitionPolicyEdge;
  try {
    executionEdge = AcquisitionPolicyEdgeSchema.parse(request.executionEdge);
  } catch {
    throwValidation('invalid execution edge');
  }
  const informationalEdges: readonly AcquisitionPolicyEdge[] = (() => {
    const raw = request.informationalEdges ?? [];
    if (!Array.isArray(raw)) throwValidation('invalid informational edges');
    if (raw.length > 99) throwValidation('too many informational edges');
    const parsed: AcquisitionPolicyEdge[] = [];
    for (const e of raw) {
      try {
        parsed.push(AcquisitionPolicyEdgeSchema.parse(e));
      } catch {
        throwValidation('invalid informational edge');
      }
      const pe = parsed[parsed.length - 1]!;
      if (pe.effect !== 'informational_capability')
        throwValidation('informational edge must be informational_capability');
      if (pe.route !== 'direct') throwValidation('informational edge must be direct');
      if (
        pe.target.kind !== 'publisher' &&
        pe.target.kind !== 'board' &&
        pe.target.kind !== 'ats_tenant'
      )
        throwValidation('informational edge target must be publisher/board/ats_tenant');
      if (pe.operation !== 'automatedSearch' && pe.operation !== 'automatedFetch')
        throwValidation('informational edge operation must be automatedSearch or automatedFetch');
    }
    // duplicate edgeIds
    const ids = parsed.map((p) => p.edgeId);
    if (new Set(ids).size !== ids.length) throwValidation('duplicate informational edge id');
    return parsed;
  })();

  let safeSearch: IndexedSafeSearch;
  try {
    safeSearch = SafeSearchSchema.parse(request.safeSearch);
  } catch {
    throwValidation('invalid safeSearch');
  }
  const aiSummary: IndexedSummaryMode = (() => {
    const v = request.aiSummary ?? 'no';
    try {
      return SummaryModeSchema.parse(v);
    } catch {
      throwValidation('invalid aiSummary');
    }
  })();
  try {
    InstantSchema.parse(request.capturedAt);
  } catch {
    throwValidation('invalid capturedAt');
  }
  const capturedAt = request.capturedAt;

  // validate deps.port
  const port = deps.port;
  if (!port || typeof port !== 'object') throwValidation('invalid port');
  if (
    typeof port.adapterId !== 'string' ||
    typeof port.providerId !== 'string' ||
    typeof port.backend !== 'string'
  )
    throwValidation('invalid port identity');
  if (
    typeof port.maxDurationMs !== 'number' ||
    !Number.isInteger(port.maxDurationMs) ||
    port.maxDurationMs <= 0
  )
    throwValidation('invalid port maxDuration');
  if (typeof port.search !== 'function') throwValidation('invalid port search');
  let governance: ProviderGovernance;
  try {
    governance = ProviderGovernanceSchema.parse(port.governance);
  } catch {
    throwValidation('invalid port governance');
  }
  // validate governance matches definition expectations (port identity must align)
  if (governance.providerId !== port.providerId)
    throwValidation('port governance providerId mismatch');
  if (governance.sourcePolicyId !== port.providerId)
    throwValidation('port governance sourcePolicyId mismatch');

  // validate capability registry
  const registry = deps.capabilityRegistry;
  if (!registry || typeof registry.supports !== 'function')
    throwValidation('invalid capability registry');

  // execution edge exactness
  const expectedActor = {
    kind: 'provider' as const,
    namespace: 'search-provider',
    id: port.providerId,
  };
  if (
    executionEdge.actor.kind !== expectedActor.kind ||
    executionEdge.actor.namespace !== expectedActor.namespace ||
    executionEdge.actor.id !== expectedActor.id ||
    executionEdge.operation !== 'automatedSearch' ||
    executionEdge.route !== 'indexed' ||
    executionEdge.target.kind !== 'discovery_provider' ||
    executionEdge.target.sourceId !== port.providerId ||
    executionEdge.effect !== 'authorized_operation' ||
    executionEdge.schemaVersion !== ACQUISITION_CONTRACT_VERSION
  ) {
    throwValidation('execution edge mismatch');
  }

  // capability check - must be before policy check per spec (capability never grants permission)
  const hasCapability = registry.supports(port.adapterId, {
    operation: 'automatedSearch',
    route: 'indexed',
    targetKind: 'discovery_provider',
  });
  const monotonicNow = deps.monotonicNow ?? (() => Date.now());

  const buildResult = (
    coverageState: AcquisitionSliceResult['coverage'][number]['state'],
    resultState: AcquisitionSliceResult['coverage'][number]['resultState'],
    candidates: AcquisitionCandidate[],
    evidence: DiscoveryEvidence[],
    warnings: string[],
    bytesUsed: number,
    durationMs: number,
    errorCode: string | undefined,
    logicalRequestsUsed: number,
    attemptsReserved: number,
  ): IndexedProviderAdapterResult => {
    const policyEdges: AcquisitionPolicyEdge[] = [executionEdge, ...informationalEdges];
    const coverage = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      adapterId: port.adapterId,
      state: coverageState,
      resultState,
      candidatesProduced: candidates.length,
      logicalRequestsUsed,
      attemptsReserved,
      bytesUsed,
      durationMs,
      ...(errorCode ? { errorCode } : {}),
      policyEdgeRefs: [executionEdge.edgeId],
    };
    const sliceResult = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      runId: slice.runId,
      sliceId: slice.sliceId,
      candidates,
      coverage: [coverage],
      warnings: warnings.slice(0, 100),
      evidence,
      observations: [],
      policyEdges,
    };
    const parsed = AcquisitionSliceResultSchema.parse(sliceResult);
    return { governance, sliceResult: parsed };
  };

  // missing capability -> not_supported zero call
  if (!hasCapability) {
    return buildResult('not_supported', 'unknown', [], [], [], 0, 0, undefined, 0, 0);
  }

  // policy state handling (non-permitted zero calls)
  if (executionEdge.state === 'blocked') {
    return buildResult('policy_blocked', 'unknown', [], [], [], 0, 0, undefined, 0, 0);
  }
  if (
    executionEdge.state === 'requires_configuration' ||
    executionEdge.state === 'requires_review'
  ) {
    return buildResult('disabled', 'unknown', [], [], [], 0, 0, undefined, 0, 0);
  }
  if (executionEdge.state === 'not_supported') {
    return buildResult('not_supported', 'unknown', [], [], [], 0, 0, undefined, 0, 0);
  }
  if (executionEdge.state !== 'permitted') {
    return buildResult('not_supported', 'unknown', [], [], [], 0, 0, undefined, 0, 0);
  }

  // budget checks before call
  if (slice.budget.milliseconds < port.maxDurationMs) {
    return buildResult('failed', 'unknown', [], [], [], 0, 0, 'BUDGET_EXHAUSTED', 0, 0);
  }
  if (slice.budget.reservedAttempts < governance.maxAttempts) {
    return buildResult('failed', 'unknown', [], [], [], 0, 0, 'BUDGET_EXHAUSTED', 0, 0);
  }
  // strict mode excludes unsupported ports without call
  if (safeSearch === 'strict' && !governance.supportsStrictSafeSearch) {
    return buildResult('not_supported', 'unknown', [], [], [], 0, 0, undefined, 0, 0);
  }

  // one provider invocation
  const start = monotonicNow();
  let rawResults: readonly SearchResult[];
  try {
    const limit = Math.min(20, slice.budget.candidates);
    const res = await port.search({ query: slice.query, limit, safeSearch, aiSummary });
    if (!Array.isArray(res)) throw new Error('invalid provider result');
    rawResults = res as readonly SearchResult[];
  } catch (err) {
    const durationMs = Math.max(
      0,
      Math.min(Math.floor(monotonicNow() - start), slice.budget.milliseconds),
    );
    const code = sanitizeErrorCode(err);
    return buildResult(
      'failed',
      'unknown',
      [],
      [],
      [sanitizeWarning()],
      0,
      durationMs,
      code,
      1,
      governance.maxAttempts,
    );
  }
  const end = monotonicNow();
  let durationMs = Math.floor(end - start);
  if (!Number.isFinite(durationMs) || durationMs < 0) durationMs = 0;
  if (durationMs > slice.budget.milliseconds) durationMs = slice.budget.milliseconds;
  if (durationMs > 86400000) durationMs = 86400000;

  // mapping
  const seenCanonical = new Set<string>();
  const candidates: AcquisitionCandidate[] = [];
  const evidence: DiscoveryEvidence[] = [];
  const warnings: string[] = [];
  let malformedCount = 0;
  let bytesUsed = 0;
  const candidateCap = Math.min(20, slice.budget.candidates);
  const publisher = inferPublisher(informationalEdges);

  // caveats base
  const baseCaveats: string[] = [
    'provider_index_only',
    'publisher_not_fetched',
    'stale_index_possible',
  ];
  const informationalCaveats = caveatsForInformationalEdges([
    ...informationalEdges,
  ] as AcquisitionPolicyEdge[]);
  // per-candidate summary caveat derived from evidencesForCandidate kinds only (no shared flag)

  for (let idx = 0; idx < rawResults.length; idx++) {
    if (candidates.length >= candidateCap) break;
    const result = rawResults[idx] as unknown as Record<string, unknown>;
    if (!result || typeof result !== 'object') {
      malformedCount++;
      continue;
    }
    const urlRaw = typeof result.url === 'string' ? result.url : '';
    if (!urlRaw || typeof urlRaw !== 'string') {
      malformedCount++;
      continue;
    }
    const meta = normalizeHttpUrlMetadata(urlRaw);
    if (!meta) {
      malformedCount++;
      continue;
    }
    const canonical = meta.canonicalUrl;
    if (seenCanonical.has(canonical)) continue;
    // bytes budget check: need to estimate before creating
    // we haven't created evidence yet, but we can check after creation
    // enforce unique

    // determine text mapping
    const contentKind = result.contentKind as string | undefined;
    const generatedSummary = result.generatedSummary;
    const generatedSummaryProvider = result.generatedSummaryProvider;

    const description = typeof result.description === 'string' ? result.description : '';
    const extraSnippet = typeof result.extraSnippet === 'string' ? result.extraSnippet : null;
    // primary text: prefer description; if empty and extraSnippet non-empty, use extraSnippet
    const primaryText = description.trim().length > 0 ? description : (extraSnippet ?? '');
    // For summary mapping, primaryText may be summary itself
    // Determine evidence kinds
    const evidencesForCandidate: DiscoveryEvidence[] = [];
    const isSummaryKind = contentKind === 'summary';
    const hasGeneratedSummary =
      typeof generatedSummary === 'string' &&
      generatedSummary.trim().length > 0 &&
      typeof generatedSummaryProvider === 'string' &&
      generatedSummaryProvider.length > 0;

    // helper to create evidence
    const makeEvidence = (
      kind: DiscoveryEvidence['kind'],
      boundedText: string | undefined,
      targetCanonicalUrl: string,
    ): DiscoveryEvidence => {
      const textForHash = boundedText ?? '';
      const hash = acquiredContentHash(textForHash);
      const evidenceId = deterministicAcquisitionId('evidence', [
        slice.runId,
        slice.sliceId,
        port.adapterId,
        canonical,
        kind,
        String(evidence.length),
      ]);
      const base: Record<string, unknown> = {
        evidenceId,
        kind,
        providerAttributed: true,
        providerId: port.providerId,
        targetCanonicalUrl,
        contentHash: hash,
        capturedAt,
      };
      if (boundedText !== undefined) {
        const capped = capText(boundedText);
        base.boundedText = capped;
        if (kind === 'provider_generated_summary') {
          base.generatedBy = port.providerId;
          base.urlAttributable = true;
        }
      } else {
        if (kind === 'provider_generated_summary') {
          base.generatedBy = port.providerId;
          base.urlAttributable = true;
          // summary requires boundedText, so should not happen; ensure we provide empty cropped?
          base.boundedText = '';
        }
      }
      // For summary, ensure boundedText present
      if (kind === 'provider_generated_summary' && base.boundedText === undefined) {
        base.boundedText = '';
      }
      // cleanup for indexed_snippet/provider_metadata: strip extra summary fields
      if (kind !== 'provider_generated_summary') {
        delete base.generatedBy;
        delete base.urlAttributable;
      }
      return base as unknown as DiscoveryEvidence;
    };

    if (isSummaryKind) {
      // map primaryText as summary
      const text = primaryText.trim();
      if (text.length === 0) {
        // fallback to metadata if no usable text
        const ev = makeEvidence('provider_metadata', undefined, canonical);
        evidencesForCandidate.push(ev);
      } else {
        const ev = makeEvidence('provider_generated_summary', capText(text), canonical);
        evidencesForCandidate.push(ev);
      }
      // also consider generatedSummary if present and matching? For summary kind, generatedSummary likely not separate; but if present and distinct, add second?
      if (hasGeneratedSummary && generatedSummaryProvider === port.backend) {
        const genText = generatedSummary.trim();
        if (genText.length > 0 && genText !== primaryText.trim()) {
          const ev2 = makeEvidence('provider_generated_summary', capText(genText), canonical);
          // ensure we don't exceed 2 per candidate; but summary kind already used 1, can add second if bytes allow
          if (evidencesForCandidate.length < 2) {
            evidencesForCandidate.push(ev2);
          }
        }
      }
    } else {
      // normal snippet
      const snippetText = primaryText.trim();
      const hasSnippet = snippetText.length > 0;
      if (hasSnippet) {
        const ev = makeEvidence('indexed_snippet', capText(snippetText), canonical);
        evidencesForCandidate.push(ev);
      }
      if (hasGeneratedSummary) {
        // only if provider matches; for exa, generatedSummaryProvider === 'exa'
        // we already check hasGeneratedSummary includes provider string
        // Accept only if generatedSummaryProvider matches port.backend (exa) or port.providerId suffix?
        // Spec: matching generatedSummary including Exa exactly
        // For exa, provider is exa, so check provider matches backend
        const genProvider = generatedSummaryProvider;
        if (genProvider === port.backend) {
          const genText = generatedSummary.trim();
          if (genText.length > 0) {
            const ev2 = makeEvidence('provider_generated_summary', capText(genText), canonical);
            if (evidencesForCandidate.length < 2) {
              evidencesForCandidate.push(ev2);
            } else {
              // if already have snippet, we can still add summary as second
            }
          }
        } else {
          // Tavily generatedSummary is null per implementation, so not relevant
          // ignore mismatched provider
        }
      }
      if (evidencesForCandidate.length === 0) {
        const ev = makeEvidence('provider_metadata', undefined, canonical);
        evidencesForCandidate.push(ev);
      }
    }

    // enforce evidence cap 2 per candidate already, and byte budget
    // compute bytes for these evidences
    let candidateBytes = 0;
    for (const ev of evidencesForCandidate) {
      const txt = (ev as unknown as { boundedText?: string }).boundedText ?? '';
      candidateBytes += Buffer.byteLength(txt, 'utf8');
    }
    if (bytesUsed + candidateBytes > slice.budget.bytes) {
      // cannot fit, stop adding more candidates
      break;
    }
    // also check total evidence count limit 2000
    if (evidence.length + evidencesForCandidate.length > 2000) break;

    // create candidate
    const candidateId = deterministicAcquisitionId('candidate', [
      slice.runId,
      slice.sliceId,
      port.adapterId,
      canonical,
    ]);
    // discoverer
    const rankRaw = result.position;
    const rank =
      typeof rankRaw === 'number' && Number.isInteger(rankRaw) && rankRaw >= 0 ? rankRaw : idx + 1;
    const discoverer: Record<string, unknown> = {
      providerId: port.providerId,
      queryVariantId: slice.queryVariantId,
      rank,
    };
    // SearXNG upstreamEngines metadata only
    if (port.backend === 'searxng' && Array.isArray(result.upstreamEngines)) {
      const engines = (result.upstreamEngines as unknown[])
        .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
        .map((e) => e.trim())
        .sort();
      if (engines.length > 0) discoverer.upstreamEngines = engines.slice(0, 32);
    }

    const provenance: Record<string, unknown> = {
      kind: 'indexed_discovery',
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      discoverers: [discoverer],
      contentDonor: {
        kind: 'provider',
        providerId: port.providerId,
        representation:
          evidencesForCandidate[0]!.kind === 'provider_generated_summary'
            ? 'provider_generated_summary'
            : evidencesForCandidate[0]!.kind === 'provider_metadata'
              ? 'provider_metadata'
              : 'indexed_snippet',
      },
      destination: {
        rawUrl: meta.rawUrl,
        canonicalUrl: meta.canonicalUrl,
        normalizedHost: meta.normalizedHost,
      },
      capturedAt,
    };
    // publisher only if unambiguous
    if (publisher) {
      provenance.publisher = { kind: publisher.kind, sourceId: publisher.sourceId };
    }

    // titleHint handling
    const titleRaw = typeof result.title === 'string' ? result.title.trim() : '';
    const titleHint = titleRaw.length > 0 ? titleRaw.slice(0, 512) : undefined;

    // caveats per candidate — per-candidate only
    const candidateCaveats = [...baseCaveats];
    if (evidencesForCandidate.some((e) => e.kind === 'provider_generated_summary'))
      candidateCaveats.push('provider_generated_summary');
    for (const c of informationalCaveats) {
      if (!candidateCaveats.includes(c)) candidateCaveats.push(c);
    }

    const candidate: Record<string, unknown> = {
      schemaVersion: ACQUISITION_CONTRACT_VERSION,
      candidateId,
      runId: slice.runId,
      sliceId: slice.sliceId,
      adapterId: port.adapterId,
      ...(titleHint ? { titleHint } : {}),
      evidenceRefs: evidencesForCandidate.map((e) => e.evidenceId),
      policyEdgeRefs: [executionEdge.edgeId],
      caveats: candidateCaveats,
      state: 'indexed_only',
      provenance,
    };

    // validate candidate via schema? We'll push and let final parse handle
    // but need to ensure evidenceRefs and policyEdgeRefs unique and within bounds - they are

    seenCanonical.add(canonical);
    candidates.push(candidate as unknown as AcquisitionCandidate);
    for (const ev of evidencesForCandidate) evidence.push(ev);
    bytesUsed += candidateBytes;
  }

  if (malformedCount > 0) {
    warnings.push(sanitizeWarning());
  }

  // determine coverage state
  let coverageState: AcquisitionSliceResult['coverage'][number]['state'];
  let resultState: AcquisitionSliceResult['coverage'][number]['resultState'];
  const errorCode: string | undefined = undefined;
  if (malformedCount > 0 && candidates.length > 0) {
    coverageState = 'partial';
    resultState = 'results';
  } else if (malformedCount > 0 && candidates.length === 0 && rawResults.length > 0) {
    coverageState = 'partial';
    resultState = 'no_results';
  } else if (candidates.length === 0) {
    coverageState = 'succeeded';
    resultState = 'no_results';
  } else {
    coverageState = 'succeeded';
    resultState = 'results';
  }

  const logicalRequestsUsed = 1;
  const attemptsReserved = governance.maxAttempts;
  // bytesUsed already computed, ensure within budget (it is)
  // warnings already

  return buildResult(
    coverageState,
    resultState,
    candidates,
    evidence,
    warnings,
    bytesUsed,
    durationMs,
    errorCode,
    logicalRequestsUsed,
    attemptsReserved,
  );
}

export { INDEXED_PROVIDER_DEFINITIONS } from './ports.js';
