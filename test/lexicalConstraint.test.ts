import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applySoftLexicalConstraint } from '../src/utils/lexicalConstraint.js';
import type { SemanticCrawlChunk } from '../src/types.js';

describe('applySoftLexicalConstraint', () => {
  const makeScore = (raw: number) => ({
    raw,
    normalized: 0.5,
    corpusMin: 0,
    corpusMax: 1,
    median: 0.5,
  });

  const makeChunk = (text: string): SemanticCrawlChunk => ({
    text,
    url: 'https://example.com',
    section: '## Test',
    charOffset: 0,
    chunkIndex: 0,
    totalChunks: 1,
    scores: {
      biEncoder: makeScore(0),
      bm25: makeScore(0),
      rrf: makeScore(0),
    },
  });

  const corpusChunks = [
    { text: 'how to configure PORT=8080', url: 'https://example.com', section: '## A', charOffset: 0, chunkIndex: 0, totalChunks: 1 },
    { text: 'docker build instructions', url: 'https://example.com', section: '## B', charOffset: 0, chunkIndex: 1, totalChunks: 2 },
    { text: 'the quick brown fox', url: 'https://example.com', section: '## C', charOffset: 0, chunkIndex: 2, totalChunks: 3 },
  ];

  it('filters chunks that lack top-IDF tokens', () => {
    const chunks = [
      makeChunk('how to configure PORT=8080'),
      makeChunk('docker build instructions'),
      makeChunk('the quick brown fox'),
    ];

    const result = applySoftLexicalConstraint(chunks, 'configure PORT=8080', corpusChunks);
    assert.ok(result.filtered.length > 0);
  });

  it('skips constraint for stopword-only queries', () => {
    const chunks = [makeChunk('the quick brown fox')];
    const result = applySoftLexicalConstraint(chunks, 'how to do it', corpusChunks);
    assert.strictEqual(result.filtered.length, 1);
    assert.strictEqual(result.warning, undefined);
  });

  it('returns warning when zero chunks satisfy', () => {
    const chunks = [makeChunk('completely unrelated text')];
    const result = applySoftLexicalConstraint(chunks, 'configure PORT=8080', corpusChunks);
    assert.strictEqual(result.filtered.length, 1); // fallback to unfiltered
    assert.ok(result.warning?.includes('zero matches'));
  });

  it('uses word-level matching, not substring', () => {
    // Query token 'car' should NOT match 'scary' (substring match would pass)
    const chunks = [
      makeChunk('I drive a car every day'),
      makeChunk('That was a scary movie'),
    ];
    const corpus = [
      { text: 'I drive a car every day', url: 'https://example.com', section: '## A', charOffset: 0, chunkIndex: 0, totalChunks: 1 },
      { text: 'That was a scary movie', url: 'https://example.com', section: '## B', charOffset: 0, chunkIndex: 1, totalChunks: 2 },
    ];
    const result = applySoftLexicalConstraint(chunks, 'car', corpus);
    assert.strictEqual(result.filtered.length, 1);
    assert.ok(result.filtered[0]?.text.includes('car'));
  });

  it('requires all tokens for 1-token queries', () => {
    const chunks = [
      makeChunk('docker build instructions'),
      makeChunk('the quick brown fox'),
    ];
    const corpus = [
      { text: 'docker build instructions', url: 'https://example.com', section: '## A', charOffset: 0, chunkIndex: 0, totalChunks: 1 },
      { text: 'the quick brown fox', url: 'https://example.com', section: '## B', charOffset: 0, chunkIndex: 1, totalChunks: 2 },
    ];
    // 1 non-stopword token → requiredCount = 1
    const result = applySoftLexicalConstraint(chunks, 'docker', corpus);
    assert.strictEqual(result.filtered.length, 1);
    assert.ok(result.filtered[0]?.text.includes('docker'));
  });

  it('requires both tokens for 2-token queries', () => {
    const chunks = [
      makeChunk('docker build instructions'),
      makeChunk('docker compose guide'),
      makeChunk('the quick brown fox'),
    ];
    const corpus = [
      { text: 'docker build instructions', url: 'https://example.com', section: '## A', charOffset: 0, chunkIndex: 0, totalChunks: 1 },
      { text: 'docker compose guide', url: 'https://example.com', section: '## B', charOffset: 0, chunkIndex: 1, totalChunks: 2 },
      { text: 'the quick brown fox', url: 'https://example.com', section: '## C', charOffset: 0, chunkIndex: 2, totalChunks: 3 },
    ];
    // 2 non-stopword tokens → requiredCount = 2
    const result = applySoftLexicalConstraint(chunks, 'docker build', corpus);
    assert.strictEqual(result.filtered.length, 1);
    assert.ok(result.filtered[0]?.text.includes('docker build'));
  });
});