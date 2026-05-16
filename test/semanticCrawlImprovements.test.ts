import test from 'node:test';
import assert from 'node:assert/strict';
import {
  retrieveSemanticChunks,
  filterByPathPrefix,
} from '../src/tools/semanticCrawl.js';
import type { CorpusChunk, CrawlPageResult, SemanticCrawlWarning } from '../src/types.js';

function buildMockResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makePage(url: string): CrawlPageResult {
  return {
    url,
    success: true,
    markdown: `# ${url}`,
    title: null,
    description: null,
    links: [],
    statusCode: 200,
    errorMessage: null,
  };
}

test('filterByPathPrefix reports dropped URLs and kept pages separately', () => {
  const result = filterByPathPrefix(
    [
      makePage('https://example.com/docs'),
      makePage('https://example.com/docs/getting-started'),
      makePage('https://example.com/blog/post'),
    ],
    'https://example.com/docs',
  );

  assert.equal(result.kept.length, 2);
  assert.equal(result.droppedCount, 1);
  assert.deepEqual(result.droppedUrls, ['https://example.com/blog/post']);
});

test('retrieveSemanticChunks falls back from lexical filtering when it would under-deliver topK', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    buildMockResponse({
      embeddings: [[1, 0]],
      model: 'test-model',
      modelRevision: 'test',
      dimensions: 2,
      mode: 'query',
      truncatedIndices: [],
    });

  try {
    const chunks: CorpusChunk[] = [
      {
        text: 'reference counting implementation details',
        url: 'https://example.com/a',
        section: 'A',
        charOffset: 0,
        chunkIndex: 0,
        totalChunks: 2,
      },
      {
        text: 'automatic memory reclamation for retain cycles',
        url: 'https://example.com/b',
        section: 'B',
        charOffset: 0,
        chunkIndex: 1,
        totalChunks: 2,
      },
    ];
    const warnings: SemanticCrawlWarning[] = [];
    const result = await retrieveSemanticChunks(chunks, {
      query: 'reference counting',
      topK: 2,
      embeddingBaseUrl: 'https://embed.example.com',
      embeddingApiToken: '',
      embeddingDimensions: 2,
      precomputedEmbeddings: [
        [1, 0],
        [0.95, 0.05],
      ],
      structuredWarnings: warnings,
    });

    assert.equal(result.length, 2);
    assert.equal(result[0]?.url, 'https://example.com/a');
    assert.equal(result[1]?.url, 'https://example.com/b');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retrieveSemanticChunks applies minScore to bi-encoder scores', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    buildMockResponse({
      embeddings: [[1, 0]],
      model: 'test-model',
      modelRevision: 'test',
      dimensions: 2,
      mode: 'query',
      truncatedIndices: [],
    });

  try {
    const chunks: CorpusChunk[] = [
      {
        text: 'primary relevant chunk',
        url: 'https://example.com/a',
        section: 'A',
        charOffset: 0,
        chunkIndex: 0,
        totalChunks: 2,
      },
      {
        text: 'secondary distant chunk',
        url: 'https://example.com/b',
        section: 'B',
        charOffset: 0,
        chunkIndex: 1,
        totalChunks: 2,
      },
    ];
    const warnings: SemanticCrawlWarning[] = [];
    const result = await retrieveSemanticChunks(chunks, {
      query: 'primary',
      topK: 2,
      minScore: 0.9,
      embeddingBaseUrl: 'https://embed.example.com',
      embeddingApiToken: '',
      embeddingDimensions: 2,
      precomputedEmbeddings: [
        [1, 0],
        [0.1, 0.9],
      ],
      structuredWarnings: warnings,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0]?.url, 'https://example.com/a');
    assert.ok(warnings.some((warning) => warning.code === 'SEMANTIC_CRAWL_MIN_SCORE_FILTER'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
