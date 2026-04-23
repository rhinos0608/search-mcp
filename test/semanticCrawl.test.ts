import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  semanticCrawl,
  isBorderline,
  applyReranking,
  type SemanticCrawlOptions,
} from '../src/tools/semanticCrawl.js';
import type { SemanticCrawlChunk } from '../src/types.js';
import type { Crawl4aiConfig } from '../src/config.js';

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
