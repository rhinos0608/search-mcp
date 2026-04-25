import test from 'node:test';
import assert from 'node:assert/strict';
import { getProfileSettings } from '../src/rag/profiles.js';
import { prepareAndRetrieve, prepareCorpus, retrieveCorpus } from '../src/rag/pipeline.js';

const fixtureChunks = [
  {
    text: 'vector only document',
    url: 'https://example.com/vector',
    section: 'Vector',
    charOffset: 0,
    chunkIndex: 0,
    totalChunks: 2,
    metadata: { label: 'vector-only' },
  },
  {
    text: 'needle lexical document',
    url: 'https://example.com/lexical',
    section: 'Lexical',
    charOffset: 0,
    chunkIndex: 1,
    totalChunks: 2,
    metadata: { label: 'lexical-only' },
  },
];

test('profile settings expose balanced defaults', () => {
  const settings = getProfileSettings('balanced', { topK: 7 });

  assert.equal(settings.profile, 'balanced');
  assert.equal(settings.topK, 7);
  assert.equal(settings.rrfK, 60);
});

test('retrieveCorpus includes vector-only and lexical-only candidates deterministically', async () => {
  const corpus = await prepareCorpus({
    adapter: 'text',
    chunks: fixtureChunks,
    embeddings: [
      [1, 0],
      [0, 1],
    ],
    model: 'fixture-model',
    dimensions: 2,
  });

  const response = await retrieveCorpus(corpus, {
    query: 'needle',
    queryEmbedding: [1, 0],
    topK: 2,
    profile: 'balanced',
  });

  const labels = response.results.map(
    (result: { item: { metadata?: Record<string, unknown> | undefined } }) => result.item.metadata?.label,
  );
  assert.ok(labels.includes('vector-only'));
  assert.ok(labels.includes('lexical-only'));
  assert.equal(response.trace.vectorCandidates, 1);
  assert.equal(response.trace.lexicalCandidates, 1);
  assert.equal(response.trace.fusedCandidates, 2);
  assert.equal(response.trace.returnedResults, 2);
});

test('retrieveCorpus returns a controlled empty response for empty corpus', async () => {
  const corpus = await prepareCorpus({ adapter: 'text', chunks: [] });
  const response = await retrieveCorpus(corpus, { query: 'anything', topK: 3 });

  assert.equal(response.corpus.status, 'empty');
  assert.deepEqual(response.results, []);
  assert.equal(response.trace.totalChunks, 0);
  assert.equal(response.trace.returnedResults, 0);
});

test('prepareAndRetrieve prepares supplied chunks and retrieves BM25-only matches', async () => {
  const response = await prepareAndRetrieve(
    {
      adapter: 'text',
      chunks: fixtureChunks,
    },
    {
      query: 'needle',
      topK: 1,
    },
  );

  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.item.metadata?.label, 'lexical-only');
  assert.equal(response.trace.lexicalCandidates, 1);
  assert.equal(response.trace.vectorCandidates, 0);
});

test('prepareAndRetrieve makes document-only corpora retrievable with lexical search', () => {
  const response = prepareAndRetrieve(
    {
      adapter: 'text',
      documents: [
        {
          id: 'doc-only',
          adapter: 'text',
          text: 'A document-only corpus should still match the unusualneedle query.',
          url: 'https://example.com/doc-only',
          title: 'Document Only',
          metadata: { kind: 'raw-document' },
        },
      ],
    },
    {
      query: 'unusualneedle',
      topK: 1,
    },
  );

  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.item.url, 'https://example.com/doc-only');
  assert.equal(response.results[0]?.item.metadata?.documentId, 'doc-only');
  assert.equal(response.trace.totalChunks, 1);
  assert.equal(response.trace.lexicalCandidates, 1);
});

test('retrieveCorpus rejects extra embeddings with a controlled validation error', () => {
  const corpus = prepareCorpus({
    adapter: 'text',
    chunks: fixtureChunks,
    embeddings: [
      [1, 0],
      [0, 1],
      [1, 1],
    ],
  });

  assert.throws(
    () => retrieveCorpus(corpus, { query: 'needle', queryEmbedding: [1, 0] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
      assert.match(error.message, /Embedding count \(3\) must match chunk count \(2\)/u);
      assert.doesNotMatch(error.message, /invalid chunk index/u);
      return true;
    },
  );
});

test('retrieveCorpus rejects too few embeddings with a controlled validation error', () => {
  const corpus = prepareCorpus({
    adapter: 'text',
    chunks: fixtureChunks,
    embeddings: [[1, 0]],
  });

  assert.throws(
    () => retrieveCorpus(corpus, { query: 'needle', queryEmbedding: [1, 0] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
      assert.match(error.message, /Embedding count \(1\) must match chunk count \(2\)/u);
      return true;
    },
  );
});

test('retrieveCorpus rejects nonnumeric embedding vectors with a controlled validation error', () => {
  const corpus = prepareCorpus({
    adapter: 'text',
    chunks: fixtureChunks,
    embeddings: [[1, 0], [Number.NaN, 1]],
  });

  assert.throws(
    () => retrieveCorpus(corpus, { query: 'needle', queryEmbedding: [1, 0] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'VALIDATION_ERROR');
      assert.match(error.message, /Embedding at index 1 must be a numeric vector/u);
      return true;
    },
  );
});
