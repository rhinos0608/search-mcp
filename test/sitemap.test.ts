import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSitemap, isSitemapIndex } from '../src/utils/sitemap.js';

describe('parseSitemap', () => {
  it('parses a basic urlset XML', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;
    const urls = parseSitemap(xml);
    assert.deepEqual(urls, ['https://example.com/page1', 'https://example.com/page2']);
  });

  it('ignores non-loc elements', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
    <lastmod>2024-01-01</lastmod>
    <changefreq>daily</changefreq>
  </url>
</urlset>`;
    const urls = parseSitemap(xml);
    assert.deepEqual(urls, ['https://example.com/page1']);
  });

  it('returns empty array for invalid XML', async () => {
    const urls = parseSitemap('not xml');
    assert.deepEqual(urls, []);
  });

  it('returns empty array for empty input', async () => {
    const urls = parseSitemap('');
    assert.deepEqual(urls, []);
  });

  it('deduplicates URLs', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page1</loc></url>
</urlset>`;
    const urls = parseSitemap(xml);
    assert.deepEqual(urls, ['https://example.com/page1']);
  });

  it('detects sitemap index files', () => {
    const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap1.xml</loc></sitemap>
</sitemapindex>`;
    assert.strictEqual(isSitemapIndex(indexXml), true);

    const urlsetXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
</urlset>`;
    assert.strictEqual(isSitemapIndex(urlsetXml), false);
  });

  it('parses sitemap index loc entries', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap2.xml</loc></sitemap>
</sitemapindex>`;
    const urls = parseSitemap(xml);
    assert.deepEqual(urls, [
      'https://example.com/sitemap1.xml',
      'https://example.com/sitemap2.xml',
    ]);
  });

  it('decodes XML entities in loc', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page?foo=1&amp;bar=2</loc></url>
</urlset>`;
    const urls = parseSitemap(xml);
    assert.deepEqual(urls, ['https://example.com/page?foo=1&bar=2']);
  });
});
