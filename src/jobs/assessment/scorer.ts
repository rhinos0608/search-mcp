/**
 * W9 Assessment — component scoring.
 *
 * Each group has component scorers that produce ComponentScore entries.
 * Missing evidence → stable 0.5, coverage/confidence falls.
 * No weight redistribution. No LLM, no network.
 */

import type { JobPosting } from '../domain/posting.js';
import type { SearchIntent } from '../domain/intent.js';
import type { EvidenceRef } from '../domain/ids.js';
import type {
  AssessmentGroup,
  ComponentScore,
  ScoreGroup,
  PersonalAdaptationDelta,
  EligibilityVerdict,
  EligibilityGate,
  EligibilityStatus,
} from './contracts.js';
import { DEFAULT_GROUP_WEIGHTS, SCORE_GROUPS, W11_DELTA_RANGE } from './contracts.js';

// ---------------------------------------------------------------------------
// Neutral fallback
// ---------------------------------------------------------------------------

const NEUTRAL = 0.5 as const;

function neutralComponent(dimension: string): ComponentScore {
  return {
    dimension,
    score: NEUTRAL,
    hasEvidence: false,
    evidenceRefs: [],
    confidence: 0.3,
  };
}

function evidentiaryComponent(
  dimension: string,
  score: number,
  evidenceRefs: readonly EvidenceRef[],
  confidence: number,
): ComponentScore {
  return {
    dimension,
    score: Math.max(0, Math.min(1, score)),
    hasEvidence: true,
    evidenceRefs: [...evidenceRefs] as EvidenceRef[],
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

// ---------------------------------------------------------------------------
// Relevance components
// ---------------------------------------------------------------------------

function scoreTitleRelevance(posting: JobPosting, intent: SearchIntent): ComponentScore {
  const query = intent.query.toLowerCase();
  const title = posting.normalizedTitle.toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return neutralComponent('titleRelevance');

  const matchCount = tokens.filter((t) => title.includes(t)).length;
  const ratio = matchCount / tokens.length;
  if (ratio === 0) return evidentiaryComponent('titleRelevance', 0, posting.evidenceRefs, 0.3);

  return evidentiaryComponent('titleRelevance', ratio, posting.evidenceRefs, 0.7);
}

function scoreRoleFamilyRelevance(posting: JobPosting, intent: SearchIntent): ComponentScore {
  const intentFamilies = new Set(intent.requestedRoleFamilies.map((f) => f.toLowerCase()));
  if (intentFamilies.size === 0) return neutralComponent('roleFamilyRelevance');

  const postingFamilies = posting.roleFamilies.map((rf) => rf.family.toLowerCase());
  const overlap = postingFamilies.filter((f) => intentFamilies.has(f));

  if (overlap.length === 0) {
    // Check if any posting role family starts with an intent family or vice versa
    const partial = postingFamilies.some((pf) =>
      [...intentFamilies].some((ifam) => pf.includes(ifam) || ifam.includes(pf)),
    );
    if (partial) {
      return evidentiaryComponent('roleFamilyRelevance', 0.3, posting.evidenceRefs, 0.5);
    }
    return neutralComponent('roleFamilyRelevance');
  }

  const bestConfidence = Math.max(
    ...posting.roleFamilies
      .filter((rf) => intentFamilies.has(rf.family.toLowerCase()))
      .map((rf) => rf.confidence),
  );
  return evidentiaryComponent(
    'roleFamilyRelevance',
    0.6 + 0.4 * bestConfidence,
    posting.evidenceRefs,
    0.8,
  );
}

function scoreDescriptionRelevance(posting: JobPosting, intent: SearchIntent): ComponentScore {
  const query = intent.query.toLowerCase();
  const desc = posting.description.toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return neutralComponent('descriptionRelevance');

  const matchCount = tokens.filter((t) => desc.includes(t)).length;
  const ratio = matchCount / tokens.length;
  if (ratio === 0)
    return evidentiaryComponent('descriptionRelevance', 0, posting.evidenceRefs, 0.3);

  return evidentiaryComponent('descriptionRelevance', ratio, posting.evidenceRefs, 0.6);
}

// ---------------------------------------------------------------------------
// CandidateFit components
// ---------------------------------------------------------------------------

function scoreRequirementsFit(_posting: JobPosting): ComponentScore {
  // No candidate profile in AssessmentInput — cannot assess fit.
  return neutralComponent('requirementsFit');
}

function scoreSeniorityFit(_posting: JobPosting, _intent: SearchIntent): ComponentScore {
  // No candidate profile in AssessmentInput — cannot assess fit.
  return neutralComponent('seniorityFit');
}

function scoreEmploymentTypeFit(_posting: JobPosting, _intent: SearchIntent): ComponentScore {
  // No candidate profile in AssessmentInput — cannot assess fit.
  return neutralComponent('employmentTypeFit');
}

// ---------------------------------------------------------------------------
// PreferenceFit components
// ---------------------------------------------------------------------------

function scoreLocationPreference(posting: JobPosting, intent: SearchIntent): ComponentScore {
  if (intent.locations.length === 0) return neutralComponent('locationPreference');

  const intentCountries = new Set(
    intent.locations.map((l) => l.country?.toLowerCase()).filter(Boolean),
  );
  const intentCities = new Set(intent.locations.map((l) => l.city?.toLowerCase()).filter(Boolean));

  const postingLocations = posting.locations;
  const hasKnownLocation = postingLocations.some(
    (loc) =>
      loc.city !== undefined ||
      loc.region !== undefined ||
      loc.country !== undefined ||
      loc.postcode !== undefined ||
      loc.remoteEligible !== undefined,
  );
  // Missing geography is absence of evidence, not a mismatch.
  if (!hasKnownLocation) return neutralComponent('locationPreference');
  for (const loc of postingLocations) {
    if (loc.remoteEligible && intent.locations.some((il) => il.remoteEligible)) {
      return evidentiaryComponent('locationPreference', 0.9, posting.evidenceRefs, 0.8);
    }
    if (loc.city && intentCities.has(loc.city.toLowerCase())) {
      return evidentiaryComponent('locationPreference', 1.0, posting.evidenceRefs, 0.9);
    }
    if (loc.country && intentCountries.has(loc.country.toLowerCase())) {
      return evidentiaryComponent('locationPreference', 0.8, posting.evidenceRefs, 0.7);
    }
  }

  return evidentiaryComponent('locationPreference', 0.2, posting.evidenceRefs, 0.4);
}

function scoreWorkModePreference(posting: JobPosting, intent: SearchIntent): ComponentScore {
  if (intent.workModes.length === 0) return neutralComponent('workModePreference');
  if (intent.workModes.includes('unknown') || posting.workMode === 'unknown')
    return neutralComponent('workModePreference');

  if (intent.workModes.includes(posting.workMode)) {
    return evidentiaryComponent('workModePreference', 0.9, posting.evidenceRefs, 0.8);
  }
  return evidentiaryComponent('workModePreference', 0.2, posting.evidenceRefs, 0.4);
}

function scoreCompensationPreference(posting: JobPosting, intent: SearchIntent): ComponentScore {
  if (intent.compensation.length === 0) return neutralComponent('compensationPreference');
  if (posting.salaries.length === 0) return neutralComponent('compensationPreference');

  // Observed salary + explicit preference overlap only. Units must match and
  // currency must be explicit on both sides; unknown currency never overlaps
  // (honest neutral, never a fabricated default).
  let best = 0;
  let matched = false;
  for (const pref of intent.compensation) {
    const prefCurrency = pref.currency.trim();
    if (prefCurrency.length !== 3) continue;
    for (const sal of posting.salaries) {
      const salCurrency = sal.currency.trim();
      if (salCurrency.length !== 3) continue;
      if (salCurrency.toUpperCase() !== prefCurrency.toUpperCase()) continue;
      if (sal.unit !== pref.unit) continue;
      const overlap = intervalOverlap(sal.min, sal.max, pref.min, pref.max);
      if (overlap !== null && overlap > 0) {
        matched = true;
        best = Math.max(best, overlap);
      }
    }
  }
  if (!matched) return neutralComponent('compensationPreference');
  return evidentiaryComponent('compensationPreference', best, posting.evidenceRefs, 0.7);
}

/** Fractional overlap of the smaller interval covered by the intersection. */
function intervalOverlap(
  aMin: number | undefined,
  aMax: number | undefined,
  bMin: number | undefined,
  bMax: number | undefined,
): number | null {
  const lo = Math.max(aMin ?? Number.NEGATIVE_INFINITY, bMin ?? Number.NEGATIVE_INFINITY);
  const hi = Math.min(aMax ?? Number.POSITIVE_INFINITY, bMax ?? Number.POSITIVE_INFINITY);
  if (hi < lo) return 0;
  const spanA = aMin !== undefined && aMax !== undefined ? aMax - aMin : Number.POSITIVE_INFINITY;
  const spanB = bMin !== undefined && bMax !== undefined ? bMax - bMin : Number.POSITIVE_INFINITY;
  if (spanA <= 0 || spanB <= 0) return 1;
  if (!Number.isFinite(spanA) && !Number.isFinite(spanB)) return 1;
  const intersection = hi - lo;
  const span = Math.min(spanA, spanB);
  if (!Number.isFinite(intersection)) return 1;
  return Math.max(0, Math.min(1, intersection / span));
}

// ---------------------------------------------------------------------------
// MarketState components
// ---------------------------------------------------------------------------

function scoreFreshness(
  posting: JobPosting,
  _intent: SearchIntent,
  nowMs?: number,
): ComponentScore {
  if (!posting.postedAt) return neutralComponent('freshness');

  const posted = new Date(posting.postedAt).getTime();
  const now = nowMs ?? Date.now();
  const ageDays = (now - posted) / (1000 * 60 * 60 * 24);

  // fresher = higher score, 0-30 days = good, 30-90 = moderate, >90 = stale
  let score: number;
  if (ageDays <= 7) score = 1.0;
  else if (ageDays <= 30) score = 0.8;
  else if (ageDays <= 90) score = 0.5;
  else score = 0.2;

  return evidentiaryComponent('freshness', score, posting.evidenceRefs, 0.9);
}

function scoreLifecycleState(posting: JobPosting, _intent: SearchIntent): ComponentScore {
  const state = posting.lifecycleState;
  if (state === 'active') {
    return evidentiaryComponent('lifecycleState', 0.9, posting.evidenceRefs, 0.8);
  }
  if (state === 'probably_closed' || state === 'confirmed_closed' || state === 'expired') {
    return evidentiaryComponent('lifecycleState', 0.1, posting.evidenceRefs, 0.7);
  }
  // discovered, superseded
  return evidentiaryComponent('lifecycleState', 0.5, posting.evidenceRefs, 0.5);
}

function scoreVerificationState(posting: JobPosting, _intent: SearchIntent): ComponentScore {
  const state = posting.verificationState;
  if (state === 'verified') {
    return evidentiaryComponent('verificationState', 0.9, posting.evidenceRefs, 0.9);
  }
  if (state === 'partially_verified') {
    return evidentiaryComponent('verificationState', 0.6, posting.evidenceRefs, 0.6);
  }
  return evidentiaryComponent('verificationState', 0.3, posting.evidenceRefs, 0.3);
}

// ---------------------------------------------------------------------------
// EvidenceQuality components
// ---------------------------------------------------------------------------

function scoreEvidenceCoverage(posting: JobPosting, _intent: SearchIntent): ComponentScore {
  const totalRefs = posting.evidenceRefs.length;
  if (totalRefs === 0) return neutralComponent('evidenceCoverage');

  // More evidence refs → higher coverage, capped at 10
  const score = Math.min(1.0, totalRefs / 10);
  return evidentiaryComponent('evidenceCoverage', score, posting.evidenceRefs, 0.8);
}

function scoreSourceVerification(posting: JobPosting, _intent: SearchIntent): ComponentScore {
  const state = posting.verificationState;
  if (state === 'verified') {
    return evidentiaryComponent('sourceVerification', 1.0, posting.evidenceRefs, 0.9);
  }
  if (state === 'partially_verified') {
    return evidentiaryComponent('sourceVerification', 0.5, posting.evidenceRefs, 0.5);
  }
  return evidentiaryComponent('sourceVerification', 0.2, posting.evidenceRefs, 0.3);
}

function scoreRequirementEvidence(posting: JobPosting, _intent: SearchIntent): ComponentScore {
  const reqs = posting.requirements;
  if (reqs.length === 0) return neutralComponent('requirementEvidence');

  const withEvidence = reqs.filter((r) => r.evidenceRefs.length > 0);
  const ratio = withEvidence.length / reqs.length;
  return evidentiaryComponent(
    'requirementEvidence',
    ratio,
    withEvidence.flatMap((r) => r.evidenceRefs),
    0.5 + 0.3 * ratio,
  );
}

// ---------------------------------------------------------------------------
// PersonalAdaptation components
// ---------------------------------------------------------------------------

function scorePersonalAdaptation(
  _posting: JobPosting,
  _intent: SearchIntent,
  delta: PersonalAdaptationDelta,
): ComponentScore {
  if (delta.appliedDelta === 0 && delta.evidenceRefs.length === 0) {
    return neutralComponent('personalAdaptation');
  }
  const score = Math.max(0, Math.min(1, NEUTRAL + delta.appliedDelta));
  return evidentiaryComponent('personalAdaptation', score, delta.evidenceRefs, 0.6);
}

// ---------------------------------------------------------------------------
// Group aggregators
// ---------------------------------------------------------------------------

function aggregateGroup(group: ScoreGroup, components: ComponentScore[]): AssessmentGroup {
  const totalComponents = components.length;
  const coverage = components.filter((c) => c.hasEvidence).length;
  const coverageRatio = totalComponents > 0 ? coverage / totalComponents : 0;

  // Weighted mean: each component weighted by its confidence
  let weightedSum = 0;
  let totalWeight = 0;
  for (const c of components) {
    weightedSum += c.score * c.confidence;
    totalWeight += c.confidence;
  }
  const score = totalWeight > 0 ? weightedSum / totalWeight : NEUTRAL;

  const evidenceRefs = components.flatMap((c) => c.evidenceRefs);

  return {
    group,
    score: Math.max(0, Math.min(1, score)),
    coverage,
    totalComponents,
    coverageRatio,
    components,
    evidenceRefs,
  };
}

// ---------------------------------------------------------------------------
// Eligibility gates
// ---------------------------------------------------------------------------

function evaluateEligibility(posting: JobPosting, intent: SearchIntent): EligibilityVerdict {
  const gates: EligibilityGate[] = [];

  // Gate: lifecycle state
  if (
    posting.lifecycleState === 'confirmed_closed' ||
    posting.lifecycleState === 'expired' ||
    posting.lifecycleState === 'superseded'
  ) {
    gates.push({
      gateId: 'lifecycle_active',
      status: 'ineligible',
      reason: `posting lifecycle state is ${posting.lifecycleState}`,
      evidenceRefs: posting.evidenceRefs,
    });
  } else if (posting.lifecycleState === 'probably_closed') {
    gates.push({
      gateId: 'lifecycle_active',
      status: 'conditionally_eligible',
      reason: 'posting lifecycle state is probably_closed',
      evidenceRefs: posting.evidenceRefs,
    });
  } else {
    gates.push({
      gateId: 'lifecycle_active',
      status: 'eligible',
      reason: `posting lifecycle state is ${posting.lifecycleState}`,
      evidenceRefs: posting.evidenceRefs,
    });
  }

  // Gate: employment type match. Unknown values are retained unless the
  // caller explicitly requests exclusion of unknown evidence.
  if (intent.employmentTypes.length > 0 && !intent.employmentTypes.includes('unknown')) {
    if (posting.employmentType === 'unknown') {
      if (intent.unknownPolicy === 'exclude') {
        gates.push({
          gateId: 'employment_type_match',
          status: 'ineligible',
          reason: 'employment type unknown and unknownPolicy=exclude',
          evidenceRefs: posting.evidenceRefs,
        });
      }
    } else if (!intent.employmentTypes.includes(posting.employmentType)) {
      gates.push({
        gateId: 'employment_type_match',
        status: 'ineligible',
        reason: `employment type ${posting.employmentType} not in requested types`,
        evidenceRefs: posting.evidenceRefs,
      });
    } else {
      gates.push({
        gateId: 'employment_type_match',
        status: 'eligible',
        reason: 'employment type matches request',
        evidenceRefs: posting.evidenceRefs,
      });
    }
  }

  if (intent.unknownPolicy === 'exclude') {
    const unknownLocation = posting.locations.every(
      (loc) =>
        loc.city === undefined &&
        loc.region === undefined &&
        loc.country === undefined &&
        loc.postcode === undefined &&
        loc.remoteEligible === undefined,
    );
    if (intent.locations.length > 0 && unknownLocation) {
      gates.push({
        gateId: 'location_match',
        status: 'ineligible',
        reason: 'location unknown and unknownPolicy=exclude',
        evidenceRefs: posting.evidenceRefs,
      });
    }
    if (
      intent.workModes.length > 0 &&
      !intent.workModes.includes('unknown') &&
      posting.workMode === 'unknown'
    ) {
      gates.push({
        gateId: 'work_mode_match',
        status: 'ineligible',
        reason: 'work mode unknown and unknownPolicy=exclude',
        evidenceRefs: posting.evidenceRefs,
      });
    }
  }

  // Gate: targeted position (if posted as targeted, may be ineligible)
  if (posting.targetedPosition === true) {
    gates.push({
      gateId: 'targeted_position',
      status: 'conditionally_eligible',
      reason: 'posting is a targeted/recruitment position',
      evidenceRefs: posting.evidenceRefs,
    });
  }

  // Aggregate verdict
  const hasIneligible = gates.some((g) => g.status === 'ineligible');
  const hasConditional = gates.some((g) => g.status === 'conditionally_eligible');

  let status: EligibilityStatus;
  if (hasIneligible) status = 'ineligible';
  else if (hasConditional) status = 'conditionally_eligible';
  else status = 'eligible';

  return { status, gates };
}

// ---------------------------------------------------------------------------
// PersonalAdaptation delta processing
// ---------------------------------------------------------------------------

export function processPersonalAdaptationDelta(
  rawDelta: number,
  evidenceRefs: readonly EvidenceRef[] = [],
): PersonalAdaptationDelta {
  if (Math.abs(rawDelta) > W11_DELTA_RANGE) {
    throw new Error(
      `PERSONAL_ADAPTATION_DELTA_OUT_OF_RANGE: |${String(rawDelta)}| > ${String(W11_DELTA_RANGE)}`,
    );
  }

  return {
    delta: rawDelta,
    accepted: true,
    appliedDelta: rawDelta,
    evidenceRefs: [...evidenceRefs],
  };
}

/**
 * Weighted mean of group scores. Undefined weight overrides keep defaults.
 * Missing group scores fall back to NEUTRAL (0.5) and are not redistributed.
 */
export function computeUtilityScore(
  groupScores: Readonly<Partial<Record<ScoreGroup, number>>>,
  weights?: Readonly<Partial<Record<ScoreGroup, number>>>,
): number {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const group of SCORE_GROUPS) {
    const override = weights?.[group];
    const w = override ?? DEFAULT_GROUP_WEIGHTS[group];
    if (w <= 0) continue;
    const score = groupScores[group] ?? NEUTRAL;
    weightedSum += score * w;
    totalWeight += w;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : NEUTRAL;
}

// ---------------------------------------------------------------------------
// Full assessment
// ---------------------------------------------------------------------------

export interface AssessmentInput {
  readonly posting: JobPosting;
  readonly intent: SearchIntent;
  readonly retrievalMetadata?: {
    readonly rrfRank?: number;
    readonly rrfScore?: number;
    readonly scoredChannelCount?: number;
  };
  readonly personalAdaptationDelta?: number;
  readonly personalAdaptationEvidenceRefs?: readonly EvidenceRef[];
  readonly groupWeights?: Partial<Record<ScoreGroup, number>>;
  /** Fixed clock for deterministic freshness scoring. Falls back to Date.now(). */
  readonly nowMs?: number;
}

export function assessCandidate(input: AssessmentInput): {
  readonly groups: AssessmentGroup[];
  readonly utilityScore: number;
  readonly eligibility: EligibilityVerdict;
  readonly personalAdaptation: PersonalAdaptationDelta;
  readonly evidenceQualitySummary: {
    readonly totalEvidenceRefs: number;
    readonly uniqueEvidenceRefs: number;
    readonly coverageRatio: number;
  };
  readonly flags: string[];
} {
  const { posting, intent } = input;

  // Personal adaptation delta
  const paDelta = processPersonalAdaptationDelta(
    input.personalAdaptationDelta ?? 0,
    input.personalAdaptationEvidenceRefs ?? [],
  );

  // Score each group
  const groupScores: AssessmentGroup[] = [];

  // 1. Relevance
  groupScores.push(
    aggregateGroup('relevance', [
      scoreTitleRelevance(posting, intent),
      scoreRoleFamilyRelevance(posting, intent),
      scoreDescriptionRelevance(posting, intent),
    ]),
  );

  // 2. CandidateFit
  groupScores.push(
    aggregateGroup('candidateFit', [
      scoreRequirementsFit(posting),
      scoreSeniorityFit(posting, intent),
      scoreEmploymentTypeFit(posting, intent),
    ]),
  );

  // 3. PreferenceFit
  groupScores.push(
    aggregateGroup('preferenceFit', [
      scoreLocationPreference(posting, intent),
      scoreWorkModePreference(posting, intent),
      scoreCompensationPreference(posting, intent),
    ]),
  );

  // 4. MarketState
  groupScores.push(
    aggregateGroup('marketState', [
      scoreFreshness(posting, intent, input.nowMs),
      scoreLifecycleState(posting, intent),
      scoreVerificationState(posting, intent),
    ]),
  );

  // 5. EvidenceQuality
  groupScores.push(
    aggregateGroup('evidenceQuality', [
      scoreEvidenceCoverage(posting, intent),
      scoreSourceVerification(posting, intent),
      scoreRequirementEvidence(posting, intent),
    ]),
  );

  // 6. PersonalAdaptation
  groupScores.push(
    aggregateGroup('personalAdaptation', [scorePersonalAdaptation(posting, intent, paDelta)]),
  );

  const scoreByGroup: Partial<Record<ScoreGroup, number>> = {};
  for (const g of groupScores) scoreByGroup[g.group] = g.score;
  const utilityScore = computeUtilityScore(scoreByGroup, input.groupWeights);

  // Eligibility
  const eligibility = evaluateEligibility(posting, intent);

  // Evidence quality summary
  const allEvidenceRefs = groupScores.flatMap((g) => g.evidenceRefs);
  const uniqueEvidenceRefs = [...new Set(allEvidenceRefs)];

  // Flags
  const flags: string[] = [];
  if (eligibility.status === 'ineligible') flags.push('ineligible');
  if (eligibility.status === 'conditionally_eligible') flags.push('conditionally_eligible');
  if (posting.flags.includes('conflicting_source_evidence'))
    flags.push('conflicting_source_evidence');
  if (posting.flags.includes('stale_fallback')) flags.push('stale_fallback');
  // personalAdaptation delta out-of-range throws before reaching this point

  return {
    groups: groupScores,
    utilityScore: Math.max(0, Math.min(1, utilityScore)),
    eligibility,
    personalAdaptation: paDelta,
    evidenceQualitySummary: {
      totalEvidenceRefs: allEvidenceRefs.length,
      uniqueEvidenceRefs: uniqueEvidenceRefs.length,
      coverageRatio:
        groupScores.length === 0
          ? 0
          : groupScores.reduce((sum, g) => sum + g.coverageRatio, 0) / groupScores.length,
    },
    flags,
  };
}
