/**
 * Timeout calculation for crawl operations.
 * Extracted from webCrawlClient.ts to break the layering dependency.
 */

export interface CrawlTimeoutOptions {
  pageTimeoutMs?: number | undefined;
}

export function computeCrawlTimeout(maxPages: number, opts: CrawlTimeoutOptions = {}): number {
  if (!Number.isFinite(maxPages) || !Number.isInteger(maxPages) || maxPages < 0) {
    throw new TypeError(
      `computeCrawlTimeout: maxPages must be a non-negative integer, got ${String(maxPages)}`,
    );
  }

  const pageTimeoutMs =
    opts.pageTimeoutMs !== undefined &&
    Number.isFinite(opts.pageTimeoutMs) &&
    opts.pageTimeoutMs > 0
      ? opts.pageTimeoutMs
      : 0;
  const pageTimeoutBudget = pageTimeoutMs > 0 ? pageTimeoutMs + 15_000 : 0;

  // 30s base + 15s per maxPage, capped at 5 minutes.
  return Math.min(Math.max(30_000 + maxPages * 15_000, pageTimeoutBudget), 300_000);
}
