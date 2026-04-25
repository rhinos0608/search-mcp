import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { semanticJobs, processJobSearchResults } from '../src/tools/semanticJobs.js';
import type { JobSearchConstraints } from '../src/rag/types/job.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeEmbedResponse(texts: string[], dim: number) {
  const embeddings = texts.map((text) => {
    const normalized = text.toLowerCase();
    const matchScore = normalized.includes('sydney') || normalized.includes('alpha') ? 1 : 0;
    return Array.from({ length: dim }, (_, index) => (index === 0 ? matchScore : 1 - matchScore));
  });

  return {
    embeddings,
    model: 'test-model',
    modelRevision: 'r1',
    dimensions: dim,
    mode: 'document',
    truncatedIndices: [],
  };
}

function installEmbeddingStub(): void {
  globalThis.fetch = async (input, init) => {
    const url = String(
      input instanceof URL ? input.href : input instanceof Request ? input.url : input,
    );
    if (!url.includes('/embed')) {
      return new Response('not found', { status: 404 });
    }

    const rawBody = init?.body !== null && init?.body !== undefined ? String(init.body) : '{}';
    const body = JSON.parse(rawBody) as { texts?: string[]; dimensions?: number };
    const texts = body.texts ?? [];
    const dim = body.dimensions ?? 4;
    return Response.json(makeEmbedResponse(texts, dim));
  };
}

function makeListingHtml(overrides: {
  title: string;
  company?: string;
  location?: string;
  jobId?: string;
  sourceUrl?: string;
}): string {
  return `
    <html>
      <head>
        <title>${overrides.title}</title>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "${overrides.title}",
            "hiringOrganization": { "@type": "Organization", "name": "${overrides.company ?? 'Atlas Digital'}" },
            "jobLocation": { "@type": "Place", "address": { "addressLocality": "${overrides.location ?? 'Sydney NSW'}" } },
            "identifier": "${overrides.jobId ?? 'job-123'}",
            "datePosted": "2026-04-20"
          }
        </script>
      </head>
      <body>
        <h1>${overrides.title}</h1>
        <div class="company">${overrides.company ?? 'Atlas Digital'}</div>
        <div class="location">${overrides.location ?? 'Sydney NSW'}</div>
        <div data-job-id="${overrides.jobId ?? 'job-123'}">${overrides.jobId ?? 'job-123'}</div>
        <p>Build products with React and TypeScript.</p>
        <a href="${overrides.sourceUrl ?? 'https://www.seek.com.au/job/123'}">Apply</a>
      </body>
    </html>
  `;
}

function makeSearchResults(urls: string[]) {
  return urls.map((url, index) => ({
    title: `Result ${String(index + 1)}`,
    url,
    description: '',
    position: index + 1,
    domain: new URL(url).hostname,
    source: 'brave' as const,
    age: null,
    extraSnippet: null,
    deepLinks: null,
  }));
}

test('semanticJobs returns ranked results for a happy-path query', async () => {
  installEmbeddingStub();

  const result = await semanticJobs(
    {
      query: 'react developer sydney',
      embeddingBaseUrl: 'http://sidecar.local',
      embeddingDimensions: 4,
      maxPages: 5,
      topK: 5,
    },
    {
      search: async () =>
        makeSearchResults([
          'https://www.seek.com.au/job/alpha',
          'https://au.indeed.com/viewjob?jk=beta',
        ]),
      crawl: async (urls) =>
        urls.map((url) => ({
          url,
          html: makeListingHtml({
            title: url.includes('alpha') ? 'Alpha Developer' : 'Beta Developer',
            company: url.includes('alpha') ? 'Alpha Co' : 'Beta Co',
            location: url.includes('alpha') ? 'Sydney NSW' : 'Melbourne VIC',
            jobId: url.includes('alpha') ? 'alpha' : 'beta',
            sourceUrl: url,
          }),
          success: true,
        })),
    },
  );

  assert.equal(result.corpusStatus.requested, 2);
  assert.equal(result.corpusStatus.fetched, 2);
  assert.equal(result.corpusStatus.failed, 0);
  assert.equal(result.corpusStatus.deduplicated, 0);
  assert.ok(result.results.length > 0, 'Expected ranked results');
  assert.equal(result.results[0]?.listing.title, 'Alpha Developer');
});

test('semanticJobs returns empty results when search finds no URLs', async () => {
  installEmbeddingStub();

  const result = await semanticJobs(
    {
      query: 'no results query',
      embeddingBaseUrl: 'http://sidecar.local',
      embeddingDimensions: 4,
    },
    {
      search: async () => [],
      crawl: async () => [],
    },
  );

  assert.equal(result.results.length, 0);
  assert.deepEqual(result.corpusStatus, { requested: 0, fetched: 0, failed: 0, deduplicated: 0 });
});

test('semanticJobs records crawl failures in warnings', async () => {
  installEmbeddingStub();

  const result = await semanticJobs(
    {
      query: 'failure query',
      embeddingBaseUrl: 'http://sidecar.local',
      embeddingDimensions: 4,
    },
    {
      search: async () =>
        makeSearchResults(['https://www.seek.com.au/job/alpha', 'https://www.seek.com.au/job/bad']),
      crawl: async (urls) =>
        urls.map((url) => {
          if (url.includes('bad')) {
            return { url, html: '', success: false, error: 'crawl failed' };
          }
          return {
            url,
            html: makeListingHtml({
              title: 'Good Developer',
              company: 'Good Co',
              location: 'Sydney NSW',
              jobId: 'good',
            }),
            success: true,
          };
        }),
    },
  );

  assert.equal(result.corpusStatus.failed, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('crawl failed')));
});

test('semanticJobs removes duplicate listings', async () => {
  installEmbeddingStub();

  const duplicateHtml = makeListingHtml({
    title: 'Duplicate Developer',
    company: 'Duplicate Co',
    location: 'Sydney NSW',
    jobId: 'same-job',
  });

  const result = await semanticJobs(
    {
      query: 'duplicate query',
      embeddingBaseUrl: 'http://sidecar.local',
      embeddingDimensions: 4,
    },
    {
      search: async () =>
        makeSearchResults([
          'https://www.seek.com.au/job/page-a',
          'https://www.seek.com.au/job/page-b',
        ]),
      crawl: async (urls) =>
        urls.map((url) => ({
          url,
          html: duplicateHtml,
          success: true,
        })),
    },
  );

  assert.equal(result.corpusStatus.deduplicated, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.listing.title, 'Duplicate Developer');
});

test('processJobSearchResults applies hard constraints', async () => {
  installEmbeddingStub();

  const crawledPages = [
    {
      url: 'https://www.seek.com.au/job/sydney',
      html: makeListingHtml({
        title: 'Sydney Developer',
        company: 'Sydney Co',
        location: 'Sydney NSW',
        jobId: 'sydney',
      }),
      success: true,
    },
    {
      url: 'https://www.seek.com.au/job/melbourne',
      html: makeListingHtml({
        title: 'Melbourne Developer',
        company: 'Melbourne Co',
        location: 'Melbourne VIC',
        jobId: 'melbourne',
      }),
      success: true,
    },
  ];

  const constraints: JobSearchConstraints = { location: ['Sydney'] };
  const result = await processJobSearchResults(
    crawledPages,
    'developer search',
    constraints,
    'http://sidecar.local',
    undefined,
    4,
  );

  assert.deepEqual(
    result.results.map((r) => r.listing.title),
    ['Sydney Developer'],
  );
});
