import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUrl, dedupPages, dedupPagesByContent, TRACKING_PARAMS } from '../src/utils/url.js';
import type { CrawlPageResult } from '../src/types.js';

// ── TRACKING_PARAMS ─────────────────────────────────────────────────────────

test('TRACKING_PARAMS contains expected utm_* keys', () => {
  assert.ok(TRACKING_PARAMS.has('utm_source'));
  assert.ok(TRACKING_PARAMS.has('utm_medium'));
  assert.ok(TRACKING_PARAMS.has('utm_campaign'));
  assert.ok(TRACKING_PARAMS.has('utm_term'));
  assert.ok(TRACKING_PARAMS.has('utm_content'));
  assert.ok(TRACKING_PARAMS.has('utm_id'));
});

test('TRACKING_PARAMS contains click identifiers', () => {
  assert.ok(TRACKING_PARAMS.has('fbclid'));
  assert.ok(TRACKING_PARAMS.has('gclid'));
  assert.ok(TRACKING_PARAMS.has('gclsrc'));
  assert.ok(TRACKING_PARAMS.has('dclid'));
});

test('TRACKING_PARAMS contains referral params', () => {
  assert.ok(TRACKING_PARAMS.has('ref'));
  assert.ok(TRACKING_PARAMS.has('source'));
  assert.ok(TRACKING_PARAMS.has('mc_cid'));
  assert.ok(TRACKING_PARAMS.has('mc_eid'));
});

// ── normalizeUrl ────────────────────────────────────────────────────────────

test('normalizeUrl: empty string returns empty string', () => {
  assert.equal(normalizeUrl(''), '');
});

test('normalizeUrl: lowercases hostname', () => {
  assert.equal(normalizeUrl('https://Example.com/'), 'https://example.com/');
});

test('normalizeUrl: strips default HTTPS port 443', () => {
  assert.equal(normalizeUrl('https://example.com:443/'), 'https://example.com/');
});

test('normalizeUrl: strips default HTTP port 80', () => {
  assert.equal(normalizeUrl('http://example.com:80/'), 'http://example.com/');
});

test('normalizeUrl: preserves non-default ports', () => {
  assert.equal(normalizeUrl('https://example.com:8080/'), 'https://example.com:8080/');
});

test('normalizeUrl: strips trailing slash on non-root paths', () => {
  assert.equal(normalizeUrl('https://example.com/foo/'), 'https://example.com/foo');
});

test('normalizeUrl: preserves root slash', () => {
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
});

test('normalizeUrl: strips fragments', () => {
  assert.equal(normalizeUrl('https://example.com/foo#bar'), 'https://example.com/foo');
});

test('normalizeUrl: strips utm_source tracking param', () => {
  assert.equal(normalizeUrl('https://example.com?utm_source=x'), 'https://example.com/');
});

test('normalizeUrl: strips multiple tracking params', () => {
  const result = normalizeUrl('https://example.com?utm_source=x&utm_medium=email&fbclid=abc');
  assert.equal(result, 'https://example.com/');
});

test('normalizeUrl: preserves non-tracking query params', () => {
  assert.equal(normalizeUrl('https://example.com?page=2&sort=name'), 'https://example.com/?page=2&sort=name');
});

test('normalizeUrl: strips tracking params but preserves non-tracking params', () => {
  const result = normalizeUrl('https://example.com?utm_source=x&page=2');
  assert.equal(result, 'https://example.com/?page=2');
});

test('normalizeUrl: malformed URL returns best-effort lowercase + stripped trailing slash', () => {
  const result = normalizeUrl('NOT A URL/');
  assert.equal(result, 'not a url');
});

test('normalizeUrl: malformed URL without trailing slash returns lowercase', () => {
  const result = normalizeUrl('NotAUrl');
  assert.equal(result, 'notaurl');
});

test('normalizeUrl: combined normalization', () => {
  const result = normalizeUrl('https://Example.com:443/path/?utm_source=x&page=2#section');
  assert.equal(result, 'https://example.com/path?page=2');
});

test('normalizeUrl: strips ref and source params', () => {
  const result = normalizeUrl('https://example.com?ref=homepage&source=sidebar&id=5');
  assert.equal(result, 'https://example.com/?id=5');
});

test('normalizeUrl: strips mc_cid and mc_eid params', () => {
  const result = normalizeUrl('https://example.com?mc_cid=abc&mc_eid=xyz&token=123');
  assert.equal(result, 'https://example.com/?token=123');
});

test('normalizeUrl: URL with no query params is unchanged (besides hostname normalization)', () => {
  assert.equal(normalizeUrl('https://example.com/path/to/page'), 'https://example.com/path/to/page');
});

test('normalizeUrl: strips www. prefix from hostname', () => {
  assert.equal(normalizeUrl('https://www.example.com/path'), 'https://example.com/path');
});

test('normalizeUrl: strips www. prefix with trailing slash', () => {
  assert.equal(normalizeUrl('https://www.example.com/'), 'https://example.com/');
});

test('normalizeUrl: combined www + tracking + trailing slash', () => {
  const result = normalizeUrl('https://www.Example.com/path/?utm_source=x&page=2');
  assert.equal(result, 'https://example.com/path?page=2');
});

// ── dedupPages ──────────────────────────────────────────────────────────────

function makePage(url: string): CrawlPageResult {
  return { url, success: true, markdown: '', title: null, description: null, links: [], statusCode: 200, errorMessage: null };
}

test('dedupPages: deduplicates by normalized URL, keeps first occurrence', () => {
  const pages = [
    makePage('https://example.com/foo'),
    makePage('https://example.com/foo/'),
    makePage('https://example.com/foo#bar'),
  ];
  const result = dedupPages(pages);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.url, 'https://example.com/foo');
});

test('dedupPages: different URLs are kept', () => {
  const pages = [
    makePage('https://example.com/foo'),
    makePage('https://example.com/bar'),
  ];
  const result = dedupPages(pages);
  assert.equal(result.length, 2);
});

test('dedupPages: empty-URL pages are kept (not deduped)', () => {
  const pages = [
    makePage(''),
    makePage(''),
    makePage('https://example.com/'),
  ];
  const result = dedupPages(pages);
  assert.equal(result.length, 3);
});

test('dedupPages: tracking param differences are deduplicated', () => {
  const pages = [
    makePage('https://example.com?utm_source=google'),
    makePage('https://example.com?utm_source=facebook'),
  ];
  const result = dedupPages(pages);
  assert.equal(result.length, 1);
});

test('dedupPages: empty input returns empty array', () => {
  const result = dedupPages([]);
  assert.equal(result.length, 0);
});

test('dedupPages: case differences in hostname are deduplicated', () => {
  const pages = [
    makePage('https://Example.com/page'),
    makePage('https://example.com/page'),
  ];
  const result = dedupPages(pages);
  assert.equal(result.length, 1);
});

// ── dedupPagesByContent ────────────────────────────────────────────────────────

function makeContentPage(url: string, markdown: string): CrawlPageResult {
  return { url, success: true, markdown, title: null, description: null, links: [], statusCode: 200, errorMessage: null };
}

test('dedupPagesByContent: removes pages with identical markdown content', () => {
  const pages: CrawlPageResult[] = [
    makeContentPage('https://example.com/v2/guide', '# Hello World\nSome content.'),
    makeContentPage('https://example.com/guide', '# Hello World\nSome content.'),
    makeContentPage('https://example.com/other', '# Different page'),
  ];
  const result = dedupPagesByContent(pages);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.url, 'https://example.com/v2/guide');
  assert.equal(result[1]!.url, 'https://example.com/other');
});

test('dedupPagesByContent: keeps first occurrence of duplicate content', () => {
  const pages: CrawlPageResult[] = [
    makeContentPage('https://example.com/first', 'identical content'),
    makeContentPage('https://example.com/second', 'identical content'),
  ];
  const result = dedupPagesByContent(pages);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.url, 'https://example.com/first');
});

test('dedupPagesByContent: empty markdown pages are NOT deduped', () => {
  const pages: CrawlPageResult[] = [
    makeContentPage('https://example.com/err1', ''),
    makeContentPage('https://example.com/err2', ''),
    makeContentPage('https://example.com/ok', 'real content'),
  ];
  const result = dedupPagesByContent(pages);
  assert.equal(result.length, 3);
});

test('dedupPagesByContent: empty input returns empty array', () => {
  const result = dedupPagesByContent([]);
  assert.equal(result.length, 0);
});

test('dedupPagesByContent: single page is returned unchanged', () => {
  const pages: CrawlPageResult[] = [
    makeContentPage('https://example.com/only', 'unique content'),
  ];
  const result = dedupPagesByContent(pages);
  assert.equal(result.length, 1);
});

test('dedupPagesByContent: all pages with same content return only first', () => {
  const pages: CrawlPageResult[] = [
    makeContentPage('https://example.com/a', 'same'),
    makeContentPage('https://example.com/b', 'same'),
    makeContentPage('https://example.com/c', 'same'),
  ];
  const result = dedupPagesByContent(pages);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.url, 'https://example.com/a');
});

test('dedupPagesByContent: all unique pages are all kept', () => {
  const pages: CrawlPageResult[] = [
    makeContentPage('https://example.com/a', 'content A'),
    makeContentPage('https://example.com/b', 'content B'),
    makeContentPage('https://example.com/c', 'content C'),
  ];
  const result = dedupPagesByContent(pages);
  assert.equal(result.length, 3);
});

test('dedupPagesByContent: different whitespace produces different hashes', () => {
  const pages: CrawlPageResult[] = [
    makeContentPage('https://example.com/a', 'hello world'),
    makeContentPage('https://example.com/b', 'hello  world'),
  ];
  const result = dedupPagesByContent(pages);
  assert.equal(result.length, 2);
});

test('dedupPagesByContent: mixed empty and duplicate content', () => {
  const pages: CrawlPageResult[] = [
    makeContentPage('https://example.com/err', ''),
    makeContentPage('https://example.com/dup1', 'shared content'),
    makeContentPage('https://example.com/dup2', 'shared content'),
    makeContentPage('https://example.com/unique', 'unique stuff'),
  ];
  const result = dedupPagesByContent(pages);
  assert.equal(result.length, 3);
  assert.equal(result[0]!.url, 'https://example.com/err');
  assert.equal(result[1]!.url, 'https://example.com/dup1');
  assert.equal(result[2]!.url, 'https://example.com/unique');
});
