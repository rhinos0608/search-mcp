import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  semanticCrawl,
  isBorderline,
  applyReranking,
  embedAndRank,
  filterByPathPrefix,
  isDirectChild,
  type SemanticCrawlOptions,
} from '../src/tools/semanticCrawl.js';
import type { SemanticCrawlChunk, SemanticCrawlResult, CorpusChunk, CrawlPageResult } from '../src/types.js';
import type { Crawl4aiConfig } from '../src/config.js';
import { rrfMerge } from '../src/utils/fusion.js';

const DUMMY_CRAWL4AI: Crawl4aiConfig = { baseUrl: '', apiToken: '' };
const DUMMY_EMBEDDING = { baseUrl: '', apiToken: '', dimensions: 768 };

describe('semanticCrawl source API', () => {
  it('accepts url source type', () => {
    const opts: SemanticCrawlOptions = {
      source: { type: 'url', url: 'https://example.com' },
      query: 'test',
      topK: 5,
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 10,
      includeExternalLinks: false,
    };
    assert.strictEqual(opts.source.type, 'url');
  });

  it('accepts sitemap source type', () => {
    const opts: SemanticCrawlOptions = {
      source: { type: 'sitemap', url: 'https://example.com/sitemap.xml' },
      query: 'test',
      topK: 5,
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 10,
      includeExternalLinks: false,
    };
    assert.strictEqual(opts.source.type, 'sitemap');
  });

  it('accepts search source type', () => {
    const opts: SemanticCrawlOptions = {
      source: { type: 'search', query: 'python web framework', maxSeedUrls: 5 },
      query: 'test',
      topK: 5,
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 10,
      includeExternalLinks: false,
    };
    assert.strictEqual(opts.source.type, 'search');
  });

  it('accepts github source type', () => {
    const opts: SemanticCrawlOptions = {
      source: { type: 'github', owner: 'facebook', repo: 'react' },
      query: 'test',
      topK: 5,
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 10,
      includeExternalLinks: false,
    };
    assert.strictEqual(opts.source.type, 'github');
  });

  it('accepts cached source type', () => {
    const opts: SemanticCrawlOptions = {
      source: { type: 'cached', corpusId: 'abc123' },
      query: 'test',
      topK: 5,
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 10,
      includeExternalLinks: false,
    };
    assert.strictEqual(opts.source.type, 'cached');
    if (opts.source.type === 'cached') {
      assert.strictEqual(opts.source.corpusId, 'abc123');
    }
  });

  it('throws for unimplemented source at runtime when crawl4ai is unconfigured', async () => {
    const opts: SemanticCrawlOptions = {
      source: { type: 'url', url: 'https://example.com' },
      query: 'test',
      topK: 5,
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 10,
      includeExternalLinks: false,
    };
    await assert.rejects(
      () =>
        semanticCrawl(
          opts,
          DUMMY_CRAWL4AI,
          DUMMY_EMBEDDING.baseUrl,
          DUMMY_EMBEDDING.apiToken,
          DUMMY_EMBEDDING.dimensions,
        ),
      (err: Error) =>
        err.message.includes('not configured') || err.message.includes('Blocked request'),
    );
  });

  it('throws "not found or expired" for cached source with unknown corpusId', async () => {
    const opts: SemanticCrawlOptions = {
      source: { type: 'cached', corpusId: 'nonexistent-corpus-id-xyz' },
      query: 'test query',
      topK: 5,
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 10,
      includeExternalLinks: false,
    };
    await assert.rejects(
      () =>
        semanticCrawl(
          opts,
          DUMMY_CRAWL4AI,
          DUMMY_EMBEDDING.baseUrl,
          DUMMY_EMBEDDING.apiToken,
          DUMMY_EMBEDDING.dimensions,
        ),
      (err: Error) => err.message.includes('not found or expired'),
    );
  });
});

describe('SemanticCrawlResult shape', () => {
  it('SemanticCrawlResult type includes corpusId field', () => {
    // Compile-time check: verify the type has corpusId
    const result: SemanticCrawlResult = {
      seedUrl: 'https://example.com',
      query: 'test',
      pagesCrawled: 1,
      totalChunks: 10,
      successfulPages: 1,
      corpusId: 'some-corpus-id',
      chunks: [],
    };
    assert.strictEqual(result.corpusId, 'some-corpus-id');
    assert.ok(typeof result.corpusId === 'string');
  });
});

describe('isBorderline', () => {
  const makeChunk = (text: string): SemanticCrawlChunk => ({
    text,
    url: 'https://example.com',
    section: '## Section',
    biEncoderScore: 0,
    charOffset: 0,
    chunkIndex: 0,
    totalChunks: 1,
  });

  it('marks moderate link density chunks as borderline', () => {
    // ~30% link density (within 0.2-0.4 range)
    const chunk = makeChunk(
      'See [Getting Started](/start) and [API Reference](/api) for more details about this important topic that needs explanation.',
    );
    assert.ok(isBorderline(chunk));
  });

  it('does not mark low link density chunks as borderline', () => {
    const chunk = makeChunk(
      `This is a regular content paragraph with lots of words and a [single link](/x). ${'Word '.repeat(30)}`,
    );
    assert.ok(!isBorderline(chunk));
  });

  it('does not mark high link density as borderline (already caught by structural filter)', () => {
    const chunk = makeChunk(
      '[Link A](/a) [Link B](/b) [Link C](/c) [Link D](/d) [Link E](/e)',
    );
    assert.ok(!isBorderline(chunk));
  });
});

describe('applyReranking', () => {
  const makeChunk = (text: string, score: number): SemanticCrawlChunk => ({
    text,
    url: 'https://example.com',
    section: '## Test',
    biEncoderScore: score,
    charOffset: 0,
    chunkIndex: 0,
    totalChunks: 1,
  });

  it('returns at most topK results', async () => {
    const candidates = [
      makeChunk('Flask is a lightweight WSGI web application framework in Python.', 0.9),
      makeChunk('The quick brown fox jumps over the lazy dog.', 0.6),
      makeChunk('Banana bread recipe: mix bananas, flour, eggs, and sugar.', 0.3),
    ];

    const result = await applyReranking('python web framework', candidates, 2);
    assert.strictEqual(result.length, 2);
  });

  it('returns all candidates when fewer than topK', async () => {
    const candidates = [makeChunk('only chunk', 0.5)];
    const result = await applyReranking('test query', candidates, 5);
    assert.strictEqual(result.length, 1);
  });
});

describe('RRF fusion', () => {
  interface TextItem {
    url: string;
    text: string;
  }

  it('fuses bi-encoder-only and BM25-only matches into a single ranked list', () => {
    // Chunk A: only appears in bi-encoder ranking (high cosine sim, no keyword match)
    // Chunk B: only appears in BM25 ranking (exact keyword match, low cosine sim)
    // Chunk C: appears in both (should rank highest)
    const chunkA: TextItem = { url: 'https://example.com/a', text: 'Semantically similar but no keywords' };
    const chunkB: TextItem = { url: 'https://example.com/b', text: 'exact keyword match bm25 only' };
    const chunkC: TextItem = { url: 'https://example.com/c', text: 'both semantic and keyword match' };

    // Bi-encoder ranking: C first, then A
    const biEncoderRanking: TextItem[] = [chunkC, chunkA];
    // BM25 ranking: C first, then B
    const bm25Ranking: TextItem[] = [chunkC, chunkB];

    const fused = rrfMerge([biEncoderRanking, bm25Ranking], {
      k: 60,
      keyFn: (item) => item.url + '|' + item.text,
    });

    const fusedTexts = fused.map((r) => r.item.text);

    // All three items should appear in the fused output
    assert.ok(fusedTexts.includes(chunkA.text), 'bi-encoder-only chunk A should appear in fused output');
    assert.ok(fusedTexts.includes(chunkB.text), 'BM25-only chunk B should appear in fused output');
    assert.ok(fusedTexts.includes(chunkC.text), 'chunk C (in both) should appear in fused output');

    // Chunk C should be ranked first (appears in both rankings)
    assert.strictEqual(fused[0]?.item.text, chunkC.text, 'chunk appearing in both rankings should rank first');

    // The RRF score for C should be higher than A and B (it appears in both)
    const scoreC = fused.find((r) => r.item.text === chunkC.text)?.rrfScore ?? 0;
    const scoreA = fused.find((r) => r.item.text === chunkA.text)?.rrfScore ?? 0;
    const scoreB = fused.find((r) => r.item.text === chunkB.text)?.rrfScore ?? 0;
    assert.ok(scoreC > scoreA, 'C (in both) should have higher RRF score than A (bi-encoder only)');
    assert.ok(scoreC > scoreB, 'C (in both) should have higher RRF score than B (BM25 only)');
  });

  it('handles empty rankings gracefully', () => {
    const fused = rrfMerge([], { k: 60, keyFn: (item: string) => item });
    assert.deepStrictEqual(fused, []);
  });

  it('handles single-item rankings with no overlap', () => {
    const rankingA = [{ url: 'a', text: 'alpha' }];
    const rankingB = [{ url: 'b', text: 'beta' }];

    const fused = rrfMerge([rankingA, rankingB], {
      k: 60,
      keyFn: (item) => item.url,
    });

    assert.strictEqual(fused.length, 2);
    // Both should have equal RRF scores since each appears exactly once
    const scoreA = fused.find((r) => r.item.url === 'a')?.rrfScore ?? 0;
    const scoreB = fused.find((r) => r.item.url === 'b')?.rrfScore ?? 0;
    assert.strictEqual(scoreA, scoreB, 'Items appearing once each should have equal RRF scores');
  });
});

describe('embedAndRank', () => {
  it('throws when precomputedEmbeddings length does not match chunk count', async () => {
    const chunks: CorpusChunk[] = [
      { text: 'chunk one', url: 'https://example.com', section: '## A', charOffset: 0, chunkIndex: 0, totalChunks: 1 },
      { text: 'chunk two', url: 'https://example.com', section: '## B', charOffset: 0, chunkIndex: 1, totalChunks: 2 },
    ];
    await assert.rejects(
      () => embedAndRank(chunks, {
        query: 'test',
        topK: 5,
        embeddingBaseUrl: '',
        embeddingApiToken: '',
        embeddingDimensions: 4,
        precomputedEmbeddings: [[0.1, 0.2, 0.3, 0.4]], // length 1, but chunks has 2
      }),
      (err: Error) => err.message.includes('does not match deduped chunk count'),
    );
  });
});

describe('isDirectChild', () => {
  it('accepts exactly one deeper segment', () => {
    assert.strictEqual(isDirectChild('/reference/dockerfile/build/', '/reference/dockerfile/'), true);
  });

  it('rejects two deeper segments', () => {
    assert.strictEqual(isDirectChild('/reference/dockerfile/build/args/', '/reference/dockerfile/'), false);
  });

  it('rejects sibling paths', () => {
    assert.strictEqual(isDirectChild('/reference/cli/', '/reference/dockerfile/'), false);
  });

  it('rejects identical paths', () => {
    assert.strictEqual(isDirectChild('/reference/dockerfile/', '/reference/dockerfile/'), false);
  });
});

describe('filterByPathPrefix', () => {
  const makePage = (url: string): CrawlPageResult => ({
    url,
    success: true,
    markdown: `# ${url}`,
    title: null,
    description: null,
    links: [],
    statusCode: 200,
    errorMessage: null,
  });

  it('keeps pages under seed path', () => {
    const seed = 'https://docs.docker.com/reference/dockerfile/';
    const pages = [
      makePage('https://docs.docker.com/reference/dockerfile/'),
      makePage('https://docs.docker.com/reference/dockerfile/build/'),
      makePage('https://docs.docker.com/reference/dockerfile/build/args/'),
      makePage('https://docs.docker.com/cli/config/'),
    ];
    const filtered = filterByPathPrefix(pages, seed);
    assert.strictEqual(filtered.length, 2);
    assert.ok(filtered.some((p) => p.url.includes('dockerfile/')));
    assert.ok(!filtered.some((p) => p.url.includes('cli/config')));
    assert.ok(!filtered.some((p) => p.url.includes('args')));
  });

  it('allows drift when allowPathDrift is true', () => {
    const seed = 'https://docs.docker.com/reference/dockerfile/';
    const pages = [
      makePage('https://docs.docker.com/reference/dockerfile/'),
      makePage('https://docs.docker.com/cli/config/'),
    ];
    const filtered = filterByPathPrefix(pages, seed, true);
    assert.strictEqual(filtered.length, 2);
  });
});

