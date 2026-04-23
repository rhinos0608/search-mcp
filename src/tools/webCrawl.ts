import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, networkError, parseError } from '../errors.js';
import type { WebCrawlResult, CrawlPageResult } from '../types.js';
import { dedupPages, dedupPagesByContent } from '../utils/url.js';

export interface WebCrawlOptions {
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  includeExternalLinks: boolean;
  /** Maximum total bytes of markdown to collect (client-side soft limit). */
  maxBytes?: number;
  /** CSS selector (css:.selector) or JS expression (js:() => boolean) to wait for before extracting. */
  waitFor?: string | undefined;
  /** Extra seconds to wait after page load for dynamic content to settle. */
  delayBeforeReturnHtml?: number | undefined;
  /** Page operation timeout in milliseconds. */
  pageTimeout?: number | undefined;
  /** Custom JavaScript to execute on the page (e.g. scroll, click buttons). */
  jsCode?: string | undefined;
}

// crawl4ai API response shape (stable across v0.7.x and v0.8.x)
interface Crawl4aiPage {
  url?: string;
  success?: boolean;
  markdown?: string | { raw_markdown?: string; fit_markdown?: string } | null;
  metadata?: {
    title?: string;
    description?: string;
    status_code?: number;
  } | null;
  links?: {
    internal?: { href?: string; text?: string }[];
    external?: { href?: string; text?: string }[];
  } | null;
  error_message?: string | null;
  status_code?: number;
}

interface Crawl4aiResponse {
  results?: Crawl4aiPage[];
  result?: Crawl4aiPage;
  success?: boolean;
  error?: string;
}

function extractMarkdown(raw: Crawl4aiPage['markdown']): string {
  if (typeof raw === 'string') return raw;
  if (raw !== null && raw !== undefined && typeof raw === 'object') {
    // v0.8.x: prefer fit_markdown (content-extracted, nav stripped),
    // fall back to raw_markdown for completeness when extraction fails.
    return raw.fit_markdown ?? raw.raw_markdown ?? '';
  }
  return '';
}

function normalizePage(page: Crawl4aiPage): CrawlPageResult {
  const internalLinks = (page.links?.internal ?? []).map((l) => ({
    href: l.href ?? '',
    text: l.text ?? '',
  }));
  const externalLinks = (page.links?.external ?? []).map((l) => ({
    href: l.href ?? '',
    text: l.text ?? '',
  }));

  return {
    url: page.url ?? '',
    success: page.success ?? false,
    markdown: extractMarkdown(page.markdown),
    title: page.metadata?.title ?? null,
    description: page.metadata?.description ?? null,
    links: [...internalLinks, ...externalLinks],
    statusCode: page.status_code ?? null,
    errorMessage: page.error_message ?? null,
  };
}

export async function webCrawl(
  url: string,
  baseUrl: string,
  apiToken: string,
  opts: WebCrawlOptions,
): Promise<WebCrawlResult> {
  assertSafeUrl(url);

  if (!baseUrl) {
    throw unavailableError(
      'crawl4ai sidecar is not configured. Set CRAWL4AI_BASE_URL to enable web_crawl.',
    );
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/crawl`;
  // Sidecar URLs come from operator configuration (CRAWL4AI_BASE_URL);
  // they are inherently trusted and should not be subject to SSRF guards.

  const crawlerConfigParams: Record<string, unknown> = {
    deep_crawl_strategy: {
      type: opts.strategy === 'bfs' ? 'BFSDeepCrawlStrategy' : 'DFSDeepCrawlStrategy',
      params: {
        max_depth: opts.maxDepth,
        max_pages: opts.maxPages,
        include_external: opts.includeExternalLinks,
      },
    },
  };

  if (opts.waitFor !== undefined && opts.waitFor.length > 0) {
    crawlerConfigParams.wait_for = opts.waitFor;
  }
  if (opts.delayBeforeReturnHtml !== undefined) {
    crawlerConfigParams.delay_before_return_html = opts.delayBeforeReturnHtml;
  }
  if (opts.pageTimeout !== undefined) {
    crawlerConfigParams.page_timeout = opts.pageTimeout;
  }
  if (opts.jsCode !== undefined && opts.jsCode.length > 0) {
    crawlerConfigParams.js_code = opts.jsCode;
  }

  const body = {
    urls: [url],
    browser_config: { type: 'BrowserConfig', params: { headless: true } },
    crawler_config: { type: 'CrawlerRunConfig', params: crawlerConfigParams },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'search-mcp/1.0',
  };
  if (apiToken) {
    headers.Authorization = `Bearer ${apiToken}`;
  }

  let raw: unknown;
  try {
    const response = await retryWithBackoff(
      () =>
        fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        }),
      { label: 'crawl4ai', maxAttempts: 2, initialDelayMs: 500 },
    );

    if (!response.ok) {
      if (response.status === 503 || response.status === 502) {
        throw unavailableError(
          `crawl4ai sidecar returned HTTP ${String(response.status)} — is the Docker container running?`,
          { statusCode: response.status },
        );
      }
      throw networkError(`crawl4ai returned HTTP ${String(response.status)} for "${url}"`, {
        statusCode: response.status,
      });
    }

    raw = await safeResponseJson(response, endpoint);

    if (raw === null || typeof raw !== 'object') {
      throw parseError(
        `crawl4ai returned an unexpected response type (expected object, got ${typeof raw}). Check that the sidecar is running the correct version.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw networkError(`crawl4ai request timed out after 120 seconds for "${url}"`);
    }
    throw err;
  }

  const data = raw as Crawl4aiResponse;

  // crawl4ai may return either { results: [...] } (deep crawl) or { result: {...} } (single page)
  let pages: CrawlPageResult[];
  if (Array.isArray(data.results) && data.results.length > 0) {
    pages = data.results.map(normalizePage);
  } else if (data.result !== undefined) {
    pages = [normalizePage(data.result)];
  } else {
    const serverErr = typeof data.error === 'string' ? ` (server error: ${data.error})` : '';
    throw parseError(
      `crawl4ai returned an unexpected response shape${serverErr}. Check that the sidecar version is v0.7.x or v0.8.x.`,
    );
  }

  // Defense-in-depth: validate each page URL against SSRF guards.
  // crawl4ai should enforce this itself, but we filter as a second layer.
  const beforeSsrf = pages.length;
  pages = pages.filter((page) => {
    try {
      assertSafeUrl(page.url);
      return true;
    } catch {
      logger.warn({ url: page.url }, 'web_crawl: skipping page with unsafe URL');
      return false;
    }
  });
  if (pages.length < beforeSsrf) {
    logger.warn(
      { url, before: beforeSsrf, after: pages.length, removed: beforeSsrf - pages.length },
      'web_crawl filtered pages with unsafe URLs',
    );
  }

  const before = pages.length;
  pages = dedupPages(pages);
  if (pages.length < before) {
    logger.debug(
      { url, before, after: pages.length, removed: before - pages.length },
      'web_crawl deduplicated pages by URL',
    );
  }

  const beforeContent = pages.length;
  pages = dedupPagesByContent(pages);
  if (pages.length < beforeContent) {
    logger.debug(
      { url, before: beforeContent, after: pages.length, removed: beforeContent - pages.length },
      'web_crawl deduplicated pages by content hash',
    );
  }

  // Client-side maxBytes enforcement: crawl4ai does not support corpus-total limits.
  const maxBytes = opts.maxBytes;
  if (maxBytes !== undefined && maxBytes > 0) {
    let totalBytes = 0;
    const filtered: CrawlPageResult[] = [];
    for (const page of pages) {
      const pageBytes = page.markdown.length;
      if (totalBytes + pageBytes > maxBytes && filtered.length > 0) {
        logger.info(
          { url, maxBytes, totalBytes, pagesKept: filtered.length },
          'web_crawl: maxBytes limit reached, stopping collection',
        );
        break;
      }
      totalBytes += pageBytes;
      filtered.push(page);
    }
    pages = filtered;
  }

  logger.debug({ url, totalPages: pages.length, strategy: opts.strategy }, 'web_crawl complete');

  return {
    seedUrl: url,
    strategy: opts.strategy,
    maxDepth: opts.maxDepth,
    maxPages: opts.maxPages,
    pages,
    totalPages: pages.length,
    successfulPages: pages.filter((p) => p.success).length,
  };
}
