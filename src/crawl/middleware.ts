/**
 * MiddlewareManager — Scrapy-inspired middleware chain.
 *
 * Manages an ordered chain of middleware that process crawl requests
 * (before hitting the crawler) and responses (after the crawler returns).
 * Inspired by Scrapy's MiddlewareManager and DownloaderMiddlewareManager.
 *
 * Each middleware declares a `priority` (lower runs first). The chain
 * processes requests in priority order, then responses in reverse priority order.
 *
 * Short-circuit: a middleware can return null from processRequest to skip
 * the rest of the chain (e.g. cache hit), or null from processResponse to
 * trigger external recovery.
 */

import { statsCollector } from './stats.js';
import type { CrawlMiddleware, CrawlRequest, CrawlResponse, CrawlContext } from './types.js';

export class MiddlewareChainError extends Error {
  readonly middlewareName: string;
  readonly phase: 'request' | 'response';

  constructor(middlewareName: string, phase: 'request' | 'response', message: string) {
    super(`[${middlewareName}] ${phase} error: ${message}`);
    this.name = 'MiddlewareChainError';
    this.middlewareName = middlewareName;
    this.phase = phase;
  }
}

export class CrawlMiddlewareChain {
  private readonly middlewares: CrawlMiddleware[];
  private sorted = true;

  constructor(middlewares: CrawlMiddleware[] = []) {
    this.middlewares = [...middlewares];
    this.sort();
  }

  /** Add a middleware to the chain. Re-sorts after add. */
  add(mw: CrawlMiddleware): void {
    this.middlewares.push(mw);
    this.sorted = false;
  }

  /** Remove a middleware by name. */
  remove(name: string): boolean {
    const idx = this.middlewares.findIndex((m) => m.name === name);
    if (idx === -1) return false;
    this.middlewares.splice(idx, 1);
    return true;
  }

  /** Get a middleware by name (for inspection/testing). */
  get(name: string): CrawlMiddleware | undefined {
    return this.middlewares.find((m) => m.name === name);
  }

  /** Get all registered middleware names in priority order. */
  get names(): string[] {
    this.ensureSorted();
    return this.middlewares.map((m) => m.name);
  }

  /**
   * Execute the full middleware chain: request → crawl → response.
   *
   * @param url - Target URL
   * @param baseUrl - Crawl4AI sidecar base URL
   * @param apiToken - Crawl4AI API token
   * @param opts - Crawl options
   * @param crawlFn - The actual crawl function (default: uses internal Crawl4AI client)
   * @returns CrawlResponse with accumulated warnings
   */
  async execute(
    url: string,
    baseUrl: string,
    apiToken: string,
    opts: import('./types.js').CrawlOptions,
    crawlFn: (req: CrawlRequest) => Promise<CrawlResponse>,
  ): Promise<CrawlResponse> {
    this.ensureSorted();

    const chainStartTime = Date.now();

    const ctx: CrawlContext = {
      startTime: chainStartTime,
      request: { url, baseUrl, apiToken, opts, attempt: 1 },
      warnings: [],
      metadata: new Map(),
    };

    // ── Request phase (forward order) ──────────────────────────────────────
    let currentReq: CrawlRequest | null = ctx.request;

    for (const mw of this.middlewares) {
      if (currentReq === null) break;
      if (!mw.processRequest) continue;

      try {
        currentReq = await mw.processRequest(currentReq, ctx);
      } catch (err) {
        throw new MiddlewareChainError(
          mw.name,
          'request',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (currentReq === null) {
      // Short-circuited — no request was made
      return {
        result: {
          seedUrl: url,
          strategy: opts.strategy,
          maxDepth: opts.maxDepth,
          maxPages: opts.maxPages,
          pages: [],
          totalPages: 0,
          successfulPages: 0,
          warnings: ctx.warnings,
        },
      };
    }

    // ── Crawl phase ───────────────────────────────────────────────────────
    ctx.request = currentReq;
    ctx.metadata.set('crawlFn', crawlFn);
    let currentResp: CrawlResponse | null;

    currentResp = await crawlFn(currentReq);

    // ── Response phase (reverse order) ─────────────────────────────────────
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const mw = this.middlewares[i];
      if (mw === undefined) continue;
      if (currentResp === null) break;
      if (!mw.processResponse) continue;

      try {
        currentResp = await mw.processResponse(currentResp, ctx);
      } catch (err) {
        throw new MiddlewareChainError(
          mw.name,
          'response',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (currentResp === null) {
      // Response was fully rejected
      return {
        result: {
          seedUrl: url,
          strategy: opts.strategy,
          maxDepth: opts.maxDepth,
          maxPages: opts.maxPages,
          pages: [],
          totalPages: 0,
          successfulPages: 0,
          warnings: ctx.warnings,
        },
      };
    }

    // Attach accumulated warnings only when non-empty (clone to avoid mutation)
    const allWarnings = [...(currentResp.result.warnings ?? []), ...ctx.warnings];
    const clonedResult = allWarnings.length > 0
      ? { ...currentResp.result, warnings: allWarnings }
      : { ...currentResp.result };

    // Record chain-level stats
    const chainDuration = Date.now() - chainStartTime;
    statsCollector.incCounter('chain.executions');
    statsCollector.recordHistogram('chain.duration_ms', chainDuration);
    statsCollector.incCounter('chain.warnings', ctx.warnings.length);

    return { ...currentResp, result: clonedResult };
  }

  private sort(): void {
    this.middlewares.sort((a, b) => a.priority - b.priority);
    this.sorted = true;
  }

  private ensureSorted(): void {
    if (!this.sorted) this.sort();
  }
}
