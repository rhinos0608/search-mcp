/**
 * Core types for the Scrapy-inspired crawl framework.
 *
 * Phase 0: Foundation — shared interfaces for middleware chains,
 * chunk pipelines, spider abstraction, link extraction, and stats.
 */

import type { CrawlPageResult, WebCrawlResult, CorpusChunk } from '../types.js';
import type { SemanticCrawlSource } from '../types.js';
import type { DomainTrustConfig } from '../config.js';

// ── Crawl Middleware Chain ─────────────────────────────────────────────────

export interface CrawlRequest {
  url: string;
  baseUrl: string;
  apiToken: string;
  opts: CrawlOptions;
  attempt: number; // 1-based; >1 means retry
}

export interface CrawlResponse {
  result: WebCrawlResult;
  /** Whether the response was recovered from an external source (Wayback, Google Cache). */
  recovered?: boolean;
  /** Source label for recovered content. */
  recoverySource?: 'wayback' | 'google-cache' | 'aggressive-render' | undefined;
}

export interface CrawlOptions {
  strategy: 'bfs' | 'dfs';
  maxDepth: number;
  maxPages: number;
  includeExternalLinks: boolean;
  maxBytes?: number | undefined;
  waitFor?: string | undefined;
  delayBeforeReturnHtml?: number | undefined;
  pageTimeout?: number | undefined;
  jsCode?: string | undefined;
  jsCodeBeforeWait?: string | undefined;
  extractionConfig?: import('../utils/extractionConfig.js').ExtractionConfig | undefined;
  llmFallback?: { provider: string; apiToken: string; baseUrl?: string } | undefined;
  domainTrust?: DomainTrustConfig | undefined;
  /** When true, use aggressive render settings for JS-heavy pages. */
  aggressive?: boolean | undefined;
}

export interface CrawlContext {
  startTime: number;
  request: CrawlRequest;
  /** Warnings accumulated through the middleware chain. */
  warnings: string[];
  /** Per-middleware metadata, keyed by middleware name. */
  metadata: Map<string, unknown>;
}

export interface CrawlMiddleware {
  /** Unique name for logging and stats. */
  readonly name: string;
  /** Lower priority runs first (like Scrapy's numeric priority). */
  readonly priority: number;

  /**
   * Process/modify the request before it reaches the crawler.
   * Return null to short-circuit the chain (e.g. cache hit).
   */
  processRequest?(req: CrawlRequest, ctx: CrawlContext): Promise<CrawlRequest | null>;

  /**
   * Process/modify the response after the crawler returns.
   * Return null to trigger external recovery or fallback.
   */
  processResponse?(resp: CrawlResponse, ctx: CrawlContext): Promise<CrawlResponse | null>;
}

// ── Chunk Processing Pipeline ─────────────────────────────────────────────

export class DropChunk extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Chunk dropped: ${reason}`);
    this.name = 'DropChunk';
    this.reason = reason;
  }
}

export interface PipelineContext {
  /** Page-level metadata available to all stages. */
  pageUrl: string;
  pageTitle: string | null;
  pageStatusCode: number | null;
  /** True when content scrubbing is enabled. */
  scrubEnabled: boolean;
  /** Accumulated drop reasons for stats. */
  droppedReasons: Map<string, number>;
}

export interface ChunkStageResult {
  chunks: CorpusChunk[];
  warnings?: string[];
}

export interface ChunkStage {
  /** Unique name for logging and stats. */
  readonly name: string;

  /**
   * Process a batch of corpus chunks.
   * Stages can throw DropChunk to remove individual chunks.
   */
  process(chunks: CorpusChunk[], ctx: PipelineContext): Promise<ChunkStageResult>;
}

// ── Spider Abstraction ────────────────────────────────────────────────────

export interface CorpusSpider {
  /** Source type this spider handles (e.g. 'url', 'sitemap', 'search', 'github', 'cached'). */
  readonly sourceType: string;

  /** Generate seed URLs from the source configuration. */
  generateSeeds(source: SemanticCrawlSource): Promise<string[]>;

  /**
   * Optional post-crawl page filtering.
   * Default implementation returns all pages unfiltered.
   */
  filterPages?(pages: CrawlPageResult[], seedUrl: string): CrawlPageResult[];
}

// ── Link Extractor ────────────────────────────────────────────────────────

export interface LinkExtractorRule {
  /** Regex patterns for URLs to allow. */
  allow?: RegExp[];
  /** Regex patterns for URLs to deny. */
  deny?: RegExp[];
  /** HTML tags to scan for links. */
  tags?: ('a' | 'area' | 'iframe' | 'frame' | 'link')[];
  /** HTML attributes to extract URLs from. */
  attrs?: ('href' | 'src' | 'data-src')[];
  /** If set, only extract links from elements matching these XPath-like selectors. */
  restrictXPaths?: string[];
  /** If true, deduplicate extracted URLs by normalized form. */
  unique?: boolean;
  /** If true, resolve relative URLs against the page URL. */
  resolveUrls?: boolean;
}

export interface ExtractedLink {
  url: string;
  text: string;
  fragment?: string;
  rel?: string[];
}

// ── Stats Collector ───────────────────────────────────────────────────────

export type CounterValue = number;
export type GaugeValue = number;
export type HistogramValue = number;

export interface StatsSnapshot {
  counters: Record<string, CounterValue>;
  gauges: Record<string, GaugeValue>;
  histograms: Record<string, { count: number; sum: number; min: number; max: number; avg: number }>;
}

export interface StatsCollector {
  /** Increment a counter by `value` (default 1). */
  incCounter(name: string, value?: number): void;
  /** Set a gauge to an absolute value. */
  setGauge(name: string, value: number): void;
  /** Record a histogram observation. */
  recordHistogram(name: string, value: number): void;
  /** Return a snapshot of all collected stats. */
  snapshot(): StatsSnapshot;
  /** Reset all stats. */
  reset(): void;
}
