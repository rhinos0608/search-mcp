import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { unavailableError, networkError, parseError } from '../errors.js';
import type { WebCrawlResult, CrawlPageResult } from '../types.js';

export interface WebCrawlOptions {
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  includeExternalLinks: boolean;
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
    statusCode: page.metadata?.status_code ?? null,
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
  assertSafeUrl(endpoint);

  const crawlerConfig: Record<string, unknown> = {
    headless: true,
    remove_overlay_elements: true,
  };
  if (opts.maxDepth > 1) {
    crawlerConfig.deep_crawl_config = {
      strategy: opts.strategy,
      max_depth: opts.maxDepth,
      max_pages: opts.maxPages,
      filter_external_links: !opts.includeExternalLinks,
    };
  }

  const body = {
    urls: [url],
    crawler_config: crawlerConfig,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'search-mcp/1.0',
  };
  if (apiToken) {
    headers['Authorization'] = `Bearer ${apiToken}`;
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
      throw networkError(
        `crawl4ai returned HTTP ${String(response.status)} for "${url}"`,
        { statusCode: response.status },
      );
    }

    // safeResponseJson enforces a 10MB cap as a guard against runaway responses.
    // The maxPages limit (1-100) keeps deep-crawl responses well below this in practice.
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

  logger.debug(
    { url, totalPages: pages.length, strategy: opts.strategy },
    'web_crawl complete',
  );

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
