import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  DEFAULT_SEMANTIC_MAX_BYTES,
  applySemanticByteBudget,
  formatSemanticBytes,
} from '../semanticLimits.js';
import { webSearch } from './webSearch.js';
import { webCrawl } from './webCrawl.js';
import {
  extractJobListingsFromHtml,
  documentsFromJobListings,
  extractJobLinksFromHtml,
} from '../rag/adapters/job.js';
import { dedupJobListings } from '../rag/jobDedup.js';
import { applyHardFilters, rankJobListings, type JobScore } from '../rag/jobRanking.js';
import { embedTexts, embedTextsBatched } from '../rag/embedding.js';
import { prepareCorpus, retrieveCorpus } from '../rag/pipeline.js';
import type { JobListingMvp, JobSearchConstraints } from '../rag/types/job.js';
import type { SearchResult } from '../types.js';

const DEFAULT_MAX_PAGES = 20;
const MAX_PAGES = 50;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;

/**
 * Maximum concurrent crawl requests per domain to avoid rate limiting.
 */
const CRAWL_CONCURRENCY = 3;

/**
 * Retry settings for failed crawls.
 */
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;

export interface SemanticJobsOptions {
  query: string;
  embeddingBaseUrl: string;
  embeddingApiToken?: string;
  embeddingDimensions: number;
  location?: string[];
  workMode?: ('remote' | 'hybrid' | 'onsite')[];
  maxSalary?: number;
  excludeTitles?: string[];
  maxPages?: number;
  topK?: number;
  maxBytes?: number;
  debug?: boolean;
  /** When true (default), appends "jobs" keyword to the search query. */
  addJobSuffix?: boolean;
}

export interface SemanticJobsCrawledPage {
  url: string;
  html?: string;
  success: boolean;
  error?: string;
}

export interface SemanticJobsResult {
  results: JobScore[];
  corpusStatus: {
    requested: number;
    fetched: number;
    failed: number;
    extracted: number;
    deduplicated: number;
    filtered: number;
  };
  warnings: string[];
}

export interface SemanticJobsDeps {
  search?: (query: string, limit: number) => Promise<SearchResult[]>;
  crawl?: (urls: string[]) => Promise<SemanticJobsCrawledPage[]>;
}

export async function semanticJobs(
  opts: SemanticJobsOptions,
  deps: SemanticJobsDeps = {},
): Promise<SemanticJobsResult> {
  const maxPages = Math.min(opts.maxPages ?? DEFAULT_MAX_PAGES, MAX_PAGES);
  const topK = Math.min(opts.topK ?? DEFAULT_TOP_K, MAX_TOP_K);
  const constraints = buildConstraints(opts);
  const addJobSuffix = opts.addJobSuffix !== false;
  const query = buildSearchQuery(opts.query, constraints, addJobSuffix);

  logger.info({ tool: 'semantic_jobs', query, maxPages, topK }, 'Starting semantic job search');

  const searchFn = deps.search ?? defaultSearch;
  const crawlFn = deps.crawl ?? defaultCrawl;

  const searchResults = await searchFn(query, maxPages);
  const seedUrls = dedupUrls(searchResults.map((result) => result.url));

  if (seedUrls.length === 0) {
    return {
      results: [],
      corpusStatus: {
        requested: 0,
        fetched: 0,
        failed: 0,
        extracted: 0,
        deduplicated: 0,
        filtered: 0,
      },
      warnings: [],
    };
  }

  const crawledPages = await crawlFn(seedUrls);
  return processJobSearchResults(
    crawledPages,
    opts.query,
    constraints,
    opts.embeddingBaseUrl,
    opts.embeddingApiToken,
    opts.embeddingDimensions,
    topK,
    opts.maxBytes,
  );
}

export async function processJobSearchResults(
  crawledPages: SemanticJobsCrawledPage[],
  query: string,
  constraints: JobSearchConstraints = {},
  embeddingBaseUrl?: string,
  embeddingApiToken?: string,
  embeddingDimensions?: number,
  topK = DEFAULT_TOP_K,
  maxBytes = DEFAULT_SEMANTIC_MAX_BYTES,
): Promise<SemanticJobsResult> {
  const warnings: string[] = [];
  const successfulPages = crawledPages.filter(
    (page) => page.success && (page.html ?? '').trim().length > 0,
  );
  const failedPages = crawledPages.length - successfulPages.length;

  const markdownOnlyCount = successfulPages.filter(
    (page) => (page.html ?? '').length > 0 && !(page.html ?? '').includes('<'),
  ).length;
  if (markdownOnlyCount > 0) {
    warnings.push(
      `semantic_jobs: ${String(markdownOnlyCount)} page(s) fetched as markdown only — ` +
        `HTML extraction unavailable; upgrade Crawl4AI sidecar to v0.8.x for structured data`,
    );
  }

  for (const page of crawledPages) {
    if (!page.success) {
      warnings.push(`Crawl failed for "${page.url}": ${page.error ?? 'unknown crawl failure'}`);
      logger.warn({ url: page.url, err: page.error }, 'semantic_jobs crawl failed');
    }
  }

  const extractedListings: JobListingMvp[] = [];
  for (const page of successfulPages) {
    extractedListings.push(...extractJobListingsFromHtml(page.html ?? '', page.url));
  }

  const dedupedListings = dedupJobListings(extractedListings);
  const deduplicatedCount = extractedListings.length - dedupedListings.length;
  const filteredListings = applyHardFilters(dedupedListings, constraints);
  const filteredCount = dedupedListings.length - filteredListings.length;

  const corpusStatus = {
    requested: crawledPages.length,
    fetched: successfulPages.length,
    failed: failedPages,
    extracted: extractedListings.length,
    deduplicated: deduplicatedCount,
    filtered: filteredCount,
  };

  if (filteredListings.length === 0) {
    return {
      results: [],
      corpusStatus,
      warnings,
    };
  }

  const semantic = await buildSemanticScores(
    filteredListings,
    query,
    embeddingBaseUrl,
    embeddingApiToken,
    embeddingDimensions,
    topK,
    maxBytes,
    warnings,
  );

  const ranked = rankJobListings(filteredListings, query, constraints, semantic);
  return {
    results: ranked.slice(0, topK),
    corpusStatus,
    warnings,
  };
}

async function buildSemanticScores(
  listings: JobListingMvp[],
  query: string,
  embeddingBaseUrl: string | undefined,
  embeddingApiToken: string | undefined,
  embeddingDimensions: number | undefined,
  topK: number,
  maxBytes: number,
  warnings: string[],
): Promise<Map<string, number> | undefined> {
  if (!embeddingBaseUrl || embeddingDimensions === undefined) {
    return undefined;
  }

  const documents = documentsFromJobListings(listings);
  const budgeted = applySemanticByteBudget(documents, maxBytes);
  if (budgeted.truncated) {
    warnings.push(
      `Job corpus budget capped at ${formatSemanticBytes(maxBytes)}; ${String(budgeted.droppedCount)} documents omitted`,
    );
  }

  if (budgeted.items.length === 0) {
    return new Map();
  }

  const docTexts = budgeted.items.map((document) => document.text);
  const docTitles = budgeted.items.map((document) => document.title ?? document.id);

  const [docEmbed, queryEmbed] = await Promise.all([
    embedTextsBatched({
      baseUrl: embeddingBaseUrl,
      apiToken: embeddingApiToken,
      texts: docTexts,
      mode: 'document',
      dimensions: embeddingDimensions,
      titles: docTitles,
    }),
    embedTexts({
      baseUrl: embeddingBaseUrl,
      apiToken: embeddingApiToken,
      texts: [query],
      mode: 'query',
      dimensions: embeddingDimensions,
    }),
  ]);

  const queryEmbedding = queryEmbed.embeddings[0];
  if (!queryEmbedding) {
    throw new Error('Embedding sidecar returned empty query embedding');
  }

  const corpus = prepareCorpus({
    adapter: 'job',
    documents: budgeted.items,
    embeddings: docEmbed.embeddings,
    model: docEmbed.model,
    dimensions: docEmbed.dimensions,
  });

  const response = retrieveCorpus(corpus, {
    query,
    queryEmbedding,
    topK,
  });

  return mapSemanticScores(response.results);
}

function mapSemanticScores(
  results: {
    item: { url: string; metadata?: Record<string, unknown> | undefined };
    score: { fused: number };
  }[],
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const result of results) {
    const raw = result.item.metadata?.documentId;
    const docId = typeof raw === 'string' ? raw : undefined;
    scores.set(docId ?? result.item.url, result.score.fused);
  }
  return scores;
}

function buildConstraints(opts: SemanticJobsOptions): JobSearchConstraints {
  return {
    ...(opts.location !== undefined ? { location: opts.location } : {}),
    ...(opts.workMode !== undefined ? { workMode: opts.workMode } : {}),
    ...(opts.maxSalary !== undefined ? { maxSalary: opts.maxSalary } : {}),
    ...(opts.excludeTitles !== undefined ? { excludeTitles: opts.excludeTitles } : {}),
  };
}

function buildSearchQuery(
  query: string,
  constraints: JobSearchConstraints,
  addJobSuffix: boolean,
): string {
  const parts = [query.trim()];
  if (constraints.location !== undefined) {
    parts.push(
      ...constraints.location.map((term) => term.trim()).filter((term) => term.length > 0),
    );
  }
  if (constraints.workMode !== undefined) {
    parts.push(
      ...constraints.workMode.map((mode) => mode.trim()).filter((term) => term.length > 0),
    );
  }
  if (addJobSuffix) {
    parts.push('jobs');
  }
  return parts.filter((part) => part.length > 0).join(' ');
}

function dedupUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    deduped.push(url);
  }
  return deduped;
}

async function defaultSearch(query: string, limit: number): Promise<SearchResult[]> {
  return webSearch(query, limit);
}

/**
 * Concurrency-limited map: process items in batches, at most `concurrency` at a time.
 */
async function concurrencyLimitedMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn));
    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        throw new Error(`Concurrent crawl failed: ${reason}`);
      }
    }
  }
  return results;
}

/**
 * Crawl a URL with retry and exponential backoff.
 */
async function crawlWithRetry(
  url: string,
  cfg: ReturnType<typeof loadConfig>,
  maxRetries: number,
): Promise<{ url: string; page: import('../types.js').CrawlPageResult | undefined }> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken, {
        strategy: 'bfs',
        maxDepth: 1,
        maxPages: 1,
        includeExternalLinks: false,
      });
      return { url, page: result.pages[0] };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        logger.debug({ url, attempt, delay, err: lastError }, 'Crawl attempt failed, retrying');
        await sleep(delay);
      }
    }
  }

  logger.warn({ url, err: lastError, maxRetries }, 'Crawl failed after all retries');
  return {
    url,
    page: {
      url,
      success: false,
      markdown: '',
      title: '',
      description: '',
      links: [],
      statusCode: null,
      errorMessage: lastError ?? 'Max retries exceeded',
    },
  };
}

/**
 * Crawl phase URLs with concurrency control, then build the result array.
 */
async function crawlPhase(
  urls: string[],
  cfg: ReturnType<typeof loadConfig>,
  maxRetries: number,
): Promise<SemanticJobsCrawledPage[]> {
  const results = await concurrencyLimitedMap(urls, CRAWL_CONCURRENCY, (url: string) =>
    crawlWithRetry(url, cfg, maxRetries),
  );

  return results.map(({ url, page }) => ({
    url,
    html: page?.html ?? page?.markdown ?? '',
    success: page?.success ?? false,
    ...(page?.errorMessage !== null && page?.errorMessage !== undefined
      ? { error: page.errorMessage }
      : {}),
  })) satisfies SemanticJobsCrawledPage[];
}

async function defaultCrawl(urls: string[]): Promise<SemanticJobsCrawledPage[]> {
  const cfg = loadConfig();

  // Phase 1: crawl collection pages to extract individual job links
  const phase1Pages = await crawlPhase(urls, cfg, MAX_RETRIES);
  const jobLinks: string[] = [];
  for (const page of phase1Pages) {
    if (page.html) {
      jobLinks.push(...extractJobLinksFromHtml(page.html, page.url));
    }
  }

  // If no individual job links found, fall back to treating collection pages as listings
  const targets = jobLinks.length > 0 ? dedupUrls(jobLinks) : urls;

  // Phase 2: crawl individual job pages (or fall back to collection pages)
  return crawlPhase(targets, cfg, MAX_RETRIES);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
