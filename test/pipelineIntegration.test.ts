import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCorpus, retrieveCorpus } from '../src/rag/pipeline.js';
import { normalizeUrl } from '../src/rag/dedup.js';

// ── prepareCorpus dedup integration ──────────────────────────────────────────

test('prepareCorpus applies URL dedup when dedupeConfig.layers.url is true', () => {
  const doc1 = {
    id: '1',
    text: 'hello',
    url: 'https://example.com/job?tracking=123',
    adapter: 'text' as const,
  };
  const doc2 = {
    id: '2',
    text: 'hello2',
    url: 'https://example.com/job',
    adapter: 'text' as const,
  };
  const corpus = prepareCorpus({
    adapter: 'text',
    documents: [doc1, doc2],
    dedupeConfig: {
      layers: { url: true, fingerprint: false, semantic: false },
      fingerprintThreshold: 0.95,
      semanticThreshold: 0.9,
      preferKeep: 'mostComplete',
    },
  });

  assert.equal(corpus.documents.length, 1);
  // dedupByUrl keeps the first occurrence; URL may still have params
  assert.ok(
    corpus.documents[0]?.url === 'https://example.com/job' ||
      corpus.documents[0]?.url === 'https://example.com/job?tracking=123',
  );
});

test('prepareCorpus applies fingerprint dedup when layer enabled', () => {
  const doc1 = {
    id: '1',
    text: 'Senior software engineer needed immediately python react typescript nodejs docker aws',
    url: 'https://example.com/a',
    adapter: 'text' as const,
  };
  const doc2 = {
    id: '2',
    text: 'Senior software engineer needed immediately python react typescript nodejs docker aws remote',
    url: 'https://example.com/b',
    adapter: 'text' as const,
  };
  const doc3 = {
    id: '3',
    text: 'Completely different content here nothing alike at all marketing sales manager',
    url: 'https://example.com/c',
    adapter: 'text' as const,
  };
  const corpus = prepareCorpus({
    adapter: 'text',
    documents: [doc1, doc2, doc3],
    dedupeConfig: {
      layers: { url: false, fingerprint: true, semantic: false },
      fingerprintThreshold: 0.95,
      semanticThreshold: 0.9,
      preferKeep: 'mostComplete',
    },
  });

  assert.ok(corpus.documents.length <= 2);
});

test('prepareCorpus skips dedup when config omitted', () => {
  const doc1 = { id: '1', text: 'hello', url: 'https://example.com/job', adapter: 'text' as const };
  const doc2 = { id: '2', text: 'world', url: 'https://example.com/job', adapter: 'text' as const };
  const corpus = prepareCorpus({
    adapter: 'text',
    documents: [doc1, doc2],
  });

  assert.equal(corpus.documents.length, 2);
});

test('prepareCorpus handles empty documents with dedupeConfig', () => {
  const corpus = prepareCorpus({
    adapter: 'text',
    documents: [],
    dedupeConfig: {
      layers: { url: true, fingerprint: true, semantic: false },
      fingerprintThreshold: 0.95,
      semanticThreshold: 0.9,
      preferKeep: 'mostComplete',
    },
  });

  assert.equal(corpus.status, 'empty');
});

// ── retrieveCorpus constraint integration ─────────────────────────────────────

test('retrieveCorpus applies constraints and filters results', () => {
  const docs = [
    { id: '1', text: 'Sydney office role', url: 'https://a.com', adapter: 'text' as const },
    { id: '2', text: 'Melbourne remote role', url: 'https://b.com', adapter: 'text' as const },
    { id: '3', text: 'Perth onsite role', url: 'https://c.com', adapter: 'text' as const },
  ];
  const corpus = prepareCorpus({ adapter: 'text', documents: docs });
  const embeddings = [
    [1.0, 0.0, 0.0],
    [0.8, 0.2, 0.0],
    [0.0, 0.0, 1.0],
  ];

  const response = retrieveCorpus(
    { ...corpus, embeddings },
    {
      query: 'role',
      queryEmbedding: [1.0, 0.0, 0.0],
      topK: 5,
      constraintConfig: {
        hardConstraints: [{ type: 'location', values: ['Sydney'] }],
        softConstraints: [],
        strictMode: false,
      },
      constraintExtractors: {
        location: (item) => {
          const chunk = item as { text: string };
          return chunk.text.includes('Sydney')
            ? 'Sydney'
            : chunk.text.includes('Melbourne')
              ? 'Melbourne'
              : chunk.text.includes('Perth')
                ? 'Perth'
                : undefined;
        },
      },
    },
  );

  assert.ok(response.results.length <= 1);
  if (response.results.length > 0) {
    assert.ok(response.results[0]!.item.text.includes('Sydney'));
  }
  assert.ok(response.coverage !== undefined);
  assert.equal(response.coverage!.chunksGenerated, 3);
});

test('retrieveCorpus includes coverage even without constraints', () => {
  const docs = [{ id: '1', text: 'hello', url: 'https://a.com', adapter: 'text' as const }];
  const corpus = prepareCorpus({ adapter: 'text', documents: docs });
  const response = retrieveCorpus(corpus, { query: 'hello' });

  assert.ok(response.coverage !== undefined);
  assert.equal(response.coverage!.documentsFound, 1);
  assert.equal(response.coverage!.chunksGenerated, 1);
  assert.deepEqual(response.coverage!.sourcesSucceeded, ['text']);
});

test('retrieveCorpus constraint warnings when results are filtered', () => {
  const docs = [
    { id: '1', text: 'Sydney role', url: 'https://a.com', adapter: 'text' as const },
    { id: '2', text: 'Perth role', url: 'https://b.com', adapter: 'text' as const },
  ];
  const corpus = prepareCorpus({ adapter: 'text', documents: docs });
  const response = retrieveCorpus(corpus, {
    query: 'role',
    constraintConfig: {
      hardConstraints: [{ type: 'location', values: ['Sydney'] }],
      softConstraints: [],
      strictMode: false,
    },
    constraintExtractors: {
      location: (item) => {
        const chunk = item as { text: string };
        return chunk.text.includes('Sydney') ? 'Sydney' : 'Perth';
      },
    },
  });

  assert.ok(
    response.warnings?.some((w) => w.includes('filtered')),
    'Expected constraint filter warning',
  );
});

// ── retrieveCorpus backward compatibility ───────────────────────────────────

test('retrieveCorpus backward compat without V3 options', () => {
  const docs = [{ id: '1', text: 'hello world', url: 'https://a.com', adapter: 'text' as const }];
  const corpus = prepareCorpus({ adapter: 'text', documents: docs });
  const response = retrieveCorpus(corpus, { query: 'hello' });

  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.item.text, 'hello world');
});

// ── normalizeUrl (dedup helper) ───────────────────────────────────────────────

test('normalizeUrl strips tracking params', () => {
  const url = normalizeUrl('https://example.com/job?utm_source=google&ref=abc');
  assert.ok(!url.includes('utm_'));
  assert.ok(!url.includes('ref='));
  assert.ok(url.includes('/job'));
});

// ── prepareCorpusAsync (async semantic dedup) ────────────────────────────────

// Skipped: requires actual embedding function; keep for integration tests
