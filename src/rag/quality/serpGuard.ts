/**
 * SerpQualityGuard
 *
 * Checks web search result quality before URLs are fed into the crawl pipeline.
 * Prevents Gmail sign-in, CNN videos, and other off-topic results from
 * polluting the job listings corpus.
 *
 * Strategy:
 * 1. For each search result, check if title/URL/description contains
 *    at least one job-related keyword AND one location-related keyword.
 * 2. If fewer than N of the top M results pass, the entire SERP batch
 *    is rejected and a constrained retry query is suggested.
 */

import type { SearchResult } from '../../types.js';

// ── Keyword sets ─────────────────────────────────────────────────────────────

/** Keywords suggesting a result is job-related. */
const JOB_KEYWORDS: readonly string[] = [
  'job',
  'jobs',
  'career',
  'careers',
  'position',
  'positions',
  'vacancy',
  'vacancies',
  'opening',
  'openings',
  'employment',
  'hiring',
  'recruit',
  'recruitment',
  'opportunity',
  'opportunities',
  'work',
  'role',
  'roles',
  'listing',
  'listings',
];

/** Keywords suggesting a result is geographically relevant to AU/NZ. */
const AU_LOCATION_KEYWORDS: readonly string[] = [
  'sydney',
  'nsw',
  'australia',
  'australian',
  'au',
  'melbourne',
  'vic',
  'brisbane',
  'qld',
  'perth',
  'wa',
  'adelaide',
  'sa',
  'canberra',
  'act',
  'hobart',
  'tas',
  'darwin',
  'nt',
  'gold coast',
  'sunshine coast',
  'newcastle',
  'wollongong',
  'geelong',
  'seek.com.au',
  'au.indeed',
  'au.seek',
  '.com.au',
];

/** Keywords suggesting the result is NOT a job listing. */
const NON_JOB_KEYWORDS: readonly string[] = [
  'sign in',
  'login',
  'gmail',
  'outlook',
  'youtube',
  'cnn',
  'facebook',
  'twitter',
  'instagram',
  'how to',
  'what is',
  'guide',
  'tutorial',
  'article',
  'salary',
  'pay',
  'review',
  'rating',
  'webroot',
  'ncsbn',
  'classlink',
  'seesaw',
  'ruca',
  'device wipe',
  'cert pdf',
  'ice machine',
];

// ── Result-level check ───────────────────────────────────────────────────────

/**
 * Check if a single search result is plausibly a job listing relevant to AU.
 */
function isResultRelevant(result: SearchResult, locationTerms: string[]): boolean {
  const haystack = `${result.title} ${result.url} ${result.description}`.toLowerCase();

  // Check for non-job indicators first (quick reject)
  for (const keyword of NON_JOB_KEYWORDS) {
    if (haystack.includes(keyword)) return false;
  }

  // Must contain at least one job keyword
  const hasJobKeyword = JOB_KEYWORDS.some((kw) => haystack.includes(kw));
  if (!hasJobKeyword) return false;

  // Must contain at least one location keyword OR be from an AU domain
  const hasLocationKeyword =
    locationTerms.some((term) => haystack.includes(term)) ||
    AU_LOCATION_KEYWORDS.some((kw) => haystack.includes(kw));
  if (!hasLocationKeyword) return false;

  return true;
}

// ── SERP-level quality check ─────────────────────────────────────────────────

export interface SerpQualityResult {
  passed: boolean;
  relevantCount: number;
  totalInspected: number;
  reasons: string[];
  /** A constrained query to retry with, if the batch failed quality. */
  constrainedQuery?: string;
}

/**
 * Check the quality of a batch of web search results.
 *
 * @param results - The search results to check.
 * @param originalQuery - The original search query, used to generate a constrained query.
 * @param minRelevant - Minimum number of relevant results required.
 * @param inspectCount - How many of the top results to inspect.
 */
export function checkSerpQuality(
  results: SearchResult[],
  originalQuery: string,
  minRelevant: number,
  inspectCount: number,
): SerpQualityResult {
  const toInspect = results.slice(0, inspectCount);
  if (toInspect.length === 0) {
    return {
      passed: false,
      relevantCount: 0,
      totalInspected: 0,
      reasons: ['No search results to inspect'],
      constrainedQuery: originalQuery,
    };
  }

  // Scale threshold to available results
  const effectiveThreshold = Math.min(minRelevant, toInspect.length);

  // Extract location terms from the query for matching
  const locationTerms = extractLocationTerms(originalQuery);

  let relevantCount = 0;
  for (const result of toInspect) {
    if (isResultRelevant(result, locationTerms)) {
      relevantCount++;
    }
  }

  const passed = relevantCount >= effectiveThreshold;
  const reasons: string[] = [];

  if (!passed) {
    const pct = Math.round((relevantCount / toInspect.length) * 100);
    reasons.push(
      `SERP quality: ${String(relevantCount)}/${String(toInspect.length)} (${String(pct)}%) relevant results below threshold of ${String(effectiveThreshold)}`,
    );

    // Identify what kinds of bad results we got
    const nonJobCount = toInspect.filter(
      (r) =>
        !JOB_KEYWORDS.some((kw) =>
          `${r.title} ${r.url} ${r.description}`.toLowerCase().includes(kw),
        ),
    ).length;
    const nonLocationCount = toInspect.filter(
      (r) =>
        !AU_LOCATION_KEYWORDS.some((kw) =>
          `${r.title} ${r.url} ${r.description}`.toLowerCase().includes(kw),
        ),
    ).length;

    if (nonJobCount > 0) reasons.push(`${String(nonJobCount)} result(s) lack job-related keywords`);
    if (nonLocationCount > 0)
      reasons.push(`${String(nonLocationCount)} result(s) lack AU location keywords`);
  }

  // Generate a constrained query for retry
  const constrainedQuery = generateConstrainedQuery(originalQuery);

  return {
    passed,
    relevantCount,
    totalInspected: toInspect.length,
    reasons,
    ...(constrainedQuery !== originalQuery ? { constrainedQuery } : {}),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract location-related terms from a query.
 */
function extractLocationTerms(query: string): string[] {
  const lower = query.toLowerCase();
  const terms: string[] = [];

  // Known Australian cities
  const cities = [
    'sydney',
    'melbourne',
    'brisbane',
    'perth',
    'adelaide',
    'canberra',
    'hobart',
    'darwin',
    'gold coast',
  ];
  for (const city of cities) {
    if (lower.includes(city)) terms.push(city);
  }

  // State codes
  const states = ['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'act', 'nt'];
  for (const state of states) {
    if (lower.includes(state)) terms.push(state);
  }

  // Country
  if (lower.includes('australia') || lower.includes('au')) {
    terms.push('australia');
  }

  return terms;
}

/**
 * Generate a constrained query that limits results to AU job boards.
 */
function generateConstrainedQuery(originalQuery: string): string {
  const lower = originalQuery.toLowerCase();

  // If already constrained to AU domains, return as-is
  if (/site:seek\.com\.au|site:au\.indeed/i.test(lower)) {
    return originalQuery;
  }

  // Check if it's already an AU-targeted query
  const hasAuLocation = extractLocationTerms(originalQuery).length > 0;

  if (hasAuLocation) {
    // Add site constraints to major AU job boards
    return `${originalQuery} (site:seek.com.au OR site:au.indeed.com OR site:jora.com)`;
  }

  // Fallback: add location + site constraint
  return `${originalQuery} Australia (site:seek.com.au OR site:au.indeed.com)`;
}
