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
import { JobPipeline, type EnrichedRecord } from '../rag/jobPipeline.js';
import { type JobSpyAcquisitionParams } from '../utils/jobspyClient.js';
import type { JobListingMvp, JobSearchConstraints } from '../rag/types/job.js';
import type { SearchResult } from '../types.js';
import { QualityGate } from '../rag/quality/qualityGate.js';
import { checkSerpQuality } from '../rag/quality/serpGuard.js';
import { canonicalizeJobUrl } from '../utils/url.js';

const DEFAULT_MAX_PAGES = 20;
const MAX_PAGES = 50;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;

/**
 * Maximum concurrent crawl requests per domain to avoid rate limiting.
 */
const CRAWL_CONCURRENCY = 8;

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
  /** When true, uses the JobSpy acquisition pipeline. */
  useJobSpy?: boolean;
  /** When true, applies hard filtering to exclude listings that don't match constraints. When false (default), constraints only influence ranking scores. */
  enforceConstraints?: boolean;
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
  if (opts.useJobSpy !== false) {
    const pipeline = new JobPipeline();
    const acquisitionParams: JobSpyAcquisitionParams = {
      query: opts.query,
    };
    if (opts.location?.[0] !== undefined) {
      if (opts.location.length > 1) {
        logger.warn(
          { locations: opts.location },
          'semantic_jobs: JobSpy only supports a single location; using the first entry.',
        );
      }
      acquisitionParams.location = opts.location[0];
    }
    const inferredCountry = inferJobSpyCountry(opts.query, opts.location);
    if (inferredCountry !== undefined) {
      acquisitionParams.country = inferredCountry;
    }
    if (opts.workMode?.includes('remote')) acquisitionParams.isRemote = true;

    // Freshness: fetch jobs posted within the last 72 hours
    acquisitionParams.hoursOld = 72;

    const maxPages = Math.min(opts.maxPages ?? DEFAULT_MAX_PAGES, MAX_PAGES);
    acquisitionParams.resultsWanted = maxPages * 5;

    const discovery = await pipeline.discover(acquisitionParams);

    if (discovery.length === 0) {
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

    const normalized = pipeline.normalize(discovery, opts.query);
    const constraints = buildConstraints(opts);
    const scored = pipeline.scoreMetadata(normalized, constraints);
    const scoreFilteredCount = normalized.length - scored.length;

    let finalRecords: EnrichedRecord[] = scored.map((s) => ({ ...s }));
    if (maxPages > 0) {
      finalRecords = await pipeline.enrich(scored);
    }

    const embedOpts: {
      baseUrl?: string;
      apiToken?: string;
      dimensions?: number;
      topK?: number;
      maxBytes?: number;
    } = {};
    embedOpts.baseUrl = opts.embeddingBaseUrl;
    if (opts.embeddingApiToken !== undefined) embedOpts.apiToken = opts.embeddingApiToken;
    embedOpts.dimensions = opts.embeddingDimensions;
    if (opts.topK !== undefined) embedOpts.topK = opts.topK;
    if (opts.maxBytes !== undefined) embedOpts.maxBytes = opts.maxBytes;

    // Default to false: constraints influence ranking by default;
    // set enforceConstraints: true for strict post-filtering only when precise control is needed.
    const enforceConstraints = opts.enforceConstraints ?? false;
    let results = await pipeline.embedAndRank(finalRecords, opts.query, embedOpts, constraints, false);
    let strictFilteredCount = 0;
    if (enforceConstraints) {
      const beforeCount = results.length;
      results = filterEnforcedJobScores(results, constraints);
      strictFilteredCount = beforeCount - results.length;
    }

    return {
      results,
      corpusStatus: {
        requested: discovery.length,
        fetched: discovery.length,
        failed: 0,
        extracted: discovery.length,
        deduplicated: discovery.length - normalized.length,
        filtered: scoreFilteredCount + strictFilteredCount,
      },
      warnings: [],
    };
  }

  const maxPages = Math.min(opts.maxPages ?? DEFAULT_MAX_PAGES, MAX_PAGES);
  const topK = Math.min(opts.topK ?? DEFAULT_TOP_K, MAX_TOP_K);
  const constraints = buildConstraints(opts);
  const addJobSuffix = opts.addJobSuffix !== false;
  const query = buildSearchQuery(opts.query, constraints, addJobSuffix);

  logger.info({ tool: 'semantic_jobs', query, maxPages, topK }, 'Starting semantic job search');

  const searchFn = deps.search ?? defaultSearch;
  const crawlFn = deps.crawl ?? defaultCrawl;

  // Try the full query first; if it returns no results, retry with a looser query
  // dropping constraints that may be too specific for web search.
  let searchResults = await searchFn(query, maxPages);

  // SERP quality guard: check if search results are relevant before crawling
  if (searchResults.length > 0) {
    const serpQuality = checkSerpQuality(searchResults, query, 3, 10);
    if (!serpQuality.passed && serpQuality.constrainedQuery) {
      logger.warn(
        { tool: 'semantic_jobs', originalQuery: query, constrained: serpQuality.constrainedQuery, reasons: serpQuality.reasons },
        'SERP quality check failed; retrying with constrained query',
      );
      searchResults = await searchFn(serpQuality.constrainedQuery, maxPages);
    }
  }

  if (searchResults.length === 0 && constraints.location !== undefined) {
    const looseQuery = buildSearchQuery(opts.query, {}, addJobSuffix);
    logger.info(
      { tool: 'semantic_jobs', originalQuery: query, looseQuery },
      'Zero results with constrained query; retrying with location-agnostic query',
    );
    searchResults = await searchFn(looseQuery, maxPages);
  }

  // Canonicalize job URLs before crawling to remove tracking sludge
  const seedUrls = dedupUrls(
    searchResults.map((result) => canonicalizeJobUrl(result.url)),
  );

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

  // Page-level intent check: skip pages that are clearly not job listings
  const extractedListings: JobListingMvp[] = [];
  let pageIntentSkipped = 0;
  for (const page of successfulPages) {
    const pageHtml = page.html ?? '';
    // Quick page-level check: short pages lacking job keywords are likely
    // login, loading, boilerplate, or non-listing content
    const pageText = pageHtml
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const isJobPage = pageText.length >= 100 || /job|career|position|vacancy|hiring|apply/i.test(pageHtml);
    if (!isJobPage) {
      pageIntentSkipped++;
      logger.debug({ url: page.url, textLen: pageText.length }, 'Skipped non-job page before extraction');
      continue;
    }
    extractedListings.push(...extractJobListingsFromHtml(pageHtml, page.url));
  }

  const dedupedListings = dedupJobListings(extractedListings);
  const deduplicatedCount = extractedListings.length - dedupedListings.length;

  // Quality gate: filter listings by country, occupation, entry-level, and boilerplate
  const qualityGate = new QualityGate();
  const qualityResult = qualityGate.filter(dedupedListings);
  if (qualityResult.rejected.length > 0) {
    logger.info(
      { tool: 'semantic_jobs', passed: qualityResult.passed.length, rejected: qualityResult.rejected.length, stats: qualityResult.stats },
      'Quality gate filtered listings',
    );
  }

  const filteredListings = applyHardFilters(qualityResult.passed, constraints);
  const filteredCount = qualityResult.passed.length - filteredListings.length;

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

const AUSTRALIAN_LOCATION_HINTS: RegExp[] = [
  /\baustralia\b/i,
  /\baustralian\b/i,
  // Multi-letter state codes only — wa, sa, nt removed (too ambiguous standalone)
  /\b(?:nsw|vic|qld|tas|act)\b/i,
  /\b(?:sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin)\b/i,
  /\b(?:gold\s+coast|sunshine\s+coast|newcastle|wollongong|geelong|ballarat|bendigo|townsville|cairns|toowoomba)\b/i,
];

export function inferJobSpyCountry(query: string, locations: string[] | undefined): string | undefined {
  const candidates = [query, ...(locations ?? [])];
  for (const candidate of candidates) {
    if (AUSTRALIAN_LOCATION_HINTS.some((pattern) => pattern.test(candidate))) {
      return 'australia';
    }
  }
  return undefined;
}

export function filterEnforcedJobScores(
  results: JobScore[],
  constraints: JobSearchConstraints,
): JobScore[] {
  return results.filter((score) => matchesStrictConstraints(score.listing, constraints));
}

function matchesStrictConstraints(listing: JobListingMvp, constraints: JobSearchConstraints): boolean {
  if (constraints.location !== undefined && constraints.location.length > 0) {
    if (listing.location === undefined) {
      return true; // Unknown location passes through (consistent with applyHardFilters)
    }
    const location = listing.location.toLowerCase();
    const locationMatch = constraints.location.some((constraint) => {
      const normalizedConstraint = constraint.trim().toLowerCase();
      return normalizedConstraint.length > 0 && location.includes(normalizedConstraint);
    });
    if (!locationMatch) {
      return false;
    }
  }

  if (constraints.workMode !== undefined && constraints.workMode.length > 0) {
    if (listing.workMode === 'unknown') {
      return true; // Unknown work mode passes through (consistent with applyHardFilters)
    }
    if (!constraints.workMode.includes(listing.workMode)) {
      return false;
    }
  }

  if (constraints.maxSalary !== undefined) {
    const salaryMax = parseSalaryMax(listing.salaryRaw);
    // Unknown salary passes through; only reject known excess
    if (salaryMax !== undefined && salaryMax > constraints.maxSalary) {
      return false;
    }
  }

  if (constraints.excludeTitles !== undefined && constraints.excludeTitles.length > 0) {
    const title = listing.title.toLowerCase();
    const excluded = constraints.excludeTitles.some((keyword) => {
      const normalizedKeyword = keyword.trim().toLowerCase();
      return normalizedKeyword.length > 0 && title.includes(normalizedKeyword);
    });
    if (excluded) {
      return false;
    }
  }

  return true;
}

function parseSalaryMax(salaryRaw: string | undefined): number | undefined {
  if (salaryRaw === undefined) {
    return undefined;
  }

  const matches = salaryRaw.match(/\d[\d,]*(?:\.\d+)?\s*k?/gi);
  if (matches === null || matches.length === 0) {
    return undefined;
  }

  const values = matches
    .map((match) => {
      const normalized = match.replace(/,/g, '').trim().toLowerCase();
      const multiplier = normalized.endsWith('k') ? 1000 : 1;
      const numericPart = normalized.endsWith('k') ? normalized.slice(0, -1) : normalized;
      const value = Number.parseFloat(numericPart);
      return Number.isFinite(value) ? value * multiplier : undefined;
    })
    .filter((value): value is number => value !== undefined);

  if (values.length === 0) {
    return undefined;
  }

  return Math.max(...values);
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
  // NOTE: workMode is intentionally NOT added to the search query.
  // Keywords like "remote" / "hybrid" pollute web search and harm recall.
  // Work-mode filtering is handled at the ranking/filtering stage.
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
 * Task-pool map: processes items with at most `concurrency` workers running at once
 * in a firehose pattern — as soon as one task finishes, the next starts immediately.
 * Failures are logged but do not abort remaining items.
 */
async function concurrencyLimitedMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      if (index >= items.length) break;
      nextIndex = index + 1;
      try {
        results[index] = await fn(items[index] as T);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn({ err: reason, index }, 'concurrencyLimitedMap: item failed');
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.allSettled(workers);
  return results.filter((r): r is R => r !== undefined);
}

/**
 * Crawl a URL with retry and exponential backoff.
 */
async function crawlWithRetry(
  url: string,
  cfg: ReturnType<typeof loadConfig>,
  maxRetries: number,
  includeExternalLinks = false,
): Promise<{ url: string; page: import('../types.js').CrawlPageResult | undefined }> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken ?? '', {
        strategy: 'bfs',
        maxDepth: 1,
        maxPages: 1,
        includeExternalLinks,
        pageTimeout: 15000,
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
  includeExternalLinks = false,
): Promise<SemanticJobsCrawledPage[]> {
  const results = await concurrencyLimitedMap(urls, CRAWL_CONCURRENCY, (url: string) =>
    crawlWithRetry(url, cfg, maxRetries, includeExternalLinks),
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

  // Phase 1: crawl collection pages to extract individual job links.
  // Allow external links so aggregator pages can link to job listings on
  // different domains (e.g. Himalayas linking to Greenhouse/Lever/Ashby).
  const phase1Pages = await crawlPhase(urls, cfg, MAX_RETRIES, true);
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
