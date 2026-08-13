import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arxivHtmlUrls,
  arxivPdfToAbstract,
  documentFallbackUrls,
  arxivIdFromUrl,
} from '../src/utils/documentUtils.js';

test('arxivHtmlUrls returns html + ar5iv candidates for a pdf URL', () => {
  const urls = arxivHtmlUrls('https://arxiv.org/pdf/2402.08954');
  assert.ok(urls.includes('https://arxiv.org/html/2402.08954'));
  assert.ok(urls.includes('https://ar5iv.labs.arxiv.org/html/2402.08954'));
});

test('arxivHtmlUrls strips version suffix from abs URLs', () => {
  const urls = arxivHtmlUrls('https://arxiv.org/abs/2402.08954v3');
  assert.ok(urls.includes('https://arxiv.org/html/2402.08954'));
  assert.ok(urls.includes('https://ar5iv.labs.arxiv.org/html/2402.08954'));
});

test('arxivHtmlUrls returns [] for non-arxiv URLs', () => {
  assert.deepEqual(arxivHtmlUrls('https://example.com/foo.pdf'), []);
  assert.deepEqual(arxivHtmlUrls('not a url'), []);
});

test('arxivIdFromUrl parses pdf, abs, and subdomain arxiv hosts', () => {
  assert.equal(arxivIdFromUrl('https://arxiv.org/pdf/2402.08954'), '2402.08954');
  assert.equal(arxivIdFromUrl('https://arxiv.org/abs/2402.08954v3'), '2402.08954');
  assert.equal(arxivIdFromUrl('https://export.arxiv.org/pdf/2402.08954'), '2402.08954');
  assert.equal(arxivIdFromUrl('https://arxiv.org/pdf/2402.08954.pdf'), '2402.08954');
  assert.equal(arxivIdFromUrl('https://example.com/pdf/2402.08954'), null);
});

test('documentFallbackUrls lists arxiv html candidate before abs URL', () => {
  const urls = documentFallbackUrls('https://arxiv.org/pdf/2402.08954');
  const htmlIdx = urls.indexOf('https://arxiv.org/html/2402.08954');
  const absIdx = urls.indexOf('https://arxiv.org/abs/2402.08954');
  assert.ok(htmlIdx !== -1, 'html candidate present');
  assert.ok(absIdx !== -1, 'abs candidate present');
  assert.ok(htmlIdx < absIdx, 'html candidate ordered before abs');
});

test('arxivPdfToAbstract still returns the abs URL for a pdf input (regression)', () => {
  assert.equal(
    arxivPdfToAbstract('https://arxiv.org/pdf/2402.08954'),
    'https://arxiv.org/abs/2402.08954',
  );
});

test('documentFallbackUrls dedupes candidates', () => {
  const urls = documentFallbackUrls('https://arxiv.org/abs/2402.08954');
  assert.equal(new Set(urls).size, urls.length, 'no duplicate candidates');
});
