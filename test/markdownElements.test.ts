import test from 'node:test';
import assert from 'node:assert/strict';
import { extractElementsFromMarkdown } from '../src/utils/markdownElements.js';

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
