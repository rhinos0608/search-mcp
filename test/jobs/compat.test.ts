import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobListing, JobListingMvp } from '../../src/rag/types/job.js';
import { mapLegacyListing } from '../../src/jobs/compat/legacyListing.js';

const listing: JobListingMvp = {
  title: 'Senior Analyst',
  company: 'Example Pty Ltd',
  location: 'Sydney NSW',
  workMode: 'hybrid',
  salaryRaw: '$120,000 - $140,000',
  source: 'indeed',
  sourceUrl: 'https://jobs.example.test/123',
  jobId: '123',
  postedRaw: '3 days ago',
  extractedText: 'Analyse operations. Apply now.',
  confidence: { title: 0.9, location: 0.8, workMode: 0.7, salary: 0.6, overall: 0.8 },
  verificationStatus: 'aggregator_result',
  caveats: ['Legacy extraction'],
};

test('maps legacy fields and reports only fields without canonical representation', () => {
  const result = mapLegacyListing(listing, {
    sourceUrls: ['https://jobs.example.test/123', 'https://employer.example.test/careers/123'],
    capturedAt: '2025-01-01T00:00:00.000Z',
  });
  assert.equal(result.posting.title, listing.title);
  assert.equal(result.posting.organisation, listing.company);
  assert.deepEqual(result.posting.listingUrls, [
    'https://jobs.example.test/123',
    'https://employer.example.test/careers/123',
  ]);
  assert.deepEqual(result.posting.salaries, []);
  assert.equal(result.posting.confidence, 0.3);
  assert.equal(result.provenance.confidenceClass, 'legacy_low');
  assert.deepEqual(
    result.losses.map((loss) => loss.field).sort(),
    [
      'postedRaw',
      'verificationStatus',
      'confidence.title',
      'confidence.location',
      'confidence.workMode',
      'confidence.salary',
      'salaryRaw',
    ].sort(),
  );
});

test('maps enhanced legacy fields and reports retrieval-only fields', () => {
  const enhanced: JobListing = {
    ...listing,
    salary: { min: 120000, max: 140000, currency: 'AUD', unit: 'year', raw: '$120k-$140k' },
    requirements: [
      { category: 'essential', skill: 'analysis', years: 3, description: 'Analysis experience' },
    ],
    niceToHave: ['Public sector experience'],
    applyUrl: 'https://example.test/apply',
    seniority: 'senior',
    experience: { min: 3, unit: 'year' },
    postedAt: new Date('2025-01-01T00:00:00.000Z'),
    expiresAt: new Date('2025-02-01T00:00:00.000Z'),
    embedding: [0.1],
    bm25Tokens: ['analysis'],
  };
  const result = mapLegacyListing(enhanced, { capturedAt: '2025-01-01T00:00:00.000Z' });
  assert.equal(result.posting.salaries[0]?.currency, 'AUD');
  assert.equal(result.posting.requirements.length, 2);
  assert.equal(result.posting.seniority, 'senior');
  assert.equal(result.posting.closingAt, '2025-02-01T00:00:00.000Z');
  assert.deepEqual(result.posting.desirableCriteria, ['Public sector experience']);
  assert.deepEqual(
    result.losses.map((loss) => loss.field).sort(),
    [
      'embedding',
      'bm25Tokens',
      'verificationStatus',
      'confidence.title',
      'confidence.location',
      'confidence.workMode',
      'confidence.salary',
      'salaryRaw',
    ].sort(),
  );
});

test('keeps listing identity stable while observation changes with content', () => {
  const revised = { ...listing, extractedText: 'Updated role details.' };
  const first = mapLegacyListing(listing, { capturedAt: '2025-01-01T00:00:00.000Z' });
  const second = mapLegacyListing(revised, { capturedAt: '2025-01-02T00:00:00.000Z' });
  assert.equal(first.sourceListing.sourceListingId, second.sourceListing.sourceListingId);
  assert.notEqual(first.observation.observationId, second.observation.observationId);
});

test('does not fabricate salary semantics or remote eligibility', () => {
  const { location: _location, ...withoutLocation } = listing;
  const legacy: JobListingMvp = {
    ...withoutLocation,
    salaryRaw: '$50/hour',
    workMode: 'onsite',
  };
  const result = mapLegacyListing(legacy, { capturedAt: '2025-01-01T00:00:00.000Z' });
  assert.deepEqual(result.posting.salaries, []);
  assert.equal(result.posting.locations[0]?.remoteEligible, undefined);
  assert.ok(result.losses.some((loss) => loss.field === 'salaryRaw'));
  assert.ok(result.losses.some((loss) => loss.field === 'location'));
});

test('drops malformed structured salary and records bounded input loss', () => {
  const oversizedRaw = 'x'.repeat(700);
  const malformed = {
    ...listing,
    salary: { min: -1, max: 2, currency: 'dollars', unit: 'year', raw: oversizedRaw },
    requirements: [],
  } as JobListing;
  const result = mapLegacyListing(malformed, { capturedAt: '2025-01-01T00:00:00.000Z' });
  assert.deepEqual(result.posting.salaries, []);
  const loss = result.losses.find((item) => item.field === 'salary');
  assert.ok(loss);
  assert.equal(typeof loss.value, 'object');
  assert.equal((loss.value as { raw: string }).raw.length, 512);
  assert.equal((loss.value as { raw: string }).raw, oversizedRaw.slice(0, 512));
});

test('drops negative experience and does not fabricate missing experience minimum', () => {
  const malformed = {
    ...listing,
    requirements: [],
    experience: { min: -1, max: 3, unit: 'year' },
  } as JobListing;
  const dropped = mapLegacyListing(malformed, { capturedAt: '2025-01-01T00:00:00.000Z' });
  assert.equal(dropped.posting.requirements.length, 0);
  assert.ok(dropped.losses.some((item) => item.field === 'experience'));

  const upTo = mapLegacyListing(
    { ...listing, requirements: [], experience: { max: 3, unit: 'year' } } as JobListing,
    { capturedAt: '2025-01-01T00:00:00.000Z' },
  );
  assert.equal(upTo.posting.requirements[0]?.rawText, 'Experience: up to 3 years');
  assert.deepEqual(upTo.posting.requirements[0]?.years, { max: 3, unit: 'year' });
});

test('maps malformed legacy strings without throwing and records losses', () => {
  const malformed = {
    ...listing,
    title: '',
    extractedText: '',
    sourceUrl: 'not a url',
    applyUrl: 'bad url',
  } as JobListing;
  const result = mapLegacyListing(malformed, { capturedAt: '2025-01-01T00:00:00.000Z' });
  assert.ok(result.posting.title.length > 0);
  assert.ok(result.posting.description.length > 0);
  assert.ok(result.losses.some((loss) => loss.field === 'title'));
  assert.ok(result.losses.some((loss) => loss.field === 'extractedText'));
  assert.ok(result.losses.some((loss) => loss.field === 'applyUrl'));
  assert.ok(result.evidence.length > 0);
});

test('adversarial salary totality: malformed inputs omit without throw and bound losses', () => {
  const cases: Array<{ salary: unknown; label: string }> = [
    {
      label: 'min>max',
      salary: { min: 200000, max: 100000, currency: 'AUD', unit: 'year', raw: '$200k-$100k' },
    },
    {
      label: 'negative min',
      salary: { min: -5, max: 100, currency: 'AUD', unit: 'year', raw: '$bad' },
    },
    {
      label: 'currency too long',
      salary: { min: 10, max: 20, currency: 'dollars', unit: 'year', raw: '$10-$20' },
    },
    {
      label: 'currency too short',
      salary: { min: 10, max: 20, currency: 'A$', unit: 'year', raw: '$10-$20' },
    },
    { label: 'empty raw', salary: { min: 10, max: 20, currency: 'AUD', unit: 'year', raw: '' } },
    {
      label: 'whitespace raw',
      salary: { min: 10, max: 20, currency: 'AUD', unit: 'year', raw: '   ' },
    },
    {
      label: 'invalid unit',
      salary: { min: 10, max: 20, currency: 'AUD', unit: 'decade', raw: '$10-$20' },
    },
    { label: 'NaN min', salary: { min: NaN, max: 20, currency: 'AUD', unit: 'year', raw: '$na' } },
    {
      label: 'Infinity max',
      salary: { min: 10, max: Infinity, currency: 'AUD', unit: 'year', raw: '$inf' },
    },
    { label: 'missing currency', salary: { min: 10, max: 20, unit: 'year', raw: '$10-$20' } },
  ];
  for (const c of cases) {
    const result = mapLegacyListing(
      { ...listing, requirements: [], salary: c.salary as JobListing['salary'] } as JobListing,
      { capturedAt: '2025-01-01T00:00:00.000Z' },
    );
    assert.deepEqual(result.posting.salaries, [], `salaries omitted for ${c.label}`);
    const loss = result.losses.find((item) => item.field === 'salary');
    assert.ok(loss, `salary loss recorded for ${c.label}`);
    // bounded: raw/currency truncated if present
    if (loss.value !== undefined && typeof loss.value === 'object') {
      const v = loss.value as { raw?: string; currency?: string };
      if (typeof v.raw === 'string') assert.ok(v.raw.length <= 512, `raw bounded for ${c.label}`);
      if (typeof v.currency === 'string')
        assert.ok(v.currency.length <= 16, `currency bounded for ${c.label}`);
    }
    // preserve contracts: manual_import flag intact, unknown-location not fabricated
    assert.ok(result.posting.flags.includes('manual_import_unverified'));
  }
});

test('adversarial experience totality: malformed inputs omit, valid up-to-max preserves semantics', () => {
  const badCases: Array<{ experience: unknown; label: string }> = [
    { label: 'min>max', experience: { min: 5, max: 2, unit: 'year' } },
    { label: 'negative min', experience: { min: -1, unit: 'year' } },
    { label: 'negative max', experience: { min: 1, max: -1, unit: 'year' } },
    { label: 'NaN min', experience: { min: NaN, unit: 'year' } },
    { label: 'Infinity max', experience: { max: Infinity, unit: 'year' } },
    { label: 'invalid unit', experience: { min: 1, unit: 'decade' } },
    { label: 'missing unit', experience: { min: 1, max: 3 } },
  ];
  for (const c of badCases) {
    const result = mapLegacyListing(
      {
        ...listing,
        requirements: [],
        experience: c.experience as JobListing['experience'],
      } as JobListing,
      { capturedAt: '2025-01-01T00:00:00.000Z' },
    );
    assert.equal(result.posting.requirements.length, 0, `experience omitted for ${c.label}`);
    assert.ok(
      result.losses.some((item) => item.field === 'experience'),
      `loss for ${c.label}`,
    );
    assert.ok(result.posting.flags.includes('manual_import_unverified'));
  }

  // missing min => up-to-max, no zero fabrication
  const upTo = mapLegacyListing(
    { ...listing, requirements: [], experience: { max: 3, unit: 'year' } } as JobListing,
    { capturedAt: '2025-01-01T00:00:00.000Z' },
  );
  assert.equal(upTo.posting.requirements.length, 1);
  assert.equal(upTo.posting.requirements[0]?.rawText, 'Experience: up to 3 years');
  assert.deepEqual(upTo.posting.requirements[0]?.years, { max: 3, unit: 'year' });
  assert.equal((upTo.posting.requirements[0]?.years as { min?: number })?.min, undefined);
  assert.ok(!upTo.posting.requirements[0]?.rawText.includes('0-'));

  const onlyMin = mapLegacyListing(
    { ...listing, requirements: [], experience: { min: 2, unit: 'year' } } as JobListing,
    { capturedAt: '2025-01-01T00:00:00.000Z' },
  );
  assert.equal(onlyMin.posting.requirements[0]?.rawText, 'Experience: 2+ years');
  assert.deepEqual(onlyMin.posting.requirements[0]?.years, { min: 2, unit: 'year' });

  const range = mapLegacyListing(
    { ...listing, requirements: [], experience: { min: 2, max: 5, unit: 'year' } } as JobListing,
    { capturedAt: '2025-01-01T00:00:00.000Z' },
  );
  assert.equal(range.posting.requirements[0]?.rawText, 'Experience: 2-5 years');

  // valid month unit also total
  const months = mapLegacyListing(
    { ...listing, requirements: [], experience: { min: 6, unit: 'month' } } as JobListing,
    { capturedAt: '2025-01-01T00:00:00.000Z' },
  );
  assert.equal(months.posting.requirements[0]?.years?.unit, 'month');
});

test('omits malformed requirement years and bounded malformed structured values without throwing', () => {
  const malformed = {
    ...listing,
    company: '',
    applyUrl: '',
    requirements: [
      { category: 'essential', description: 'Experience required', years: -1 },
      { category: 'preferred', description: 'NaN experience', years: NaN },
      { category: 'preferred', description: 'Infinite experience', years: Infinity },
    ],
    salary: null,
    experience: null,
  } as unknown as JobListing;
  const result = mapLegacyListing(malformed, { capturedAt: '2025-01-01T00:00:00.000Z' });
  assert.equal(result.posting.organisation, 'Unknown organisation');
  assert.equal(result.posting.requirements.length, 3);
  assert.ok(result.posting.requirements.every((requirement) => requirement.years === undefined));
  assert.deepEqual(result.posting.salaries, []);
  assert.ok(result.losses.some((loss) => loss.field === 'requirements.years' && loss.value === -1));
  assert.ok(
    result.losses.some((loss) => loss.field === 'requirements.years' && Number.isNaN(loss.value)),
  );
  assert.ok(
    result.losses.some((loss) => loss.field === 'requirements.years' && loss.value === Infinity),
  );
  assert.ok(result.losses.some((loss) => loss.field === 'salary'));
  assert.ok(result.losses.some((loss) => loss.field === 'experience'));
  assert.ok(result.losses.some((loss) => loss.field === 'company'));
  assert.ok(result.losses.some((loss) => loss.field === 'applyUrl'));
});

test('maps missing optionals without fabricating evidence', () => {
  const minimal: JobListingMvp = {
    title: 'Assistant',
    workMode: 'unknown',
    source: 'other',
    extractedText: 'Details',
    confidence: { title: 1, location: 0, workMode: 0, salary: 0, overall: 1 },
    verificationStatus: 'search_result_only',
    caveats: [],
  };
  const first = mapLegacyListing(minimal, { capturedAt: '2025-01-01T00:00:00.000Z' });
  const second = mapLegacyListing(minimal, { capturedAt: '2025-01-01T00:00:00.000Z' });
  assert.deepEqual(first.posting, second.posting);
  assert.equal(first.posting.salaries.length, 0);
  assert.equal(first.posting.listingUrls.length, 0);
  assert.equal(first.posting.sourceListingIds.length, 1);
  assert.equal(first.posting.observationIds.length, 1);
  assert.ok(first.losses.some((loss) => loss.field === 'company'));
});
