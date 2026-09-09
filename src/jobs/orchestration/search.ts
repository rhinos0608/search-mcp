/**
 * executeJobsSearch — private deterministic application seam (Checkpoint C).
 *
 * Composes existing modules only: intent validation → runAcquisition →
 * extraction where permitted → identity → retrieval → assessment → ranking,
 * with optional request-scoped profile fit and bounded reasoning fallback.
 *
 * Hard boundaries (no exceptions):
 * - No MCP registration or legacy-surface coupling.
 * - No durable profile/persistence (request-scoped profile only).
 * - No new observations fabricated: indexed-only candidates stay indexed-only.
 * - Manual inline content performs zero fetch (coordinator enforces; seam
 *   asserts no destination evidence appears for manual candidates).
 * - Blocked SEEK performs zero direct calls (policy-enforced; seam counts).
 * - Source failures isolated per slice; never silent (coverage outcomes).
 * - Utility / coverage / confidence / eligibility stay separate fields.
 * - RRF is retrieval metadata only, never a utility input.
 * - No locale assumptions without a pack (retrieval geography gated on it).
 * - Explicit preferences outrank learned (applyLearnedResidual skips them).
 * - Deadline / budget / cancellation respected between stages.
 */

import { z } from 'zod/v4';
import { SearchIntentSchema, type SearchIntent } from '../domain/intent.js';
import { JobFlagSchema, JobPostingSchema, type JobPosting } from '../domain/posting.js';
import type { ExtractionResult } from '../extraction/contracts.js';
import {
  ACQUISITION_COORDINATOR_VERSION,
  AcquisitionRunBudgetSchema,
  AcquisitionRunOptionsSchema,
  runAcquisition,
} from '../acquisition/coordinator.js';
import type {
  AcquiredObservationEnvelope,
  AcquisitionCandidate,
  DiscoveryEvidence,
} from '../acquisition/contracts.js';
import {
  EXTRACTION_CONTRACT_VERSION,
  EXTRACTOR_VERSION,
  ExtractObservationInputSchema,
} from '../extraction/contracts.js';
import { extractObservation } from '../extraction/pipeline.js';
import {
  IDENTITY_RESOLVER_VERSION,
  extractIdentityFeatures,
  mergeSubjects,
  proposeIdentityDecision,
  scoreIdentityPair,
} from '../identity/index.js';
import type { IdentitySubject } from '../identity/index.js';
import type { IdentityDecision } from '../domain/identity.js';
import type { IdentityDecisionId } from '../domain/ids.js';
import { runRetrieval } from '../retrieval/pipeline.js';
import { applyIndexedEnrichment } from './indexedEnrichment.js';
import { RETRIEVAL_CONTRACT_VERSION } from '../retrieval/contracts.js';
import {
  ASSESSMENT_CONTRACT_VERSION,
  DEFAULT_GROUP_WEIGHTS,
  type ScoreGroup,
} from '../assessment/contracts.js';
import { assessCandidate } from '../assessment/scorer.js';
import { rankCandidates } from '../ranking/ranker.js';
import { processProfileRequest } from '../profile/service.js';
import type { ResidualFeatureKey } from '../feedback/contracts.js';
import { applyLearnedResidual, zeroResidual } from '../feedback/residual.js';
import { canonicalKey } from '../feedback/ids.js';
import { buildReasoningPacket } from '../reasoning/packet.js';
import { createIdempotencyStore } from '../reasoning/submit.js';
import { runOptionalReasoning } from '../reasoning/run.js';
import { validationError } from '../../errors.js';
import { classifyListingUrl } from '../acquisition/listingHeuristics.js';
import {
  JOBS_SEARCH_CONTRACT_VERSION,
  JobsSearchError,
  JobsSearchResultSchema,
  type JobsSearchCandidate,
  type JobsSearchCoverageOutcome,
  type JobsSearchDeps,
  type JobsSearchEvidenceState,
  type JobsSearchRequest,
  type JobsSearchResult,
} from './searchContracts.js';

function throwValidation(message = 'VALIDATION_ERROR'): never {
  throw validationError(message);
}

// ---------------------------------------------------------------------------
// Internal per-candidate assembly
// ---------------------------------------------------------------------------

interface AssembledCandidate {
  acquisitionCandidate: AcquisitionCandidate;
  envelopes: AcquiredObservationEnvelope[];
  evidenceById: Map<string, DiscoveryEvidence>;
  evidenceState: JobsSearchEvidenceState;
  origins: ('observed' | 'indexed' | 'user_supplied' | 'deterministic_derived')[];
  sourceListingIds: string[];
  observationIds: string[];
  titleHint: string | null;
  organisationHint: string | null;
  posting: JobPosting | null;
  extraction: ExtractionResult | null;
  extractionWarnings: string[];
  identityDecision: IdentityDecision | null;
  identityConfidence: number;
  sliceOrdinal: number;
}

function evidenceOrigin(kind: string): 'observed' | 'indexed' | 'user_supplied' {
  if (kind === 'destination_content' || kind === 'adapter_listing') return 'observed';
  if (kind === 'user_supplied_content') return 'user_supplied';
  return 'indexed';
}

function classifyEvidenceState(
  candidate: AcquisitionCandidate,
  envelopes: AcquiredObservationEnvelope[],
  origins: Set<string>,
): JobsSearchEvidenceState {
  void envelopes;
  if (candidate.state === 'indexed_only' || candidate.state === 'fetch_eligible') {
    return 'indexed_only';
  }
  if (candidate.state === 'manual_content') return 'user_supplied';
  // fetched/adapter candidates with both observation + indexed provenance
  if (origins.has('observed') && origins.has('indexed')) return 'mixed_upgradeable';
  return 'observation_backed';
}

function candidateTitleHint(c: AcquisitionCandidate): string | null {
  return typeof c.titleHint === 'string' && c.titleHint.length > 0 ? c.titleHint : null;
}

function deriveRoleFamilies(
  a: AssembledCandidate,
  domainPack: JobsSearchRequest['domainPack'],
): JobPosting['roleFamilies'] {
  const posting = a.posting;
  if (!posting) return [];
  const out: JobPosting['roleFamilies'] = [];
  const seen = new Set<string>();
  const push = (family: string, confidence: number): void => {
    const key = family.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push({
      family: family.trim(),
      confidence,
      evidenceRefs: [...posting.evidenceRefs],
    });
  };
  // 1. extraction roleFamilies are already on the posting (adopted).
  // 2. domain pack role graph: title/capability term overlap.
  if (domainPack) {
    const haystacks: string[] = [
      posting.normalizedTitle,
      posting.title,
      ...posting.requirements.flatMap((r) =>
        r.semanticCapability !== undefined && r.semanticCapability.length > 0
          ? [r.semanticCapability]
          : [],
      ),
    ].map((h) => h.toLowerCase());
    for (const node of domainPack.roleNodes) {
      const names = [node.label, ...node.aliases];
      const hit = names.some(
        (n) => n.trim().length > 2 && haystacks.some((h) => h.includes(n.trim().toLowerCase())),
      );
      if (hit) push(node.label, 0.6);
      for (const cap of node.capabilities) {
        if (cap.trim().length > 2 && haystacks.some((h) => h.includes(cap.trim().toLowerCase()))) {
          push(node.label, 0.55);
          break;
        }
      }
      if (out.length >= 8) break;
    }
  }
  return out.slice(0, 8);
}

function postingFromExtraction(
  candidateId: string,
  envelopes: AcquiredObservationEnvelope[],
  extraction: { projection: ExtractionResult['projection']; extractionWarnings: string[] } | null,
  nowMs: number,
): { posting: JobPosting | null; warnings: string[] } {
  const first = envelopes[0];
  if (!first) return { posting: null, warnings: ['no_observation_envelope'] };
  const fields = (extraction?.projection.fields ?? {}) as Record<string, unknown>;
  const asText = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  // Posting locator URLs: canonical listing URL (credential-free) plus apply
  // URL when extraction observed one. listingUrl is a locator, not evidence text.
  const firstCanonicalUrl = first.listing.canonicalUrl;
  const listingUrls = [
    ...new Set(
      [firstCanonicalUrl, asText(fields.applyUrl)].filter(
        (u): u is string => typeof u === 'string' && u.length > 0,
      ),
    ),
  ];
  // Adopt every extracted hot field; fall back to placeholders only when the
  // extractor produced nothing (placeholders keep JobPostingSchema satisfied).
  const title = asText(fields.title) ?? 'Untitled posting';
  const organisation = asText(fields.organisation) ?? 'Unknown organisation';
  const description = asText(fields.description) ?? 'No description available.';
  const locations: JobPosting['locations'] =
    extraction && extraction.projection.locations.length > 0
      ? extraction.projection.locations.map((l) => ({ ...l }))
      : [{}];
  const salaries: JobPosting['salaries'] = extraction
    ? extraction.projection.salaries.map((s) => ({ ...s }))
    : [];
  const workMode =
    fields.workMode === 'onsite' || fields.workMode === 'hybrid' || fields.workMode === 'remote'
      ? fields.workMode
      : 'unknown';
  const employmentType =
    typeof fields.employmentType === 'string' &&
    ['full_time', 'part_time', 'casual', 'contract', 'temporary', 'internship'].includes(
      fields.employmentType,
    )
      ? (fields.employmentType as JobPosting['employmentType'])
      : 'unknown';
  const roleFamilies: JobPosting['roleFamilies'] = extraction
    ? extraction.projection.roleFamilies.map((r) => ({
        family: r.family,
        confidence: r.confidence,
        evidenceRefs: [...r.evidenceRefs] as JobPosting['roleFamilies'][number]['evidenceRefs'],
      }))
    : [];
  const closingAt = typeof fields.closingAt === 'string' ? fields.closingAt : undefined;
  const lifecycleState: JobPosting['lifecycleState'] =
    closingAt !== undefined && new Date(closingAt).getTime() <= nowMs
      ? 'confirmed_closed'
      : first.acquisition.captureKind === 'destination_fetch'
        ? 'active'
        : 'discovered';
  const candidate: unknown = {
    postingId: `posting:${candidateId}`,
    schemaVersion: '1.0.0',
    canonicalRevision: 1,
    title,
    normalizedTitle: title.toLowerCase(),
    organisation,
    ...(typeof fields.organisationUnit === 'string' && fields.organisationUnit.length > 0
      ? { organisationUnit: fields.organisationUnit }
      : {}),
    roleFamilies,
    locations,
    workMode,
    employmentType,
    salaries,
    classifications: [],
    ...(typeof fields.postedAt === 'string' ? { postedAt: fields.postedAt } : {}),
    ...(typeof fields.closingAt === 'string' ? { closingAt: fields.closingAt } : {}),
    ...(typeof fields.applyUrl === 'string' ? { applyUrl: fields.applyUrl } : {}),
    listingUrls,
    description,
    responsibilities: [],
    requirements: [],
    desirableCriteria: [],
    applicationRequirements: [],
    selectionQuestions: [],
    licencesChecksRegistration: [],
    verificationState:
      first.acquisition.captureKind === 'adapter_listing'
        ? 'unverified'
        : first.observation.fetchOutcome === 'success'
          ? 'partially_verified'
          : 'unverified',
    lifecycleState,
    flags: [],
    confidence: 0.3,
    caveats: ['seam projection: extraction-backed minimum'],
    evidenceRefs: [...first.observation.evidenceRefs],
    fieldEvidenceLinks: extraction
      ? extraction.projection.fieldEvidenceLinks.map(
          (l: { fieldPath: string; evidenceRefs: readonly string[] }) => ({
            fieldPath: l.fieldPath,
            evidenceRefs: [...l.evidenceRefs],
          }),
        )
      : [],
    sourceListingIds: [first.listing.sourceListingId],
    observationIds: [first.observation.observationId],
    identityDecisionRevision: 'none',
  };
  const parsed = JobPostingSchema.safeParse(candidate);
  if (!parsed.success) {
    return { posting: null, warnings: ['posting_schema_rejected'] };
  }
  return { posting: parsed.data, warnings: [...(extraction?.extractionWarnings ?? [])] };
}

// ---------------------------------------------------------------------------
// Main seam
// ---------------------------------------------------------------------------

export async function executeJobsSearch(
  request: JobsSearchRequest,
  deps: JobsSearchDeps,
): Promise<JobsSearchResult> {
  // ----- validate intent + run envelope before any work -----
  let intent: SearchIntent;
  try {
    intent = SearchIntentSchema.parse(request.intent);
  } catch {
    throwValidation();
  }
  const runId = request.runId;
  const capturedAt = request.capturedAt;
  try {
    z.string().trim().min(1).max(256).parse(runId);
    z.string().trim().min(1).parse(capturedAt);
    new Date(capturedAt).toISOString();
  } catch {
    throwValidation();
  }
  let budget: JobsSearchRequest['budget'];
  try {
    budget = AcquisitionRunBudgetSchema.parse(request.budget);
  } catch {
    throwValidation();
  }
  if (!Array.isArray(request.plan) || request.plan.length === 0) {
    throw new JobsSearchError('NO_CANDIDATES', 'empty acquisition plan');
  }
  if (request.abortSignal?.aborted) {
    throw new JobsSearchError('ABORTED', 'aborted before acquisition');
  }
  const monotonicNow = request.monotonicNow ?? (() => Date.now());
  const startMs = monotonicNow();
  const budgetMs = intent.budgets.milliseconds;
  // Deterministic clock: injected nowMs drives every timestamp except the
  // caller-supplied capturedAt (acquisition provenance). Reasoning packet IDs
  // stay intentionally nondeterministic (randomUUID) and are excluded from the
  // deterministic output contract (versions.reasoningFallback reports status).
  const frozenNowMs = request.nowMs ?? Date.now();
  const nowMs = frozenNowMs;
  const nowIso = (): string => new Date(frozenNowMs).toISOString();

  const checkDeadline = (stage: string): void => {
    if (monotonicNow() - startMs > budgetMs) {
      throw new JobsSearchError('DEADLINE_EXCEEDED', `deadline exceeded at ${stage}`);
    }
    if (request.abortSignal?.aborted) {
      throw new JobsSearchError('ABORTED', `aborted at ${stage}`);
    }
  };

  let options: z.infer<typeof AcquisitionRunOptionsSchema>;
  try {
    options = AcquisitionRunOptionsSchema.parse({
      runId,
      capturedAt,
      budget,
      plan: request.plan,
      ...(request.abortSignal !== undefined ? { abortSignal: request.abortSignal } : {}),
    });
  } catch {
    throwValidation();
  }

  // ----- acquisition (source failures isolated inside coordinator) -----
  let acquisition: Awaited<ReturnType<typeof runAcquisition>>;
  try {
    acquisition = await runAcquisition(options, {
      policyRegistry: deps.policyRegistry,
      capabilityRegistry: deps.capabilityRegistry,
      ports: deps.ports,
      scrapeJobs: deps.scrapeJobs,
      ...(request.monotonicNow !== undefined ? { monotonicNow: request.monotonicNow } : {}),
    });
    const enrichCap = Math.min(10, intent.budgets.enrichment);
    const enriched = await applyIndexedEnrichment(acquisition, deps.ports, intent.query, enrichCap);
    acquisition = enriched.run;
    if (enriched.warnings.length > 0) {
      acquisition = {
        ...acquisition,
        warnings: [...acquisition.warnings, ...enriched.warnings].slice(0, 100),
      };
    }
  } catch (err) {
    if (err instanceof JobsSearchError) throw err;
    throw new JobsSearchError(
      'ACQUISITION_FAILED',
      err instanceof Error ? err.message : 'acquisition failed',
    );
  }
  checkDeadline('post-acquisition');

  // ----- assemble candidates: envelopes + evidence, no fabrication -----
  const assembled: AssembledCandidate[] = [];
  const warnings: string[] = [...acquisition.warnings.slice(0, 50)];
  const coverageOutcomes: JobsSearchCoverageOutcome[] = [];
  let directSeekCalls = 0;

  for (const slice of acquisition.slices) {
    const evidenceById = new Map<string, DiscoveryEvidence>();
    for (const e of slice.evidence) evidenceById.set(e.evidenceId, e);
    const envelopesById = new Map<string, AcquiredObservationEnvelope>();
    for (const o of slice.observations) envelopesById.set(o.envelopeId, o);

    for (const cov of slice.coverage) {
      coverageOutcomes.push({
        sliceId: slice.sliceId,
        adapterId: cov.adapterId,
        state: cov.state,
        candidatesProduced: cov.candidatesProduced,
        isolated: cov.state === 'failed' || cov.state === 'policy_blocked',
      });
    }

    for (const edge of slice.policyEdges) {
      if (
        edge.route === 'direct' &&
        edge.effect === 'authorized_operation' &&
        (edge.target.sourceId === 'board:seek' || edge.target.sourceId === 'seek')
      ) {
        directSeekCalls += 1;
      }
    }

    for (const cand of slice.candidates) {
      const linkedEnvelopes: AcquiredObservationEnvelope[] = [];
      const ref =
        'observationEnvelopeRef' in cand
          ? (cand as { observationEnvelopeRef?: unknown }).observationEnvelopeRef
          : undefined;
      if (typeof ref === 'string') {
        const env = envelopesById.get(ref);
        if (env) linkedEnvelopes.push(env);
      }
      // Manual inline must perform zero fetch: no destination evidence allowed
      if (cand.state === 'manual_content') {
        for (const eRef of cand.evidenceRefs) {
          if (evidenceById.get(eRef)?.kind === 'destination_content') {
            throw new JobsSearchError(
              'VALIDATION_ERROR',
              'manual candidate carries destination fetch evidence',
            );
          }
        }
      }
      // Indexed-only must have no observation envelope (no fabrication path)
      if (
        (cand.state === 'indexed_only' || cand.state === 'fetch_eligible') &&
        linkedEnvelopes.length > 0
      ) {
        throw new JobsSearchError(
          'VALIDATION_ERROR',
          'indexed-only candidate carries observation envelope',
        );
      }
      const origins = new Set<'observed' | 'indexed' | 'user_supplied'>();
      for (const eRef of cand.evidenceRefs) {
        const ev = evidenceById.get(eRef);
        if (ev) origins.add(evidenceOrigin(ev.kind));
      }
      const sourceListingIds: string[] = [];
      const observationIds: string[] = [];
      for (const env of linkedEnvelopes) {
        sourceListingIds.push(env.listing.sourceListingId);
        observationIds.push(env.observation.observationId);
      }
      assembled.push({
        acquisitionCandidate: cand,
        envelopes: linkedEnvelopes,
        evidenceById,
        evidenceState: classifyEvidenceState(cand, linkedEnvelopes, origins),
        origins: [...origins],
        sourceListingIds: [...new Set(sourceListingIds)],
        observationIds: [...new Set(observationIds)],
        titleHint: candidateTitleHint(cand),
        organisationHint: null,
        posting: null,
        extraction: null,
        extractionWarnings: [],
        identityDecision: null,
        identityConfidence: 0,
        sliceOrdinal: request.plan.findIndex((item) => item.slice.sliceId === cand.sliceId),
      });
    }
  }
  for (const skipped of acquisition.skipped) {
    coverageOutcomes.push({
      sliceId: skipped.sliceId,
      adapterId: 'unknown',
      state:
        skipped.reason === 'budget_exhausted'
          ? 'skipped_budget'
          : skipped.reason === 'deadline_exceeded'
            ? 'skipped_deadline'
            : 'skipped_aborted',
      candidatesProduced: 0,
      isolated: true,
    });
  }
  if (directSeekCalls > 0) {
    throw new JobsSearchError('VALIDATION_ERROR', 'blocked SEEK direct call observed');
  }
  if (assembled.length === 0) {
    if (acquisition.status === 'aborted') throw new JobsSearchError('ABORTED', 'run aborted');
    if (acquisition.status === 'deadline_exceeded')
      throw new JobsSearchError('DEADLINE_EXCEEDED', 'acquisition deadline exceeded');
    if (acquisition.status === 'budget_exhausted')
      throw new JobsSearchError('BUDGET_EXHAUSTED', 'acquisition budget exhausted');
    // Aggregate pages skipped at mapping never become candidates; when that
    // leaves zero candidates the warning would otherwise vanish with the
    // result. Thread it onto the error so callers see why (never silent).
    const aggregateSkipWarnings = acquisition.warnings.filter(
      (w) => w === 'aggregate_search_page_skipped',
    );
    if (aggregateSkipWarnings.length > 0) {
      throw new JobsSearchError(
        'NO_CANDIDATES',
        `acquisition produced zero candidates (${String(aggregateSkipWarnings.length)} aggregate_search_page_skipped warning recorded)`,
        aggregateSkipWarnings,
      );
    }
    throw new JobsSearchError('NO_CANDIDATES', 'acquisition produced zero candidates');
  }
  checkDeadline('post-assembly');

  // ----- extraction where permitted (observation-backed + manual only) -----
  const extractable = assembled
    .filter((a) => a.envelopes.length > 0)
    .sort((a, b) => {
      if (a.sliceOrdinal !== b.sliceOrdinal) return a.sliceOrdinal - b.sliceOrdinal;
      const idA = a.acquisitionCandidate.candidateId;
      const idB = b.acquisitionCandidate.candidateId;
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    })
    .slice(0, 20);
  for (const a of extractable) {
    if (a.envelopes.length === 0) continue; // indexed-only: no extraction, no fabrication
    const env = a.envelopes[0];
    if (!env) continue;
    const envelopeEvidence = a.evidenceById.get(env.acquisition.evidenceRefs[0] as string);
    void envelopeEvidence;
    // Build extraction input from envelope: evidence limited to envelope refs
    const inputEvidence: DiscoveryEvidence[] = [];
    for (const ref of env.acquisition.evidenceRefs) {
      const ev = a.evidenceById.get(ref);
      if (ev) inputEvidence.push(ev);
    }
    if (inputEvidence.length === 0) {
      a.extractionWarnings.push('no_extractable_evidence');
      continue;
    }
    try {
      const parsed = ExtractObservationInputSchema.parse({
        schemaVersion: EXTRACTION_CONTRACT_VERSION,
        envelope: env,
        evidence: inputEvidence.slice(0, 32),
        packs: {
          ...(request.domainPack !== undefined ? { domain: request.domainPack } : {}),
          ...(request.localePack !== undefined ? { locale: request.localePack } : {}),
        },
        attachments: [],
        now: capturedAt,
      });
      const result = await extractObservation(parsed);
      a.extraction = result;
      a.extractionWarnings.push(...result.projection.warnings.slice(0, 8));
    } catch {
      a.extractionWarnings.push('extraction_failed_isolated');
    }
    checkDeadline('extraction');
  }

  // ----- posting projection: extraction-backed minimum, indexed stays thin -----
  for (const a of assembled) {
    if (a.envelopes.length > 0) {
      const { posting, warnings } = postingFromExtraction(
        a.acquisitionCandidate.candidateId,
        a.envelopes,
        a.extraction ? { projection: a.extraction.projection, extractionWarnings: [] } : null,
        nowMs,
      );
      a.posting = posting;
      a.extractionWarnings.push(...warnings);
    } else {
      // Indexed-only: thin posting from hints only, explicit caveats, no observation ids
      const destinationUrl = (
        a.acquisitionCandidate.provenance as unknown as {
          destination?: { canonicalUrl?: string };
        }
      ).destination?.canonicalUrl;
      const candidatePosting = {
        postingId: `posting:${a.acquisitionCandidate.candidateId}`,
        schemaVersion: '1.0.0',
        canonicalRevision: 1,
        title: a.titleHint ?? 'Untitled indexed posting',
        normalizedTitle: (a.titleHint ?? 'untitled indexed posting').toLowerCase(),
        organisation: 'Unknown organisation',
        roleFamilies: [],
        locations: [{}],
        workMode: 'unknown',
        employmentType: 'unknown',
        salaries: [],
        classifications: [],
        listingUrls: destinationUrl !== undefined ? [destinationUrl] : [],
        description: 'Indexed snippet only; no observation fetched.',
        responsibilities: [],
        requirements: [],
        desirableCriteria: [],
        applicationRequirements: [],
        selectionQuestions: [],
        licencesChecksRegistration: [],
        verificationState: 'unverified',
        lifecycleState: 'discovered',
        flags: [],
        confidence: 0.2,
        caveats: ['indexed_only: no observation; fields are hints, not facts'],
        evidenceRefs: [...a.acquisitionCandidate.evidenceRefs],
        sourceListingIds: [],
        observationIds: [],
        identityDecisionRevision: 'none',
      };
      const parsedPosting = JobPostingSchema.safeParse(candidatePosting);
      if (parsedPosting.success) {
        a.posting = parsedPosting.data;
      } else {
        a.posting = null;
        a.extractionWarnings.push('posting_schema_rejected');
      }
    }
  }
  checkDeadline('post-projection');

  // ----- role-family derivation (extraction/pack-backed, evidence-linked) ---
  // Postings carry zero roleFamilies unless extraction or the domain pack
  // supplies them. Pack role graph expansion runs on normalized title +
  // requirement capabilities; every family links extraction evidence.
  for (const a of assembled) {
    if (!a.posting || a.posting.roleFamilies.length > 0) continue;
    const derived = deriveRoleFamilies(a, request.domainPack);
    if (derived.length > 0) {
      a.posting = { ...a.posting, roleFamilies: derived };
    }
  }

  // ----- identity: pairwise within run, merge only on non-weak features -----
  // Merge groups (union-find over assembled indices): same_posting pairs in
  // one group emit ONE aggregated output candidate preserving every listing
  // / observation ref. No candidate disappears silently.
  const mergeParent = new Map<AssembledCandidate, AssembledCandidate>();
  const mergeFind = (a: AssembledCandidate): AssembledCandidate => {
    let root = a;
    while (mergeParent.get(root) !== undefined && mergeParent.get(root) !== root) {
      const next = mergeParent.get(root);
      if (!next) break;
      root = next;
    }
    return root;
  };
  const mergeGroupDecision = new Map<AssembledCandidate, IdentityDecision>();
  const mergeGroupConfidence = new Map<AssembledCandidate, number>();
  function unionMerge(
    left: AssembledCandidate,
    right: AssembledCandidate,
    decision: IdentityDecision,
    confidence: number,
  ): void {
    const rl = mergeFind(left);
    const rr = mergeFind(right);
    const root = rl;
    mergeParent.set(rr, root);
    mergeParent.set(rl, root);
    mergeParent.set(left, root);
    mergeParent.set(right, root);
    mergeGroupDecision.set(root, decision);
    const prev = mergeGroupConfidence.get(root) ?? 0;
    mergeGroupConfidence.set(root, Math.max(prev, confidence));
    left.identityDecision = decision;
    right.identityDecision = decision;
    left.identityConfidence = Math.max(left.identityConfidence, confidence);
    right.identityConfidence = Math.max(right.identityConfidence, confidence);
  }
  const subjects: {
    assembled: AssembledCandidate;
    vector: ReturnType<typeof extractIdentityFeatures>;
  }[] = [];
  for (const a of assembled) {
    if (!a.posting || a.envelopes.length === 0) continue;
    const env = a.envelopes[0];
    if (!env) continue;
    const subject: IdentitySubject = {
      listing: env.listing,
      observation: env.observation,
      postingProjection: {
        title: a.posting.title,
        normalizedTitle: a.posting.normalizedTitle,
        organisation: a.posting.organisation,
        locations: [...a.posting.locations],
        salaries: [...a.posting.salaries],
        listingUrls: [...a.posting.listingUrls],
        description: a.posting.description,
        evidenceRefs: [...a.posting.evidenceRefs],
      },
    };
    subjects.push({ assembled: a, vector: extractIdentityFeatures(subject) });
  }
  const decisions: IdentityDecision[] = [];
  const seenPairs = new Set<string>();
  for (let i = 0; i < subjects.length; i++) {
    for (let j = i + 1; j < subjects.length; j++) {
      const left = subjects[i];
      const right = subjects[j];
      if (!left || !right) continue;
      const key = [left.vector.subject.observationId, right.vector.subject.observationId]
        .sort()
        .join('|');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const pair = scoreIdentityPair(left.vector, right.vector);
      if (pair.proposedOutcome === 'same_posting') {
        try {
          const merged = mergeSubjects(
            [
              left.assembled.envelopes[0] && {
                listing: left.assembled.envelopes[0].listing,
                observation: left.assembled.envelopes[0].observation,
              },
              right.assembled.envelopes[0] && {
                listing: right.assembled.envelopes[0].listing,
                observation: right.assembled.envelopes[0].observation,
              },
            ].filter(Boolean) as unknown as IdentitySubject[],
            {
              now: capturedAt,
              decisionId:
                `identity-decision:${left.vector.subject.observationId}:${right.vector.subject.observationId}` as IdentityDecisionId,
              confidence: pair.confidence,
              contributions: pair.contributions,
              contradictoryEvidenceRefs: pair.contradictoryEvidenceRefs,
            },
          );
          decisions.push(merged);
          // Union both sides into the SAME merge group; output aggregation
          // below emits one candidate per group preserving all refs.
          unionMerge(left.assembled, right.assembled, merged, pair.confidence);
        } catch {
          // MERGE_FORBIDDEN (org+title only / veto): keep distinct, no failure
          const proposed = proposeIdentityDecision(pair, {
            now: capturedAt,
            decisionId:
              `identity-decision:${left.vector.subject.observationId}:${right.vector.subject.observationId}` as IdentityDecisionId,
          });
          decisions.push(proposed);
        }
      } else {
        const proposed = proposeIdentityDecision(pair, {
          now: capturedAt,
          decisionId:
            `identity-decision:${left.vector.subject.observationId}:${right.vector.subject.observationId}` as IdentityDecisionId,
        });
        decisions.push(proposed);
      }
    }
  }
  void decisions;
  checkDeadline('post-identity');

  // ----- merge-group aggregation: one output unit per same_posting group --
  // Preserves every listing/observation ref; the aggregated unit carries the
  // max-confidence decision and union evidence. Ungrouped stay singleton.
  interface OutputUnit {
    key: string;
    members: AssembledCandidate[];
    sourceListingIds: string[];
    observationIds: string[];
    evidenceRefs: string[];
    origins: AssembledCandidate['origins'];
    extractionWarnings: string[];
    extractionEvidenceRefs: string[];
    identityDecision: IdentityDecision | null;
    identityConfidence: number;
  }
  const unitsByRoot = new Map<AssembledCandidate, AssembledCandidate[]>();
  for (const a of assembled) {
    const root = mergeFind(a);
    const list = unitsByRoot.get(root) ?? [];
    list.push(a);
    unitsByRoot.set(root, list);
  }
  const units: OutputUnit[] = [];
  for (const [, members] of unitsByRoot) {
    const first = members[0];
    if (!first) continue;
    const root = mergeFind(first);
    const hasGroup =
      (mergeParent.get(root) !== undefined &&
        mergeFind(root) === root &&
        (unitsByRoot.get(root)?.length ?? 0) > 1) ||
      members.length > 1;
    if (!hasGroup && members.length === 1) {
      const m = first;
      units.push({
        key: m.acquisitionCandidate.candidateId,
        members: [m],
        sourceListingIds: [...m.sourceListingIds],
        observationIds: [...m.observationIds],
        evidenceRefs: [...m.acquisitionCandidate.evidenceRefs],
        origins: [...m.origins],
        extractionWarnings: [...m.extractionWarnings],
        extractionEvidenceRefs: m.extraction ? m.extraction.evidence.map((e) => e.evidenceId) : [],
        identityDecision: m.identityDecision,
        identityConfidence: m.identityConfidence,
      });
      continue;
    }
    // Merged group: aggregate. Representative posting = richest (most evidence refs).
    const sorted = [...members].sort(
      (x, y) =>
        y.acquisitionCandidate.evidenceRefs.length - x.acquisitionCandidate.evidenceRefs.length,
    );
    const rep = sorted[0];
    if (!rep) continue;
    const union = <T>(lists: T[][]): T[] => [...new Set(lists.flat())];
    const decision = mergeGroupDecision.get(root) ?? rep.identityDecision;
    units.push({
      key: [...members.map((m) => m.acquisitionCandidate.candidateId)].sort().join('+'),
      members,
      sourceListingIds: union(members.map((m) => m.sourceListingIds)),
      observationIds: union(members.map((m) => m.observationIds)),
      evidenceRefs: union(members.map((m) => [...m.acquisitionCandidate.evidenceRefs])),
      origins: [...new Set(members.flatMap((m) => [...m.origins]))],
      extractionWarnings: union(members.map((m) => [...m.extractionWarnings])),
      extractionEvidenceRefs: union(
        members.map((m) => (m.extraction ? m.extraction.evidence.map((e) => e.evidenceId) : [])),
      ),
      identityDecision: decision,
      identityConfidence: mergeGroupConfidence.get(root) ?? rep.identityConfidence,
    });
    void rep;
  }

  // Representative posting per unit: richest member (most evidence refs);
  // merged groups inherit the rep posting but keep union listing/observation refs.
  const unitPosting = (u: OutputUnit): JobPosting | null => {
    const withPosting = u.members.filter(
      (m): m is AssembledCandidate & { posting: JobPosting } => m.posting !== null,
    );
    if (withPosting.length === 0) return null;
    let best = withPosting[0] as AssembledCandidate & { posting: JobPosting };
    for (const m of withPosting) {
      if (m.posting.evidenceRefs.length > best.posting.evidenceRefs.length) best = m;
    }
    return best.posting;
  };

  // ----- retrieval: RRF metadata only (never utility) -----
  const retrievalCandidates: {
    candidateId: string;
    postingId?: string;
    roleFamilies: string[];
    locations: { country?: string; region?: string; city?: string }[];
    capabilities?: string[];
  }[] = units
    .map((u) => ({ unit: u, posting: unitPosting(u) }))
    .filter((x): x is { unit: OutputUnit; posting: JobPosting } => x.posting !== null)
    .map(({ unit: u, posting }) => ({
      candidateId: u.key,
      postingId: posting.postingId,
      roleFamilies: posting.roleFamilies.map((r) => r.family),
      locations: posting.locations.map((l) => ({
        ...(l.country !== undefined ? { country: l.country } : {}),
        ...(l.region !== undefined ? { region: l.region } : {}),
        ...(l.city !== undefined ? { city: l.city } : {}),
      })),
      capabilities: posting.requirements
        .map((r) => r.semanticCapability)
        .filter((c): c is string => typeof c === 'string'),
    }));
  const postingMap = new Map<
    string,
    import('../retrieval/channels/textBm25.js').TextBm25PostingLike
  >(
    units
      .map((u) => ({ unit: u, posting: unitPosting(u) }))
      .filter((x): x is { unit: OutputUnit; posting: JobPosting } => x.posting !== null)
      .map(({ unit: u, posting }) => [
        posting.postingId,
        {
          candidateId: u.key,
          postingId: posting.postingId,
          title: posting.title,
          normalizedTitle: posting.normalizedTitle,
          organisation: posting.organisation,
          description: posting.description,
          responsibilities: [...posting.responsibilities],
          requirements: posting.requirements.map((r) => ({ rawText: r.rawText })),
        },
      ]),
  );
  const retrieval = runRetrieval({
    runId,
    emittedAt: nowIso(),
    candidates: retrievalCandidates,
    postings: postingMap,
    intent: {
      query: intent.query,
      requestedRoleFamilies: intent.requestedRoleFamilies,
      locations: intent.locations.map((l) => ({
        ...(l.country !== undefined ? { country: l.country } : {}),
        ...(l.region !== undefined ? { region: l.region } : {}),
        ...(l.city !== undefined ? { city: l.city } : {}),
      })),
    },
    // No locale pack => no geography channel assumptions (pipeline omits it)
    ...(request.domainPack !== undefined ? { domainPack: request.domainPack } : {}),
    ...(request.localePack !== undefined ? { localePack: request.localePack } : {}),
    // Keep full RRF union for utility assessment. topK is presentation output,
    // not retrieval input; truncating here silently removes candidates before
    // utility ranking and metadata attachment.
  });
  const retrievalById = new Map(retrieval.candidates.map((c) => [c.candidateId, c]));
  checkDeadline('post-retrieval');

  // ----- request-scoped profile fit (structured only; affects fit, not facts) -----
  const profileDeltaByCandidate = new Map<string, number>();
  const profileEvidenceByCandidate = new Map<string, import('../domain/ids.js').EvidenceRef[]>();
  let profileApplied = false;
  if (request.profileInput !== undefined) {
    const allowed = request.allowedProfileTermRefs ?? new Set<string>();
    const minimized = await processProfileRequest(request.profileInput, {
      allowedTermRefs: allowed,
    });
    if (minimized.status === 'minimized') {
      // Evidence-backed terms only: minimized draft roleHints + capabilities
      // termIds. A candidate is profile-applied ONLY when a term overlaps its
      // derived role families or requirement capabilities (measurable fit).
      const terms = new Set<string>();
      for (const f of minimized.draft.roleHints) terms.add(f.term.termId.toLowerCase());
      for (const f of minimized.draft.capabilities) terms.add(f.term.termId.toLowerCase());
      let anyApplied = false;
      for (const a of assembled) {
        const posting = a.posting;
        if (!posting) continue;
        const families = posting.roleFamilies.map((r) => r.family.toLowerCase());
        const caps = posting.requirements.flatMap((r) =>
          r.semanticCapability !== undefined && r.semanticCapability.length > 0
            ? [r.semanticCapability.toLowerCase()]
            : [],
        );
        const hay = [...families, ...caps];
        const hit =
          terms.size > 0 &&
          hay.some((h) => [...terms].some((t) => t.length > 2 && (h.includes(t) || t.includes(h))));
        if (hit) {
          anyApplied = true;
          profileDeltaByCandidate.set(a.acquisitionCandidate.candidateId, 0.05);
          // Request-scoped user_statement evidence id from the minimized draft.
          const evId = minimized.evidence[0]?.evidenceId;
          if (evId !== undefined)
            profileEvidenceByCandidate.set(a.acquisitionCandidate.candidateId, [
              evId as import('../domain/ids.js').EvidenceRef,
            ]);
        } else {
          profileDeltaByCandidate.set(a.acquisitionCandidate.candidateId, 0);
        }
      }
      profileApplied = anyApplied;
    }
  }

  // ----- assessment: utility/coverage/confidence/eligibility separate -----
  const explicitKeys: readonly ResidualFeatureKey[] = request.explicitPreferenceKeys ?? [];
  const residual = request.learnedResidual ?? zeroResidual(nowIso());
  // (7) No silent drops: every assembled candidate belongs to exactly one
  // unit; every unit is assessed, ranked, and either emitted or reported with
  // an explicit reason. Posting-null units are the only exclusion, surfaced
  // as withheld_error results below.
  const assessed = units
    .map((u) => {
      const posting = unitPosting(u);
      if (!posting) {
        warnings.push(`withheld_error:${u.key}:missing posting projection`);
        return null;
      }
      // Aggregate pages are discovery artifacts, not postings. Withhold the
      // unit with an explicit warning (never silent; never NO_CANDIDATES —
      // that error means true zero acquisition, not all-withheld).
      const unitAggregate = u.members.some((m) => {
        if (m.acquisitionCandidate.caveats.includes('aggregate_search_page')) return true;
        const dest = (
          m.acquisitionCandidate.provenance as unknown as {
            destination?: { canonicalUrl?: string };
          }
        ).destination?.canonicalUrl;
        return dest !== undefined && classifyListingUrl(dest) === 'aggregate';
      });
      if (unitAggregate) {
        warnings.push(`aggregate_page_withheld:${u.key}`);
        return null;
      }
      const retrievalMeta = retrievalById.get(u.key);
      // Learned residual -> personalAdaptation delta; explicit keys excluded inside.
      const familySlug = (posting.roleFamilies[0]?.family ?? 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9._:/-]/g, '');
      const candidateKeys: ResidualFeatureKey[] = [];
      const addKey = (dimension: ResidualFeatureKey['dimension'], value: string): void => {
        const normalized = value.trim().toLowerCase();
        if (normalized.length === 0 || !/^[a-z0-9][a-z0-9._:/-]*$/u.test(normalized)) return;
        candidateKeys.push({ dimension, value: normalized });
      };
      if (familySlug.length > 0 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(familySlug)) {
        addKey('role', familySlug);
      }
      addKey('work_mode', posting.workMode);
      addKey('employment_type', posting.employmentType);
      addKey('sector', posting.sector ?? 'unknown');
      for (const location of posting.locations) {
        addKey('location', location.city ?? location.region ?? location.country ?? 'unknown');
      }
      addKey('compensation_band', posting.salaries.length > 0 ? 'meets_min' : 'unknown_comp');
      // mixed_upgradeable ONLY when indexed + observation evidence coexist in
      // the unit. Merged observation-only groups stay observation_backed.
      const unitOrigins = new Set(u.members.flatMap((m) => [...m.origins]));
      const firstState: JobsSearchEvidenceState = u.members[0]?.evidenceState ?? 'indexed_only';
      const unitState: JobsSearchEvidenceState = u.members.every(
        (m) => m.evidenceState === 'indexed_only',
      )
        ? 'indexed_only'
        : u.members.some((m) => m.evidenceState === 'user_supplied')
          ? 'user_supplied'
          : unitOrigins.has('indexed') && unitOrigins.has('observed')
            ? 'mixed_upgradeable'
            : firstState;
      const grouped = {
        relevance: 0.5,
        candidateFit: 0.5,
        preferenceFit: 0.5,
        marketState: 0.5,
        evidenceQuality: unitState === 'indexed_only' ? 0.3 : 0.5,
        personalAdaptation: 0.5,
      };
      const withLearned = applyLearnedResidual({
        grouped,
        residual,
        candidateFeatureKeys: candidateKeys,
        explicitPreferenceKeys: explicitKeys,
      });
      const memberDeltas = u.members.map(
        (m) => profileDeltaByCandidate.get(m.acquisitionCandidate.candidateId) ?? 0,
      );
      const profileDelta = Math.max(0, ...memberDeltas);
      const profileEvidence: import('../domain/ids.js').EvidenceRef[] = [];
      if (profileDelta > 0) {
        for (const m of u.members) {
          const refs = profileEvidenceByCandidate.get(m.acquisitionCandidate.candidateId);
          if (
            refs !== undefined &&
            (profileDeltaByCandidate.get(m.acquisitionCandidate.candidateId) ?? 0) === profileDelta
          ) {
            profileEvidence.push(...refs);
            break;
          }
        }
      }
      // withLearned.personalAdaptation is the learned delta itself (dot of
      // residual features, 0 when no residual): add profile fit directly.
      // (Previous form subtracted 0.5, collapsing every run to the -0.1 floor
      // and erasing any measurable profile effect.)
      const personalDelta = Math.max(
        -0.1,
        Math.min(0.1, withLearned.personalAdaptation + profileDelta),
      );
      const result = assessCandidate({
        posting,
        intent,
        ...(retrievalMeta !== undefined
          ? {
              retrievalMetadata: {
                rrfRank: retrievalMeta.rrfRank,
                rrfScore: retrievalMeta.rrfScore,
                scoredChannelCount: retrievalMeta.scoredChannelCount,
              },
            }
          : {}),
        personalAdaptationDelta: personalDelta,
        ...(profileEvidence.length > 0 ? { personalAdaptationEvidenceRefs: profileEvidence } : {}),
        ...(request.groupWeights !== undefined ? { groupWeights: request.groupWeights } : {}),
        nowMs,
      });
      return { unit: u, posting, unitState, assessment: result };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  checkDeadline('post-assessment');

  // ----- ranking: utility sort only; RRF never enters utility -----
  const rankingInput = {
    runId,
    emittedAt: nowIso(),
    assessments: assessed.map(({ unit: u, assessment }) => {
      const groupScores = {} as Record<ScoreGroup, number>;
      for (const g of assessment.groups) {
        groupScores[g.group] = g.score;
      }
      return {
        candidateId: u.key,
        utilityScore: assessment.utilityScore,
        groupScores,
        eligibilityStatus: assessment.eligibility.status,
        flags: assessment.flags,
      };
    }),
    ...(request.groupWeights !== undefined ? { groupWeights: request.groupWeights } : {}),
    topK: intent.topK,
  };
  const ranked = rankCandidates(rankingInput);
  checkDeadline('post-ranking');

  // Selected pack versions propagate into reasoning provenance + output
  // versions. Generic core contributes none when no packs are selected.
  const selectedPackVersions: string[] = [
    ...(request.localePack !== undefined
      ? [`locale:${request.localePack.id}:${request.localePack.version}`]
      : []),
    ...(request.domainPack !== undefined
      ? [`domain:${request.domainPack.id}:${request.domainPack.version}`]
      : []),
  ];

  // ----- optional bounded reasoning fallback (never overwrites facts) -----
  let reasoningFallbackVersion: string | undefined;
  let reasoningAdvisory: import('../reasoning/contracts.js').ReasoningRunResult | undefined;
  if (request.reasoningBudget !== undefined && request.reasoningBudget > 0) {
    try {
      // Reasoning is bounded fallback only: packet carries ranked views with
      // grouped utility + coverage/confidence, never raw profile material.
      // Skip reasoning when no observation-backed posting exists to describe.
      const packetCandidates = ranked.candidates.slice(0, 5).flatMap((c) => {
        const found = assessed.find((x) => x.unit.key === c.candidateId);
        const posting = found?.posting;
        if (!posting) return [];
        const groups = found.assessment.groups;
        const grouped = {
          relevance: groups.find((g) => g.group === 'relevance')?.score ?? 0.5,
          candidateFit: groups.find((g) => g.group === 'candidateFit')?.score ?? 0.5,
          preferenceFit: groups.find((g) => g.group === 'preferenceFit')?.score ?? 0.5,
          marketState: groups.find((g) => g.group === 'marketState')?.score ?? 0.5,
          evidenceQuality: groups.find((g) => g.group === 'evidenceQuality')?.score ?? 0.5,
          personalAdaptation: groups.find((g) => g.group === 'personalAdaptation')?.score ?? 0.5,
        };
        const coverages = groups.map((g) => g.coverageRatio);
        const coverage =
          coverages.length > 0 ? coverages.reduce((x, y) => x + y, 0) / coverages.length : 0;
        return [
          {
            postingId: posting.postingId,
            canonicalRevision: posting.canonicalRevision,
            identityDecisionRevision: posting.identityDecisionRevision,
            title: posting.title.slice(0, 200),
            organisation: posting.organisation.slice(0, 200),
            normalizedTitle: posting.normalizedTitle.slice(0, 200),
            workMode: posting.workMode,
            employmentType: posting.employmentType,
            expectedUtility: c.utilityScore,
            evidenceCoverage: coverage,
            confidence:
              found.assessment.groups.length > 0
                ? Math.min(
                    ...found.assessment.groups.flatMap((g) =>
                      g.components.map((component) => component.confidence),
                    ),
                  )
                : 0.3,
            grouped,
            flags: [...new Set([...posting.flags, ...c.flags])].flatMap((flag) =>
              JobFlagSchema.safeParse(flag).success ? [flag as JobPosting['flags'][number]] : [],
            ),
            evidenceRefs: [
              ...new Set([
                ...found.unit.evidenceRefs,
                ...found.unit.extractionEvidenceRefs,
                ...(found.unit.identityDecision?.contradictoryEvidenceRefs ?? []),
                ...(found.unit.identityDecision?.featureContributions.flatMap(
                  (f) => f.evidenceRefs,
                ) ?? []),
              ]),
            ].slice(0, 32) as import('../domain/ids.js').EvidenceRef[],
            rank: c.rank,
          },
        ];
      });
      if (packetCandidates.length > 0) {
        const packet = buildReasoningPacket({
          runId,
          rankingRevision: 'seam/1',
          rankingVersion: ASSESSMENT_CONTRACT_VERSION,
          packVersions: selectedPackVersions,
          intent: {
            strictness: intent.strictness,
            unknownPolicy: intent.unknownPolicy,
            topK: intent.topK,
            budgets: intent.budgets,
          },
          candidates: packetCandidates,
          questions: [],
          excerpts: assessed
            .filter((x) =>
              packetCandidates.some((candidate) => candidate.postingId === x.posting.postingId),
            )
            .flatMap((x) =>
              x.unit.members
                .flatMap((member) => member.extraction?.evidence ?? [])
                .flatMap((evidence) =>
                  evidence.boundedExcerpt !== undefined
                    ? [
                        {
                          evidenceId: evidence.evidenceId,
                          kind: evidence.kind,
                          ...(evidence.fieldPath !== undefined
                            ? { fieldPath: evidence.fieldPath }
                            : {}),
                          excerpt: evidence.boundedExcerpt.slice(0, 400),
                        },
                      ]
                    : [],
                ),
            )
            .slice(0, 16),
          now: capturedAt,
        });
        const outcome = await runOptionalReasoning({
          packet,
          provider: request.reasoningProvider,
          reasoningBudget: request.reasoningBudget,
          store: deps.idempotencyStore ?? createIdempotencyStore(),
          signal: request.abortSignal,
          now: capturedAt,
        });
        reasoningFallbackVersion = outcome.status;
        reasoningAdvisory = outcome;
      } else {
        reasoningFallbackVersion = 'skipped_no_candidates';
      }
    } catch {
      reasoningFallbackVersion = 'fallback_failed_isolated';
    }
  }

  // ----- output assembly: separate utility/coverage/confidence/eligibility -----
  const finalCandidates: JobsSearchCandidate[] = ranked.candidates.map((rc) => {
    const found = assessed.find((x) => x.unit.key === rc.candidateId);
    if (!found) throw new JobsSearchError('ACQUISITION_FAILED', 'ranking/assessment mismatch');
    const { unit: u, posting: unitPostingVal, unitState, assessment } = found;
    const retrievalMeta = retrievalById.get(rc.candidateId);
    const coverages = assessment.groups.map((g) => g.coverageRatio);
    const coverage =
      coverages.length > 0 ? coverages.reduce((x, y) => x + y, 0) / coverages.length : 0;
    const confidences = assessment.groups.flatMap((g) => g.components.map((c) => c.confidence));
    const confidence = confidences.length > 0 ? Math.min(...confidences) : 0.3;
    const groupScores = {} as JobsSearchCandidate['groupScores'];
    for (const g of assessment.groups) {
      groupScores[g.group] = g.score;
    }
    // Unknown eligibility is NOT contradiction: surface as conditionally_eligible
    // only when assessor says so; never upgrade ineligible.
    const mergedSuffix =
      u.members.length > 1 ? [`merged:${String(u.members.length)}_observations`] : [];
    return {
      candidateId: rc.candidateId,
      evidenceState: unitState,
      utility: assessment.utilityScore,
      coverage,
      confidence,
      eligibility: assessment.eligibility.status,
      eligibilityGates: assessment.eligibility.gates.map((g) => ({
        gateId: g.gateId,
        status: g.status,
        reason: g.reason,
      })),
      groupScores,
      retrievalMetadata: {
        rrfRank: retrievalMeta?.rrfRank ?? null,
        rrfScore: retrievalMeta?.rrfScore ?? null,
        scoredChannelCount: retrievalMeta?.scoredChannelCount ?? 0,
        textBm25Score: retrievalMeta?.channelScores.text_bm25 ?? null,
      },
      flags: [...rc.flags, ...u.extractionWarnings].slice(0, 16),
      caveats: [
        ...(unitState === 'indexed_only'
          ? ['indexed_only: snippet-backed; upgrade requires authoritative fetch']
          : unitState === 'user_supplied'
            ? ['user_supplied: unverified manual content']
            : unitState === 'mixed_upgradeable'
              ? mergedSuffix
              : [...mergedSuffix]),
        ...new Set(u.members.flatMap((m) => m.acquisitionCandidate.caveats)),
      ].slice(0, 16),
      evidenceRefs: [
        ...new Set([
          ...u.evidenceRefs,
          ...u.extractionEvidenceRefs,
          ...(u.identityDecision?.contradictoryEvidenceRefs ?? []),
          ...(u.identityDecision?.featureContributions.flatMap((c) => c.evidenceRefs) ?? []),
        ]),
      ].slice(0, 128),
      provenance: [...new Set(u.origins)].slice(0, 8),
      sourceListingIds: u.sourceListingIds.slice(0, 16),
      observationIds: u.observationIds.slice(0, 16),
      title: unitPostingVal.title,
      organisation: unitPostingVal.organisation,
      // Provenance locator fields: additive, omitted when absent.
      // listingUrl = canonical posting URL (apply/inspect locator, never
      // evidence text). description placeholder is never copied to output.
      ...(() => {
        const envelopeUrls = u.members.flatMap((m) =>
          m.envelopes
            .map((e) => e.listing.canonicalUrl)
            .filter((x): x is string => typeof x === 'string' && x.length > 0),
        );
        const destinationUrls = u.members.flatMap((m) => {
          const dest = (
            m.acquisitionCandidate.provenance as unknown as {
              destination?: { canonicalUrl?: string };
            }
          ).destination?.canonicalUrl;
          return dest !== undefined ? [dest] : [];
        });
        const listingUrl = unitPostingVal.listingUrls[0] ?? envelopeUrls[0] ?? destinationUrls[0];
        const applyUrl = unitPostingVal.applyUrl;
        const loc = unitPostingVal.locations.find(
          (l) => l.city !== undefined || l.region !== undefined || l.country !== undefined,
        );
        const location = loc
          ? [loc.city, loc.region, loc.country].filter((p) => p !== undefined).join(', ')
          : undefined;
        const salaryText = unitPostingVal.salaries[0]?.raw;
        const rawDescription = unitPostingVal.description;
        const description =
          rawDescription === 'Indexed snippet only; no observation fetched.' ||
          rawDescription === 'No description available.'
            ? undefined
            : rawDescription.slice(0, 2048);
        return {
          ...(listingUrl !== undefined ? { listingUrl } : {}),
          ...(applyUrl !== undefined ? { applyUrl } : {}),
          ...(location !== undefined && location.length > 0 ? { location } : {}),
          ...(salaryText !== undefined ? { salaryText } : {}),
          ...(description !== undefined ? { description } : {}),
        };
      })(),
      ...(u.identityDecision?.decisionId !== undefined
        ? { identityDecisionId: u.identityDecision.decisionId }
        : {}),
      identityDecisionRevision:
        u.identityDecision?.decisionId ?? unitPostingVal.identityDecisionRevision,
      profileApplied:
        profileApplied &&
        u.members.some(
          (m) =>
            profileDeltaByCandidate.get(m.acquisitionCandidate.candidateId) !== 0 &&
            profileDeltaByCandidate.has(m.acquisitionCandidate.candidateId),
        ),
      rank: rc.rank,
    };
  });

  const eligibilitySummary: Record<'eligible' | 'conditionally_eligible' | 'ineligible', number> = {
    eligible: 0,
    conditionally_eligible: 0,
    ineligible: 0,
  };
  for (const c of finalCandidates) eligibilitySummary[c.eligibility] += 1;

  const status: JobsSearchResult['status'] =
    acquisition.status === 'completed'
      ? coverageOutcomes.some((o) => o.state === 'failed' || o.state === 'partial')
        ? 'partial'
        : 'completed'
      : acquisition.status === 'budget_exhausted'
        ? 'budget_exhausted'
        : acquisition.status === 'deadline_exceeded'
          ? 'deadline_exceeded'
          : 'aborted';

  const result = {
    schemaVersion: JOBS_SEARCH_CONTRACT_VERSION,
    runId,
    status,
    candidates: finalCandidates.slice(0, 100),
    coverageOutcomes: coverageOutcomes.slice(0, 100),
    acquisitionStatus: acquisition.status,
    warnings: warnings.slice(0, 100),
    ...(reasoningAdvisory !== undefined ? { reasoningAdvisory } : {}),
    eligibilitySummary,
    versions: {
      contractVersion: JOBS_SEARCH_CONTRACT_VERSION,
      acquisitionVersion: ACQUISITION_COORDINATOR_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      identityResolverVersion: IDENTITY_RESOLVER_VERSION,
      retrievalVersion: RETRIEVAL_CONTRACT_VERSION,
      assessmentVersion: ASSESSMENT_CONTRACT_VERSION,
      rankingVersion: ASSESSMENT_CONTRACT_VERSION,
      ...(reasoningFallbackVersion !== undefined
        ? { reasoningFallback: reasoningFallbackVersion }
        : {}),
      packVersions: selectedPackVersions,
    },
  };
  try {
    return JobsSearchResultSchema.parse(result);
  } catch {
    throwValidation('result schema violation');
  }
}

export type { JobsSearchDeps, JobsSearchRequest, JobsSearchResult };
export { JobsSearchError };
export { JOBS_SEARCH_CONTRACT_VERSION as JOBS_SEARCH_VERSION };
export type { ScoreGroup };
export { DEFAULT_GROUP_WEIGHTS };
export { canonicalKey };
