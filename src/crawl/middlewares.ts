/**
 * Built-in middleware implementations for the crawl middleware chain.
 *
 * Each middleware wraps an existing utility or inline behavior from the
 * current crawl pipeline into a composable CrawlMiddleware.
 */

import { logger } from '../logger.js';
import { assertSafeUrl } from '../httpGuards.js';
import { retryWithBackoff } from '../retry.js';
import { getUserAgent } from '../version.js';
import { assessMarkdownBatchQuality, compareQuality } from '../utils/renderRecovery.js';
import { safeStructuredFromMarkdown } from '../utils/elementHelpers.js';
import { attemptExternalRecovery } from '../utils/externalRecovery.js';
import { recordOutcome } from '../utils/extractionStats.js';
import { statsCollector } from './stats.js';
import { networkError, parseError, unavailableError } from '../errors.js';
import { safeResponseJson } from '../httpGuards.js';
import { dedupPages, dedupPagesByContent } from '../utils/url.js';
import { mapToCrawl4ai } from '../utils/extractionConfig.js';
import { computeCrawlTimeout } from './timeout.js';
import type { CrawlMiddleware, CrawlRequest, CrawlResponse, CrawlContext } from './types.js';
import type { CrawlPageResult } from '../types.js';
import type { ExtractionConfig } from '../utils/extractionConfig.js';

// ── Crawl4AI client types (internal) ──────────────────────────────────────

interface Crawl4aiRawPage {
  url?: string;
  success?: boolean;
  markdown?: string | { raw_markdown?: string; fit_markdown?: string } | null;
  html?: string | null;
  cleaned_html?: string | null;
  fit_html?: string | null;
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
  extracted_content?: unknown;
}

interface Crawl4aiRawResponse {
  results?: Crawl4aiRawPage[];
  result?: Crawl4aiRawPage;
  success?: boolean;
  error?: string;
}

// ── Utility: extract markdown from Crawl4AI response ──────────────────────

function extractMarkdown(raw: Crawl4aiRawPage['markdown']): string {
  if (typeof raw === 'string') return raw;
  if (raw !== null && raw !== undefined && typeof raw === 'object') {
    const fit = raw.fit_markdown?.trim();
    if (fit) return fit;
    const rawMarkdown = raw.raw_markdown?.trim();
    if (rawMarkdown) return rawMarkdown;
    return '';
  }
  return '';
}

function normalizePage(page: Crawl4aiRawPage): CrawlPageResult {
  const internalLinks = (page.links?.internal ?? []).map((l) => ({
    href: l.href ?? '',
    text: l.text ?? '',
  }));
  const externalLinks = (page.links?.external ?? []).map((l) => ({
    href: l.href ?? '',
    text: l.text ?? '',
  }));

  const extractedData = parseExtractedData(page.extracted_content);
  const markdown = extractMarkdown(page.markdown);
  const success = page.success ?? markdown.trim().length > 0;
  const structured = safeStructuredFromMarkdown(markdown);

  const html = [page.fit_html, page.cleaned_html, page.html]
    .map((s) => s?.trim())
    .find((s): s is string => s !== undefined && s.length > 0);

  return {
    url: page.url ?? '',
    success,
    markdown,
    ...structured,
    ...(html !== undefined ? { html } : {}),
    title: page.metadata?.title ?? null,
    description: page.metadata?.description ?? null,
    links: [...internalLinks, ...externalLinks],
    statusCode: page.status_code ?? null,
    errorMessage: page.error_message ?? null,
    ...(extractedData !== undefined && { extractedData }),
  };
}

function parseExtractedData(raw: unknown): Record<string, unknown>[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (typeof raw === 'object') return [raw as Record<string, unknown>];
  return undefined;
}

function normalizeCrawlResponse(
  data: Crawl4aiRawResponse,
  extractionConfig?: ExtractionConfig,
): CrawlPageResult[] {
  // Detect unsupported sidecar when extractionConfig was provided but no extracted_content present
  if (extractionConfig) {
    const allPages = Array.isArray(data.results)
      ? data.results
      : data.result !== undefined
        ? [data.result]
        : [];
    const anySuccessful = allPages.some((p) => p.success !== false);
    const anySuccessfulWithExtraction = allPages.some(
      (p) => p.success !== false && 'extracted_content' in p,
    );
    if (anySuccessful && !anySuccessfulWithExtraction) {
      throw parseError(
        'Crawl4AI sidecar does not support extraction. Upgrade Crawl4AI sidecar to v0.8.x or later for extraction support.',
      );
    }
  }

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

  // Defense-in-depth: validate each page URL against SSRF guards
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
      {
        url: data.result?.url ?? data.results?.[0]?.url ?? '',
        before: beforeSsrf,
        after: pages.length,
      },
      'web_crawl filtered pages with unsafe URLs',
    );
  }

  const before = pages.length;
  pages = dedupPages(pages);
  if (pages.length < before) {
    logger.debug(
      { url: data.result?.url ?? data.results?.[0]?.url ?? '', before, after: pages.length },
      'web_crawl deduplicated pages by URL',
    );
  }

  const beforeContent = pages.length;
  pages = dedupPagesByContent(pages);
  if (pages.length < beforeContent) {
    logger.debug(
      {
        url: data.result?.url ?? data.results?.[0]?.url ?? '',
        before: beforeContent,
        after: pages.length,
      },
      'web_crawl deduplicated pages by content hash',
    );
  }

  // Client-side maxBytes enforcement
  return pages;
}

// ── 1. SentryGuardMiddleware ───────────────────────────────────────────────

export class SentryGuardMiddleware implements CrawlMiddleware {
  readonly name = 'sentry-guard';
  readonly priority = 100;

  async processRequest(req: CrawlRequest): Promise<CrawlRequest | null> {
    assertSafeUrl(req.url);
    return req;
  }

  async processResponse(resp: CrawlResponse): Promise<CrawlResponse | null> {
    // Defensive: validate each page URL in the response
    const cleanPages = resp.result.pages.filter((page) => {
      try {
        assertSafeUrl(page.url);
        return true;
      } catch {
        logger.warn({ url: page.url }, 'sentry-guard: removing unsafe page URL from response');
        return false;
      }
    });
    if (cleanPages.length < resp.result.pages.length) {
      return {
        ...resp,
        result: {
          ...resp.result,
          pages: cleanPages,
          totalPages: cleanPages.length,
          successfulPages: cleanPages.filter((p) => p.success).length,
        },
      };
    }
    return resp;
  }
}

// ── 2. DomainTrustMiddleware ───────────────────────────────────────────────

export class DomainTrustMiddleware implements CrawlMiddleware {
  readonly name = 'domain-trust';
  readonly priority = 200;

  constructor(private readonly config?: import('../utils/domainTrust.js').DomainTrustOptions) {}

  async processRequest(req: CrawlRequest): Promise<CrawlRequest | null> {
    if (!this.config?.blockedDomains?.length) return req;
    try {
      const hostname = new URL(req.url).hostname.replace(/^www\./, '');
      if (this.config.blockedDomains.some((d) => hostname === d || hostname.endsWith('.' + d))) {
        logger.warn({ url: req.url, hostname }, 'domain-trust: blocked domain');
        return null; // Short-circuit: don't crawl
      }
    } catch {
      // Invalid URL — let the chain handle it
    }
    return req;
  }
}

// ── 3. Crawl4aiClientMiddleware ────────────────────────────────────────────

export class Crawl4aiClientMiddleware implements CrawlMiddleware {
  readonly name = 'crawl4ai-client';
  readonly priority = 500;

  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
  ) {}

  async processRequest(req: CrawlRequest): Promise<CrawlRequest | null> {
    if (!this.baseUrl) {
      throw unavailableError(
        'crawl4ai sidecar is not configured. Set CRAWL4AI_BASE_URL to enable web_crawl.',
      );
    }
    return req;
  }

  /**
   * Execute the actual crawl4ai API call.
   * This is the core middleware that translates CrawlRequest into CrawlResponse.
   */
  async processResponse(resp: CrawlResponse, _ctx: CrawlContext): Promise<CrawlResponse | null> {
    // No-op in response phase — the actual crawl is delegated via crawlFn
    return resp;
  }

  /**
   * Call the Crawl4AI sidecar.
   * Used by the execute() crawlFn parameter.
   */
  async crawl(req: CrawlRequest): Promise<CrawlResponse> {
    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/crawl`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
    };
    if (this.apiToken) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }

    const raw = await retryWithBackoff(
      async () => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(this.buildRequestBody(req)),
          signal: AbortSignal.timeout(computeCrawlTimeout(req.opts.maxPages)),
        });

        if (!response.ok) {
          if (response.status === 503 || response.status === 502) {
            throw unavailableError(
              `crawl4ai sidecar returned HTTP ${String(response.status)} — is the Docker container running?`,
              { statusCode: response.status },
            );
          }
          throw networkError(`crawl4ai returned HTTP ${String(response.status)} for "${req.url}"`, {
            statusCode: response.status,
          });
        }

        return await safeResponseJson(response, endpoint);
      },
      { label: 'crawl4ai', maxAttempts: 2, initialDelayMs: 500 },
    );

    const data = raw as Crawl4aiRawResponse;
    const pages = normalizeCrawlResponse(data, req.opts.extractionConfig);

    logger.debug(
      { url: req.url, totalPages: pages.length, strategy: req.opts.strategy },
      'crawl4ai-client complete',
    );

    return {
      result: {
        seedUrl: req.url,
        strategy: req.opts.strategy,
        maxDepth: req.opts.maxDepth,
        maxPages: req.opts.maxPages,
        pages,
        totalPages: pages.length,
        successfulPages: pages.filter((p) => p.success).length,
      },
    };
  }

  private buildRequestBody(req: CrawlRequest): Record<string, unknown> {
    const crawlerConfigParams: Record<string, unknown> = {
      deep_crawl_strategy: {
        type: req.opts.strategy === 'bfs' ? 'BFSDeepCrawlStrategy' : 'DFSDeepCrawlStrategy',
        params: {
          max_depth: req.opts.maxDepth,
          max_pages: req.opts.maxPages,
          include_external: req.opts.includeExternalLinks,
        },
      },
    };

    if (req.opts.waitFor !== undefined && req.opts.waitFor.length > 0) {
      crawlerConfigParams.wait_for = req.opts.waitFor;
    }
    if (req.opts.delayBeforeReturnHtml !== undefined) {
      crawlerConfigParams.delay_before_return_html = req.opts.delayBeforeReturnHtml;
    }
    if (req.opts.pageTimeout !== undefined) {
      crawlerConfigParams.page_timeout = req.opts.pageTimeout;
    }
    if (req.opts.jsCodeBeforeWait !== undefined && req.opts.jsCodeBeforeWait.length > 0) {
      crawlerConfigParams.js_code_before_wait = req.opts.jsCodeBeforeWait;
    }
    if (req.opts.jsCode !== undefined && req.opts.jsCode.length > 0) {
      crawlerConfigParams.js_code = req.opts.jsCode;
    }

    const body: Record<string, unknown> = {
      urls: [req.url],
      browser_config: { type: 'BrowserConfig', params: { headless: true } },
      crawler_config: {
        type: 'CrawlerRunConfig',
        params: crawlerConfigParams,
      },
    };

    if (req.opts.extractionConfig) {
      body.extraction_config = mapToCrawl4ai(req.opts.extractionConfig, req.opts.llmFallback);
    }

    return body;
  }
}

// ── 4. ResponseQualityMiddleware ───────────────────────────────────────────

export class ResponseQualityMiddleware implements CrawlMiddleware {
  readonly name = 'response-quality';
  readonly priority = 800;

  async processResponse(resp: CrawlResponse): Promise<CrawlResponse | null> {
    if (resp.result.pages.length === 0) return resp;

    const quality = assessMarkdownBatchQuality(resp.result.pages.map((p) => p.markdown));
    if (!quality.meaningful) {
      logger.info(
        {
          url: resp.result.seedUrl,
          classification: quality.classification,
          score: quality.score,
          reasons: quality.reasons,
        },
        'response-quality: low quality, signaling for recovery',
      );
      return {
        ...resp,
        result: {
          ...resp.result,
          warnings: [
            ...(resp.result.warnings ?? []),
            `Low quality crawl output (${quality.classification}: ${quality.reasons.join(', ')})`,
          ],
        },
      };
    }
    return resp;
  }
}

// ── 5. AggressiveRenderMiddleware ──────────────────────────────────────────

export class AggressiveRenderMiddleware implements CrawlMiddleware {
  readonly name = 'aggressive-render';
  readonly priority = 700;

  async processResponse(resp: CrawlResponse, ctx: CrawlContext): Promise<CrawlResponse | null> {
    // Only trigger if the initial response has no or very low-quality content
    if (resp.result.pages.length === 0) return resp;

    const batchPages = resp.result.pages.map((p) => p.markdown);
    const quality = assessMarkdownBatchQuality(batchPages);
    if (quality.meaningful) return resp;

    // Don't override user's explicit dynamic-content settings
    if (ctx.request.opts.waitFor || ctx.request.opts.jsCode || ctx.request.opts.jsCodeBeforeWait) {
      return resp;
    }

    // Use recovery recommendation to decide strategy
    const rec = quality.recovery;
    if (rec.stopRetrying) {
      logger.info(
        { url: ctx.request.url, classification: quality.classification },
        'aggressive-render: skipping retry (classification recommends stop)',
      );
      return resp;
    }

    if (!rec.retryAggressiveRender) {
      logger.info(
        { url: ctx.request.url, classification: quality.classification },
        'aggressive-render: skipping retry (classification does not recommend aggressive render)',
      );
      return resp;
    }

    logger.info(
      {
        url: ctx.request.url,
        classification: quality.classification,
        score: quality.score,
        reasons: quality.reasons,
      },
      'aggressive-render: retrying with aggressive settings',
    );

    // Determine delay and scroll strategy based on classification
    const isJsShell = quality.classification === 'js_shell';
    const isNavHeavy =
      quality.classification === 'nav_heavy' ||
      quality.classification === 'too_thin' ||
      quality.classification === 'mixed_low_confidence';

    const delaySeconds =
      isJsShell || isNavHeavy
        ? Math.max(ctx.request.opts.delayBeforeReturnHtml ?? 0.1, 8)
        : Math.max(ctx.request.opts.delayBeforeReturnHtml ?? 0.1, 3);

    const scrollJs = isNavHeavy
      ? [
          '(async () => {',
          '  window.scrollTo(0, document.body.scrollHeight * 0.5);',
          '  await new Promise(r => setTimeout(r, 2000));',
          '  window.scrollTo(0, document.body.scrollHeight);',
          '  await new Promise(r => setTimeout(r, 2000));',
          '})();',
          '',
        ].join('\n')
      : 'window.scrollTo(0, document.body.scrollHeight);';

    const waitFor = isJsShell
      ? 'js:() => document.body.innerText.trim().length > 200'
      : isNavHeavy
        ? 'js:() => document.body.innerText.trim().length > 200'
        : [
            'js:() => document.body.innerText.trim().length > 0',
            '  && !/^(loading\\.?\\.?\\.?|please wait|just a moment|enable javascript|this page requires javascript)$/i',
            '    .test(document.body.innerText.trim())',
          ].join('');

    const aggressiveReq: CrawlRequest = {
      ...ctx.request,
      opts: {
        ...ctx.request.opts,
        waitFor,
        delayBeforeReturnHtml: delaySeconds,
        jsCodeBeforeWait: scrollJs,
        jsCode:
          ctx.request.opts.jsCode && ctx.request.opts.jsCode.length > 0
            ? `${ctx.request.opts.jsCode}\n${scrollJs}`
            : scrollJs,
        aggressive: true,
      },
      attempt: ctx.request.attempt + 1,
    };

    const crawlFn = ctx.metadata.get('crawlFn') as
      | ((req: CrawlRequest) => Promise<CrawlResponse>)
      | undefined;
    if (!crawlFn) {
      logger.warn(
        { url: ctx.request.url },
        'aggressive-render: no crawlFn in context, skipping retry',
      );
      return resp;
    }

    try {
      const recovery = await crawlFn(aggressiveReq);

      // Compare quality before and after — only accept if quality improved
      const recoveryQuality = assessMarkdownBatchQuality(
        recovery.result.pages.map((p) => p.markdown),
      );

      ctx.warnings.push(
        'Retried ' +
          ctx.request.url +
          ' with aggressive render profile because baseline output looked low quality',
      );

      // Use compareQuality to check if the retry improved semantic quality
      const comparison = compareQuality(quality, recoveryQuality);

      if (recoveryQuality.meaningful && comparison.improved) {
        ctx.warnings.push(`Aggressive render improved quality: ${comparison.summary}`);
        recordOutcome({
          url: ctx.request.url,
          domain: new URL(ctx.request.url).hostname.replace(/^www\./, ''),
          success: true,
          strategy: 'aggressive-render',
          timestamp: Date.now(),
          chars: recovery.result.pages.reduce((sum, p) => sum + p.markdown.length, 0),
        });
        return recovery;
      }

      if (comparison.improved) {
        // Quality improved even if not yet "meaningful" — still better
        ctx.warnings.push(
          `Aggressive render improved metrics (overall: ${String(Math.round(comparison.deltas.overallScore))})`,
        );
        return recovery;
      }

      ctx.warnings.push(`Aggressive render did not improve quality (${comparison.summary})`);
      return { ...recovery, result: { ...recovery.result, warnings: ctx.warnings } };
    } catch (err) {
      logger.warn({ err, url: ctx.request.url }, 'aggressive-render retry failed');
      return resp;
    }
  }
}

// ── 6. ExternalRecoveryMiddleware ──────────────────────────────────────────

export class ExternalRecoveryMiddleware implements CrawlMiddleware {
  readonly name = 'external-recovery';
  readonly priority = 600;

  async processResponse(resp: CrawlResponse, ctx: CrawlContext): Promise<CrawlResponse | null> {
    // Only attempt if response quality assessment says content is not meaningful
    if (resp.result.pages.length > 0) {
      const quality = assessMarkdownBatchQuality(resp.result.pages.map((p) => p.markdown));
      if (quality.meaningful) return resp;

      // Check recovery recommendation
      if (quality.recovery.stopRetrying) {
        logger.info(
          { url: ctx.request.url, classification: quality.classification },
          'external-recovery: skipping (classification recommends stop)',
        );
        return resp;
      }

      if (!quality.recovery.attemptExternalRecovery) {
        logger.info(
          { url: ctx.request.url, classification: quality.classification },
          'external-recovery: skipping (not recommended for this classification)',
        );
        return resp;
      }
    }

    logger.info(
      { url: ctx.request.url },
      'external-recovery: attempting Wayback/Google Cache fallback',
    );

    const externalResult = await attemptExternalRecovery(ctx.request.url);
    if (externalResult.content !== null && externalResult.source !== null) {
      recordOutcome({
        url: ctx.request.url,
        domain: new URL(ctx.request.url).hostname.replace(/^www\./, ''),
        success: true,
        strategy: 'external-recovery',
        timestamp: Date.now(),
        chars: externalResult.content.length,
      });

      ctx.warnings.push(`Recovered ${ctx.request.url} from ${externalResult.source}`);

      const recoveredPage: CrawlPageResult = {
        url: ctx.request.url,
        success: true,
        markdown: externalResult.content,
        title: null,
        description: null,
        links: [],
        statusCode: null,
        errorMessage: null,
        recoverySource: externalResult.source,
      };

      return {
        result: {
          seedUrl: ctx.request.url,
          strategy: resp.result.strategy,
          maxDepth: resp.result.maxDepth,
          maxPages: resp.result.maxPages,
          pages: [recoveredPage, ...resp.result.pages],
          totalPages: resp.result.pages.length + 1,
          successfulPages: resp.result.successfulPages + 1,
          warnings: ctx.warnings,
        },
      };
    }

    recordOutcome({
      url: ctx.request.url,
      domain: new URL(ctx.request.url).hostname.replace(/^www\./, ''),
      success: false,
      strategy: 'all-failed',
      timestamp: Date.now(),
      chars: 0,
    });

    return resp;
  }
}

// ── 7. StatsRecorderMiddleware ─────────────────────────────────────────────

export class StatsRecorderMiddleware implements CrawlMiddleware {
  readonly name = 'stats-recorder';
  // Lowest priority: runs LAST in response phase (after all modifications)
  readonly priority = 50;

  async processResponse(resp: CrawlResponse, ctx: CrawlContext): Promise<CrawlResponse | null> {
    statsCollector.incCounter('crawl.pages.total', resp.result.totalPages);
    statsCollector.incCounter('crawl.pages.successful', resp.result.successfulPages);
    statsCollector.incCounter('crawl.seeds.attempted', 1);
    statsCollector.recordHistogram('crawl.pages.per_seed', resp.result.totalPages);

    for (const page of resp.result.pages) {
      const domain = safeDomain(ctx.request.url);
      recordOutcome({
        url: page.url,
        domain,
        success: page.success,
        strategy: ctx.request.opts.aggressive ? 'aggressive-render' : 'baseline',
        timestamp: Date.now(),
        chars: page.markdown.length,
      });
    }
    return resp;
  }
}

// ── Utility ────────────────────────────────────────────────────────────────

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
