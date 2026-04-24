import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractElementsFromMarkdown,
  MAX_ELEMENTS,
  MAX_TEXT_LENGTH,
  TRUNCATED_MARKER,
} from '../src/utils/markdownElements.js';

test('extracts headings', () => {
  const md = '# H1\n\n## H2\n\nparagraph\n';
  const elements = extractElementsFromMarkdown(md);

  assert.equal(elements.length, 3);
  assert.deepEqual(elements[0], { type: 'heading', level: 1, text: 'H1', id: null });
  assert.deepEqual(elements[1], { type: 'heading', level: 2, text: 'H2', id: null });
});

test('extracts table from markdown', () => {
  const md = '| A | B |\n|---|---|\n| 1 | 2 |\n';
  const elements = extractElementsFromMarkdown(md);

  assert.equal(elements.length, 1);
  const table = elements[0]!;
  assert.equal(table.type, 'table');
  assert.ok(table.markdown!.includes('| A | B |'));
  assert.equal(table.rows, 2);
  assert.equal(table.cols, 2);
});

test('extracts fenced code blocks with language', () => {
  const md = '```python\nprint(1)\n```\n';
  const elements = extractElementsFromMarkdown(md);

  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0], { type: 'code', language: 'python', content: 'print(1)' });
});

test('extracts inline code as text', () => {
  const md = 'Use `const` for declarations.\n';
  const elements = extractElementsFromMarkdown(md);

  assert.equal(elements.length, 1);
  assert.equal(elements[0]!.type, 'text');
  assert.equal(elements[0]!.text, 'Use const for declarations.');
});

test('extracts images from markdown', () => {
  const md = '![alt text](https://example.com/img.png "title")\n';
  const elements = extractElementsFromMarkdown(md);

  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0], {
    type: 'image',
    src: 'https://example.com/img.png',
    alt: 'alt text',
    title: 'title',
  });
});

test('extracts images without title', () => {
  const md = '![alt text](https://example.com/img.png)\n';
  const elements = extractElementsFromMarkdown(md);

  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0], {
    type: 'image',
    src: 'https://example.com/img.png',
    alt: 'alt text',
    title: null,
  });
});

test('extracts multiple image lines', () => {
  const md = '![a](http://a.com/a.png)\n![b](http://b.com/b.png)\n';
  const elements = extractElementsFromMarkdown(md);

  assert.equal(elements.length, 2);
  assert.equal(elements[0]!.type, 'image');
  assert.equal(elements[0]!.src, 'http://a.com/a.png');
  assert.equal(elements[1]!.type, 'image');
  assert.equal(elements[1]!.src, 'http://b.com/b.png');
});

test('extracts unordered and ordered lists', () => {
  const md = '- one\n- two\n\n1. first\n';
  const elements = extractElementsFromMarkdown(md);

  assert.equal(elements.length, 2);
  assert.deepEqual(elements[0], { type: 'list', ordered: false, items: ['one', 'two'] });
  assert.deepEqual(elements[1], { type: 'list', ordered: true, items: ['first'] });
});

test('handles mixed markdown', () => {
  const md = `# Title

Some intro text.

| Col1 | Col2 |
|------|------|
| a    | b    |

- item 1
- item 2

\`\`\`js
const x = 1;
\`\`\`

![pic](/img.jpg)
`;
  const elements = extractElementsFromMarkdown(md);

  assert.equal(elements[0]!.type, 'heading');
  assert.equal(elements[1]!.type, 'text');
  assert.equal(elements[2]!.type, 'table');
  assert.equal(elements[3]!.type, 'list');
  assert.equal(elements[4]!.type, 'code');
  assert.equal(elements[5]!.type, 'image');
});

test('handles empty input', () => {
  const elements = extractElementsFromMarkdown('');
  assert.equal(elements.length, 0);
});

test('handles whitespace-only input', () => {
  const elements = extractElementsFromMarkdown('   \n\n  ');
  assert.equal(elements.length, 0);
});

test('handles unclosed fenced code block', () => {
  const md = '```python\nprint(1)\n';
  const elements = extractElementsFromMarkdown(md);

  assert.equal(elements.length, 1);
  assert.equal(elements[0]!.type, 'code');
  assert.equal(elements[0]!.language, 'python');
  assert.equal(elements[0]!.content, 'print(1)');
});

test('handles fenced code block containing backticks', () => {
  const md = '````\n```\ninner\n```\n````\n';
  const elements = extractElementsFromMarkdown(md);

  assert.equal(elements.length, 1);
  assert.equal(elements[0]!.type, 'code');
  assert.ok(elements[0]!.content.includes('inner'));
});

test('handles list continuation lines', () => {
  const md = '- first item\n  continuation text\n- second item\n';
  const elements = extractElementsFromMarkdown(md);

  assert.equal(elements.length, 1);
  const list = elements[0]!;
  assert.equal(list.type, 'list');
  assert.equal(list.items.length, 2);
  assert.ok(list.items[0]!.includes('continuation'));
});

test('keeps late high-signal candidates beyond final element budget', () => {
  const paragraphs = Array.from({ length: MAX_ELEMENTS + 5 }, (_, i) => `Paragraph ${i}`).join(
    '\n\n',
  );
  const md = `${paragraphs}\n\n## Late heading\n\n| A |\n|---|\n| B |\n`;
  const elements = extractElementsFromMarkdown(md);

  assert.ok(elements.length > MAX_ELEMENTS);
  assert.ok(
    elements.some((element) => element.type === 'heading' && element.text === 'Late heading'),
  );
  assert.ok(elements.some((element) => element.type === 'table'));
});

test('annotates truncated text, code, and table markdown payloads', () => {
  const longText = 'a'.repeat(MAX_TEXT_LENGTH + 10);
  const md = `${longText}\n\n\`\`\`ts\n${longText}\n\`\`\`\n\n| A |\n|---|\n| ${longText} |\n`;
  const elements = extractElementsFromMarkdown(md);

  const text = elements.find((element) => element.type === 'text') as
    | { type: 'text'; text: string; truncated?: true; originalLength?: number }
    | undefined;
  const code = elements.find((element) => element.type === 'code') as
    | { type: 'code'; content: string; truncated?: true; originalLength?: number }
    | undefined;
  const table = elements.find((element) => element.type === 'table') as
    | { type: 'table'; markdown: string; truncated?: true; originalLength?: number }
    | undefined;

  assert.equal(text?.truncated, true);
  assert.equal(text?.originalLength, longText.length);
  assert.ok(text?.text.endsWith(TRUNCATED_MARKER));

  assert.equal(code?.truncated, true);
  assert.equal(code?.originalLength, longText.length);
  assert.ok(code?.content.endsWith(TRUNCATED_MARKER));

  assert.equal(table?.truncated, true);
  assert.ok((table?.originalLength ?? 0) > MAX_TEXT_LENGTH);
  assert.ok(table?.markdown.endsWith(TRUNCATED_MARKER));
});
