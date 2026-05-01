import type { JobListingMvp, JobSearchConstraints, JobSource } from './types/job.js';
import type { GraphDuplicateCluster } from './types/jobGraph.js';
import { findJobsByCompany, findDuplicatesByTitleCompany } from '../utils/jobGraphDb.js';

export interface JobScore {
  listing: JobListingMvp;
  overallScore: number;
  matchedConstraints: string[];
  caveats: string[];
  componentScores: {
    semantic: number;
    location: number;
    workMode: number;
    recency: number;
    completeness: number;
    sourceReliability: number;
    duplicateDensity: number;
    companyReliability: number;
  };
}

export function applyHardFilters(
  listings: JobListingMvp[],
  constraints: JobSearchConstraints,
): JobListingMvp[] {
  return listings.filter((listing) => {
    if (!matchesLocationConstraint(listing, constraints.location)) {
      return false;
    }

    if (!matchesWorkModeConstraint(listing, constraints.workMode)) {
      return false;
    }

    if (!matchesSalaryConstraint(listing, constraints.maxSalary)) {
      return false;
    }

    if (!matchesTitleConstraint(listing, constraints.excludeTitles)) {
      return false;
    }

    return true;
  });
}

export function rankJobListings(
  listings: JobListingMvp[],
  query: string,
  constraints?: JobSearchConstraints,
  semanticScores?: Map<string, number>,
  graphScoring = false,
): JobScore[] {
  void query;

  const scores: JobScore[] = listings.map((listing, index) => {
    const semantic = resolveSemanticScore(listing, index, semanticScores);
    const location = calculateLocationScore(listing, constraints?.location);
    const workMode = calculateWorkModeScore(listing, constraints?.workMode);
    const recency = calculateFreshnessScore(listing.postedRaw);
    const completeness = calculateCompletenessScore(listing);

    let overallScore: number;
    let sourceReliability = 0;
    let duplicateDensity = 0;
    let companyReliability = 0;

    if (graphScoring) {
      sourceReliability = calculateSourceReliability(listing.source);
      if (listing.company) {
        duplicateDensity = calculateDuplicateScore(listing.company, listing.title);
        companyReliability = calculateCompanyReliability(listing.company);
      }
      overallScore =
        semantic * 0.35 +
        location * 0.15 +
        workMode * 0.10 +
        recency * 0.10 +
        completeness * 0.10 +
        sourceReliability * 0.10 +
        duplicateDensity * 0.05 +
        companyReliability * 0.05;
    } else {
      overallScore =
        semantic * 0.45 + location * 0.2 + workMode * 0.15 + recency * 0.1 + completeness * 0.1;
    }

    return {
      listing,
      overallScore,
      matchedConstraints: collectMatchedConstraints(listing, constraints),
      caveats: [...listing.caveats],
      componentScores: {
        semantic,
        location,
        workMode,
        recency,
        completeness,
        sourceReliability,
        duplicateDensity,
        companyReliability,
      },
    };
  });

  return scores.sort((left, right) => right.overallScore - left.overallScore);
}

function matchesLocationConstraint(
  listing: JobListingMvp,
  locationConstraints: string[] | undefined,
): boolean {
  if (locationConstraints === undefined || locationConstraints.length === 0) {
    return true;
  }

  if (listing.location === undefined) {
    return true;
  }

  const listingLocation = listing.location.toLowerCase();
  return locationConstraints.some((constraint) => {
    const normalizedConstraint = constraint.trim().toLowerCase();
    return normalizedConstraint.length > 0 && listingLocation.includes(normalizedConstraint);
  });
}

function matchesWorkModeConstraint(
  listing: JobListingMvp,
  workModeConstraints: JobSearchConstraints['workMode'],
): boolean {
  if (workModeConstraints === undefined || workModeConstraints.length === 0) {
    return true;
  }

  if (listing.workMode === 'unknown') {
    return true;
  }

  return workModeConstraints.includes(listing.workMode);
}

function matchesSalaryConstraint(listing: JobListingMvp, maxSalary: number | undefined): boolean {
  if (maxSalary === undefined) {
    return true;
  }

  if (listing.salaryRaw === undefined) {
    return true;
  }

  const parsedSalaryMax = parseSalaryMax(listing.salaryRaw);
  if (parsedSalaryMax === undefined) {
    return true;
  }

  return parsedSalaryMax <= maxSalary;
}

function matchesTitleConstraint(
  listing: JobListingMvp,
  excludeTitles: string[] | undefined,
): boolean {
  if (excludeTitles === undefined || excludeTitles.length === 0) {
    return true;
  }

  const title = listing.title.toLowerCase();
  return !excludeTitles.some((keyword) => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return normalizedKeyword.length > 0 && title.includes(normalizedKeyword);
  });
}

function parseSalaryMax(salaryRaw: string): number | undefined {
  const matches = salaryRaw.match(/\d[\d,]*(?:\.\d+)?\s*k?/gi);
  if (matches === null || matches.length === 0) {
    return undefined;
  }

  const values = matches
    .map((match) => {
      const normalized = match.replace(/,/g, '').trim().toLowerCase();
      const multiplier = normalized.endsWith('k') ? 1000 : 1;
      const numericPart = normalized.endsWith('k') ? normalized.slice(0, -1) : normalized;
      const value = Number.parseFloat(numericPart);
      return Number.isFinite(value) ? value * multiplier : undefined;
    })
    .filter((value): value is number => value !== undefined);

  if (values.length === 0) {
    return undefined;
  }

  return Math.max(...values);
}

function resolveSemanticScore(
  listing: JobListingMvp,
  index: number,
  semanticScores: Map<string, number> | undefined,
): number {
  if (semanticScores === undefined) {
    return 0;
  }

  if (listing.jobId !== undefined) {
    const jobScore = semanticScores.get(listing.jobId);
    if (jobScore !== undefined) {
      return jobScore;
    }
  }

  if (listing.sourceUrl !== undefined) {
    const sourceScore = semanticScores.get(listing.sourceUrl);
    if (sourceScore !== undefined) {
      return sourceScore;
    }
  }

  const indexScore = semanticScores.get(String(index));
  if (indexScore !== undefined) {
    return indexScore;
  }

  return 0;
}

function calculateLocationScore(
  listing: JobListingMvp,
  locationConstraints: string[] | undefined,
): number {
  if (locationConstraints === undefined || locationConstraints.length === 0) {
    return 0.5;
  }

  if (listing.location === undefined) {
    return 0;
  }

  const listingLocation = listing.location.toLowerCase();
  return locationConstraints.some((constraint) => {
    const normalizedConstraint = constraint.trim().toLowerCase();
    return normalizedConstraint.length > 0 && listingLocation.includes(normalizedConstraint);
  })
    ? 1
    : 0;
}

function calculateWorkModeScore(
  listing: JobListingMvp,
  workModeConstraints: JobSearchConstraints['workMode'],
): number {
  if (workModeConstraints === undefined || workModeConstraints.length === 0) {
    return 0.5;
  }

  if (listing.workMode === 'unknown') {
    return 0;
  }

  return workModeConstraints.includes(listing.workMode) ? 1 : 0;
}

export function calculateFreshnessScore(postedRaw: string | undefined): number {
  if (postedRaw === undefined) {
    return 0;
  }

  const normalized = postedRaw.trim().toLowerCase();
  const daysAgoPattern = /(?:posted\s+)?(\d+)\s+days?\s+ago/;
  const daysAgoMatch = daysAgoPattern.exec(normalized);
  if (daysAgoMatch?.[1] !== undefined) {
    return scoreByAge(Number.parseInt(daysAgoMatch[1], 10));
  }

  if (normalized.includes('today')) {
    return 1;
  }

  if (normalized.includes('yesterday')) {
    return 1;
  }

  const parsedDate = Date.parse(postedRaw);
  if (Number.isNaN(parsedDate)) {
    return 0;
  }

  const ageInDays = Math.max(0, (Date.now() - parsedDate) / (1000 * 60 * 60 * 24));
  return scoreByAge(ageInDays);
}

/** @deprecated Use calculateFreshnessScore instead */
export function calculateRecencyScore(postedRaw: string | undefined): number {
  return calculateFreshnessScore(postedRaw);
}

export function calculateSourceReliability(source: JobSource): number {
  switch (source) {
    case 'linkedin':
    case 'indeed':
      return 1.0;
    case 'glassdoor':
    case 'ziprecruiter':
      return 0.9;
    case 'seek':
    case 'monster':
      return 0.7;
    case 'jora':
    case 'jooble':
    case 'other':
      return 0.5;
    default:
      return 0.5;
  }
}

export function calculateDuplicateScore(company: string, title: string): number {
  const clusters: GraphDuplicateCluster[] = findDuplicatesByTitleCompany(company, title);
  if (clusters.length === 0) return 0;

  const cluster = clusters[0];
  if (!cluster) return 0;

  // More duplicates + multiple sites = higher confidence (breadth signal)
  // Max boost: 0.15
  const siteCount = cluster.memberSites.length;
  return Math.min(siteCount * 0.05, 0.15);
}

export function calculateCompanyReliability(company: string): number {
  const companyId = company.trim().toLowerCase();
  const historicalJobs = findJobsByCompany(companyId);
  const count = historicalJobs.length;

  // Returns 0.0 to 0.1 boost
  // More consistent postings = more reliable.
  if (count > 5) return 0.1;
  if (count >= 3) return 0.05;
  if (count >= 1) return 0.02;
  return 0;
}

function scoreByAge(ageInDays: number): number {
  if (ageInDays <= 7) {
    return 1;
  }

  if (ageInDays <= 30) {
    return 0.7;
  }

  if (ageInDays <= 90) {
    return 0.3;
  }

  return 0;
}

function calculateCompletenessScore(listing: JobListingMvp): number {
  const populatedFields = [
    listing.company !== undefined,
    listing.location !== undefined,
    listing.salaryRaw !== undefined,
    listing.workMode !== 'unknown',
  ].filter(Boolean).length;

  return populatedFields / 4;
}

function collectMatchedConstraints(
  listing: JobListingMvp,
  constraints: JobSearchConstraints | undefined,
): string[] {
  if (constraints === undefined) {
    return [];
  }

  const matchedConstraints: string[] = [];

  if (constraints.location !== undefined && listing.location !== undefined) {
    const matchedLocation = constraints.location.find((constraint) => {
      const normalizedConstraint = constraint.trim().toLowerCase();
      return (
        normalizedConstraint.length > 0 &&
        listing.location?.toLowerCase().includes(normalizedConstraint)
      );
    });
    if (matchedLocation !== undefined) {
      matchedConstraints.push(`location: ${matchedLocation}`);
    }
  }

  if (constraints.workMode !== undefined && listing.workMode !== 'unknown') {
    const matchedWorkMode = constraints.workMode.find(
      (constraint) => constraint === listing.workMode,
    );
    if (matchedWorkMode !== undefined) {
      matchedConstraints.push(`work mode: ${matchedWorkMode}`);
    }
  }

  if (constraints.maxSalary !== undefined && listing.salaryRaw !== undefined) {
    const parsedSalaryMax = parseSalaryMax(listing.salaryRaw);
    if (parsedSalaryMax !== undefined && parsedSalaryMax <= constraints.maxSalary) {
      matchedConstraints.push('salary within budget');
    }
  }

  return matchedConstraints;
}
