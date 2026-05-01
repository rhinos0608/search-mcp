import test from 'node:test';
import assert from 'node:assert/strict';
import { JobPipeline } from '../src/rag/jobPipeline.js';
import type { FlatJobRecord } from '../src/utils/jobspyClient.js';

test('JobPipeline: Stage 1 returns results from JobSpy', async () => {
  const mockRecord = {
    id: 'li-123',
    site: 'linkedin',
    title: 'Software Engineer',
    company: 'Google',
    jobUrl: 'https://linkedin.com/jobs/view/123',
    description: 'Full stack engineer position at Google',
    location: 'San Francisco',
    date_posted: '2026-04-01',
    job_type: 'fulltime',
    is_remote: true,
  } as unknown as FlatJobRecord;

  const pipeline = new JobPipeline({
    searchJobSpy: async () => [mockRecord],
  });

  const results = await pipeline.discover({ query: 'software engineer' });
  assert.ok(results.length > 0);
  assert.equal(results[0]?.title, 'Software Engineer');
  assert.equal(results[0]?.site, 'linkedin');
});

test('JobPipeline: Stage 1 fallback returns empty when no results', async () => {
  const pipeline = new JobPipeline({
    searchJobSpy: async () => [],
    webSearch: async () => [],
  });

  const results = await pipeline.discover({ query: 'nonexistent' });
  assert.equal(results.length, 0);
});

test('JobPipeline: normalize clusters duplicates', async () => {
  const pipeline = new JobPipeline({
    searchJobSpy: async () => [],
    webSearch: async () => [],
  });

  const rawRecords = [
    {
      site: 'linkedin', title: 'Dev', jobUrl: 'https://li.com/1',
      company: 'Google', location: 'SF',
    },
    {
      site: 'indeed', title: 'Dev', jobUrl: 'https://in.com/1',
      company: 'Google', location: 'SF',
    },
  ];

  const normalized = await pipeline.normalize(rawRecords, 'developer');
  // dedupJobListings clusters by company+title, so we should get 1
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.company, 'Google');
});

test('JobPipeline: scoreMetadata ranks items', () => {
  const pipeline = new JobPipeline();
  const records = [
    {
      site: 'li', title: 'Senior Dev', jobUrl: 'url1',
      company: 'A', workMode: 'onsite' as const,
      confidence: 1, caveats: [],
    },
    {
      site: 'li', title: 'Junior Dev', jobUrl: 'url2',
      company: 'A', workMode: 'remote' as const,
      confidence: 1, caveats: [],
    },
  ];

  const scored = pipeline.scoreMetadata(records, { workMode: ['remote'] });
  assert.ok(scored.length > 0);
  const topScore = scored[0];
  assert.ok(topScore !== undefined);
});

test('JobPipeline: verifyHealth does not throw', async () => {
  const pipeline = new JobPipeline();
  // Should not throw regardless of real backend availability
  let threw = false;
  try {
    await pipeline.verifyHealth();
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
});
