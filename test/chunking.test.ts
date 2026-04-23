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
    // Short section A should be merged into B, producing exactly one chunk
    assert.strictEqual(chunks.length, 1);
    assert.ok(chunks[0]);
    assert.ok(chunks[0].content.includes('Short.'));
    assert.ok(chunks[0].content.includes('much longer'));
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

  it('tracks ancestor headings across depth changes', () => {
    const md = `# Title\n\n## A\n\nContent A.\n\n### B\n\nContent B.\n\n## C\n\nContent C.\n\n### D\n\nContent D.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    const dChunk = chunks.find((c) => c.content.includes('Content D.'));
    assert.ok(dChunk);
    assert.strictEqual(dChunk!.section, '# Title > ## C > ### D');
  });

  it('snaps overlap to last sentence boundary in window', () => {
    // Create content with many short sentences so the overlap window
    // contains multiple boundaries. The first boundary in the window
    // would give a tiny overlap; the fix should find the best one.
    const sentence = 'Sentence one. Sentence two. Sentence three. Sentence four. Sentence five. ';
    // 60 chars per repeat. Need ~1700 chars to exceed maxChars=1600.
    const content = sentence.repeat(30);
    const md = `# Title\n\n## Section\n\n${content}`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.ok(chunks.length > 1, 'Should produce multiple chunks');
    // No chunk (except first) should start mid-sentence with a lowercase letter
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      const trimmed = chunk.content.trimStart();
      if (trimmed.length === 0) continue;
      const firstChar = trimmed.charAt(0);
      // After sentence snapping, chunks should start at word boundaries
      assert.ok(
        /^[A-Z\d\s`#*|\-]/.test(firstChar) || trimmed.startsWith('```'),
        `Chunk ${i} starts mid-sentence: "${trimmed.slice(0, 40)}"`,
      );
    }
  });

  it('annotates totalChunks globally across all returned chunks', () => {
    const longText = 'Word '.repeat(500);
    const md = `# Title\n\n## One\n\n${longText}\n\n## Two\n\n${longText}`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.ok(chunks.length > 1, 'Should produce multiple chunks');
    for (let i = 0; i < chunks.length; i++) {
      assert.strictEqual(chunks[i]!.chunkIndex, i, `chunkIndex should be ${i}`);
      assert.strictEqual(chunks[i]!.totalChunks, chunks.length, `totalChunks should be ${chunks.length}`);
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

  it('filters nav menu boilerplate with high link density', () => {
    const md = `# Title\n\n## Docs\n\n- [Getting Started](/start)\n- [API Reference](/api)\n- [Examples](/examples)\n- [GitHub](/github)\n\n## Real Content\n\n${'Word '.repeat(50)}This is actual documentation content that should survive filtering.\n`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    // Nav section should be filtered; real content should remain
    assert.ok(chunks.some((c) => c.content.includes('actual documentation content')));
    assert.ok(!chunks.some((c) => c.content.includes('Getting Started')));
  });

  it('filters sidebar link lists', () => {
    const md = `# Title\n\n## Sidebar\n\n- Home\n- About\n- Contact\n- Products\n- Pricing\n- Blog\n\n## Article\n\n${'Word '.repeat(50)}Deep technical article content goes here and should not be filtered.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.ok(chunks.some((c) => c.content.includes('Deep technical article')));
    assert.ok(!chunks.some((c) => c.content.includes('Products')));
  });

  it('keeps content-rich sections with moderate link density', () => {
    const md = `# Title\n\n## Resources\n\nHere are useful links: [Google](https://google.com), [GitHub](https://github.com), and [Docs](https://docs.example.com). ${'Word '.repeat(30)} Plus more detailed explanation that makes this section substantial.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.ok(chunks.length > 0);
    assert.ok(chunks.some((c) => c.content.includes('useful links')));
  });

  // --- New boilerplate heuristics ---

  it('filters breadcrumb navigation patterns', () => {
    const md = `# Title

## Breadcrumbs

[Home](/) > [Docs](/docs) > [API](/api) > [Reference](/ref) > [Users](/users)

## Real Content

${'Word '.repeat(50)}This is the actual documentation content that matters.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.ok(chunks.some((c) => c.content.includes('actual documentation content')));
    assert.ok(!chunks.some((c) => c.content.includes('[Home]')));
  });

  it('filters short-line + link-heavy sidebar content', () => {
    const md = `# Title

## Sidebar

[Intro](/intro)
[Setup](/setup)
[Config](/config)
[Deploy](/deploy)
[FAQ](/faq)

## Article

${'Word '.repeat(50)}Detailed technical article content that should be preserved.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.ok(chunks.some((c) => c.content.includes('Detailed technical article')));
    assert.ok(!chunks.some((c) => c.content.includes('[Intro]')));
  });

  it('filters repeated nav blocks across sibling sections', () => {
    const navBlock = '- [Home](/)\n- [Docs](/docs)\n- [API](/api)\n- [Blog](/blog)\n- [GitHub](/github)';
    const md = `# Title

## Section A

${navBlock}

Some content A here. ${'Word '.repeat(20)}

## Section B

${navBlock}

Some content B here. ${'Word '.repeat(20)}

## Section C

${navBlock}

Some content C here. ${'Word '.repeat(20)}`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    // The repeated nav block should appear at most once (or zero times)
    const navChunks = chunks.filter((c) => c.content.includes('[Home]'));
    assert.ok(navChunks.length <= 1, `Expected at most 1 nav chunk, got ${navChunks.length}`);
    // Content sections should all be present
    assert.ok(chunks.some((c) => c.content.includes('content A')));
    assert.ok(chunks.some((c) => c.content.includes('content B')));
    assert.ok(chunks.some((c) => c.content.includes('content C')));
  });

  it('preserves content with moderate links that is not boilerplate', () => {
    const md = `# Title

## Guide

Read the [installation docs](/install) first, then follow the [configuration guide](/config). ${'Word '.repeat(30)}After setup, you can deploy using our [deployment tool](/deploy).`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.ok(chunks.length > 0);
    assert.ok(chunks.some((c) => c.content.includes('installation docs')));
    assert.ok(chunks.some((c) => c.content.includes('configuration guide')));
  });

  it('filters pure link lines with short average word count', () => {
    const md = `# Title

## Links

[Go here](/a)
[Go there](/b)
[Go everywhere](/c)
[Go nowhere](/d)
[Go somewhere](/e)

## Content

${'Word '.repeat(50)}Real documentation content.`;
    const chunks = chunkMarkdown(md, 'https://example.com');
    assert.ok(chunks.some((c) => c.content.includes('Real documentation')));
    assert.ok(!chunks.some((c) => c.content.includes('[Go here]')));
  });
});
