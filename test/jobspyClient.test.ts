import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_JOBSPY_SITES,
  buildJobSpyParams,
  normalizeFlatJobRecord,
} from '../src/utils/jobspyClient.js';

test('jobspy params default to safe sites', () => {
  const params = buildJobSpyParams({ query: 'react developer' });
  assert.deepEqual(params.site_name, [...DEFAULT_JOBSPY_SITES]);
  assert.equal(params.search_term, 'react developer');
});

test('jobspy params forward country and explicit sites', () => {
  const params = buildJobSpyParams({
    query: 'react developer',
    sites: ['linkedin', 'google'],
    country: 'australia',
    location: 'Sydney NSW',
  });

  assert.deepEqual(params.site_name, ['linkedin', 'google']);
  assert.equal(params.country_indeed, 'australia');
  assert.equal(params.location, 'Sydney NSW');
});

test('normalizeFlatJobRecord falls back to direct job url', () => {
  const record = normalizeFlatJobRecord({
    site: 'linkedin',
    job_url: '   ',
    job_url_direct: 'https://example.com/jobs/123',
    title: 'Software Engineer',
  });

  assert.equal(record.job_url, 'https://example.com/jobs/123');
  assert.equal(record.job_url_direct, 'https://example.com/jobs/123');
});
