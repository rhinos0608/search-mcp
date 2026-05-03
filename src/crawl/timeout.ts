/**
 * Timeout calculation for crawl operations.
 * Extracted from webCrawlClient.ts to break the layering dependency.
 */

export function computeCrawlTimeout(maxPages: number): number {
  if (!Number.isFinite(maxPages) || !Number.isInteger(maxPages) || maxPages < 0) {
    throw new TypeError(
      `computeCrawlTimeout: maxPages must be a non-negative integer, got ${String(maxPages)}`,
    );
  }
  // 60s base + 20s per maxPage, capped at 5 minutes.
  return Math.min(60_000 + maxPages * 20_000, 300_000);
}
