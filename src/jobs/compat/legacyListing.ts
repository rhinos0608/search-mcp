/* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/prefer-nullish-coalescing */
import { createHash } from 'node:crypto';
import type { JobListing, JobListingMvp } from '../../rag/types/job.js';
import { EvidenceSchema, type Evidence } from '../domain/evidence.js';
import { JobPostingSchema, type JobPosting, type Requirement } from '../domain/posting.js';
import {
  SourceListingSchema,
  SourceObservationSchema,
  type SourceListing,
  type SourceObservation,
} from '../domain/source.js';

export type LegacyListing = JobListingMvp | JobListing;
export interface LegacyMappingLoss {
  field: string;
  value: unknown;
  reason: string;
}
export interface LegacyMappingProvenance {
  source: 'legacy';
  confidenceClass: 'legacy_low';
  mapperVersion: string;
  capturedAt: string;
}
export interface LegacyListingMapping {
  posting: JobPosting;
  sourceListing: SourceListing;
  observation: SourceObservation;
  evidence: Evidence[];
  losses: LegacyMappingLoss[];
  provenance: LegacyMappingProvenance;
}
export interface LegacyMappingOptions {
  capturedAt: string;
  sourceUrls?: readonly string[];
}

const MAPPER_VERSION = 'legacy-listing-v1';
const CONFIDENCE_CAP = 0.3;
const digest = (kind: string, value: unknown): string =>
  `${kind}-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const bounded = (value: unknown): string => String(value).slice(0, 512);
const boundedSalary = (salary: unknown): unknown => {
  if (salary === null || typeof salary !== 'object') return bounded(salary);
  const value = salary as unknown as Record<string, unknown>;
  return {
    min: value.min,
    max: value.max,
    currency: bounded(value.currency),
    unit: value.unit,
    raw: bounded(value.raw),
  };
};
const boundedExperience = (experience: unknown): unknown => {
  if (experience === null || typeof experience !== 'object') return bounded(experience);
  const value = experience as unknown as Record<string, unknown>;
  return { min: value.min, max: value.max, unit: value.unit };
};
const instant = (value: Date | string | null | undefined): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};
const validUrl = (value: string): boolean => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** Additive projection for semantic_jobs migration; never mutates legacy input. */
export function mapLegacyListing(
  listing: LegacyListing,
  options: LegacyMappingOptions,
): LegacyListingMapping {
  const losses: LegacyMappingLoss[] = [];
  const lose = (field: string, value: unknown, reason: string) =>
    losses.push({ field, value, reason });
  const capturedAt = instant(options.capturedAt);
  if (!capturedAt) throw new Error('capturedAt must be valid ISO timestamp');

  const rawUrls = [
    ...(options.sourceUrls ?? []),
    ...(listing.sourceUrl === undefined ? [] : [listing.sourceUrl]),
  ];
  for (const url of rawUrls)
    if (!validUrl(url)) lose('sourceUrl', url, 'invalid URL omitted from canonical URL list');
  const urls = [...new Set(rawUrls.filter(validUrl))];
  const sourceKey = listing.jobId?.trim()
    ? { source: listing.source, externalId: listing.jobId.trim() }
    : urls[0]
      ? { source: listing.source, canonicalUrl: urls[0] }
      : {
          source: listing.source,
          company: listing.company?.trim(),
          title: listing.title.trim(),
          location: listing.location?.trim(),
          workMode: listing.workMode,
          unresolved: true,
        };
  if (!listing.jobId?.trim() && !urls[0])
    lose(
      'identity',
      sourceKey,
      'stable source ID and canonical URL absent; identity remains unresolved',
    );
  const sourceListingId = digest('legacy-listing', sourceKey);
  const contentHash = digest('legacy-content', listing.extractedText);
  const observationId = digest('legacy-observation', { sourceListingId, contentHash });
  const postingId = digest('legacy-posting', sourceKey);
  const confidence = Math.min(CONFIDENCE_CAP, listing.confidence.overall);
  const title = listing.title.trim() || 'Unresolved legacy listing';
  const description = listing.extractedText.trim() || 'Legacy listing content unavailable';
  if (!listing.title.trim())
    lose('title', listing.title, 'required title empty; explicit placeholder used');
  if (!listing.extractedText.trim())
    lose(
      'extractedText',
      listing.extractedText,
      'required description empty; explicit placeholder used',
    );
  if (!listing.company?.trim())
    lose('company', listing.company, 'canonical posting requires organisation; placeholder used');
  if (listing.workMode !== 'remote' && !listing.location?.trim())
    lose('location', listing.location, 'location absent; remote eligibility remains unknown');
  const legacyPostedAt =
    'postedAt' in listing ? (listing.postedAt as Date | string | null | undefined) : undefined;
  const legacyClosingAt =
    'expiresAt' in listing ? (listing.expiresAt as Date | string | null | undefined) : undefined;
  if ('postedRaw' in listing && listing.postedRaw !== undefined && !instant(legacyPostedAt))
    lose(
      'postedRaw',
      listing.postedRaw,
      'relative legacy date cannot be converted to canonical instant',
    );

  const postedAt = instant(legacyPostedAt);
  const closingAt = instant(legacyClosingAt);
  if ('postedAt' in listing && listing.postedAt != null && !postedAt)
    lose('postedAt', listing.postedAt, 'invalid date omitted');
  if ('expiresAt' in listing && listing.expiresAt != null && !closingAt)
    lose('expiresAt', listing.expiresAt, 'invalid date omitted');
  for (const field of ['title', 'location', 'workMode', 'salary'] as const)
    lose(
      `confidence.${field}`,
      listing.confidence[field],
      'canonical projection retains only aggregate confidence',
    );
  if (listing.verificationStatus !== undefined)
    lose(
      'verificationStatus',
      listing.verificationStatus,
      'legacy verification vocabulary has no exact canonical equivalent',
    );
  if ('embedding' in listing && listing.embedding !== undefined)
    lose('embedding', listing.embedding, 'legacy retrieval vector is not canonical posting data');
  if ('bm25Tokens' in listing && listing.bm25Tokens !== undefined)
    lose(
      'bm25Tokens',
      listing.bm25Tokens,
      'legacy retrieval tokens are not canonical posting data',
    );

  let salaries: JobPosting['salaries'] = [];
  if ('salary' in listing && listing.salary !== undefined) {
    const salary = listing.salary;
    if (salary === null || typeof salary !== 'object') {
      lose(
        'salary',
        boundedSalary(salary),
        'malformed structured salary omitted from canonical projection',
      );
    } else {
      const value = salary as unknown as Record<string, unknown>;
      const currency = value.currency;
      if (!currency)
        lose(
          'salary.currency',
          undefined,
          'currency absent; salary omitted rather than using fabricated XXX',
        );
      const salaryUnits = new Set(['hour', 'day', 'week', 'month', 'year']);
      const rawOk = typeof value.raw === 'string' && value.raw.trim().length > 0;
      const currencyOk = typeof currency === 'string' && currency.length === 3;
      const unitOk = typeof value.unit === 'string' && salaryUnits.has(value.unit);
      const min = value.min;
      const max = value.max;
      const validSalary =
        currencyOk &&
        rawOk &&
        unitOk &&
        (min === undefined || (typeof min === 'number' && Number.isFinite(min) && min >= 0)) &&
        (max === undefined || (typeof max === 'number' && Number.isFinite(max) && max >= 0)) &&
        (min === undefined || max === undefined || min <= max);
      if (
        validSalary &&
        currency &&
        typeof value.unit === 'string' &&
        typeof value.raw === 'string'
      )
        salaries = [
          {
            ...(min === undefined ? {} : { min }),
            ...(max === undefined ? {} : { max }),
            currency,
            unit: value.unit as 'hour' | 'day' | 'week' | 'month' | 'year',
            period: 'stated',
            raw: value.raw,
          },
        ];
      else
        lose(
          'salary',
          boundedSalary(salary),
          'malformed structured salary omitted from canonical projection',
        );
    }
    if ('salaryRaw' in listing && listing.salaryRaw !== undefined)
      lose('salaryRaw', listing.salaryRaw, 'structured salary mapped; raw duplicate ignored');
  } else if ('salaryRaw' in listing && listing.salaryRaw !== undefined) {
    lose(
      'salaryRaw',
      listing.salaryRaw,
      'unit and currency unknown; raw salary ignored rather than annualized',
    );
  }

  const evidenceSeed = { sourceListingId, observationId, capturedAt };
  const evidence: Evidence[] = [];
  const addEvidence = (
    fieldPath: string,
    value: unknown,
    kind: 'structured_field' | 'text_span' = 'structured_field',
  ) => {
    if (value === undefined || value === null || value === '') return;
    const evidenceId = digest('legacy-evidence', { ...evidenceSeed, fieldPath });
    evidence.push(
      EvidenceSchema.parse({
        evidenceId,
        subjectType: 'posting',
        subjectId: postingId,
        fieldPath,
        kind,
        observationId,
        boundedExcerpt: bounded(value),
        capturedAt,
        extractorVersion: MAPPER_VERSION,
        confidence,
        retentionClass: 'legacy_bounded',
      }),
    );
  };
  addEvidence('title', listing.title);
  addEvidence('organisation', listing.company);
  addEvidence('location', listing.location);
  addEvidence('workMode', listing.workMode);
  addEvidence('salary', salaries[0]?.raw);
  addEvidence('description', description, 'text_span');
  const evidenceRefs = evidence.map((item) => item.evidenceId);

  const requirements: Requirement[] = [];
  if ('requirements' in listing) {
    for (const requirement of listing.requirements) {
      if (requirement === null || typeof requirement !== 'object') {
        lose('requirements', requirement, 'malformed requirement omitted');
        continue;
      }
      const r = requirement as unknown as Record<string, unknown>;
      const rawText = typeof r.description === 'string' ? r.description : '';
      if (!rawText.trim()) {
        lose('requirements', requirement, 'empty requirement omitted');
        continue;
      }
      const years = r.years;
      const validYears =
        years === undefined || (typeof years === 'number' && Number.isFinite(years) && years >= 0);
      if (!validYears) lose('requirements.years', years, 'malformed requirement years omitted');
      requirements.push({
        rawText,
        category: r.skill ? 'skill' : 'other',
        force:
          r.category === 'essential'
            ? 'mandatory'
            : r.category === 'preferred'
              ? 'preferred'
              : 'uncertain',
        ...(typeof r.skill === 'string' && r.skill ? { semanticCapability: r.skill } : {}),
        ...(validYears && years !== undefined
          ? { years: { min: years, unit: 'year' as const } }
          : {}),
        evidenceRefs,
        confidence,
        interpretationProvenance: MAPPER_VERSION,
      });
    }
  }
  if ('experience' in listing && listing.experience !== undefined) {
    const experience = listing.experience;
    const value =
      experience !== null && typeof experience === 'object'
        ? (experience as unknown as Record<string, unknown>)
        : undefined;
    const expUnits = new Set(['month', 'year']);
    const unitValid =
      value !== undefined && typeof value.unit === 'string' && expUnits.has(value.unit);
    const min = value?.min;
    const max = value?.max;
    const validExperience =
      unitValid &&
      (min === undefined || (typeof min === 'number' && Number.isFinite(min) && min >= 0)) &&
      (max === undefined || (typeof max === 'number' && Number.isFinite(max) && max >= 0)) &&
      (min === undefined || max === undefined || min <= max);
    if (!validExperience)
      lose(
        'experience',
        boundedExperience(experience),
        'malformed experience omitted from canonical projection',
      );
    else {
      const rangeText =
        min === undefined
          ? max === undefined
            ? 'unspecified'
            : `up to ${String(max)}`
          : max === undefined
            ? `${String(min)}+`
            : `${String(min)}-${String(max)}`;
      const unit = value?.unit as 'month' | 'year';
      requirements.push({
        rawText: `Experience: ${rangeText} ${unit}${max === 1 ? '' : 's'}`,
        category: 'experience',
        force: 'uncertain',
        years: {
          ...(min === undefined ? {} : { min }),
          ...(max === undefined ? {} : { max }),
          unit,
        },
        evidenceRefs,
        confidence,
        interpretationProvenance: MAPPER_VERSION,
      });
    }
  }

  const sourceListing = SourceListingSchema.parse({
    sourceListingId,
    adapterId: digest('legacy-adapter', listing.source),
    ...(listing.jobId?.trim() ? { externalId: listing.jobId.trim() } : {}),
    ...(urls[0] ? { canonicalUrl: urls[0] } : {}),
    firstSeenAt: capturedAt,
    lastSeenAt: capturedAt,
    currentObservationId: observationId,
  });
  const observation = SourceObservationSchema.parse({
    observationId,
    sourceListingId,
    fetchedAt: capturedAt,
    contentHash,
    evidenceRefs,
    extractionVersion: MAPPER_VERSION,
    adapterVersion: MAPPER_VERSION,
    fetchOutcome: 'success',
    sourceConfidence: { overall: confidence },
    immutable: true,
  });
  const applyUrl =
    'applyUrl' in listing && typeof listing.applyUrl === 'string' && listing.applyUrl
      ? validUrl(listing.applyUrl)
        ? listing.applyUrl
        : undefined
      : undefined;
  if ('applyUrl' in listing && !applyUrl)
    lose('applyUrl', listing.applyUrl, 'empty or invalid URL omitted');
  const posting = JobPostingSchema.parse({
    postingId,
    schemaVersion: '1.0.0',
    canonicalRevision: 1,
    title,
    normalizedTitle: title.toLowerCase(),
    organisation: listing.company?.trim() || 'Unknown organisation',
    roleFamilies: [],
    locations: listing.location?.trim() ? [{ city: listing.location.trim() }] : [{}],
    workMode: listing.workMode,
    employmentType: 'unknown',
    salaries,
    classifications: [],
    ...('seniority' in listing && listing.seniority ? { seniority: listing.seniority } : {}),
    ...(postedAt ? { postedAt } : {}),
    ...(closingAt ? { closingAt } : {}),
    listingUrls: urls,
    description,
    responsibilities: [],
    requirements,
    desirableCriteria:
      'niceToHave' in listing ? (listing.niceToHave ?? []).filter((v) => v.trim()) : [],
    applicationRequirements: [],
    selectionQuestions: [],
    licencesChecksRegistration: [],
    verificationState:
      listing.verificationStatus === 'listing_page_fetched' ? 'partially_verified' : 'unverified',
    lifecycleState: 'discovered',
    flags: [
      'manual_import_unverified',
      ...(!listing.location?.trim() ? ['eligibility_unknown' as const] : []),
    ],
    confidence,
    caveats: [...listing.caveats, 'Projected from legacy listing; field confidence capped at 0.3.'],
    evidenceRefs,
    sourceListingIds: [sourceListingId],
    observationIds: [observationId],
    identityDecisionRevision: digest('legacy-identity', sourceKey),
    ...(applyUrl ? { applyUrl } : {}),
  });
  return {
    posting,
    sourceListing,
    observation,
    evidence,
    losses,
    provenance: {
      source: 'legacy',
      confidenceClass: 'legacy_low',
      mapperVersion: MAPPER_VERSION,
      capturedAt,
    },
  };
}
