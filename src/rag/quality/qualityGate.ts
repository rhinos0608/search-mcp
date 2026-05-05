/**
 * QualityGate — orchestrator
 *
 * Composes all quality gate classifiers into a single pipeline that
 * filters job listings before they reach the ranking stage.
 *
 * Flow per listing:
 *   pageIntent → countryEligibility → occupation → boilerplate → entryLevel
 *
 * Each gate produces structured results. The orchestrator makes the
 * overall pass/fail decision based on configurable policies.
 */

import type { JobListingMvp } from '../types/job.js';
import type {
  QualityGateConfig,
  QualityGateResult,
  GateResult,
  PageIntentResult,
} from './types.js';
import { DEFAULT_QUALITY_CONFIG } from './types.js';
import { classifyPageIntent, evaluatePageIntent } from './pageIntent.js';
import { assessCountryEligibility } from './countryEligibility.js';
import { classifyOccupation } from './occupationClassifier.js';
import { classifyEntryLevel } from './entryLevelClassifier.js';
import { detectBoilerplate } from './boilerplateDetector.js';

export type { QualityGateConfig, QualityGateResult } from './types.js';
export { DEFAULT_QUALITY_CONFIG } from './types.js';

export interface QualityGateStats {
  total: number;
  passed: number;
  rejectedByPageIntent: number;
  rejectedByCountry: number;
  rejectedByOccupation: number;
  rejectedByBoilerplate: number;
  rejectedByEntryLevel: number;
}

/**
 * QualityGate class — orchestrates the full quality gate pipeline.
 *
 * Usage:
 *   const gate = new QualityGate(config);
 *   const { passed, rejected } = gate.filter(listings);
 */
export class QualityGate {
  private config: QualityGateConfig;

  constructor(config?: Partial<QualityGateConfig>) {
    this.config = { ...DEFAULT_QUALITY_CONFIG, ...config };
  }

  /**
   * Run the full quality gate pipeline on a list of listings.
   * Returns the filtered list and detailed results for each listing.
   */
  filter(listings: JobListingMvp[]): {
    passed: JobListingMvp[];
    rejected: JobListingMvp[];
    results: QualityGateResult[];
    stats: QualityGateStats;
  } {
    const assumedPageIntent = {
      passed: true,
      confidence: 1,
      reasons: ['Listings already extracted — page intent not rechecked'],
      intent: 'job_listing' as const,
    };
    const results = listings.map((listing) => this.evaluateRemaining(listing, assumedPageIntent));
    return this.separateResults(results);
  }

  /**
   * Evaluate a listing against all gates INCLUDING page intent.
   * Used when raw HTML is available (pre-extraction).
   */
  evaluate(listing: JobListingMvp, rawHtml?: string): QualityGateResult {
    const url = listing.sourceUrl ?? '';

    // ── Page Intent ────────────────────────────────────────────────────
    const pageIntent = rawHtml ? classifyPageIntent(url, listing.title, rawHtml) : 'job_listing'; // If no raw HTML, assume already extracted → job listing
    const pageIntentResult = evaluatePageIntent(pageIntent, this.config.requireJobListingIntent);

    // ── Remaining gates ────────────────────────────────────────────────
    return this.evaluateRemaining(listing, pageIntentResult);
  }

  /**
   * Evaluate a listing against ALL gates EXCEPT page intent.
   * Used when page intent was already checked at the page level.
   */
  filterRemaining(listings: JobListingMvp[]): {
    passed: JobListingMvp[];
    rejected: JobListingMvp[];
    results: QualityGateResult[];
    stats: QualityGateStats;
  } {
    const results = listings.map((l) =>
      this.evaluateRemaining(l, {
        passed: true,
        confidence: 1,
        reasons: ['Page intent already checked at page level'],
        intent: 'job_listing' as const,
      }),
    );
    return this.separateResults(results);
  }

  /**
   * Evaluate a listing against country, occupation, entry-level, and boilerplate gates,
   * with a provided page intent result (either checked or assumed).
   */
  private evaluateRemaining(
    listing: JobListingMvp,
    pageIntentResult: PageIntentResult,
  ): QualityGateResult {
    const countryResult = assessCountryEligibility(listing, this.config);
    const occupationResult = classifyOccupation(listing);
    const entryLevelResult = classifyEntryLevel(listing);
    const boilerplateResult = detectBoilerplate(listing, this.config.minContentRatio);

    const overall = this.decideOverall({
      pageIntent: pageIntentResult,
      country: countryResult,
      occupation: occupationResult,
      entryLevel: entryLevelResult,
      boilerplate: boilerplateResult,
    });

    return {
      listing,
      overall,
      pageIntent: pageIntentResult,
      country: countryResult,
      occupation: occupationResult,
      entryLevel: entryLevelResult,
      boilerplate: boilerplateResult,
    };
  }

  /**
   * Combine individual gate results into an overall pass/fail decision.
   */
  private decideOverall(gates: {
    pageIntent: { passed: boolean; reasons: string[] };
    country: { passed: boolean; reasons: string[] };
    occupation: { passed: boolean; classification: string; reasons: string[] };
    entryLevel: { passed: boolean; classification: string; reasons: string[] };
    boilerplate: { passed: boolean; reasons: string[] };
  }): GateResult {
    const blockReasons: string[] = [];
    let allPassed = true;

    // Mandatory gates (hard rejects)
    if (!gates.pageIntent.passed) {
      allPassed = false;
      blockReasons.push(...gates.pageIntent.reasons);
    }

    if (!gates.country.passed) {
      allPassed = false;
      blockReasons.push(...gates.country.reasons);
    }

    // Occupation: reject IT admin when configured
    if (this.config.rejectItAdmin && gates.occupation.classification === 'it_admin') {
      allPassed = false;
      blockReasons.push(...gates.occupation.reasons);
    }

    // Entry level: reject overqualified when configured
    if (this.config.rejectOverqualified && gates.entryLevel.classification === 'overqualified') {
      allPassed = false;
      blockReasons.push(...gates.entryLevel.reasons);
    }

    // Boilerplate: hard reject
    if (!gates.boilerplate.passed) {
      allPassed = false;
      blockReasons.push(...gates.boilerplate.reasons);
    }

    // Compute overall confidence as weighted average of applicable gates
    const confidences: number[] = [];
    confidences.push(
      gates.pageIntent.passed ? (gates.pageIntent.reasons.length > 0 ? 0.9 : 0.5) : 0,
    );
    confidences.push(
      gates.country.passed ? Math.max(gates.country.reasons.length > 0 ? 0.7 : 0.3, 0.3) : 0,
    );
    confidences.push(gates.occupation.passed ? 0.8 : 0);
    confidences.push(gates.entryLevel.passed ? 0.7 : 0);
    confidences.push(gates.boilerplate.passed ? 0.8 : 0);

    const validConfidences = confidences.filter((c) => c > 0);
    const confidence =
      validConfidences.length > 0
        ? validConfidences.reduce((a, b) => a + b, 0) / validConfidences.length
        : 0;

    return {
      passed: allPassed,
      confidence,
      reasons: allPassed ? [] : blockReasons,
    };
  }

  /**
   * Compute aggregate statistics from quality gate results.
   */
  /**
   * Separate results into passed/rejected listings and compute stats.
   */
  private separateResults(results: QualityGateResult[]): {
    passed: JobListingMvp[];
    rejected: JobListingMvp[];
    results: QualityGateResult[];
    stats: QualityGateStats;
  } {
    const passed: JobListingMvp[] = [];
    const rejected: JobListingMvp[] = [];

    for (const result of results) {
      if (result.overall.passed) {
        passed.push(result.listing);
      } else {
        rejected.push(result.listing);
      }
    }

    const stats = this.computeStats(results);

    return { passed, rejected, results, stats };
  }

  private computeStats(results: QualityGateResult[]): QualityGateStats {
    const stats: QualityGateStats = {
      total: results.length,
      passed: 0,
      rejectedByPageIntent: 0,
      rejectedByCountry: 0,
      rejectedByOccupation: 0,
      rejectedByBoilerplate: 0,
      rejectedByEntryLevel: 0,
    };

    for (const result of results) {
      if (result.overall.passed) {
        stats.passed++;
      } else {
        // Count by first failing gate (most specific)
        if (!result.pageIntent.passed) stats.rejectedByPageIntent++;
        else if (!result.country.passed) stats.rejectedByCountry++;
        else if (this.config.rejectItAdmin && result.occupation.classification === 'it_admin') {
          stats.rejectedByOccupation++;
        } else if (!result.boilerplate.passed) stats.rejectedByBoilerplate++;
        else if (
          this.config.rejectOverqualified &&
          result.entryLevel.classification === 'overqualified'
        ) {
          stats.rejectedByEntryLevel++;
        }
      }
    }

    return stats;
  }
}
