/**
 * Spider implementations for the CorpusSpider abstraction.
 *
 * Each spider handles a specific source type (url, sitemap, search, github, cached)
 * by generating seed URLs and providing optional page filtering logic.
 *
 * Inspired by Scrapy's CrawlSpider, SitemapSpider, and XMLFeedSpider patterns.
 */

import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseText } from '../httpGuards.js';
import { parseSitemap, isSitemapIndex } from '../utils/sitemap.js';
import { getUserAgent } from '../version.js';
import type { SearchResult } from '../types.js';
import type { CrawlPageResult, SemanticCrawlSource } from '../types.js';
import type { CorpusSpider } from './types.js';

// ── URL Spider ────────────────────────────────────────────────────────────

export class UrlSpider implements CorpusSpider {
  readonly sourceType = 'url';

  async generateSeeds(source: SemanticCrawlSource): Promise<string[]> {
    if (source.type !== 'url') {
      throw new Error(`UrlSpider received unexpected source type: ${source.type}`);
    }
    const urls = [source.url, ...(source.urls ?? [])];
    // Validate all URLs
    for (const u of urls) {
      assertSafeUrl(u);
    }
    return urls;
  }

  filterPages(pages: CrawlPageResult[], seedUrl: string): CrawlPageResult[] {
    return filterByPathPrefix(pages, seedUrl);
  }
}

// ── Sitemap Spider ────────────────────────────────────────────────────────

export class SitemapSpider implements CorpusSpider {
  readonly sourceType = 'sitemap';

  async generateSeeds(source: SemanticCrawlSource): Promise<string[]> {
    if (source.type !== 'sitemap') {
      throw new Error(`SitemapSpider received unexpected source type: ${source.type}`);
    }

    const seedUrl = source.url;
    assertSafeUrl(seedUrl);

    const response = await fetch(seedUrl, {
      headers: { 'User-Agent': getUserAgent() },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Sitemap fetch failed: HTTP ${String(response.status)} for ${seedUrl}`);
    }

    const xml = await safeResponseText(response, seedUrl);
    let sitemapUrls = parseSitemap(xml);

    // If it's a sitemap index, fetch sub-sitemaps for page URLs
    if (isSitemapIndex(xml) && sitemapUrls.length > 0) {
      logger.info(
        { sitemapUrl: seedUrl, subSitemaps: sitemapUrls.length },
        'Sitemap is an index; fetching sub-sitemaps',
      );
      const pageUrls: string[] = [];
      for (const subUrl of sitemapUrls.slice(0, 10)) {
        try {
          assertSafeUrl(subUrl);
          const subResponse = await fetch(subUrl, {
            headers: { 'User-Agent': getUserAgent() },
            signal: AbortSignal.timeout(30_000),
          });
          if (subResponse.ok) {
            const subXml = await safeResponseText(subResponse, subUrl);
            const subUrls = parseSitemap(subXml);
            pageUrls.push(...subUrls);
          }
        } catch (err) {
          logger.warn({ err, subUrl }, 'Failed to fetch sub-sitemap');
        }
      }
      sitemapUrls = pageUrls;
      logger.info({ totalUrls: sitemapUrls.length }, 'Fetched sub-sitemaps');
    }

    return sitemapUrls;
  }

  filterPages(pages: CrawlPageResult[], _seedUrl: string): CrawlPageResult[] {
    // Sitemap pages are authoritative — no path filtering needed
    return pages;
  }
}

// ── Search Spider ─────────────────────────────────────────────────────────

export type SearchFunction = (
  query: string,
  limit: number,
  safeSearch: 'strict' | 'moderate' | 'off',
) => Promise<SearchResult[]>;

export class SearchSpider implements CorpusSpider {
  readonly sourceType = 'search';

  constructor(private readonly searchFn: SearchFunction) {}

  async generateSeeds(source: SemanticCrawlSource): Promise<string[]> {
    if (source.type !== 'search') {
      throw new Error(`SearchSpider received unexpected source type: ${source.type}`);
    }

    const searchResults = await this.searchFn(source.query, source.maxSeedUrls ?? 10, 'moderate');

    const urls = searchResults.map((r) => r.url).filter((url) => url.length > 0);

    logger.info({ query: source.query, urlsFound: urls.length }, 'Search spider discovered URLs');

    return urls;
  }

  filterPages(pages: CrawlPageResult[], _seedUrl: string): CrawlPageResult[] {
    // Search-derived URLs are target pages — allow path drift
    return pages;
  }
}

// ── GitHub Spider ─────────────────────────────────────────────────────────

export class GitHubSpider implements CorpusSpider {
  readonly sourceType = 'github';

  async generateSeeds(source: SemanticCrawlSource): Promise<string[]> {
    if (source.type !== 'github') {
      throw new Error(`GitHubSpider received unexpected source type: ${source.type}`);
    }

    const { fetchGitHubCorpus } = await import('../utils/githubCorpus.js');
    const ghOpts: import('../utils/githubCorpus.js').GitHubCorpusOptions = {
      owner: source.owner,
      repo: source.repo,
      maxFiles: 100, // Will be capped by the pipeline's maxPages
    };
    if (source.branch !== undefined) ghOpts.branch = source.branch;
    if (source.extensions !== undefined) ghOpts.extensions = source.extensions;
    if (source.query !== undefined) ghOpts.query = source.query;

    const docs = await fetchGitHubCorpus(ghOpts);
    // Return document URLs as seeds — these aren't actually crawled,
    // but the pipeline will handle them via the GitHub case
    return docs.map((d) => d.url);
  }
}

// ── Cached Spider ─────────────────────────────────────────────────────────

export class CachedSpider implements CorpusSpider {
  readonly sourceType = 'cached';

  async generateSeeds(source: SemanticCrawlSource): Promise<string[]> {
    if (source.type !== 'cached') {
      throw new Error(`CachedSpider received unexpected source type: ${source.type}`);
    }

    const { loadCorpusById } = await import('../utils/corpusCache.js');
    const cached = loadCorpusById(source.corpusId, {
      ttlMs: 24 * 60 * 60 * 1000,
    });

    if (!cached) {
      throw new Error(
        `Corpus '${source.corpusId}' not found or expired. Re-issue with the original source to rebuild.`,
      );
    }

    // Return chunk URLs as seeds (metadata only — no actual crawling)
    return cached.chunks.map((c) => c.url).filter(Boolean);
  }
}

// ── Spider Registry ────────────────────────────────────────────────────────

const SPIDER_MAP = new Map<string, CorpusSpider>();

/** Register a spider for a source type. */
export function registerSpider(spider: CorpusSpider): void {
  SPIDER_MAP.set(spider.sourceType, spider);
}

/** Get a spider by source type. Throws if not found. */
export function getSpider(sourceType: string): CorpusSpider {
  const spider = SPIDER_MAP.get(sourceType);
  if (!spider) {
    throw new Error(`Unknown source type '${sourceType}'. No spider registered.`);
  }
  return spider;
}

/** Register all built-in spiders. */
/**
 * Register spiders that don't require external dependencies.
 * SearchSpider requires a search function injected at the app level.
 * GitHubSpider and CachedSpider use lazy dynamic imports internally.
 */
export function registerDefaultSpiders(): void {
  registerSpider(new UrlSpider());
  registerSpider(new SitemapSpider());
  registerSpider(new GitHubSpider());
  registerSpider(new CachedSpider());
}

/** Get a list of all registered spider source types. */
export function getRegisteredSourceTypes(): string[] {
  return Array.from(SPIDER_MAP.keys());
}

// ── Utility: Path Prefix Filter ───────────────────────────────────────────

/**
 * Filter pages to those within the seed URL's path prefix.
 * Used by UrlSpider to prevent path drift.
 */
function filterByPathPrefix(
  pages: CrawlPageResult[],
  seedUrl: string,
  allowPathDrift = false,
): CrawlPageResult[] {
  if (allowPathDrift) return pages;

  let seedPath: string;
  try {
    seedPath = new URL(seedUrl).pathname;
  } catch {
    logger.warn({ url: seedUrl }, 'filterByPathPrefix: invalid seed URL');
    return pages;
  }

  const prefix = seedPath.endsWith('/') ? seedPath : `${seedPath}/`;
  const kept: CrawlPageResult[] = [];
  let dropped = 0;

  for (const page of pages) {
    let pagePath: string;
    try {
      pagePath = new URL(page.url).pathname;
    } catch {
      logger.warn({ url: page.url }, 'filterByPathPrefix: malformed page URL');
      continue;
    }
    if (pagePath === seedPath || pagePath.startsWith(prefix)) {
      kept.push(page);
    } else {
      dropped++;
    }
  }

  if (dropped > 0) {
    logger.info({ dropped, seedPath }, 'filterByPathPrefix: dropped pages outside seed path');
  }

  return kept;
}
