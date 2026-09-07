import type { ClaimCandidate } from '../domain/claims.js';
import type { JobFlag } from '../domain/posting.js';
import { resolveClaim } from '../domain/claims.js';
import { deterministicEnrichmentId } from './ids.js';
import type { EnrichmentWarning, ExtractedFieldSnapshot } from './contracts.js';
import type { QualitySignal } from './contracts.js';

const HOT_FIELDS = [
  'title',
  'organisation',
  'locations',
  'salaries',
  'classifications',
  'requirements',
  'workMode',
  'employmentType',
] as const;

export interface QualityEnrichmentResult {
  readonly qualitySignals: QualitySignal[];
  readonly flags: JobFlag[];
  readonly warnings: EnrichmentWarning[];
}

function hasEvidenceForField(snapshot: ExtractedFieldSnapshot, field: string): boolean {
  return snapshot.fieldEvidenceLinks.some((link) => link.fieldPath === field);
}

export function deriveQualitySignals(
  snapshot: ExtractedFieldSnapshot,
  derivedClaims: readonly ClaimCandidate<unknown>[],
  employerMatch: 'exact' | 'alias' | 'none' | 'ambiguous',
  classificationsExist: boolean,
  clock: { producedAt: string },
): QualityEnrichmentResult {
  const signals: QualitySignal[] = [];
  const flags: JobFlag[] = [];
  const warnings: EnrichmentWarning[] = [];

  // evidence_coverage: min(1, evidencedHotFields / 8)
  let evidencedHotFields = 0;
  for (const field of HOT_FIELDS) {
    if (hasEvidenceForField(snapshot, field)) {
      evidencedHotFields += 1;
    }
  }
  signals.push({
    signalId: deterministicEnrichmentId('quality', ['evidence_coverage', clock.producedAt]),
    name: 'evidence_coverage',
    value: Math.min(1, evidencedHotFields / 8),
    flags: [],
    evidenceRefs: [],
    notes: [],
  });

  // source_verification
  const hasHighConfidenceStructured = snapshot.evidence.some(
    (e) => e.confidence >= 0.8 && e.kind === 'structured_field',
  );
  const hasAnyEvidence = snapshot.evidence.length > 0;
  signals.push({
    signalId: deterministicEnrichmentId('quality', ['source_verification', clock.producedAt]),
    name: 'source_verification',
    value: hasHighConfidenceStructured ? 1 : hasAnyEvidence ? 0.5 : 0,
    flags: [],
    evidenceRefs: [],
    notes: [],
  });

  // junk_or_non_job_intent
  const junkValue = !snapshot.title && (snapshot.requirements?.length ?? 0) === 0 ? 1 : 0;
  signals.push({
    signalId: deterministicEnrichmentId('quality', ['junk_or_non_job_intent', clock.producedAt]),
    name: 'junk_or_non_job_intent',
    value: junkValue,
    flags: [],
    evidenceRefs: [],
    notes: [],
  });

  // conflicting_claims
  const allClaims = [...snapshot.claimCandidates, ...derivedClaims];
  const fieldGroups = new Map<string, ClaimCandidate<unknown>[]>();
  for (const claim of allClaims) {
    const key = (claim as { method?: string }).method ?? 'unknown';
    if (!fieldGroups.has(key)) fieldGroups.set(key, []);
    fieldGroups.get(key)?.push(claim);
  }
  let hasConflict = false;
  for (const [, group] of fieldGroups) {
    const resolved = resolveClaim(group);
    if (resolved.state === 'conflicting') {
      hasConflict = true;
      break;
    }
  }
  if (hasConflict) {
    flags.push('conflicting_source_evidence');
  }
  signals.push({
    signalId: deterministicEnrichmentId('quality', ['conflicting_claims', clock.producedAt]),
    name: 'conflicting_claims',
    value: hasConflict ? 1 : 0,
    flags: hasConflict ? ['conflicting_source_evidence'] : [],
    evidenceRefs: [],
    notes: [],
  });

  // missing_salary
  signals.push({
    signalId: deterministicEnrichmentId('quality', ['missing_salary', clock.producedAt]),
    name: 'missing_salary',
    value: !snapshot.salaries || snapshot.salaries.length === 0 ? 1 : 0,
    flags: [],
    evidenceRefs: [],
    notes: [],
  });

  // missing_classification
  signals.push({
    signalId: deterministicEnrichmentId('quality', ['missing_classification', clock.producedAt]),
    name: 'missing_classification',
    value: classificationsExist ? 0 : 1,
    flags: [],
    evidenceRefs: [],
    notes: [],
  });

  // missing_employer_verification
  const employerMissing = employerMatch === 'none' || employerMatch === 'ambiguous';
  signals.push({
    signalId: deterministicEnrichmentId('quality', [
      'missing_employer_verification',
      clock.producedAt,
    ]),
    name: 'missing_employer_verification',
    value: employerMissing ? 1 : 0,
    flags: [],
    evidenceRefs: [],
    notes: [],
  });

  // registration_gap
  const hasRegistrationReq = snapshot.requirements?.some((r) => r.category === 'registration');
  const clinicalTokens = ['nurse', 'medical', 'clinical', 'practitioner'];
  const titleLower = (snapshot.title ?? '').toLocaleLowerCase();
  const hasClinicalToken = clinicalTokens.some((t) => titleLower.includes(t));
  const registrationGap = hasClinicalToken && !hasRegistrationReq;
  if (registrationGap) {
    flags.push('registration_not_evidenced');
  }
  signals.push({
    signalId: deterministicEnrichmentId('quality', ['registration_gap', clock.producedAt]),
    name: 'registration_gap',
    value: registrationGap ? 1 : 0,
    flags: registrationGap ? ['registration_not_evidenced'] : [],
    evidenceRefs: [],
    notes: [],
  });

  // identified_position
  const identified = snapshot.targetedPosition === true;
  if (identified) {
    flags.push('identified_position_requirement', 'eligibility_unknown');
  }
  signals.push({
    signalId: deterministicEnrichmentId('quality', ['identified_position', clock.producedAt]),
    name: 'identified_position',
    value: identified ? 1 : 0,
    flags: identified ? ['identified_position_requirement', 'eligibility_unknown'] : [],
    evidenceRefs: [],
    notes: [],
  });

  return { qualitySignals: signals, flags, warnings };
}
