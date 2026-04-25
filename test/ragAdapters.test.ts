import test from 'node:test';
import assert from 'node:assert/strict';
import { chunksFromTextPages } from '../src/rag/adapters/text.js';
import { chunksFromTranscript } from '../src/rag/adapters/transcript.js';
import { chunksFromConversation } from '../src/rag/adapters/conversation.js';
import * as adapters from '../src/rag/adapters/index.js';

test('text adapter chunks successful markdown pages like semantic crawl page chunking', () => {
  const chunks = chunksFromTextPages([
    {
      url: 'https://example.com/docs',
      markdown: '# Docs\n\n## Install\n\nUse the package manager to install the library.',
      success: true,
    },
    {
      url: 'https://example.com/fail',
      markdown: '# Failed\n\nIgnore me.',
      success: false,
    },
  ]);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.url, 'https://example.com/docs');
  assert.equal(chunks[0]?.section, '# Docs > ## Install');
  assert.equal(chunks[0]?.metadata?.adapter, 'text');
});

test('transcript adapter records segment offset and duration metadata', () => {
  const chunks = chunksFromTranscript({
    videoId: 'abc123',
    title: 'Demo video',
    url: 'https://youtube.com/watch?v=abc123',
    segments: [
      { text: 'Opening words', offset: 12.5, duration: 3.25 },
      { text: 'Second segment', offset: 15.75, duration: 4 },
    ],
  });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.text, 'Opening words');
  assert.equal(chunks[0]?.metadata?.offset, 12.5);
  assert.equal(chunks[0]?.metadata?.duration, 3.25);
  assert.equal(chunks[0]?.metadata?.videoId, 'abc123');
});

test('conversation adapter filters deleted comments and includes bounded parent context', () => {
  const chunks = chunksFromConversation(
    [
      { id: 'root', body: 'Root topic mentions retrieval', author: 'a', permalink: '/root', parentId: null },
      { id: 'deleted', body: '[deleted]', author: '[deleted]', permalink: '/deleted', parentId: 'root' },
      { id: 'removed', body: '[removed]', author: 'mod', permalink: '/removed', parentId: 'root' },
      { id: 'child', body: 'Child answer expands ranking', author: 'b', permalink: '/child', parentId: 'root' },
      { id: 'grandchild', body: 'Grandchild adds fusion detail', author: 'c', permalink: '/grandchild', parentId: 'child' },
    ],
    { parentContextDepth: 1, baseUrl: 'https://reddit.com' },
  );

  assert.deepEqual(
    chunks.map((chunk: { metadata?: Record<string, unknown> | undefined }) => chunk.metadata?.commentId),
    ['root', 'child', 'grandchild'],
  );
  assert.equal(chunks[2]?.metadata?.parentContext, 'Child answer expands ranking');
  assert.ok(!chunks[2]?.text.includes('Root topic mentions retrieval'));
  assert.equal(chunks[2]?.url, 'https://reddit.com/grandchild');
});

test('adapter index exports text transcript and conversation helpers', () => {
  assert.equal(typeof adapters.chunksFromTextPages, 'function');
  assert.equal(typeof adapters.chunksFromTranscript, 'function');
  assert.equal(typeof adapters.chunksFromConversation, 'function');
});
