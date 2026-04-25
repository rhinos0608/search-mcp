import type { JobListingMvp } from './types/job.js';

export interface DedupResult {
  canonical: JobListingMvp;
  removedCount: number;
  reason: string;
}

const SOURCE_RELIABILITY: Record<JobListingMvp['source'], number> = {
  seek: 0,
  indeed: 1,
  jora: 2,
  other: 3,
};

export function dedupJobListings(listings: JobListingMvp[]): JobListingMvp[] {
  return dedupByCompanyAndTitle(dedupBySourceAndJobId(dedupBySourceUrl(listings)));
}

function dedupBySourceUrl(listings: JobListingMvp[]): JobListingMvp[] {
  const result: JobListingMvp[] = [];
  const seen = new Map<string, number>();

  for (const listing of listings) {
    if (listing.sourceUrl === undefined) {
      result.push(listing);
      continue;
    }

    const existingIndex = seen.get(listing.sourceUrl);
    if (existingIndex === undefined) {
      seen.set(listing.sourceUrl, result.length);
      result.push(listing);
      continue;
    }

    const existing = result[existingIndex];
    if (existing === undefined || isMoreReliable(listing.source, existing.source)) {
      result[existingIndex] = listing;
    }
  }

  return result;
}

function dedupBySourceAndJobId(listings: JobListingMvp[]): JobListingMvp[] {
  const result: JobListingMvp[] = [];
  const seen = new Map<string, number>();

  for (const listing of listings) {
    if (listing.jobId === undefined) {
      result.push(listing);
      continue;
    }

    const key = `${listing.source}:${listing.jobId}`;
    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, result.length);
      result.push(listing);
      continue;
    }

    const existing = result[existingIndex];
    if (existing === undefined || listing.confidence.overall > existing.confidence.overall) {
      result[existingIndex] = listing;
    }
  }

  return result;
}

function dedupByCompanyAndTitle(listings: JobListingMvp[]): JobListingMvp[] {
  const result: JobListingMvp[] = [];
  const seen = new Map<string, number>();

  for (const listing of listings) {
    if (listing.company === undefined) {
      result.push(listing);
      continue;
    }

    const key = `${normalize(listing.company)}|${normalize(listing.title)}`;
    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, result.length);
      result.push(listing);
      continue;
    }

    const existing = result[existingIndex];
    if (existing === undefined || listing.confidence.overall > existing.confidence.overall) {
      result[existingIndex] = listing;
    }
  }

  return result;
}

function isMoreReliable(left: JobListingMvp['source'], right: JobListingMvp['source']): boolean {
  return SOURCE_RELIABILITY[left] < SOURCE_RELIABILITY[right];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
