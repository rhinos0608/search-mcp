import test from 'node:test';
import assert from 'node:assert/strict';
import { LinkExtractor } from '../../src/crawl/linkExtractor.js';

// ── HTML Extraction ────────────────────────────────────────────────────────

test('LinkExtractor: extracts simple <a> links from HTML', () => {
  const extractor = new LinkExtractor();
  const html = '<a href="https://example.com/page">Link</a>';
  const links = extractor.extractFromHtml(html, 'https://base.com');
  assert.equal(links.length, 1);
  assert.equal(links[0]?.url, 'https://example.com/page');
});

test('LinkExtractor: extracts multiple links', () => {
  const extractor = new LinkExtractor();
  const html = '<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>';
  const links = extractor.extractFromHtml(html, 'https://example.com');
  assert.equal(links.length, 3);
});

test('LinkExtractor: resolves relative URLs', () => {
  const extractor = new LinkExtractor();
  const html = '<a href="/blog/post">Blog</a>';
  const links = extractor.extractFromHtml(html, 'https://example.com');
  assert.equal(links[0]?.url, 'https://example.com/blog/post');
});

test('LinkExtractor: ignores anchor-only links', () => {
  const extractor = new LinkExtractor();
  const html = '<a href="#section">Section</a>';
  const links = extractor.extractFromHtml(html, 'https://example.com');
  assert.equal(links.length, 0);
});

test('LinkExtractor: ignores javascript: links', () => {
  const extractor = new LinkExtractor();
  const html = '<a href="javascript:void(0)">Click</a>';
  const links = extractor.extractFromHtml(html, 'https://example.com');
  assert.equal(links.length, 0);
});

test('LinkExtractor: ignores mailto: links', () => {
  const extractor = new LinkExtractor();
  const html = '<a href="mailto:test@test.com">Email</a>';
  const links = extractor.extractFromHtml(html, 'https://example.com');
  assert.equal(links.length, 0);
});

test('LinkExtractor: ignores data: URIs', () => {
  const extractor = new LinkExtractor();
  const html = '<a href="data:text/html,hello">Data</a>';
  const links = extractor.extractFromHtml(html, 'https://example.com');
  assert.equal(links.length, 0);
});

test('LinkExtractor: extracts <area> links', () => {
  const extractor = new LinkExtractor();
  const html = '<map><area href="https://example.com/area" shape="rect"></map>';
  const links = extractor.extractFromHtml(html, 'https://base.com');
  assert.equal(links.length, 1);
});

test('LinkExtractor: extracts <iframe> src', () => {
  const extractor = new LinkExtractor();
  const html = '<iframe src="https://example.com/embed"></iframe>';
  const links = extractor.extractFromHtml(html, 'https://base.com');
  assert.equal(links.length, 1);
});

test('LinkExtractor: empty HTML returns empty list', () => {
  const extractor = new LinkExtractor();
  const links = extractor.extractFromHtml('', 'https://example.com');
  assert.equal(links.length, 0);
});

// ── Markdown Extraction ────────────────────────────────────────────────────

test('LinkExtractor: extracts markdown links', () => {
  const extractor = new LinkExtractor();
  const md = '[Example](https://example.com)';
  const links = extractor.extractFromMarkdown(md, 'https://base.com');
  assert.equal(links.length, 1);
  assert.equal(links[0]?.url, 'https://example.com/');
  assert.equal(links[0]?.text, 'Example');
});

test('LinkExtractor: extracts multiple markdown links', () => {
  const extractor = new LinkExtractor();
  const md = '[A](https://a.com) text [B](https://b.com) more [C](https://c.com)';
  const links = extractor.extractFromMarkdown(md, 'https://base.com');
  assert.equal(links.length, 3);
});

test('LinkExtractor: resolves relative markdown URLs', () => {
  const extractor = new LinkExtractor();
  const md = '[Page](/page)';
  const links = extractor.extractFromMarkdown(md, 'https://example.com');
  assert.equal(links[0]?.url, 'https://example.com/page');
});

// ── Allow/Deny Rules ───────────────────────────────────────────────────────

test('LinkExtractor: deny pattern filters out matching URLs', () => {
  const extractor = new LinkExtractor([{ deny: [/\.pdf$/] }]);
  const html =
    '<a href="https://example.com/doc.pdf">PDF</a><a href="https://example.com/page">Page</a>';
  const links = extractor.extractFromHtml(html, 'https://base.com');
  assert.equal(links.length, 1);
  assert.equal(links[0]?.url, 'https://example.com/page');
});

test('LinkExtractor: allow pattern only includes matching URLs', () => {
  const extractor = new LinkExtractor([{ allow: [/^https:\/\/blog\./] }]);
  const html =
    '<a href="https://blog.example.com/post">Blog</a><a href="https://other.com/page">Other</a>';
  const links = extractor.extractFromHtml(html, 'https://base.com');
  assert.equal(links.length, 1);
  assert.equal(links[0]?.url, 'https://blog.example.com/post');
});

test('LinkExtractor: deny takes precedence over allow', () => {
  const extractor = new LinkExtractor([{ allow: [/^https:\/\/example\.com/], deny: [/\.pdf$/] }]);
  const html =
    '<a href="https://example.com/doc.pdf">PDF</a><a href="https://example.com/page">Page</a>';
  const links = extractor.extractFromHtml(html, 'https://base.com');
  assert.equal(links.length, 1);
  assert.equal(links[0]?.url, 'https://example.com/page');
});

// ── Tag Filtering ──────────────────────────────────────────────────────────

test('LinkExtractor: tag filtering restricts extracted tags', () => {
  const extractor = new LinkExtractor([{ tags: ['a'] }]);
  const html =
    '<a href="https://a.com">A</a><iframe src="https://iframe.com"></iframe><link href="https://link.com">';
  const links = extractor.extractFromHtml(html, 'https://base.com');
  assert.equal(links.length, 1);
  assert.equal(links[0]?.url, 'https://a.com/');
});

// ── filterLinks ────────────────────────────────────────────────────────────

test('LinkExtractor: filterLinks deduplicates and filters', () => {
  const extractor = new LinkExtractor([{ deny: [/\.pdf$/] }]);
  const input = [
    { url: 'https://example.com/page', text: 'Page' },
    { url: 'https://example.com/page', text: 'Page dup' },
    { url: 'https://example.com/doc.pdf', text: 'PDF' },
  ];
  const filtered = extractor.filterLinks(input);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.url, 'https://example.com/page');
});

// ── Multiple Rules ─────────────────────────────────────────────────────────

test('LinkExtractor: multiple rule sets combined', () => {
  const extractor = new LinkExtractor([
    { deny: [/\.zip$/, /\.tar\.gz$/] },
    { allow: [/^https:\/\/example\.com/] },
  ]);
  const html =
    '<a href="https://example.com/file.zip">Zip</a><a href="https://example.com/file.tar.gz">Tar</a><a href="https://example.com/doc">Doc</a><a href="https://other.com/page">Other</a>';
  const links = extractor.extractFromHtml(html, 'https://base.com');
  assert.equal(links.length, 1);
  assert.equal(links[0]?.url, 'https://example.com/doc');
});

// ── addRule ────────────────────────────────────────────────────────────────

test('LinkExtractor: addRule dynamically', () => {
  const extractor = new LinkExtractor();
  extractor.addRule({ deny: [/\.exe$/] });
  const html = '<a href="https://example.com/app.exe">App</a>';
  const links = extractor.extractFromHtml(html, 'https://base.com');
  assert.equal(links.length, 0);
});

// ── no rules = allow all ───────────────────────────────────────────────────

test('LinkExtractor: no rules allows all extractable links', () => {
  const extractor = new LinkExtractor();
  const html =
    '<a href="https://example.com/1">1</a><a href="https://example.com/2">2</a><a href="https://example.com/3">3</a>';
  const links = extractor.extractFromHtml(html, 'https://base.com');
  assert.equal(links.length, 3);
});
