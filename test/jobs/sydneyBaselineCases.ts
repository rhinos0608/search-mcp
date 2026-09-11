/**
 * Stage 0 Sydney baseline — 36 seed query cases, six per cohort.
 *
 * Fixture file only: no relevance labels, no human-reviewed judgments, no
 * live data. Each case declares explicit intent constraints (only fields that
 * exist on SearchIntentSchema), constraints that the current intent/profile
 * contracts cannot express (retained verbatim, never silently applied), and
 * expected PIPELINE BEHAVIOR (not expected ranking). Query wording alone never
 * establishes a candidate fact: any candidate-fact modeling (expired
 * registration, citizenship status, WWCC) would require synthetic evidence the
 * current profile contract cannot carry, so such facts are marked unsupported
 * rather than invented.
 */

export type SydneyBaselineCohort =
  | 'public-administration'
  | 'transferable-capabilities'
  | 'health'
  | 'other-employers'
  | 'geography-work-conditions'
  | 'ambiguity-counterexamples';

export const SYDNEY_BASELINE_COHORTS: readonly SydneyBaselineCohort[] = [
  'public-administration',
  'transferable-capabilities',
  'health',
  'other-employers',
  'geography-work-conditions',
  'ambiguity-counterexamples',
];

export type SydneyBaselineScenario = 'ok' | 'unavailable' | 'ok_empty';

export interface SydneyBaselineCase {
  caseId: string;
  cohort: SydneyBaselineCohort;
  query: string;
  /** Explicit constraints, expressed ONLY via existing SearchIntent fields. */
  intentConstraints: {
    locations?: { country?: string; region?: string; city?: string }[];
    workModes?: ('onsite' | 'hybrid' | 'remote' | 'unknown')[];
    employmentTypes?: (
      | 'full_time'
      | 'part_time'
      | 'casual'
      | 'contract'
      | 'temporary'
      | 'internship'
      | 'unknown'
    )[];
    compensation?: {
      min: number;
      currency: 'AUD';
      unit: 'year';
      period: 'annualized' | 'stated';
      raw: string;
    }[];
    unknownPolicy?: 'include' | 'exclude';
  };
  /** Constraints the current contracts cannot express — retained, not applied. */
  unsupportedConstraints: { constraint: string; reason: string }[];
  /** Behavioral expectations only — never relevance labels. */
  expectedBehavior: string[];
  /** Provider boundary scenario for the synthetic fixture. */
  providerScenario: SydneyBaselineScenario;
  /** Synthetic profile evidence is not expressible for any case yet: facts
   * like registration expiry or WWCC status have no field in the current
   * profile contract, and none of the 36 cases require inventing one. */
  syntheticProfileEvidence: null;
}

const NSW_SYDNEY = { region: 'NSW', city: 'Sydney' } as const;
const NSW = { region: 'NSW' } as const;

function loc(...l: { country?: string; region?: string; city?: string }[]): { country?: string; region?: string; city?: string }[] {
  return l;
}

const BASE_COMPLETED_BEHAVIOR = [
  'harness records the indexed provider boundary call and replays it with identical request identity',
  'record run and replay run produce identical normalized pipeline outputs',
  'result separates utility, coverage, confidence, and eligibility; no relevance label asserted',
] as const;

function behavior(...extra: string[]): string[] {
  return [...BASE_COMPLETED_BEHAVIOR, ...extra];
}

export const SYDNEY_BASELINE_CASES: readonly SydneyBaselineCase[] = [
  // -------------------------------------------------------------------------
  // public-administration
  // -------------------------------------------------------------------------
  {
    caseId: 'pub-01',
    cohort: 'public-administration',
    query: 'project officer Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior('run completes or reports an explicit failure; never a silent zero'),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'pub-02',
    cohort: 'public-administration',
    query: 'policy officer NSW',
    intentConstraints: { locations: loc(NSW) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'pub-03',
    cohort: 'public-administration',
    query: 'program support officer Parramatta',
    intentConstraints: { locations: loc({ region: 'NSW', city: 'Parramatta' }) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'pub-04',
    cohort: 'public-administration',
    query: 'business support clerk grade 5/6 Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [
      {
        constraint: 'grade 5/6 classification band',
        reason: 'SearchIntent has no classification-grade field; query wording alone must not set candidate facts',
      },
    ],
    expectedBehavior: behavior('grade constraint stays in unsupportedConstraints and is not applied'),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'pub-05',
    cohort: 'public-administration',
    query: 'governance officer NSW government',
    intentConstraints: { locations: loc(NSW) },
    unsupportedConstraints: [
      {
        constraint: 'government-sector restriction',
        reason: 'sectors is a positive hint array; no sector-exclusion or verified-sector field exists on the intent contract',
      },
    ],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'pub-06',
    cohort: 'public-administration',
    query: 'executive support officer Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  // -------------------------------------------------------------------------
  // transferable-capabilities
  // -------------------------------------------------------------------------
  {
    caseId: 'cap-01',
    cohort: 'transferable-capabilities',
    query: 'stakeholder engagement community programs Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'cap-02',
    cohort: 'transferable-capabilities',
    query: 'grants administration reporting Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'cap-03',
    cohort: 'transferable-capabilities',
    query: 'procurement contracts administration Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'cap-04',
    cohort: 'transferable-capabilities',
    query: 'records information management Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'cap-05',
    cohort: 'transferable-capabilities',
    query: 'service improvement analyst Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'cap-06',
    cohort: 'transferable-capabilities',
    query: 'research evaluation officer Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  // -------------------------------------------------------------------------
  // health
  // -------------------------------------------------------------------------
  {
    caseId: 'hea-01',
    cohort: 'health',
    query: 'NSW Health administration officer Westmead',
    intentConstraints: { locations: loc({ region: 'NSW', city: 'Westmead' }) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'hea-02',
    cohort: 'health',
    query: 'patient services officer Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'hea-03',
    cohort: 'health',
    query: 'clinical trials coordinator Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'hea-04',
    cohort: 'health',
    query: 'health project officer non-clinical Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [
      {
        constraint: 'non-clinical exclusion',
        reason: 'no clinical/non-clinical exclusion field on SearchIntent; query wording must not set candidate facts',
      },
    ],
    expectedBehavior: behavior('non-clinical constraint stays unsupported and is not applied'),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'hea-05',
    cohort: 'health',
    query: 'registered nurse Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'hea-06',
    cohort: 'health',
    query: 'allied health assistant Western Sydney',
    intentConstraints: { locations: loc({ region: 'NSW', city: 'Sydney' }) },
    unsupportedConstraints: [
      {
        constraint: 'Western Sydney sub-region',
        reason: 'LocationSchema has city/postcode but no sub-region granularity; modeled as city Sydney only',
      },
    ],
    expectedBehavior: behavior(
      'provider boundary fails; run reports an explicit failed outcome isolated from any other slice',
    ),
    providerScenario: 'unavailable',
    syntheticProfileEvidence: null,
  },
  // -------------------------------------------------------------------------
  // other-employers
  // -------------------------------------------------------------------------
  {
    caseId: 'emp-01',
    cohort: 'other-employers',
    query: 'APS program officer Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [
      {
        constraint: 'APS agency scope',
        reason: 'no agency/scope field on SearchIntent beyond free-form sectors; not fabricated',
      },
    ],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'emp-02',
    cohort: 'other-employers',
    query: 'council community development officer Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'emp-03',
    cohort: 'other-employers',
    query: 'university research administration Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'emp-04',
    cohort: 'other-employers',
    query: 'student services officer Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'emp-05',
    cohort: 'other-employers',
    query: 'private hospital administration Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'emp-06',
    cohort: 'other-employers',
    query: 'Workday project coordinator Sydney',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  // -------------------------------------------------------------------------
  // geography-work-conditions
  // -------------------------------------------------------------------------
  {
    caseId: 'geo-01',
    cohort: 'geography-work-conditions',
    query: 'project officer Parramatta hybrid',
    intentConstraints: {
      locations: loc({ region: 'NSW', city: 'Parramatta' }),
      workModes: ['hybrid'],
    },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'geo-02',
    cohort: 'geography-work-conditions',
    query: 'administration officer Penrith part time',
    intentConstraints: {
      locations: loc({ region: 'NSW', city: 'Penrith' }),
      employmentTypes: ['part_time'],
    },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'geo-03',
    cohort: 'geography-work-conditions',
    query: 'program coordinator Liverpool',
    intentConstraints: { locations: loc({ region: 'NSW', city: 'Liverpool' }) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'geo-04',
    cohort: 'geography-work-conditions',
    query: 'community engagement Blacktown',
    intentConstraints: { locations: loc({ region: 'NSW', city: 'Blacktown' }) },
    unsupportedConstraints: [],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'geo-05',
    cohort: 'geography-work-conditions',
    query: 'policy analyst remote Australia Sydney based',
    intentConstraints: {
      locations: loc({ country: 'Australia', region: 'NSW', city: 'Sydney' }),
      workModes: ['remote'],
    },
    unsupportedConstraints: [
      {
        constraint: '"Sydney based" while remote',
        reason: 'intent cannot express remote-with-Sydney-base as a single coherent location constraint; both are applied independently',
      },
    ],
    expectedBehavior: behavior(),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'geo-06',
    cohort: 'geography-work-conditions',
    query: 'project support Sydney minimum $100000 excluding super',
    intentConstraints: {
      locations: loc(NSW_SYDNEY),
      compensation: [
        {
          min: 100000,
          currency: 'AUD',
          unit: 'year',
          period: 'stated',
          raw: 'minimum $100000 excluding super',
        },
      ],
    },
    unsupportedConstraints: [
      {
        constraint: 'superannuation inclusion of stated minimum',
        reason: 'SalaryInterval has min/currency/unit but no super-inclusion flag; raw text retained verbatim',
      },
    ],
    expectedBehavior: behavior(
      'provider boundary succeeds with zero results; pipeline reports the explicit NO_CANDIDATES failure rather than a fabricated empty success',
    ),
    providerScenario: 'ok_empty',
    syntheticProfileEvidence: null,
  },
  // -------------------------------------------------------------------------
  // ambiguity-counterexamples
  // -------------------------------------------------------------------------
  {
    caseId: 'amb-01',
    cohort: 'ambiguity-counterexamples',
    query: 'project officer Sydney no government experience',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [
      {
        constraint: 'candidate has no government experience',
        reason: 'query wording never establishes candidate facts; profile contract exposes no government-experience status here',
      },
    ],
    expectedBehavior: behavior(
      'no candidate eligibility or fact is derived from the query wording alone',
      'unsupported constraint retained verbatim in fixture expectations',
    ),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'amb-02',
    cohort: 'ambiguity-counterexamples',
    query: 'APS officer Sydney citizenship unknown',
    intentConstraints: { locations: loc(NSW_SYDNEY), unknownPolicy: 'include' },
    unsupportedConstraints: [
      {
        constraint: 'citizenship status is unknown',
        reason: 'unknownPolicy include is expressible, but citizenship as a candidate fact is not; no invented field',
      },
    ],
    expectedBehavior: behavior('unknown candidates stay included; no citizenship eligibility derived'),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'amb-03',
    cohort: 'ambiguity-counterexamples',
    query: 'registered nurse Sydney registration expired',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [
      {
        constraint: 'registration expiry status',
        reason: 'profile contract has a registrations term dimension but no expiry/status field; modeling would require invented fields',
      },
    ],
    expectedBehavior: behavior(
      'expired registration is NOT modeled from query wording; no eligibility downgrade without explicit separate evidence',
    ),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'amb-04',
    cohort: 'ambiguity-counterexamples',
    query: 'community services Sydney WWCC unknown',
    intentConstraints: { locations: loc(NSW_SYDNEY), unknownPolicy: 'include' },
    unsupportedConstraints: [
      {
        constraint: 'WWCC status is unknown',
        reason: 'no WWCC status field expressible under the current profile contract without invented fields',
      },
    ],
    expectedBehavior: behavior('unknown WWCC stays included; no check-status fact derived from wording'),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'amb-05',
    cohort: 'ambiguity-counterexamples',
    query: 'entry level policy Sydney senior roles excluded',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [
      {
        constraint: 'senior roles excluded',
        reason: 'SearchIntent has no seniority-exclusion field; exclusion is retained in expectations, not applied',
      },
    ],
    expectedBehavior: behavior('seniority exclusion stays unsupported and is not applied'),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
  {
    caseId: 'amb-06',
    cohort: 'ambiguity-counterexamples',
    query: 'project officer Sydney exclude construction',
    intentConstraints: { locations: loc(NSW_SYDNEY) },
    unsupportedConstraints: [
      {
        constraint: 'construction sector excluded',
        reason: 'sectors is a positive hint array; negative sector exclusion is not expressible on the intent contract',
      },
    ],
    expectedBehavior: behavior('sector exclusion stays unsupported and is not applied'),
    providerScenario: 'ok',
    syntheticProfileEvidence: null,
  },
];

/** Rejects incomplete or malformed 36-case sets (CASE_SET_INCOMPLETE). */
export function validateCaseSet(cases: readonly SydneyBaselineCase[]): void {
  if (cases.length !== 36) {
    throw new Error(
      `CASE_SET_INCOMPLETE: expected exactly 36 Sydney baseline cases, got ${String(cases.length)}`,
    );
  }
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.caseId)) throw new Error(`CASE_SET_INCOMPLETE: duplicate caseId ${c.caseId}`);
    seen.add(c.caseId);
    if (c.query.trim().length === 0) {
      throw new Error(`CASE_SET_INCOMPLETE: case ${c.caseId} has empty query`);
    }
  }
  for (const cohort of SYDNEY_BASELINE_COHORTS) {
    const count = cases.filter((c) => c.cohort === cohort).length;
    if (count !== 6) {
      throw new Error(
        `CASE_SET_INCOMPLETE: cohort '${cohort}' has ${String(count)} cases, expected 6`,
      );
    }
  }
}
