/**
 * Types for the JobCandidateQualityGate system.
 *
 * Each gate classifier returns a structured result with pass/fail,
 * confidence, and human-readable reasons. The orchestrator composes
 * all gates and produces an overall QualityGateResult per listing.
 */

import type { JobListingMvp } from '../types/job.js';

// ── Page intent ──────────────────────────────────────────────────────────────

/** The type of page a URL/content represents. */
export type PageIntent =
  | 'job_listing'
  | 'job_search_results'
  | 'career_advice'
  | 'salary_info'
  | 'login'
  | 'generic_article'
  | 'company_profile';

// ── Occupation classification ────────────────────────────────────────────────

/** High-level occupation category derived from title + description analysis. */
export type OccupationClass =
  | 'clerical_admin'
  | 'it_admin'
  | 'other_admin'
  | 'unrelated';

// ── Entry-level classification ───────────────────────────────────────────────

/** How compatible a listing is with entry-level expectations. */
export type EntryLevelClass =
  | 'entry'
  | 'mid'
  | 'senior'
  | 'overqualified'
  | 'uncertain';

// ── Per-gate results ─────────────────────────────────────────────────────────

export interface GateResult {
  passed: boolean;
  confidence: number; // 0..1
  reasons: string[];
}

export interface PageIntentResult extends GateResult {
  intent: PageIntent;
}

export interface CountryResult extends GateResult {
  detectedCountry: string | undefined;
  signals: CountrySignal[];
}

export interface CountrySignal {
  type:
    | 'location_text'
    | 'currency'
    | 'state_abbreviation'
    | 'domain_tld'
    | 'remote_eligibility';
  value: string;
  positive: boolean; // true = supports target country
}

export interface OccupationResult extends GateResult {
  classification: OccupationClass;
}

export interface EntryLevelResult extends GateResult {
  classification: EntryLevelClass;
}

export interface BoilerplateResult extends GateResult {
  contentRatio: number; // 0..1 ratio of meaningful content to total text
}

// ── Composite result ─────────────────────────────────────────────────────────

export interface QualityGateResult {
  listing: JobListingMvp;
  overall: GateResult;
  pageIntent: PageIntentResult;
  country: CountryResult;
  occupation: OccupationResult;
  entryLevel: EntryLevelResult;
  boilerplate: BoilerplateResult;
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface QualityGateConfig {
  /** Target country for eligibility filtering (e.g. 'AU', 'US', 'GB'). */
  targetCountry: string;

  /** Preferred cities/regions that boost score (e.g. ['Sydney', 'NSW']). */
  targetRegions: string[];

  /**
   * When true, listings with no location information are allowed through
   * with reduced confidence rather than rejected outright.
   */
  allowUnknownLocation: boolean;

  /** When true, non-job-listing page intents are rejected. */
  requireJobListingIntent: boolean;

  /** When true, IT/sysadmin classified listings are rejected. */
  rejectItAdmin: boolean;

  /** When true, overqualified / senior listings are rejected. */
  rejectOverqualified: boolean;

  /**
   * Minimum content ratio (meaningful / total text) for boilerplate check.
   * Pages below this threshold are rejected.
   */
  minContentRatio: number;

  /**
   * Minimum number of search results (out of top N) that must pass
   * relevance check for the SERP batch to be accepted.
   */
  serpMinRelevant: number;

  /**
   * How many top search results to inspect for SERP quality.
   */
  serpInspectCount: number;

  /**
   * When true, currency signals (USD vs AUD) are used for country eligibility.
   */
  checkCurrency: boolean;

  /**
   * When true, domain TLD is used for country eligibility.
   */
  checkDomainTld: boolean;

  /**
   * When true, US state abbreviations in location text are treated as
   * negative signals for AU-targeted searches.
   */
  checkUsStateAbbreviations: boolean;
}

export const DEFAULT_QUALITY_CONFIG: QualityGateConfig = {
  targetCountry: 'AU',
  targetRegions: ['Sydney', 'NSW'],
  allowUnknownLocation: true,
  requireJobListingIntent: true,
  rejectItAdmin: true,
  rejectOverqualified: true,
  minContentRatio: 0.3,
  serpMinRelevant: 3,
  serpInspectCount: 10,
  checkCurrency: true,
  checkDomainTld: true,
  checkUsStateAbbreviations: true,
};
