import assert from 'node:assert/strict';
import test from 'node:test';

import type { JobListingMvp, JobSearchConstraints } from '../src/rag/types/job.js';
import { applyHardFilters, rankJobListings } from '../src/rag/jobRanking.js';

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

  if (overrides.company !== undefined) {
    listing.company = overrides.company;
  }
  if (overrides.location !== undefined) {
    listing.location = overrides.location;
  }
  if (overrides.salaryRaw !== undefined) {
    listing.salaryRaw = overrides.salaryRaw;
  }
  if (overrides.sourceUrl !== undefined) {
    listing.sourceUrl = overrides.sourceUrl;
  }
  if (overrides.jobId !== undefined) {
    listing.jobId = overrides.jobId;
  }
  if (overrides.postedRaw !== undefined) {
    listing.postedRaw = overrides.postedRaw;
  }

  return listing;
}

const baseConfidence = { title: 0.9, location: 0.8, workMode: 0.9, salary: 0.8, overall: 0.85 };

function makeConstraints(overrides: JobSearchConstraints): JobSearchConstraints {
  return overrides;
}

test('applyHardFilters with location constraint keeps matching listings', () => {
  const listings = [
    makeListing({
      title: 'Sydney Developer',
      location: 'Sydney NSW',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Sydney listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
    makeListing({
      title: 'Melbourne Developer',
      location: 'Melbourne VIC',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Melbourne listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
    makeListing({
      title: 'Unknown Location Developer',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Unknown location listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
  ];

  const filtered = applyHardFilters(listings, makeConstraints({ location: ['Sydney'] }));

  assert.deepEqual(
    filtered.map((listing) => listing.title),
    ['Sydney Developer', 'Unknown Location Developer'],
  );
});

test('applyHardFilters with workMode constraint keeps matching and unknown', () => {
  const listings = [
    makeListing({
      title: 'Remote Developer',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Remote listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
    makeListing({
      title: 'Hybrid Developer',
      workMode: 'hybrid',
      source: 'seek',
      extractedText: 'Hybrid listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
    makeListing({
      title: 'Unknown Mode Developer',
      workMode: 'unknown',
      source: 'seek',
      extractedText: 'Unknown mode listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
  ];

  const filtered = applyHardFilters(listings, makeConstraints({ workMode: ['remote'] }));

  assert.deepEqual(
    filtered.map((listing) => listing.title),
    ['Remote Developer', 'Unknown Mode Developer'],
  );
});

test('applyHardFilters with maxSalary filters high-salary only', () => {
  const listings = [
    makeListing({
      title: 'Budget Developer',
      salaryRaw: '$30-40/hr',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Budget listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
    makeListing({
      title: 'Expensive Developer',
      salaryRaw: '$80-100k/year',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Expensive listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
    makeListing({
      title: 'No Salary Developer',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'No salary listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
  ];

  const filtered = applyHardFilters(listings, makeConstraints({ maxSalary: 50000 }));

  assert.deepEqual(
    filtered.map((listing) => listing.title),
    ['Budget Developer', 'No Salary Developer'],
  );
});

test('applyHardFilters with excludeTitles removes matches', () => {
  const listings = [
    makeListing({
      title: 'Senior Developer',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Senior listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
    makeListing({
      title: 'Junior Developer',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Junior listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
    makeListing({
      title: 'Frontend Developer',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Frontend listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
    }),
  ];

  const filtered = applyHardFilters(listings, makeConstraints({ excludeTitles: ['Senior'] }));

  assert.deepEqual(
    filtered.map((listing) => listing.title),
    ['Junior Developer', 'Frontend Developer'],
  );
});

test('rankJobListings scores location match higher than non-match', () => {
  const listings = [
    makeListing({
      title: 'Sydney Developer',
      location: 'Sydney NSW',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Sydney listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
      sourceUrl: 'https://example.com/sydney',
    }),
    makeListing({
      title: 'Melbourne Developer',
      location: 'Melbourne VIC',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Melbourne listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
      sourceUrl: 'https://example.com/melbourne',
    }),
  ];

  const semanticScores = new Map<string, number>([
    ['https://example.com/sydney', 0.8],
    ['https://example.com/melbourne', 0.8],
  ]);

  const ranked = rankJobListings(listings, 'developer', { location: ['Sydney'] }, semanticScores);

  assert.equal(ranked[0]?.listing.title, 'Sydney Developer');
  assert.equal(ranked[1]?.listing.title, 'Melbourne Developer');
});

test('rankJobListings without semantic scores uses neutral baseline', () => {
  const listings = [
    makeListing({
      title: 'Developer A',
      location: 'Sydney NSW',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'A listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
      sourceUrl: 'https://example.com/a',
    }),
    makeListing({
      title: 'Developer B',
      location: 'Sydney NSW',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'B listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
      sourceUrl: 'https://example.com/b',
    }),
  ];

  const ranked = rankJobListings(listings, 'developer', { location: ['Sydney'] });

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]?.overallScore, ranked[1]?.overallScore);
});

test('rankJobListings with recent postings scores higher recency', () => {
  const listings = [
    makeListing({
      title: 'Recent Developer',
      postedRaw: 'Posted 2 days ago',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Recent listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
      sourceUrl: 'https://example.com/recent',
    }),
    makeListing({
      title: 'Older Developer',
      postedRaw: 'Posted 60 days ago',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Older listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
      sourceUrl: 'https://example.com/older',
    }),
    makeListing({
      title: 'Unknown Date Developer',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Unknown date listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
      sourceUrl: 'https://example.com/unknown',
    }),
  ];

  const ranked = rankJobListings(listings, 'developer');

  assert.equal(ranked[0]?.listing.title, 'Recent Developer');
  assert.equal(ranked[1]?.listing.title, 'Older Developer');
  assert.equal(ranked[2]?.listing.title, 'Unknown Date Developer');
});

test('rankJobListings tracks matched constraints', () => {
  const listings = [
    makeListing({
      title: 'Sydney Remote Developer',
      location: 'Sydney NSW',
      workMode: 'remote',
      source: 'seek',
      extractedText: 'Sydney remote listing',
      confidence: baseConfidence,
      verificationStatus: 'listing_page_fetched',
      caveats: [],
      sourceUrl: 'https://example.com/matched',
    }),
  ];

  const ranked = rankJobListings(listings, 'developer', {
    location: ['Sydney'],
    workMode: ['remote'],
  });

  assert.deepEqual(ranked[0]?.matchedConstraints, ['location: Sydney', 'work mode: remote']);
});
