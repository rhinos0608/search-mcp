import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown } from '../src/rag/chunking.js';
import { buildBm25Index } from '../src/rag/bm25.js';
import { rrfMerge } from '../src/rag/fusion.js';
import { applySoftLexicalConstraint } from '../src/rag/lexicalConstraint.js';
import { rerank } from '../src/rag/rerank.js';
import { buildSourceKey, computeCorpusId, getOrBuildCorpus } from '../src/rag/corpusCache.js';

test('rag chunking wrapper preserves chunkMarkdown behavior', () => {
  const chunks = chunkMarkdown('# Title\n\n## Body\n\nUseful content.', 'https://example.com');

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.section, '# Title > ## Body');
});

test('rag BM25 wrapper preserves buildBm25Index behavior', () => {
  const index = buildBm25Index([
    { id: 'a', text: 'alpha beta' },
    { id: 'b', text: 'gamma' },
  ]);

  assert.equal(index.search('alpha')[0]?.id, 'a');
});

test('rag fusion wrapper preserves rrfMerge behavior', () => {
  const merged = rrfMerge(
    [
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'b' }],
    ],
    { getId: (item: { id: string }) => item.id },
  );

  assert.equal(merged[0]?.item.id, 'b');
});

test('rag lexical constraint wrapper preserves filtering behavior', () => {
  const chunk = {
    text: 'rareterm relevant text',
    url: 'https://example.com',
    section: 'Body',
    charOffset: 0,
    chunkIndex: 0,
    totalChunks: 1,
    scores: {
      biEncoder: { raw: 1, normalized: 1, corpusMin: 0, corpusMax: 1, median: 1 },
      bm25: { raw: 1, normalized: 1, corpusMin: 0, corpusMax: 1, median: 1 },
      rrf: { raw: 1, normalized: 1, corpusMin: 0, corpusMax: 1, median: 1 },
    },
  };

  const result = applySoftLexicalConstraint([chunk], 'rareterm', [chunk]);

  assert.equal(result.filtered.length, 1);
});

test('rag rerank wrapper exports the existing rerank function', () => {
  assert.equal(typeof rerank, 'function');
});

test('rag corpus cache wrapper preserves disk-backed cache exports and source key helper', () => {
  const source = { type: 'url' as const, url: 'https://example.com' };
  const sourceKey = buildSourceKey({ adapter: 'url', source });

  assert.equal(typeof getOrBuildCorpus, 'function');
  assert.equal(typeof computeCorpusId, 'function');
  assert.equal(sourceKey, '{"adapter":"url","source":{"type":"url","url":"https://example.com"}}');
});
