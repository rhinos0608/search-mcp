import test from 'node:test';
import assert from 'node:assert/strict';
import * as jobTypes from '../src/rag/types/job.js';
import type {
  JobListingMvp,
  JobSearchConstraints,
  JobSource,
  VerificationStatus,
  WorkMode,
} from '../src/rag/types/job.js';

test('job types accept minimal and optional listing shapes', () => {
  const minimalListing: JobListingMvp = {
    title: 'Frontend Developer',
    workMode: 'hybrid',
    source: 'seek',
    extractedText: 'Full listing content goes here.',
    confidence: {
      title: 1,
      location: 0.8,
      workMode: 1,
      salary: 0.4,
      overall: 0.9,
    },
    verificationStatus: 'listing_page_fetched',
    caveats: [],
  };

  const fullListing: JobListingMvp = {
    title: 'Senior Platform Engineer',
    company: 'Example Pty Ltd',
    location: 'Sydney NSW',
    workMode: 'remote',
    salaryRaw: '$150,000 - $170,000',
    source: 'indeed',
    sourceUrl: 'https://example.com/jobs/123',
    jobId: '123',
    postedRaw: 'Posted 3 days ago',
    extractedText: 'We are hiring a senior platform engineer.',
    confidence: {
      title: 0.98,
      location: 0.92,
      workMode: 0.97,
      salary: 0.88,
      overall: 0.94,
    },
    verificationStatus: 'aggregator_result',
    caveats: ['Salary normalized from a range.'],
  };

  assert.equal(minimalListing.workMode, 'hybrid');
  assert.equal(fullListing.company, 'Example Pty Ltd');
  assert.equal(typeof jobTypes, 'object');
});

test('job union types accept all declared values', () => {
  const workModes: WorkMode[] = ['onsite', 'hybrid', 'remote', 'unknown'];
  const verificationStatuses: VerificationStatus[] = [
    'listing_page_fetched',
    'search_result_only',
    'aggregator_result',
    'needs_manual_check',
  ];
  const sources: JobSource[] = ['seek', 'indeed', 'jora', 'other'];

  assert.deepEqual(workModes, ['onsite', 'hybrid', 'remote', 'unknown']);
  assert.deepEqual(verificationStatuses, [
    'listing_page_fetched',
    'search_result_only',
    'aggregator_result',
    'needs_manual_check',
  ]);
  assert.deepEqual(sources, ['seek', 'indeed', 'jora', 'other']);
});

test('job search constraints accept empty and complete shapes', () => {
  const emptyConstraints: JobSearchConstraints = {};
  const fullConstraints: JobSearchConstraints = {
    location: ['Sydney NSW', 'Remote'],
    workMode: ['onsite', 'hybrid'],
    maxSalary: 140000,
    excludeTitles: ['Intern', 'Graduate'],
  };

  assert.equal(emptyConstraints.location, undefined);
  assert.equal(fullConstraints.maxSalary, 140000);
});
