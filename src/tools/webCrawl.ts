import { logger } from '../logger.js';
import { assertSafeUrl } from '../httpGuards.js';
import { CrawlMiddlewareChain } from '../crawl/middleware.js';
import {
  SentryGuardMiddleware,
  DomainTrustMiddleware,
  Crawl4aiClientMiddleware,
  ResponseQualityMiddleware,
  AggressiveRenderMiddleware,
  ExternalRecoveryMiddleware,
  StatsRecorderMiddleware,
} from '../crawl/middlewares.js';
import { unavailableError } from '../errors.js';
import { cleanMarkdownContent } from '../utils/contentCleanup.js';
import { detectContentChallenge } from '../utils/contentChallengeDetector.js';
import type { WebCrawlResult, CrawlPageResult } from '../types.js';
import type { DomainTrustConfig } from '../config.js';
import type { ExtractionConfig } from '../utils/extractionConfig.js';
import type { CrawlOptions } from '../crawl/types.js';

export interface WebCrawlOptions {
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  includeExternalLinks: boolean;
  maxBytes?: number;
  waitFor?: string | undefined;
  delayBeforeReturnHtml?: number | undefined;
  pageTimeout?: number | undefined;
  jsCode?: string | undefined;
  jsCodeBeforeWait?: string | undefined;
  extractionConfig?: ExtractionConfig;
  llmFallback?: { provider: string; apiToken: string; baseUrl?: string };
  domainTrust?: DomainTrustConfig | undefined;
}

/**
 * Clean noise from a single crawl page's markdown.
 */
function cleanPageMarkdown(page: CrawlPageResult): CrawlPageResult {
  return {
    ...page,
    markdown: cleanMarkdownContent(page.markdown),
  };
}

// Re-export for backward compatibility
export { computeCrawlTimeout } from './webCrawlClient.js';

function buildCrawlOptions(opts: WebCrawlOptions): CrawlOptions {
  return {
    strategy: opts.strategy,
    maxDepth: opts.maxDepth,
    maxPages: opts.maxPages,
    includeExternalLinks: opts.includeExternalLinks,
    maxBytes: opts.maxBytes,
    waitFor: opts.waitFor,
    delayBeforeReturnHtml: opts.delayBeforeReturnHtml,
    pageTimeout: opts.pageTimeout,
    jsCode: opts.jsCode,
    jsCodeBeforeWait: opts.jsCodeBeforeWait,
    extractionConfig: opts.extractionConfig,
    llmFallback: opts.llmFallback,
    domainTrust: opts.domainTrust,
  };
}

function buildDomainTrustOptions(
  config?: DomainTrustConfig,
): import('../utils/domainTrust.js').DomainTrustOptions | undefined {
  if (!config?.enabled) return undefined;
  return {
    trustedDomains: config.trustedDomains,
    blockedDomains: config.blockedDomains,
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

  const clientMw = new Crawl4aiClientMiddleware(baseUrl, apiToken);

  const chain = new CrawlMiddlewareChain([
    new SentryGuardMiddleware(),
    new DomainTrustMiddleware(buildDomainTrustOptions(opts.domainTrust)),
    clientMw,
    new ResponseQualityMiddleware(),
    new AggressiveRenderMiddleware(),
    new ExternalRecoveryMiddleware(),
    new StatsRecorderMiddleware(),
  ]);

  logger.info(
    {
      url,
      strategy: opts.strategy,
      maxDepth: opts.maxDepth,
      maxPages: opts.maxPages,
      middleware: chain.names,
    },
    'web_crawl: executing middleware chain',
  );

  const response = await chain.execute(url, baseUrl, apiToken, buildCrawlOptions(opts), (req) =>
    clientMw.crawl(req),
  );

  // Clean up noise in markdown output: literal \n sequences,
  // navigation boilerplate, excessive whitespace
  const cleanedPages: CrawlPageResult[] = response.result.pages.map(cleanPageMarkdown);

  // Filter out pages that are challenge/blocker pages (Cloudflare, CAPTCHA, etc.)
  let filteredChallenges = 0;
  const filteredPages: CrawlPageResult[] = [];
  for (const page of cleanedPages) {
    const challenge = detectContentChallenge(page.title ?? '', page.markdown);
    if (challenge.isChallenge) {
      filteredChallenges++;
      logger.warn(
        { url: page.url, challengeReason: challenge.reason },
        'web_crawl: filtered challenge page',
      );
    } else {
      filteredPages.push(page);
    }
  }

  return {
    ...response.result,
    pages: filteredPages,
    filteredChallenges,
  };
}
