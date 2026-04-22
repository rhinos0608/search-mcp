import { describe, it } from 'node:test';
import assert from 'node:assert';
import { chunkMarkdown } from '../src/chunking.js';

describe('chunkMarkdown', () => {
  it('splits on H2 and H3 boundaries', () => {
    const longText = 'Word '.repeat(50);
    const md = `# Title\n\n## Section A\n\n${longText}Content A.\n\n### Sub B\n\n${longText}Content B.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.strictEqual(chunks.length, 2);
    assert.ok(chunks[0]);
    assert.ok(chunks[0].content.includes('Content A.'));
    assert.strictEqual(chunks[0].section, '# Title > ## Section A');
    assert.ok(chunks[1]);
    assert.ok(chunks[1].content.includes('Content B.'));
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

  it('annotates totalChunks per section', () => {
    const longText = 'Word '.repeat(500);
    const md = `# Title\n\n## One\n\n${longText}\n\n## Two\n\n${longText}`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    const sectionOne = chunks.filter((c) => c.section.includes('One'));
    const sectionTwo = chunks.filter((c) => c.section.includes('Two'));
    assert.ok(sectionOne.length > 1, 'Section One should split into multiple chunks');
    assert.ok(sectionTwo.length > 1, 'Section Two should split into multiple chunks');
    for (const c of sectionOne) {
      assert.strictEqual(c.totalChunks, sectionOne.length);
    }
    for (const c of sectionTwo) {
      assert.strictEqual(c.totalChunks, sectionTwo.length);
    }
  });

  it('does not treat # lines inside code fences as headings', () => {
    const md = `# Title\n\n## Section\n\n\`\`\`python\n# This is a comment\ndef foo():\n    pass\n\`\`\`\n\nText after.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    const codeChunk = chunks.find((c) => c.content.includes('def foo():'));
    assert.ok(codeChunk);
    assert.ok(codeChunk!.content.includes('# This is a comment'));
    assert.strictEqual(codeChunk!.totalChunks, 1); // should not be split
  });

  it('does not split on H4+ headings', () => {
    const md = `# Title\n\n## Section A\n\nContent A.\n\n#### H4 Heading\n\nMore content under A.\n\n### Sub B\n\nContent B.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    const sectionA = chunks.find((c) => c.section.includes('Section A'));
    assert.ok(sectionA);
    assert.ok(sectionA!.content.includes('H4 Heading'));
    assert.ok(sectionA!.content.includes('More content under A.'));
  });

  it('preserves content before the first heading', () => {
    const md = `Some intro text here.\n\n# Title\n\n## Section\n\nContent.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.ok(chunks.some((c) => c.content.includes('Some intro text here.')));
  });

  it('merges last short section backward', () => {
    const md = `# Title\n\n## A\n\nThis is a much longer section with enough content to clear the fifty token floor easily. This is a much longer section with enough content to clear the fifty token floor easily. This is a much longer section with enough content to clear the fifty token floor easily.\n\n## B\n\nShort.\n\n## C\n\nAlso short.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    // B and C are short and at the end; they should merge backward into A or forward into each other
    assert.ok(chunks.every((c) => c.tokenEstimate >= 50 || chunks.length === 1));
  });

  it('keeps markdown tables atomic', () => {
    const md = `# Title\n\n## Section\n\n| Col1 | Col2 |\n|------|------|\n| A    | B    |\n| C    | D    |\n\nText after.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    const tableChunk = chunks.find((c) => c.content.includes('| Col1 |'));
    assert.ok(tableChunk);
    assert.ok(tableChunk!.content.includes('| C    | D    |'));
  });

  it('handles empty input', () => {
    const chunks = chunkMarkdown('', 'https://example.com');
    assert.strictEqual(chunks.length, 0);
  });

  it('handles input with no headings', () => {
    const md = 'Just some plain text without any headings at all. It should still produce a chunk.';
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.strictEqual(chunks.length, 1);
    assert.ok(chunks[0]);
    assert.ok(chunks[0].content.includes('Just some plain text'));
  });

  it('keeps oversized atomic units whole', () => {
    const code = 'x = 1\n'.repeat(500); // ~3000 chars, well over MAX_TOKENS
    const after = 'This is a much longer section with enough content to clear the fifty token floor easily. '.repeat(4);
    const md = `# Title\n\n## Section\n\n\`\`\`python\n${code}\`\`\`\n\n${after}`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    const codeChunk = chunks.find((c) => c.content.includes('x = 1'));
    assert.ok(codeChunk);
    assert.ok(codeChunk!.content.startsWith('\`\`\`'));
    assert.ok(codeChunk!.content.endsWith('\`\`\`'));
  });

  it('handles multiple H1s', () => {
    const md = `# First\n\n## A\n\nContent A.\n\n# Second\n\n## B\n\nContent B.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    // All chunks should have pageTitle from first H1
    assert.ok(chunks.every((c) => c.pageTitle === 'First'));
    // Second H1 content should appear in some chunk
    assert.ok(chunks.some((c) => c.content.includes('Content B.')));
  });

  it('has monotonically increasing charOffsets', () => {
    const md = `# Title\n\n## One\n\n${'Word '.repeat(200)}\n\n## Two\n\n${'Word '.repeat(200)}`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    for (let i = 1; i < chunks.length; i++) {
      const curr = chunks[i];
      const prev = chunks[i - 1];
      if (curr && prev) {
        assert.ok(curr.charOffset >= prev.charOffset, `charOffset should not decrease at index ${i}`);
      }
    }
  });
});
