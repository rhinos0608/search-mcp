import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLikelyJsHeavySite,
  estimateSerializedBytes,
  SAFE_BYTES,
  RESPONSE_CAP_BYTES,
  DEFAULT_AVG_PAGE_BYTES,
  JS_HEAVY_AVG_PAGE_BYTES,
} from '../src/utils/crawlBudget.js';

// ── Constants ────────────────────────────────────────────────────────────────

test('SAFE_BYTES is 80% of RESPONSE_CAP_BYTES', () => {
  assert.equal(SAFE_BYTES, Math.floor(RESPONSE_CAP_BYTES * 0.8));
});

test('JS_HEAVY_AVG_PAGE_BYTES is larger than DEFAULT_AVG_PAGE_BYTES', () => {
  assert.ok(JS_HEAVY_AVG_PAGE_BYTES > DEFAULT_AVG_PAGE_BYTES);
});

// ── isLikelyJsHeavySite ──────────────────────────────────────────────────────

test('isLikelyJsHeavySite: search source type → true regardless of URL', () => {
  assert.equal(isLikelyJsHeavySite({ sourceType: 'search' }), true);
  assert.equal(isLikelyJsHeavySite({ sourceType: 'search', url: 'https://docs.example.com/' }), true);
});

test('isLikelyJsHeavySite: known-heavy hostname seek.com.au → true', () => {
  assert.equal(
    isLikelyJsHeavySite({ sourceType: 'url', url: 'https://www.seek.com.au/data-entry-jobs' }),
    true,
  );
});

test('isLikelyJsHeavySite: known-heavy hostname indeed.com → true', () => {
  assert.equal(
    isLikelyJsHeavySite({ sourceType: 'url', url: 'https://au.indeed.com/q-developer-l-sydney' }),
    true,
  );
});

test('isLikelyJsHeavySite: URL with ?q= param → true', () => {
  assert.equal(
    isLikelyJsHeavySite({ sourceType: 'url', url: 'https://example.com/find?q=developer' }),
    true,
  );
});

test('isLikelyJsHeavySite: URL with /search path → true', () => {
  assert.equal(
    isLikelyJsHeavySite({ sourceType: 'url', url: 'https://example.com/search/results' }),
    true,
  );
});

test('isLikelyJsHeavySite: URL with /jobs path → true', () => {
  assert.equal(
    isLikelyJsHeavySite({ sourceType: 'url', url: 'https://example.com/jobs/sydney' }),
    true,
  );
});

test('isLikelyJsHeavySite: plain docs URL with url source → false', () => {
  assert.equal(
    isLikelyJsHeavySite({ sourceType: 'url', url: 'https://docs.example.com/getting-started' }),
    false,
  );
});

test('isLikelyJsHeavySite: sitemap source with normal URL → false', () => {
  assert.equal(
    isLikelyJsHeavySite({ sourceType: 'sitemap', url: 'https://example.com/sitemap.xml' }),
    false,
  );
});

test('isLikelyJsHeavySite: github source → false', () => {
  assert.equal(
    isLikelyJsHeavySite({ sourceType: 'github', url: 'https://github.com/user/repo' }),
    false,
  );
});

test('isLikelyJsHeavySite: no url provided for url source → false', () => {
  assert.equal(isLikelyJsHeavySite({ sourceType: 'url' }), false);
});

// ── estimateSerializedBytes ───────────────────────────────────────────────────

test('estimateSerializedBytes matches Buffer.byteLength of JSON.stringify', () => {
  const value = { url: 'https://example.com', markdown: 'hello world', success: true };
  const expected = Buffer.byteLength(JSON.stringify(value), 'utf8');
  assert.equal(estimateSerializedBytes(value), expected);
});

test('estimateSerializedBytes handles multibyte characters', () => {
  const value = { text: '你好世界' };
  const expected = Buffer.byteLength(JSON.stringify(value), 'utf8');
  assert.equal(estimateSerializedBytes(value), expected);
});
