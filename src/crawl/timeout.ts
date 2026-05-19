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
  // 30s base + 15s per maxPage, capped at 5 minutes.
  return Math.min(30_000 + maxPages * 15_000, 300_000);
}
