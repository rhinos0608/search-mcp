import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { detectJobSource, getSourceProfile } from '../src/rag/sources/jobSources.js';
import type { JobListingMvp } from '../src/rag/types/job.js';
import {
  chunksFromJobListings,
  documentsFromJobListings,
  extractCompany,
  extractCaveats,
  extractJobId,
  extractJobListingsFromHtml,
  extractLocation,
  extractPostedDate,
  extractSalaryRaw,
  extractTitle,
  extractWorkMode,
} from '../src/rag/adapters/job.js';

function loadFixture(name: string): string {
  const candidates = [
    new URL(`./fixtures/jobs/${name}`, import.meta.url),
    new URL(`../../../test/fixtures/jobs/${name}`, import.meta.url),
  ];

  for (const candidate of candidates) {
    try {
      return readFileSync(fileURLToPath(candidate), 'utf8');
    } catch {
      // Try the next location.
    }
  }

  return readFileSync(path.join(process.cwd(), 'test/fixtures/jobs', name), 'utf8');
}

test('detectJobSource matches known job hosts', () => {
  assert.equal(detectJobSource('https://www.seek.com.au/job/12345'), 'seek');
  assert.equal(detectJobSource('https://au.indeed.com/viewjob?jk=abc'), 'indeed');
  assert.equal(detectJobSource('https://www.jora.com/job/12345'), 'jora');
  assert.equal(detectJobSource('https://example.com/job/12345'), 'other');
});

test('detectJobSource is reflected in source profiles', () => {
  assert.equal(getSourceProfile('seek').source, 'seek');
  assert.equal(getSourceProfile('indeed').source, 'indeed');
  assert.equal(getSourceProfile('jora').source, 'jora');
});

test('extracts Seek basic listing fields', () => {
  const html = loadFixture('seek-basic.html');
  const url = 'https://www.seek.com.au/job/12345';
  const listings = extractJobListingsFromHtml(html, url);

  assert.equal(listings.length, 1);
  const listing = listings[0];
  assert.ok(listing);

  assert.equal(extractTitle(html), 'Frontend Developer');
  assert.equal(extractCompany(html), 'Atlas Digital Pty Ltd');
  assert.equal(extractLocation(html), 'Sydney NSW');
  assert.equal(extractWorkMode(html), 'hybrid');
  assert.equal(extractSalaryRaw(html), '$35-45.60/hr');
  assert.equal(extractJobId(url, html), '12345');
  assert.equal(extractPostedDate(html), '2026-04-20');
  assert.deepEqual(extractCaveats(html), ['contract']);

  assert.equal(listing.title, 'Frontend Developer');
  assert.equal(listing.company, 'Atlas Digital Pty Ltd');
  assert.equal(listing.location, 'Sydney NSW');
  assert.equal(listing.workMode, 'hybrid');
  assert.equal(listing.salaryRaw, '$35-45.60/hr');
  assert.equal(listing.jobId, '12345');
  assert.equal(listing.postedRaw, '2026-04-20');
  assert.equal(listing.verificationStatus, 'listing_page_fetched');
  assert.ok(listing.confidence.overall > 0.5);
});

test('extracts Seek listing without salary', () => {
  const html = loadFixture('seek-no-salary.html');
  const listings = extractJobListingsFromHtml(html, 'https://www.seek.com.au/job/67890');

  assert.equal(listings.length, 1);
  const listing = listings[0];
  assert.ok(listing);

  assert.equal(listing.title, 'Product Designer');
  assert.equal(listing.company, 'North Star Studio');
  assert.equal(listing.salaryRaw, undefined);
  assert.equal(listing.confidence.salary, 0);
});

test('extracts Indeed listing fields', () => {
  const html = loadFixture('indeed-basic.html');
  const listings = extractJobListingsFromHtml(html, 'https://au.indeed.com/viewjob?jk=a1b2c3d4');

  assert.equal(listings.length, 1);
  const listing = listings[0];
  assert.ok(listing);

  assert.equal(listing.title, 'Software Engineer');
  assert.equal(listing.company, 'Southern Cross Tech');
  assert.equal(listing.location, 'Melbourne VIC');
  assert.equal(listing.workMode, 'remote');
  assert.equal(listing.salaryRaw, '$60,000 - $80,000 a year');
  assert.equal(listing.postedRaw, 'Posted 3 days ago');
  assert.equal(listing.verificationStatus, 'listing_page_fetched');
});

test('marks Jora aggregator listings as aggregator_result', () => {
  const html = loadFixture('jora-aggregated.html');
  const listings = extractJobListingsFromHtml(html, 'https://www.jora.com/job/99999');

  assert.equal(listings.length, 1);
  const listing = listings[0];
  assert.ok(listing);

  assert.equal(listing.verificationStatus, 'aggregator_result');
});

test('extracts minimal generic listing conservatively', () => {
  const html = loadFixture('generic-job.html');
  const listings = extractJobListingsFromHtml(
    html,
    'https://example.com/jobs/temporary-contract-role',
  );

  assert.equal(listings.length, 1);
  const listing = listings[0];
  assert.ok(listing);

  assert.equal(listing.title, 'Temporary Contract Role');
  assert.equal(listing.company, undefined);
  assert.equal(listing.location, undefined);
  assert.equal(listing.salaryRaw, undefined);
  assert.ok(listing.confidence.overall < 0.4);
  assert.deepEqual(extractCaveats(html), ['contract', 'temp']);
});

test('extractJobId reads ids from url path and data attributes', () => {
  const html = loadFixture('seek-basic.html');
  assert.equal(extractJobId('https://www.seek.com.au/job/12345', html), '12345');
  assert.equal(extractJobId('https://www.seek.com.au/job/12345?foo=bar', html), '12345');
});

test('documentsFromJobListings builds embedding-friendly documents', () => {
  const listings: JobListingMvp[] = [
    {
      title: 'Frontend Developer',
      company: 'Atlas Digital Pty Ltd',
      location: 'Sydney NSW',
      workMode: 'hybrid',
      salaryRaw: '$35-45.60/hr',
      source: 'seek',
      sourceUrl: 'https://www.seek.com.au/job/12345',
      jobId: '12345',
      extractedText: 'Build user interfaces',
      confidence: { title: 0.95, location: 0.8, workMode: 0.9, salary: 0.85, overall: 0.87 },
      verificationStatus: 'listing_page_fetched',
      caveats: ['contract'],
    },
  ];

  const documents = documentsFromJobListings(listings);

  assert.equal(documents.length, 1);
  assert.equal(documents[0]?.adapter, 'search');
  assert.equal(documents[0]?.id, '12345');
  assert.equal(documents[0]?.url, 'https://www.seek.com.au/job/12345');
  assert.equal(documents[0]?.title, 'Frontend Developer');
  assert.match(documents[0]?.text ?? '', /Frontend Developer/);
  assert.match(documents[0]?.text ?? '', /Atlas Digital Pty Ltd/);
  assert.match(documents[0]?.text ?? '', /Sydney NSW/);
  assert.match(documents[0]?.text ?? '', /hybrid/);
  assert.match(documents[0]?.text ?? '', /\$35-45\.60\/hr/);
  assert.match(documents[0]?.text ?? '', /Build user interfaces/);
  assert.deepEqual(documents[0]?.metadata, {
    source: 'seek',
    sourceUrl: 'https://www.seek.com.au/job/12345',
    jobId: '12345',
    confidence: { title: 0.95, location: 0.8, workMode: 0.9, salary: 0.85, overall: 0.87 },
    verificationStatus: 'listing_page_fetched',
    caveats: ['contract'],
  });
});

test('chunksFromJobListings builds one chunk per listing', () => {
  const listings: JobListingMvp[] = [
    {
      title: 'Frontend Developer',
      company: 'Atlas Digital Pty Ltd',
      location: 'Sydney NSW',
      workMode: 'hybrid',
      source: 'seek',
      sourceUrl: 'https://www.seek.com.au/job/12345',
      jobId: '12345',
      extractedText: 'Build user interfaces',
      confidence: { title: 0.95, location: 0.8, workMode: 0.9, salary: 0.85, overall: 0.87 },
      verificationStatus: 'listing_page_fetched',
      caveats: ['contract'],
    },
  ];

  const chunks = chunksFromJobListings(listings);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.section, 'Atlas Digital Pty Ltd > Frontend Developer');
  assert.equal(chunks[0]?.chunkIndex, 0);
  assert.equal(chunks[0]?.totalChunks, 1);
  assert.equal(chunks[0]?.url, 'https://www.seek.com.au/job/12345');
  assert.deepEqual(chunks[0]?.metadata, listings[0]);
  assert.match(chunks[0]?.text ?? '', /Frontend Developer/);
  assert.match(chunks[0]?.text ?? '', /Build user interfaces/);
});
