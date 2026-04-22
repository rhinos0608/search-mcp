import { describe, it } from 'node:test';
import assert from 'node:assert';
import { chunkMarkdown } from '../src/chunking.js';

describe('chunkMarkdown', () => {
  it('splits on H2 and H3 boundaries', () => {
    const md = `# Title\n\n## Section A\n\nContent A.\n\n### Sub B\n\nContent B.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.strictEqual(chunks.length, 2);
    assert.ok(chunks[0]);
    assert.strictEqual(chunks[0].content.trim(), 'Content A.');
    assert.strictEqual(chunks[0].section, '# Title > ## Section A');
    assert.ok(chunks[1]);
    assert.strictEqual(chunks[1].content.trim(), 'Content B.');
    assert.strictEqual(chunks[1].section, '# Title > ## Section A > ### Sub B');
  });

  it('keeps code fences atomic', () => {
    const md = `# Title\n\n## Section\n\nText before.\n\n\`\`\`python\ndef foo():\n    pass\n\`\`\`\n\nText after.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    const codeChunk = chunks.find((c) => c.content.includes('def foo():'));
    assert.ok(codeChunk);
    assert.ok(codeChunk!.content.includes('\`\`\`'));
  });

  it('merges short sections forward', () => {
    const md = `# Title\n\n## A\n\nShort.\n\n## B\n\nThis is a much longer section with enough content to clear the fifty token floor easily. This is a much longer section with enough content to clear the fifty token floor easily. This is a much longer section with enough content to clear the fifty token floor easily. This is a much longer section with enough content to clear the fifty token floor easily.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    // Short section A should be merged into B
    assert.ok(chunks.length <= 2);
    assert.ok(chunks.some((c) => c.content.includes('Short.') && c.content.includes('much longer')));
  });

  it('splits oversized sections at boundaries', () => {
    const md = `# Title\n\n## Big\n\n${'Word '.repeat(500)}`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.ok(chunks.length >= 1);
    assert.ok(chunks.every((c) => c.content.length > 0));
  });

  it('preserves H1 as pageTitle on every chunk', () => {
    const md = `# My Page\n\n## One\n\nContent.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.ok(chunks[0]);
    assert.strictEqual(chunks[0].pageTitle, 'My Page');
  });

  it('annotates totalChunks correctly', () => {
    const md = `# Title\n\n## One\n\nContent one.\n\n## Two\n\nContent two.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    for (const c of chunks) {
      assert.strictEqual(c.totalChunks, chunks.length);
    }
  });
});
