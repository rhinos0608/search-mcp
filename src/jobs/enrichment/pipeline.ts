import type { ClaimCandidate } from '../domain/claims.js';
import { EnrichmentError } from './errors.js';
import { deterministicEnrichmentId } from './ids.js';
import { enrichListing } from './listing.js';
import { interpretAttachments } from './attachment.js';
import { interpretFramework } from './framework.js';
import { enrichEmployer } from './employer.js';
import { normalizeSalary } from './salary.js';
import { mapClassification } from './classification.js';
import { deriveQualitySignals } from './quality.js';
import type { EnrichmentRequest, EnrichmentResult, EnrichmentWarning } from './contracts.js';
import { EnrichmentRequestSchema, EnrichmentResultSchema } from './contracts.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function enrichKnowledge(input: unknown): EnrichmentResult {
  // 1. Parse request
  let req: EnrichmentRequest;
  try {
    req = EnrichmentRequestSchema.parse(input);
  } catch {
    throw new EnrichmentError('VALIDATION_ERROR', 'invalid enrichment request');
  }

  // 2. immutable guaranteed by schema (z.literal(true))

  // 3. Require packs check
  if (req.requirePacks && !req.localePack && !req.domainPack) {
    throw new EnrichmentError('PACK_UNAVAILABLE', 'required pack unavailable');
  }

  // 4. Deep-copy snapshot (immutable input contract)
  const snapshot = { ...req.snapshot };
  const warnings: EnrichmentWarning[] = [];
  const allDerivedClaimCandidates: ClaimCandidate<unknown>[] = [];
  const allDerivedEvidence: unknown[] = [];
  const allFlags: string[] = [];
  let unitsConsumed = 0;
  const budget = req.budget.units;
  const allRoleFamilies: { family: string; confidence: number; evidenceRefs: string[] }[] = [];

  // 5. Listing enrichment
  if (unitsConsumed < budget) {
    unitsConsumed += 1;
    const listingResult = enrichListing(snapshot, req.localePack, req.domainPack, req.clock);
    allDerivedClaimCandidates.push(...listingResult.derivedClaimCandidates);
    allDerivedEvidence.push(...listingResult.derivedEvidence);
    allRoleFamilies.push(...listingResult.roleFamilies);
    warnings.push(...listingResult.warnings);
  }

  // 6. Attachment enrichment
  const attachmentEvidence = snapshot.evidence.filter((e) => e.kind === 'attachment');
  const fingerprints = new Set<string>();
  for (const ev of attachmentEvidence) {
    if (unitsConsumed >= budget) break;
    const fp = ev.documentFingerprint;
    if (fp && !fingerprints.has(fp)) {
      fingerprints.add(fp);
      unitsConsumed += 1;
    } else if (!fp) {
      unitsConsumed += 1;
    }
  }
  if (unitsConsumed <= budget || !attachmentEvidence.length) {
    const attachmentResult = interpretAttachments(snapshot, req.clock);
    allDerivedEvidence.push(...attachmentResult.derivedEvidence);
    warnings.push(...attachmentResult.warnings);
  }

  // 7. Framework enrichment
  const frameworkClassifications = snapshot.classifications ?? [];
  for (const _cls of frameworkClassifications) {
    if (unitsConsumed >= budget) break;
    unitsConsumed += 1;
  }
  if (unitsConsumed <= budget || !frameworkClassifications.length) {
    const frameworkResult = interpretFramework(snapshot, req.localePack, req.clock);
    allFlags.push(...frameworkResult.flags);
    warnings.push(...frameworkResult.warnings);
  }

  // 8. Employer enrichment
  if (snapshot.organisation && unitsConsumed < budget) {
    unitsConsumed += 1;
  }
  const employerResult = enrichEmployer(snapshot, req.employerCatalog, req.clock);
  warnings.push(...employerResult.warnings);
  if (
    req.requireVerifiedEmployer &&
    employerResult.employerMatch.match !== 'exact' &&
    employerResult.employerMatch.match !== 'alias'
  ) {
    throw new EnrichmentError('UNVERIFIED_EMPLOYER', 'employer not verified');
  }

  // 9. Salary normalization
  const salaries = snapshot.salaries ?? [];
  const salaryResult = normalizeSalary(salaries, req.localePack);
  for (const _s of salaryResult.stated) {
    if (unitsConsumed >= budget) break;
    unitsConsumed += 1;
  }
  warnings.push(...salaryResult.warnings);

  // 10. Classification mapping
  const clsResult = mapClassification(snapshot.classifications ?? [], req.localePack);
  for (const _c of snapshot.classifications ?? []) {
    if (unitsConsumed >= budget) break;
    unitsConsumed += 1;
  }
  warnings.push(...clsResult.warnings);

  // 11. Quality signals
  if (unitsConsumed < budget) {
    unitsConsumed += 1;
    const qualityResult = deriveQualitySignals(
      snapshot,
      allDerivedClaimCandidates,
      employerResult.employerMatch.match,
      clsResult.mapped.length + clsResult.unmapped.length > 0,
      req.clock,
    );
    allFlags.push(...qualityResult.flags);
    warnings.push(...qualityResult.warnings);

    // Check budget exhaustion
    if (unitsConsumed >= budget) {
      warnings.push({ code: 'BUDGET_EXHAUSTED' });
    }

    // Determine status
    let status: EnrichmentResult['status'];
    if (
      !req.localePack &&
      !req.domainPack &&
      !req.employerCatalog &&
      allDerivedClaimCandidates.length === 0
    ) {
      status = 'pass_through';
    } else if (warnings.some((w) => w.code === 'BUDGET_EXHAUSTED')) {
      status = 'partial';
    } else if (employerResult.employerMatch.match === 'none' || clsResult.unmapped.length > 0) {
      status = 'partial';
    } else {
      status = 'complete';
    }

    // Build pack versions
    const packVersions: string[] = [];
    if (req.localePack) {
      packVersions.push(`locale:${req.localePack.id}:${req.localePack.version}`);
    }
    if (req.domainPack) {
      packVersions.push(`domain:${req.domainPack.id}:${req.domainPack.version}`);
    }

    // Build enrichmentId
    const enrichmentId = deterministicEnrichmentId('record', [
      req.snapshot.observationId,
      req.snapshot.sourceListingId,
      packVersions.join(','),
      req.snapshot.extractorVersion,
    ]);

    // Build field evidence links from snapshot + derived
    const fieldEvidenceLinks = [...snapshot.fieldEvidenceLinks];

    const result: EnrichmentResult = {
      schemaVersion: '1.0.0',
      enrichmentId,
      status,
      observationId: req.snapshot.observationId,
      sourceListingId: req.snapshot.sourceListingId,
      packVersions,
      derivedClaimCandidates: allDerivedClaimCandidates,
      derivedEvidence: allDerivedEvidence as never[],
      fieldEvidenceLinks,
      salaries: [...salaryResult.stated, ...salaryResult.annualized],
      classifications: [...clsResult.mapped],
      roleFamilies: [...allRoleFamilies],
      employer: {
        employerRecordId: employerResult.employerMatch.employerRecordId,
        legalName: employerResult.employerMatch.legalName,
        sector: employerResult.employerMatch.sector,
        organisationUnit: employerResult.employerMatch.organisationUnit,
        match: employerResult.employerMatch.match,
        evidenceRefs: employerResult.employerMatch.evidenceRefs,
      },
      requirementsInterpreted: snapshot.requirements ?? [],
      flags: allFlags as never[],
      qualitySignals: qualityResult.qualitySignals,
      warnings,
      budgetRemaining: Math.max(0, budget - unitsConsumed),
      unitsConsumed,
    };

    return deepFreeze(EnrichmentResultSchema.parse(result));
  }

  // Budget exhausted before quality stage
  warnings.push({ code: 'BUDGET_EXHAUSTED' });
  const packVersions: string[] = [];
  if (req.localePack) {
    packVersions.push(`locale:${req.localePack.id}:${req.localePack.version}`);
  }
  if (req.domainPack) {
    packVersions.push(`domain:${req.domainPack.id}:${req.domainPack.version}`);
  }
  const enrichmentId = deterministicEnrichmentId('record', [
    req.snapshot.observationId,
    req.snapshot.sourceListingId,
    packVersions.join(','),
    req.snapshot.extractorVersion,
  ]);

  const partialResult: EnrichmentResult = {
    schemaVersion: '1.0.0',
    enrichmentId,
    status: 'partial',
    observationId: req.snapshot.observationId,
    sourceListingId: req.snapshot.sourceListingId,
    packVersions,
    derivedClaimCandidates: allDerivedClaimCandidates,
    derivedEvidence: allDerivedEvidence as never[],
    fieldEvidenceLinks: [...snapshot.fieldEvidenceLinks],
    salaries: [...salaryResult.stated, ...salaryResult.annualized],
    classifications: [...clsResult.mapped],
    roleFamilies: [...allRoleFamilies],
    employer: {
      employerRecordId: employerResult.employerMatch.employerRecordId,
      legalName: employerResult.employerMatch.legalName,
      sector: employerResult.employerMatch.sector,
      organisationUnit: employerResult.employerMatch.organisationUnit,
      match: employerResult.employerMatch.match,
      evidenceRefs: employerResult.employerMatch.evidenceRefs,
    },
    requirementsInterpreted: snapshot.requirements ?? [],
    flags: allFlags as never[],
    qualitySignals: [],
    warnings,
    budgetRemaining: 0,
    unitsConsumed,
  };

  return deepFreeze(EnrichmentResultSchema.parse(partialResult));
}
