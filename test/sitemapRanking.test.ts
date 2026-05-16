import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseSitemapLocaleDuplicates, rankSitemapUrls } from '../src/utils/sitemapRanking.js';

test('collapseSitemapLocaleDuplicates keeps the preferred locale representative', () => {
  const result = collapseSitemapLocaleDuplicates(
    [
      'https://docs.example.com/de/guides/install',
      'https://docs.example.com/en/guides/install',
      'https://docs.example.com/ja/guides/install',
      'https://docs.example.com/en/guides/cache',
    ],
    'en',
  );

  assert.equal(result.collapsedCount, 2);
  assert.deepEqual(result.urls, [
    'https://docs.example.com/en/guides/install',
    'https://docs.example.com/en/guides/cache',
  ]);
});

test('rankSitemapUrls still prioritizes query-relevant paths after locale collapse', () => {
  const ranked = rankSitemapUrls(
    [
      'https://docs.example.com/en/blog/company-update',
      'https://docs.example.com/en/reference/reference-counting',
      'https://docs.example.com/en/guides/getting-started',
    ],
    'reference counting',
  );

  assert.equal(ranked[0], 'https://docs.example.com/en/reference/reference-counting');
});
