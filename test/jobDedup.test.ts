import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupJobListings } from '../src/rag/jobDedup.js';
import type { JobListingMvp } from '../src/rag/types/job.js';

function makeListing(
  overrides: Partial<JobListingMvp> &
    Pick<
      JobListingMvp,
      | 'title'
      | 'workMode'
      | 'source'
      | 'extractedText'
      | 'confidence'
      | 'verificationStatus'
      | 'caveats'
    >,
): JobListingMvp {
  const listing: JobListingMvp = {
    title: overrides.title,
    workMode: overrides.workMode,
    source: overrides.source,
    extractedText: overrides.extractedText,
    confidence: overrides.confidence,
    verificationStatus: overrides.verificationStatus,
    caveats: overrides.caveats,
  };

  if (overrides.company !== undefined) listing.company = overrides.company;
  if (overrides.location !== undefined) listing.location = overrides.location;
  if (overrides.salaryRaw !== undefined) listing.salaryRaw = overrides.salaryRaw;
  if (overrides.sourceUrl !== undefined) listing.sourceUrl = overrides.sourceUrl;
  if (overrides.jobId !== undefined) listing.jobId = overrides.jobId;
  if (overrides.postedRaw !== undefined) listing.postedRaw = overrides.postedRaw;

  return listing;
}

const lowConfidence = { title: 0.5, location: 0.5, workMode: 0.5, salary: 0.5, overall: 0.5 };
const highConfidence = { title: 0.9, location: 0.9, workMode: 0.9, salary: 0.9, overall: 0.9 };

test('dedupJobListings prefers the more reliable source for identical URLs', () => {
  const listings = [
    makeListing({
      title: 'Role A',
      workMode: 'remote',
      source: 'other',
      sourceUrl: 'https://example.com/job/123',
      extractedText: 'A',
      confidence: lowConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
    makeListing({
      title: 'Role B',
      workMode: 'remote',
      source: 'seek',
      sourceUrl: 'https://example.com/job/123',
      extractedText: 'B',
      confidence: lowConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
  ];

  const deduped = dedupJobListings(listings);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.source, 'seek');
});

test('dedupJobListings prefers higher confidence for identical source and jobId', () => {
  const listings = [
    makeListing({
      title: 'Role A',
      workMode: 'remote',
      source: 'seek',
      jobId: 'abc123',
      extractedText: 'A',
      confidence: lowConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
    makeListing({
      title: 'Role A better',
      workMode: 'remote',
      source: 'seek',
      jobId: 'abc123',
      extractedText: 'B',
      confidence: highConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
  ];

  const deduped = dedupJobListings(listings);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.confidence.overall, 0.9);
});

test('dedupJobListings treats matching company and title as duplicates', () => {
  const listings = [
    makeListing({
      title: 'Frontend Developer',
      company: 'Atlas Digital',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'A',
      confidence: lowConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
    makeListing({
      title: 'Frontend Developer',
      company: 'Atlas Digital',
      workMode: 'remote',
      source: 'indeed',
      extractedText: 'B',
      confidence: highConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
  ];

  const deduped = dedupJobListings(listings);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.source, 'indeed');
});
