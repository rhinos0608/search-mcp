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
import type { WebCrawlResult } from '../types.js';
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

  return response.result;
}
