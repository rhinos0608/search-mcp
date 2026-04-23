import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractElementsFromHtml } from '../src/utils/htmlElements.js';

test('extracts headings with levels', () => {
  const html = '<h1>Title</h1><h2>Subtitle</h2><p>Body</p>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 3);
  assert.deepEqual(elements[0], { type: 'heading', level: 1, text: 'Title', id: null });
  assert.deepEqual(elements[1], { type: 'heading', level: 2, text: 'Subtitle', id: null });
});

test('extracts table as markdown', () => {
  const html = '<table><caption>Results</caption><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 1);
  const table = elements[0]!;
  assert.equal(table.type, 'table');
  assert.ok(table.markdown!.includes('| A | B |'));
  assert.equal(table.caption, 'Results');
});

test('extracts images with alt and src', () => {
  const html = '<img src="/pic.png" alt="diagram" title="My Diagram">';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0], {
    type: 'image',
    src: '/pic.png',
    alt: 'diagram',
    title: 'My Diagram',
  });
});

test('extracts code blocks with language', () => {
  const html = '<pre><code class="language-python">print(1)</code></pre>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0], {
    type: 'code',
    language: 'python',
    content: 'print(1)',
  });
});

test('extracts unordered and ordered lists', () => {
  const html = '<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 2);
  assert.deepEqual(elements[0], { type: 'list', ordered: false, items: ['one', 'two'] });
  assert.deepEqual(elements[1], { type: 'list', ordered: true, items: ['first'] });
});

test('skips script and style tags', () => {
  const html = '<script>alert(1)</script><style>.x{}</style><p>text</p>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0], { type: 'text', text: 'text' });
});

test('converts inline code inside paragraphs to plain text', () => {
  const html = '<p>Use <code>const</code> for declarations.</p>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 1);
  assert.equal(elements[0]!.type, 'text');
  assert.equal(elements[0]!.text, 'Use const for declarations.');
});
