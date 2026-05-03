import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UrlSpider,
  SitemapSpider,
  SearchSpider,
  GitHubSpider,
  CachedSpider,
  registerSpider,
  getSpider,
  registerDefaultSpiders,
  getRegisteredSourceTypes,
} from '../../src/crawl/spiders.js';
import type { CrawlPageResult, SemanticCrawlSource } from '../../src/types.js';

// ── UrlSpider ──────────────────────────────────────────────────────────────

test('UrlSpider: generates single URL', async () => {
  const spider = new UrlSpider();
  const source: SemanticCrawlSource = { type: 'url', url: 'https://example.com' };
  const seeds = await spider.generateSeeds(source);
  assert.deepEqual(seeds, ['https://example.com']);
});

test('UrlSpider: generates URLs with additional seeds', async () => {
  const spider = new UrlSpider();
  const source: SemanticCrawlSource = {
    type: 'url',
    url: 'https://example.com',
    urls: ['https://example.com/extra'],
  };
  const seeds = await spider.generateSeeds(source);
  assert.deepEqual(seeds, ['https://example.com', 'https://example.com/extra']);
});

test('UrlSpider: rejects invalid URLs', async () => {
  const spider = new UrlSpider();
  const source: SemanticCrawlSource = { type: 'url', url: 'not-a-url' };
  await assert.rejects(() => spider.generateSeeds(source));
});

test('UrlSpider: filterPages keeps same-path pages', () => {
  const spider = new UrlSpider();
  const pages: CrawlPageResult[] = [
    makePageResult('https://example.com/docs'),
    makePageResult('https://example.com/docs/guide'),
    makePageResult('https://example.com/docs/api/reference'),
    makePageResult('https://other.com/page'),
  ];
  const filtered = spider.filterPages(pages, 'https://example.com/docs');
  assert.equal(filtered.length, 3);
  assert.ok(filtered.every((p) => p.url.startsWith('https://example.com/docs')));
});

test('UrlSpider: filterPages with root URL path', () => {
  const spider = new UrlSpider();
  const pages: CrawlPageResult[] = [
    makePageResult('https://example.com/'),
    makePageResult('https://example.com/about'),
  ];
  const filtered = spider.filterPages(pages, 'https://example.com/');
  assert.equal(filtered.length, 2);
});

test('UrlSpider: throws for wrong source type', async () => {
  const spider = new UrlSpider();
  const source: SemanticCrawlSource = { type: 'sitemap', url: 'https://example.com/sitemap.xml' };
  await assert.rejects(() => spider.generateSeeds(source));
});

// ── SitemapSpider ──────────────────────────────────────────────────────────

test('SitemapSpider: throws for wrong source type', async () => {
  const spider = new SitemapSpider();
  const source: SemanticCrawlSource = { type: 'url', url: 'https://example.com' };
  await assert.rejects(() => spider.generateSeeds(source));
});

test('SitemapSpider: filterPages returns all pages unchanged', () => {
  const spider = new SitemapSpider();
  const pages = [makePageResult('https://any.com/page')];
  const filtered = spider.filterPages(pages, 'https://example.com');
  assert.equal(filtered.length, 1);
});

// ── SearchSpider ───────────────────────────────────────────────────────────

test('SearchSpider: uses injected search function', async () => {
  let callCount = 0;
  const searchFn: import('../../src/crawl/spiders.js').SearchFunction = async (query, limit) => {
    callCount++;
    assert.equal(query, 'test query');
    assert.equal(limit, 10);
    return [
      {
        url: 'https://result1.com',
        title: 'R1',
        description: '',
        position: 0,
        domain: 'result1.com',
        source: 'brave',
        age: null,
        extraSnippet: null,
        deepLinks: null,
      },
      {
        url: 'https://result2.com',
        title: 'R2',
        description: '',
        position: 0,
        domain: 'result2.com',
        source: 'brave',
        age: null,
        extraSnippet: null,
        deepLinks: null,
      },
    ];
  };

  const spider = new SearchSpider(searchFn);
  const source: SemanticCrawlSource = { type: 'search', query: 'test query' };
  const seeds = await spider.generateSeeds(source);
  assert.equal(callCount, 1);
  assert.equal(seeds.length, 2);
  assert.ok(seeds.includes('https://result1.com'));
});

test('SearchSpider: uses custom maxSeedUrls', async () => {
  let capturedLimit = 0;
  const searchFn = async (_query: string, limit: number) => {
    capturedLimit = limit;
    return [];
  };

  const spider = new SearchSpider(searchFn);
  const source: SemanticCrawlSource = { type: 'search', query: 'hi', maxSeedUrls: 5 };
  await spider.generateSeeds(source);
  assert.equal(capturedLimit, 5);
});

test('SearchSpider: throws for wrong source type', async () => {
  const spider = new SearchSpider(async () => []);
  const source: SemanticCrawlSource = { type: 'url', url: 'https://example.com' };
  await assert.rejects(() => spider.generateSeeds(source));
});

test('SearchSpider: filterPages allows all pages (path drift)', () => {
  const spider = new SearchSpider(async () => []);
  const pages = [makePageResult('https://any.com/page')];
  const filtered = spider.filterPages(pages, 'https://example.com');
  assert.equal(filtered.length, 1);
});

// ── GitHubSpider ───────────────────────────────────────────────────────────

test('GitHubSpider: throws for wrong source type', async () => {
  const spider = new GitHubSpider();
  const source: SemanticCrawlSource = { type: 'url', url: 'https://example.com' };
  await assert.rejects(() => spider.generateSeeds(source));
});

// ── CachedSpider ───────────────────────────────────────────────────────────

test('CachedSpider: throws for wrong source type', async () => {
  const spider = new CachedSpider();
  const source: SemanticCrawlSource = { type: 'url', url: 'https://example.com' };
  await assert.rejects(() => spider.generateSeeds(source));
});

// ── Spider Registry ────────────────────────────────────────────────────────

test('registerSpider and getSpider: round-trip', async () => {
  // Use a fresh registry context by registering the spiders fresh
  const spider = new UrlSpider();
  registerSpider(spider);
  const retrieved = getSpider('url');
  assert.equal(retrieved.sourceType, 'url');
});

test('getSpider: throws for unknown type', () => {
  assert.throws(() => getSpider('nonexistent'), /Unknown source type/);
});

test('registerDefaultSpiders: registers built-in spiders', () => {
  registerDefaultSpiders();
  const types = getRegisteredSourceTypes();
  assert.ok(types.includes('url'));
  assert.ok(types.includes('sitemap'));
  assert.ok(types.includes('github'));
  assert.ok(types.includes('cached'));
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makePageResult(url: string): CrawlPageResult {
  return {
    url,
    success: true,
    markdown: 'content',
    title: null,
    description: null,
    links: [],
    statusCode: 200,
    errorMessage: null,
  };
}
