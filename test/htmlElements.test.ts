import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractElementsFromHtml } from '../src/utils/htmlElements.js';
import type { TableElement, ImageElement } from '../src/types.js';

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
  const table = elements[0]! as TableElement;
  assert.equal(table.type, 'table');
  assert.ok(table.markdown.includes('| A | B |'));
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

test('skips nav, header, and footer content', () => {
  const html = '<nav>Nav link</nav><header>Header</header><main><p>Body</p></main><footer>Footer</footer>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0], { type: 'text', text: 'Body' });
});

test('skips deeply nested content inside ignored tags', () => {
  const html = '<nav><div><p>Nested nav text</p></div></nav><p>Body</p>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0], { type: 'text', text: 'Body' });
});

test('handles nested lists', () => {
  const html = '<ul><li>outer<ul><li>inner</li></ul></li></ul>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 2);
  assert.equal(elements[0]!.type, 'list');
  assert.equal(elements[0]!.items[0], 'outerinner');
  assert.equal(elements[1]!.type, 'list');
  assert.equal(elements[1]!.items[0], 'inner');
});

test('handles nested tables', () => {
  const html = '<table><tr><td><table><tr><th>X</th></tr><tr><td>1</td></tr></table></td></tr></table>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 2);
  assert.equal(elements[0]!.type, 'table');
  assert.equal(elements[1]!.type, 'table');
});

test('table separator covers all columns even when first row has fewer', () => {
  const html = '<table><tr><td>A</td></tr><tr><td>1</td><td>2</td></tr></table>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 1);
  const table = elements[0]! as TableElement;
  assert.equal(table.cols, 2);
  assert.ok(table.markdown.includes(' --- | --- |'));
});

test('handles img with missing src', () => {
  const html = '<img alt="no src">';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 1);
  assert.equal(elements[0]!.type, 'image');
  assert.equal(elements[0]!.src, null);
});

test('handles pre without code child', () => {
  const html = '<pre>raw text</pre>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 1);
  assert.equal(elements[0]!.type, 'code');
  assert.equal(elements[0]!.language, null);
  assert.equal(elements[0]!.content, 'raw text');
});

test('filters out empty headings and lists', () => {
  const html = '<h1></h1><ul></ul><ol></ol><p>text</p>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0], { type: 'text', text: 'text' });
});

test('filters out empty table', () => {
  const html = '<table></table><p>text</p>';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 2);
  assert.equal(elements[0]!.type, 'table');
  assert.equal(elements[1]!.type, 'text');
});

test('filters dangerous image src schemes', () => {
  const html = '<img src="javascript:alert(1)" alt="bad"><img src="data:text/html,foo" alt="also bad"><img src="/safe.png" alt="safe">';
  const dom = new JSDOM(html);
  const elements = extractElementsFromHtml(dom.window.document);

  assert.equal(elements.length, 3);
  assert.equal((elements[0]! as ImageElement).src, null);
  assert.equal((elements[1]! as ImageElement).src, null);
  assert.equal((elements[2]! as ImageElement).src, '/safe.png');
});
