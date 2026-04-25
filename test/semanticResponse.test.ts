import test from 'node:test';
import assert from 'node:assert/strict';

import { compactSemanticResponse } from '../src/utils/semanticResponse.js';

test('compactSemanticResponse strips corpus payloads to keep tool output small', () => {
  const documents = Array.from({ length: 500 }, (_, i) => ({
    id: `doc-${String(i)}`,
    adapter: 'transcript' as const,
    text: 'x'.repeat(500),
    url: `https://example.com/${String(i)}`,
    title: `Document ${String(i)}`,
    metadata: { source: 'fixture', index: i },
  }));

  const chunks = Array.from({ length: 500 }, (_, i) => ({
    text: 'y'.repeat(1000),
    url: `https://example.com/${String(i)}`,
    section: `## Section ${String(i)}`,
    charOffset: i * 1000,
    chunkIndex: i,
    totalChunks: 500,
    metadata: { source: 'fixture', index: i },
    scores: {
      biEncoder: { raw: 1, normalized: 1, corpusMin: 0, corpusMax: 1, median: 0.5 },
      bm25: { raw: 1, normalized: 1, corpusMin: 0, corpusMax: 1, median: 0.5 },
      rrf: { raw: 1, normalized: 1, corpusMin: 0, corpusMax: 1, median: 0.5 },
    },
  }));

  const embeddings = Array.from({ length: 500 }, () => Array.from({ length: 768 }, () => 0.123456));

  const compact = compactSemanticResponse({
    corpus: {
      id: 'corpus-123',
      status: 'ready',
      adapter: 'transcript',
      documents,
      chunks,
      embeddings,
      model: 'embedding-test',
      modelRevision: 'rev-1',
      dimensions: 768,
      metadata: { source: 'fixture' },
    },
    results: [
      {
        item: {
          text: 'answer passage',
          url: 'https://example.com/answer',
          section: '## Answer',
          charOffset: 0,
          chunkIndex: 0,
          totalChunks: 1,
          scores: {
            biEncoder: { raw: 1, normalized: 1, corpusMin: 0, corpusMax: 1, median: 0.5 },
            bm25: { raw: 1, normalized: 1, corpusMin: 0, corpusMax: 1, median: 0.5 },
            rrf: { raw: 1, normalized: 1, corpusMin: 0, corpusMax: 1, median: 0.5 },
          },
        },
        score: { fused: 1 },
        rank: 1,
      },
    ],
    trace: {
      query: 'answer',
      profile: 'balanced',
      totalChunks: 500,
      vectorCandidates: 50,
      lexicalCandidates: 50,
      fusedCandidates: 10,
      returnedResults: 1,
    },
    warnings: ['fixture warning'],
  });

  const json = JSON.stringify(compact);
  assert.ok(Buffer.byteLength(json, 'utf8') < 1_000_000, 'Expected compact semantic output to stay under 1MB');
  assert.equal(compact.corpus.id, 'corpus-123');
  assert.equal(compact.corpus.chunkCount, 500);
  assert.equal(compact.corpus.documentCount, 500);
  assert.equal(compact.corpus.embeddingCount, 500);
  assert.equal(compact.warnings?.[0], 'fixture warning');
  assert.equal('chunks' in compact.corpus, false);
  assert.equal('documents' in compact.corpus, false);
  assert.equal('embeddings' in compact.corpus, false);
});
