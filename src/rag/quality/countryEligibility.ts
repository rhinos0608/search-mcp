/**
 * CountryEligibilityFilter
 *
 * Determines whether a job listing is likely eligible for a target country.
 * Combines signals from:
 * - Location text (city, state, country mentions)
 * - Currency symbols and codes in salary
 * - US state abbreviations (negative for AU-targeted searches)
 * - Domain TLD (.com.au vs .com)
 * - Remote eligibility verification
 *
 * For AU-targeted searches, listings with US location signals, USD currency,
 * or US state abbreviations are rejected or penalised.
 */

import type { CountryResult, CountrySignal, QualityGateConfig } from './types.js';
import type { JobListingMvp } from '../types/job.js';

// ── AU state / territory codes (keep these — they are NOT negative signals) ──

const AU_STATE_CODES = new Set(['act', 'nsw', 'nt', 'qld', 'sa', 'tas', 'vic', 'wa']);

// ── US state codes (negative for AU searches) ────────────────────────────────

const US_STATE_CODES = new Set([
  'al',
  'ak',
  'az',
  'ar',
  'ca',
  'co',
  'ct',
  'de',
  'fl',
  'ga',
  'hi',
  'id',
  'il',
  'in',
  'ia',
  'ks',
  'ky',
  'la',
  'me',
  'md',
  'ma',
  'mi',
  'mn',
  'ms',
  'mo',
  'mt',
  'ne',
  'nv',
  'nh',
  'nj',
  'nm',
  'ny',
  'nc',
  'nd',
  'oh',
  'ok',
  'or',
  'pa',
  'ri',
  'sc',
  'sd',
  'tn',
  'tx',
  'ut',
  'vt',
  'va',
  'wa',
  'wv',
  'wi',
  'wy',
]);

// ── Location text signals ────────────────────────────────────────────────────

/** Recognised country names and demonyms. */
const COUNTRY_NAMES: Record<string, string> = {
  australia: 'AU',
  australian: 'AU',
  'australia only': 'AU',
  canada: 'CA',
  canadian: 'CA',
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  us: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  america: 'US',
  american: 'US',
  'united kingdom': 'GB',
  uk: 'GB',
  'u.k.': 'GB',
  england: 'GB',
  'new zealand': 'NZ',
  nz: 'NZ',
};

/** Major AU cities for positive signals. */
const AU_CITIES = new Set([
  'sydney',
  'melbourne',
  'brisbane',
  'perth',
  'adelaide',
  'canberra',
  'hobart',
  'darwin',
  'gold coast',
  'sunshine coast',
  'newcastle',
  'wollongong',
  'geelong',
  'ballarat',
  'bendigo',
  'townsville',
  'cairns',
  'toowoomba',
  'paramatta',
  'penrith',
]);

/** Major US cities (negative signal for AU searches). */
const US_CITIES = new Set([
  'new york',
  'los angeles',
  'chicago',
  'houston',
  'phoenix',
  'philadelphia',
  'san antonio',
  'san diego',
  'dallas',
  'austin',
  'san jose',
  'jacksonville',
  'fort worth',
  'columbus',
  'charlotte',
  'indianapolis',
  'san francisco',
  'seattle',
  'denver',
  'nashville',
  'oklahoma city',
  'el paso',
  'washington',
  'boston',
  'las vegas',
  'portland',
  'memphis',
  'louisville',
  'baltimore',
  'milwaukee',
  'albuquerque',
  'tucson',
  'fresno',
  'sacramento',
  'mesa',
  'kansas city',
  'atlanta',
  'omaha',
  'colorado springs',
  'raleigh',
  'long beach',
  'virginia beach',
  'miami',
  'oakland',
  'minneapolis',
  'tampa',
  'tulsa',
  'arlington',
  'wichita',
  'cleveland',
  'bakersfield',
  'aurora',
  'anaheim',
  'honolulu',
  'santa ana',
  'riverside',
  'corpus christi',
  'lexington',
  'stockton',
  'henderson',
  'st. louis',
  'st paul',
  'cincinnati',
  'pittsburgh',
  'greensboro',
  'ann arbor',
  'annapolis',
  'burlington',
  'richmond',
  'longmont',
  'asheville',
  'west des moines',
  'tysons corner',
]);

// ── Currency patterns ────────────────────────────────────────────────────────

const AUD_CURRENCY_RE = /(?:A\$\s*|AU\$\s*|AUD\s*|A\$)s?\d/i;
const USD_CURRENCY_RE = /(?:US\$\s*|USD\s*|US\$)\s?\d/i;
const AMBIGUOUS_DOLLAR_RE = /(?:\$\s*)\d[\d,]*/;

// ── Domain TLD / host patterns ───────────────────────────────────────────────

const AU_DOMAIN_RE = /\.com\.au$/i;
const AU_HOST_RE = /^(?:au|nz)\./i;

// ── Main classifier ──────────────────────────────────────────────────────────

/**
 * Assess country eligibility for a job listing against a target country.
 *
 * Returns a CountryResult with:
 * - passed: boolean — whether the listing is eligible
 * - confidence: 0..1
 * - detectedCountry: ISO code if determinable
 * - signals: list of supporting evidence
 * - reasons: human-readable explanation
 */
export function assessCountryEligibility(
  listing: JobListingMvp,
  config: QualityGateConfig,
): CountryResult {
  const signals: CountrySignal[] = [];
  const reasons: string[] = [];
  let positiveScore = 0;
  let negativeScore = 0;
  let detectedCountry: string | undefined;

  const location = (listing.location ?? '').toLowerCase().trim();
  const sourceUrl = listing.sourceUrl ?? '';
  const salaryRaw = listing.salaryRaw ?? '';

  // ── 1. Location text analysis ────────────────────────────────────────────
  if (location.length > 0) {
    // Check for explicit country name
    for (const [name, code] of Object.entries(COUNTRY_NAMES)) {
      if (location.includes(name)) {
        detectedCountry = code;
        const positive = code === config.targetCountry;
        signals.push({
          type: 'location_text',
          value: name,
          positive,
        });
        if (positive) positiveScore += 3;
        else negativeScore += 3;
        reasons.push(
          `Location text mentions "${name}" → ${positive ? 'positive' : 'negative'} signal`,
        );
        break;
      }
    }

    // Check for AU cities (positive)
    for (const city of AU_CITIES) {
      if (location.includes(city)) {
        detectedCountry = 'AU';
        signals.push({ type: 'location_text', value: city, positive: true });
        positiveScore += 2;
        reasons.push(`Location contains AU city "${city}" — strong positive`);
        break;
      }
    }

    // Check for US cities (negative for AU target)
    if (config.checkUsStateAbbreviations) {
      for (const city of US_CITIES) {
        if (location.includes(city)) {
          detectedCountry = 'US';
          signals.push({ type: 'location_text', value: city, positive: false });
          negativeScore += 2;
          reasons.push(`Location contains US city "${city}" — negative signal for AU search`);
          break;
        }
      }
    }

    // Check for AU state code (positive)
    const locationWords = location.split(/[\s,]+/);
    for (const word of locationWords) {
      const clean = word.replace(/[^a-z]/g, '');
      if (AU_STATE_CODES.has(clean)) {
        detectedCountry = 'AU';
        signals.push({ type: 'location_text', value: clean.toUpperCase(), positive: true });
        positiveScore += 2;
        reasons.push(`AU state code "${clean.toUpperCase()}" detected — strong positive`);
        break;
      }
    }

    // Check for US state code (negative for AU target)
    if (config.checkUsStateAbbreviations) {
      for (const word of locationWords) {
        const clean = word.replace(/[^a-z]/g, '');
        // Must be exactly 2 chars and not also an AU code
        if (clean.length === 2 && US_STATE_CODES.has(clean) && !AU_STATE_CODES.has(clean)) {
          detectedCountry = 'US';
          signals.push({ type: 'state_abbreviation', value: clean.toUpperCase(), positive: false });
          negativeScore += 2;
          reasons.push(`US state abbreviation "${clean.toUpperCase()}" detected — negative signal`);
          break;
        }
      }
    }
  }

  // ── 2. Currency detection ──────────────────────────────────────────────
  if (config.checkCurrency && salaryRaw.length > 0) {
    if (AUD_CURRENCY_RE.test(salaryRaw)) {
      detectedCountry = 'AU';
      signals.push({ type: 'currency', value: 'AUD', positive: true });
      positiveScore += 2;
      reasons.push('AUD currency symbol detected — positive signal');
    } else if (USD_CURRENCY_RE.test(salaryRaw)) {
      detectedCountry = 'US';
      signals.push({ type: 'currency', value: 'USD', positive: false });
      negativeScore += 2;
      reasons.push('USD currency symbol detected — negative signal for AU search');
    } else if (AMBIGUOUS_DOLLAR_RE.test(salaryRaw)) {
      // $ is ambiguous — slight negative if no other AU signals
      signals.push({ type: 'currency', value: '$', positive: false });
      negativeScore += 0.5;
      reasons.push('Ambiguous "$" currency — no AUD prefix');
    }
  }

  // ── 3. Domain TLD / host analysis ──────────────────────────────────────
  if (config.checkDomainTld && sourceUrl.length > 0) {
    try {
      const hostname = new URL(sourceUrl).hostname;
      if (AU_DOMAIN_RE.test(hostname)) {
        detectedCountry = 'AU';
        signals.push({ type: 'domain_tld', value: '.com.au', positive: true });
        positiveScore += 1.5;
        reasons.push('Domain is .com.au — strong AU signal');
      }
      if (AU_HOST_RE.test(hostname)) {
        detectedCountry = 'AU';
        signals.push({ type: 'domain_tld', value: 'au.', positive: true });
        positiveScore += 1.5;
        reasons.push('Subdomain suggests AU locale (au.)');
      }
      // Generic .com is neutral — no signal either way
    } catch {
      // ignore malformed URLs
    }
  }

  // ── 4. Remote country eligibility ──────────────────────────────────────
  // If listing is marked remote but location is US, reject.
  // If remote with no location or AU location, allow.
  if (listing.workMode === 'remote' && detectedCountry === 'US') {
    reasons.push('Remote role located in US — rejected for AU search');
    negativeScore += 5;
  }

  // ── Decision ───────────────────────────────────────────────────────────
  const netScore = positiveScore - negativeScore;
  const confidence = clamp(netScore / 5, 0, 1);
  const passed = netScore >= -1; // Allow through if roughly neutral or positive
  // Unknown location with no other signals: pass through with low confidence

  if (reasons.length === 0) {
    reasons.push('No location/currency/domain signals available — allowing through');
  }

  return {
    passed,
    confidence,
    reasons,
    detectedCountry,
    signals,
  } satisfies CountryResult;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
