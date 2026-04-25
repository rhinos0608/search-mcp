import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { detectJobSource, getSourceProfile } from '../src/rag/sources/jobSources.js';
import {
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
