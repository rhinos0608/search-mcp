import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyListingUrl } from '../../src/jobs/acquisition/listingHeuristics.js';

// F2: aggregate pages are discovery artifacts, never candidates; postings
// survive. Heuristics are pure string ops (zero network).
test('LinkedIn job view is posting, jobs/search is aggregate', () => {
  assert.equal(classifyListingUrl('https://www.linkedin.com/jobs/view/1234567'), 'posting');
  assert.equal(
    classifyListingUrl('https://www.linkedin.com/jobs/search?keywords=engineer'),
    'aggregate',
  );
});

test('Indeed viewjob and jk= are postings', () => {
  assert.equal(classifyListingUrl('https://au.indeed.com/viewjob?jk=abc123'), 'posting');
  assert.equal(classifyListingUrl('https://au.indeed.com/m/viewjob?jk=xyz789'), 'posting');
});

test('Glassdoor job-listing is posting', () => {
  assert.equal(
    classifyListingUrl('https://www.glassdoor.com/job-listing/senior-engineer_1001.htm'),
    'posting',
  );
});

test('SEEK /job/<digits> is posting; /jobs collection and keyword SERP are aggregate', () => {
  assert.equal(classifyListingUrl('https://www.seek.com.au/job/78901234'), 'posting');
  assert.equal(classifyListingUrl('https://www.seek.com.au/jobs?keywords=plumber'), 'aggregate');
  assert.equal(classifyListingUrl('https://www.seek.com.au/jobs'), 'aggregate');
});

test('generic /job/<numeric-id> is posting; slug without id stays unknown', () => {
  assert.equal(classifyListingUrl('https://example.test/job/424242'), 'posting');
  assert.equal(classifyListingUrl('https://example.test/job/engineering-role'), 'unknown');
});

test('ATS job-id paths are postings', () => {
  assert.equal(classifyListingUrl('https://boards.greenhouse.io/acme/jobs/4012345'), 'posting');
  assert.equal(classifyListingUrl('https://jobs.lever.co/acme/1a2b3c4d'), 'posting');
  assert.equal(classifyListingUrl('https://jobs.ashbyhq.com/acme/posting/abc123'), 'posting');
});

test('article/blog/career-advice/company pages are aggregate', () => {
  assert.equal(classifyListingUrl('https://example.test/blog/how-to-interview'), 'aggregate');
  assert.equal(classifyListingUrl('https://example.test/articles/top-10-tips'), 'aggregate');
  assert.equal(classifyListingUrl('https://example.test/career-advice/resumes'), 'aggregate');
  assert.equal(classifyListingUrl('https://www.linkedin.com/company/acme/'), 'aggregate');
});

test('editorial title downgrades unknown URL to aggregate, never a posting URL', () => {
  assert.equal(
    classifyListingUrl('https://example.test/careers/pathways', 'How to become a plumber'),
    'aggregate',
  );
  assert.equal(
    classifyListingUrl('https://www.seek.com.au/job/78901234', 'How to become a plumber'),
    'posting',
  );
  assert.equal(classifyListingUrl('https://example.test/careers/pathways'), 'unknown');
});

test('unknown URLs are kept (no silent exclusion)', () => {
  assert.equal(classifyListingUrl('https://example.test/careers/engineering'), 'unknown');
  assert.equal(classifyListingUrl('not a url'), 'unknown');
  assert.equal(classifyListingUrl(''), 'unknown');
});
