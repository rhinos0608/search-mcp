/**
 * Firecrawl scrape fallback for web_crawl — supervisor-approved policy:
 *
 * - Double-gated: `firecrawl.scrapeFallback.enabled` (default false) AND
 *   `FIRECRAWL_API_KEY` must both be present; Crawl4AI stays the required
 *   primary and registration gate (web_crawl is unusable without it).
 * - Trigger: ONLY when the primary Crawl4AI client execution THROWS after the
 *   request-phase guards (SSRF, Sentry, domain trust) already passed. Never on
 *   low-quality/empty responses (external-recovery middleware owns that path),
 *   never on request-phase policy errors (they throw before the client runs),
 *   and never on recognizable caller cancellation (AbortError).
 * - Semantics guard: fallback is skipped when the caller requested behavior
 *   Firecrawl cannot honor — waitFor, delayBeforeReturnHtml (explicitly
 *   non-default), jsCode, jsCodeBeforeWait, extractionConfig, llmFallback, or
 *   includeExternalLinks — in which case the original error is rethrown.
 *   maxBytes IS honored: the fallback serves the seed URL then truncates the
 *   scraped markdown to the caller's byte budget with a UTF-8-safe decoder.
 * - Placement: wraps only the primary client execution (crawlFn), so the
 *   fallback result still flows through the response-phase middlewares
 *   (quality assessment, challenge filtering, stats).
 * - Counts are honest: totalPages=1/successfulPages=1 only for a validated
 *   non-empty scrape; requested maxDepth/maxPages are preserved in the result.
 *   A multi-page request degrades to the seed URL only and emits a stable
 *   degraded warning.
 */

import { StringDecoder } from 'node:string_decoder';
import { logger } from '../logger.js';
import { firecrawlScrape } from './firecrawlScrape.js';
import { safeDomain } from './providerFields.js';
import type { CrawlResponse } from '../crawl/types.js';
import type { CrawlRequest } from '../crawl/types.js';

/**
 * Loggable crawl-target identifier: hostname only. Target URLs can carry query
 * params or userinfo containing secrets — the full URL is never logged by the
 * fallback. (Pre-existing full-URL logging elsewhere in the crawl path is out
 * of scope for this change.)
 */
export function fallbackLogTarget(url: string): string {
  return safeDomain(url) || '<unparseable-target>';
}

/** Stable warning prefix so consumers can detect fallback usage deterministically. */
export const FIRECRAWL_FALLBACK_WARNING_PREFIX = 'firecrawl-scrape-fallback:';

export interface FirecrawlFallbackConfig {
  apiKey: string;
}

function isCallerCancellation(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function canHonorSemantics(req: CrawlRequest): boolean {
  const opts = req.opts;
  return (
    opts.waitFor === undefined &&
    (opts.delayBeforeReturnHtml === undefined || opts.delayBeforeReturnHtml <= 0.1) &&
    opts.jsCode === undefined &&
    opts.jsCodeBeforeWait === undefined &&
    opts.extractionConfig === undefined &&
    opts.llmFallback === undefined &&
    !opts.includeExternalLinks
  );
}

/**
 * Wrap the primary Crawl4AI client execution with the Firecrawl scrape
 * fallback. Returns a crawlFn suitable for CrawlMiddlewareChain.execute.
 * `fallback` is undefined when the gate is closed — primary behavior is
 * untouched in that case.
 */
export function withFirecrawlScrapeFallback(
  primary: (req: CrawlRequest) => Promise<CrawlResponse>,
  fallback: FirecrawlFallbackConfig | undefined,
): (req: CrawlRequest) => Promise<CrawlResponse> {
  if (fallback === undefined) return primary;

  return async (req: CrawlRequest): Promise<CrawlResponse> => {
    try {
      return await primary(req);
    } catch (primaryErr) {
      // Recognizable caller cancellation is never intercepted.
      if (isCallerCancellation(primaryErr)) throw primaryErr;
      // Firecrawl scrape is a single-URL markdown fetch — it cannot honor
      // waitFor / JS / custom extraction / LLM fallback / external-link
      // traversal. Skip fallback when any of those were requested.
      if (!canHonorSemantics(req)) throw primaryErr;

      logger.warn(
        {
          target: fallbackLogTarget(req.url),
          maxPages: req.opts.maxPages,
          maxDepth: req.opts.maxDepth,
        },
        'web_crawl: primary Crawl4AI execution failed; attempting Firecrawl scrape fallback',
      );

      let page;
      try {
        page = await firecrawlScrape(req.url, fallback.apiKey);
      } catch (fallbackErr) {
        logger.warn(
          {
            target: fallbackLogTarget(req.url),
            err: fallbackErr instanceof Error ? fallbackErr.name : String(fallbackErr),
          },
          'web_crawl: Firecrawl scrape fallback failed',
        );
        // The primary failure is the actionable truth — rethrow it.
        throw primaryErr;
      }

      // Only a validated non-empty scrape may be served.
      if (!page.success || page.markdown.trim().length === 0) {
        logger.warn(
          { target: fallbackLogTarget(req.url) },
          'web_crawl: Firecrawl scrape fallback returned no content',
        );
        throw primaryErr;
      }

      const warnings: string[] = [
        `${FIRECRAWL_FALLBACK_WARNING_PREFIX} primary Crawl4AI execution failed; served the seed URL via the Firecrawl scrape fallback (recoverySource=firecrawl).`,
      ];
      if (req.opts.maxPages > 1 || req.opts.maxDepth > 1) {
        warnings.push(
          `${FIRECRAWL_FALLBACK_WARNING_PREFIX}degraded: multi-page crawl requested (maxDepth=${String(req.opts.maxDepth)}, maxPages=${String(req.opts.maxPages)}); only the seed URL was fetched — no link traversal was performed.`,
        );
      }

      let markdown = page.markdown;
      if (typeof req.opts.maxBytes === 'number' && req.opts.maxBytes > 0) {
        const buf = Buffer.from(markdown, 'utf-8');
        if (buf.byteLength > req.opts.maxBytes) {
          const decoder = new StringDecoder('utf-8');
          markdown = decoder.write(buf.subarray(0, req.opts.maxBytes)) + decoder.end();
        }
      }

      return {
        result: {
          seedUrl: req.url,
          strategy: req.opts.strategy,
          maxDepth: req.opts.maxDepth,
          maxPages: req.opts.maxPages,
          pages: [{ ...page, markdown, recoverySource: 'firecrawl' }],
          totalPages: 1,
          successfulPages: 1,
          warnings,
        },
        recovered: true,
        recoverySource: 'firecrawl',
      };
    }
  };
}
