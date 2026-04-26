import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCodeBlocks, buildSearchQuery } from '../src/tools/stackoverflowAnswers.js';

// ── extractCodeBlocks ───────────────────────────────────────────────────────

test('extractCodeBlocks extracts code blocks with language', () => {
  const html = `
    <pre><code class="language-typescript">const x: number = 1;</code></pre>
    <pre><code>Plain code block</code></pre>
  `;
  const blocks = extractCodeBlocks(html);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.language, 'typescript');
  assert.equal(blocks[0]!.code, 'const x: number = 1;');
  assert.equal(blocks[1]!.language, undefined);
  assert.equal(blocks[1]!.code, 'Plain code block');
});

test('extractCodeBlocks decodes HTML entities', () => {
  const html = '<pre><code>&lt;div&gt;</code></pre>';
  const blocks = extractCodeBlocks(html);
  assert.equal(blocks[0]!.code, '<div>');
});

test('extractCodeBlocks returns empty for no code blocks', () => {
  assert.deepEqual(extractCodeBlocks('<p>No code here</p>'), []);
});

// ── buildSearchQuery ────────────────────────────────────────────────────────

test('buildSearchQuery builds query with all params', () => {
  const query = buildSearchQuery({
    intitle: 'TypeScript',
    tagged: ['typescript', 'react'],
    notTagged: ['angular'],
    minScore: 10,
    hasAnswers: true,
    accepted: true,
  });
  assert.ok(query.includes('intitle:TypeScript'));
  assert.ok(query.includes('tagged='));
  assert.ok(query.includes('nottagged='));
  assert.ok(query.includes('min=10'));
  assert.ok(query.includes('answers:1'));
  assert.ok(query.includes('hasaccepted:yes'));
});

test('buildSearchQuery builds empty query when no params', () => {
  assert.equal(buildSearchQuery({}), '');
});
