import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCorpus, retrieveCorpus } from '../src/rag/pipeline.js';
import { getCounter, getGauge, resetMetrics } from '../src/rag/metrics.js';

const TEST_EMBEDDINGS = [
  [1, 0, 0, 0],
  [0.9, 0.1, 0, 0],
  [0, 1, 0, 0],
  [0, 0.9, 0.1, 0],
];

test.beforeEach(() => {
  resetMetrics();
});

test('prepareCorpus records dedup metrics', () => {
  prepareCorpus({
    adapter: 'text',
    documents: [
      { id: '1', text: 'hello world', url: 'http://example.com/a', adapter: 'text' },
      { id: '2', text: 'hello world', url: 'http://example.com/a', adapter: 'text' },
      { id: '3', text: 'foo bar', url: 'http://example.com/b', adapter: 'text' },
    ],
    dedupeConfig: {
      layers: { url: true, fingerprint: true, semantic: true, entityOverlap: false },
      fingerprintThreshold: 0.95,
      semanticThreshold: 0.95,
      preferKeep: 'newest',
    },
    embeddings: TEST_EMBEDDINGS,
  });

  const dedupCounter = getCounter('rag.dedup.url_removed', { adapter: 'text' });
  assert.ok(dedupCounter);
  assert.equal(typeof dedupCounter.value, 'number');
  assert.ok(dedupCounter.value >= 0);

  const gauge = getGauge('rag.documents.after_dedup', { adapter: 'text' });
  assert.ok(gauge);
  assert.ok(gauge.current <= 3);
});

test('retrieveCorpus records retrieval metrics', () => {
  const chunks = [
    {
      text: 'hello world',
      url: 'http://example.com/a',
      chunkIndex: 0,
      totalChunks: 4,
      charOffset: 0,
      metadata: { adapter: 'text' },
      section: 'a',
    },
    {
      text: 'hello again',
      url: 'http://example.com/b',
      chunkIndex: 1,
      totalChunks: 4,
      charOffset: 0,
      metadata: { adapter: 'text' },
      section: 'b',
    },
    {
      text: 'foo bar',
      url: 'http://example.com/c',
      chunkIndex: 2,
      totalChunks: 4,
      charOffset: 0,
      metadata: { adapter: 'text' },
      section: 'c',
    },
    {
      text: 'baz qux',
      url: 'http://example.com/d',
      chunkIndex: 3,
      totalChunks: 4,
      charOffset: 0,
      metadata: { adapter: 'text' },
      section: 'd',
    },
  ];

  const corpus = prepareCorpus({ adapter: 'text', chunks, embeddings: TEST_EMBEDDINGS });

  retrieveCorpus(corpus, {
    query: 'hello',
    queryEmbedding: [1, 0, 0, 0],
    topK: 2,
  });

  const retrievalCounter = getCounter('rag.retrieval.total', { adapter: 'text' });
  assert.ok(retrievalCounter);
  assert.equal(retrievalCounter.value, 1);

  const returnedCounter = getCounter('rag.results.returned', { adapter: 'text' });
  assert.ok(returnedCounter);
  assert.equal(returnedCounter.value, 2);

  const chunksGauge = getGauge('rag.chunks.available', { adapter: 'text' });
  assert.ok(chunksGauge);
  assert.equal(chunksGauge.current, 4);
});

test('retrieveCorpus records constraint metrics', () => {
  const chunks = [
    {
      text: 'senior engineer job in sydney',
      url: 'http://example.com/a',
      chunkIndex: 0,
      totalChunks: 2,
      charOffset: 0,
      metadata: { adapter: 'text', location: 'Sydney' },
      section: 'a',
    },
    {
      text: 'junior engineer job in melbourne',
      url: 'http://example.com/b',
      chunkIndex: 1,
      totalChunks: 2,
      charOffset: 0,
      metadata: { adapter: 'text', location: 'Melbourne' },
      section: 'b',
    },
  ];

  const corpus = prepareCorpus({ adapter: 'text', chunks });

  retrieveCorpus(corpus, {
    query: 'engineer',
    topK: 10,
    constraintConfig: {
      hardConstraints: [{ type: 'location', values: ['Sydney'], tolerance: 'exact' }],
      softConstraints: [],
      strictMode: true,
    },
    constraintExtractors: {
      location: (item: unknown) => {
        if (item && typeof item === 'object' && 'metadata' in item) {
          const meta = (item as { metadata?: Record<string, unknown> }).metadata;
          return typeof meta?.location === 'string' ? meta.location : undefined;
        }
        return undefined;
      },
    },
  });

  const passedCounter = getCounter('rag.constraints.passed', { adapter: 'text' });
  assert.ok(passedCounter);
  assert.equal(passedCounter.value, 1);

  const filteredCounter = getCounter('rag.constraints.filtered', { adapter: 'text' });
  assert.ok(filteredCounter);
  assert.equal(filteredCounter.value, 1);
});
