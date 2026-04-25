import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AdapterType,
  CorpusStatus,
  PreparedCorpus,
  PrepareCorpusOptions,
  ProfileSettings,
  RagChunk,
  RawDocument,
  RetrievalProfileName,
  RetrievalResponse,
  RetrievalResult,
  RetrievalScore,
  RetrievalTrace,
} from '../src/rag/types.js';

test('rag shared types accept current semantic crawl compatible chunk shapes', () => {
  const adapter: AdapterType = 'text';
  const profile: RetrievalProfileName = 'balanced';
  const status: CorpusStatus = 'ready';

  const raw: RawDocument = {
    id: 'doc-1',
    adapter,
    text: '# Title\n\nBody text',
    url: 'https://example.com/doc',
    title: 'Doc',
    metadata: { source: 'fixture' },
  };

  const chunk: RagChunk = {
    text: 'Body text',
    url: raw.url,
    section: '# Title',
    charOffset: 10,
    chunkIndex: 0,
    totalChunks: 1,
    metadata: { documentId: raw.id },
    scores: {
      biEncoder: { raw: 0.7, normalized: 1, corpusMin: 0.1, corpusMax: 0.7, median: 0.4 },
      bm25: { raw: 1.2, normalized: 1, corpusMin: 0, corpusMax: 1.2, median: 0.6 },
      rrf: { raw: 0.03, normalized: 1, corpusMin: 0, corpusMax: 0.03, median: 0.01 },
    },
  };

  const score: RetrievalScore = {
    vector: 0.7,
    lexical: 1.2,
    fused: 0.03,
    details: chunk.scores,
  };

  const result: RetrievalResult<RagChunk> = {
    item: chunk,
    score,
    rank: 1,
  };

  const trace: RetrievalTrace = {
    query: 'body',
    profile,
    totalChunks: 1,
    vectorCandidates: 1,
    lexicalCandidates: 1,
    fusedCandidates: 1,
    returnedResults: 1,
  };

  const corpus: PreparedCorpus = {
    id: 'corpus-1',
    status,
    adapter,
    documents: [raw],
    chunks: [chunk],
    model: 'fixture-model',
    dimensions: 2,
    metadata: { fixture: true },
  };

  const response: RetrievalResponse<RagChunk> = {
    corpus,
    results: [result],
    trace,
    warnings: [],
  };

  const options: PrepareCorpusOptions = {
    adapter,
    profile,
    documents: [raw],
    chunks: [chunk],
    embeddings: [[1, 0]],
    model: 'fixture-model',
    dimensions: 2,
  };

  const settings: ProfileSettings = {
    profile,
    topK: 5,
    vectorWeight: 1,
    lexicalWeight: 1,
    rrfK: 60,
    useReranker: false,
  };

  assert.equal(response.results[0]?.item.metadata?.documentId, 'doc-1');
  assert.equal(options.chunks?.[0]?.text, 'Body text');
  assert.equal(settings.profile, 'balanced');
});
