/**
 * Crawl framework — Scrapy-inspired patterns for search-mcp.
 *
 * This module provides:
 * - CrawlMiddlewareChain: composable request/response middleware
 * - ChunkPipeline: staged chunk processing pipeline
 * - CorpusSpider: polymorphic source type abstraction
 * - LinkExtractor: configurable link extraction
 * - StatsCollector: unified metrics
 * - Middleware implementations: pre-built crawl middleware classes
 *
 * @module crawl
 */

export { CrawlMiddlewareChain, MiddlewareChainError } from './middleware.js';

export { ChunkPipeline, runPipeline } from './pipeline.js';

export {
  SentryGuardMiddleware,
  DomainTrustMiddleware,
  Crawl4aiClientMiddleware,
  ResponseQualityMiddleware,
  AggressiveRenderMiddleware,
  ExternalRecoveryMiddleware,
  StatsRecorderMiddleware,
} from './middlewares.js';

export { DropChunk } from './types.js';

export {
  statsCollector,
  incCounter,
  setGauge,
  recordHistogram,
  getStatsSnapshot,
  resetStats,
} from './stats.js';

export type {
  CrawlMiddleware,
  CrawlRequest,
  CrawlResponse,
  CrawlContext,
  CrawlOptions,
} from './types.js';

export type { PipelineBatchResult, PipelineOptions } from './pipeline.js';

export { LinkExtractor } from './linkExtractor.js';

export {
  UrlSpider,
  SitemapSpider,
  SearchSpider,
  GitHubSpider,
  CachedSpider,
  registerSpider,
  getSpider,
  registerDefaultSpiders,
  getRegisteredSourceTypes,
} from './spiders.js';

export {
  ConsentWallFilterStage,
  HttpErrorFilterStage,
  CookieBannerFilterStage,
  ContentScrubStage,
  MarkdownChunkStage,
  DedupStage,
  buildDefaultStages,
} from './stages.js';

export type {
  ChunkStage,
  ChunkStageResult,
  PipelineContext,
  CorpusSpider,
  LinkExtractorRule,
  ExtractedLink,
  StatsCollector,
  StatsSnapshot,
} from './types.js';

export type { SearchFunction } from './spiders.js';
